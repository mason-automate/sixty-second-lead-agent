import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { draftFollowUp } from "@/lib/claude";
import { sendMessage } from "@/lib/sent";
import {
  findConversationByMessageId,
  getConversation,
  recordWebhookSample,
  saveConversation,
} from "@/lib/store";
import type { Channel, Conversation, MessageRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receives Sent's message lifecycle events and drives two things:
 *
 *   - the live status panel (QUEUED -> PROCESSED -> ROUTED -> SENT ->
 *     DELIVERED -> READ, plus the channel Sent resolved)
 *   - the conversational loop, on `message.received`
 *
 * Sent's webhook payload shape is not published, so parsing here is
 * deliberately tolerant and every delivery is recorded verbatim — see
 * /api/messages?debug=1.
 */

/** Sent's opt-out keywords. It handles these itself; replying would be a violation. */
const OPT_OUT = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

function verifySignature(rawBody: string, request: Request): boolean {
  const secret = process.env.SENT_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook] SENT_WEBHOOK_SECRET is not set — skipping signature check");
    return true;
  }

  const provided =
    request.headers.get("x-sent-signature") ??
    request.headers.get("x-webhook-signature") ??
    request.headers.get("x-signature");
  if (!provided) return false;

  // Accept either encoding — Sent's is not documented.
  const candidates = (["hex", "base64"] as const).map((encoding) =>
    createHmac("sha256", secret).update(rawBody).digest(encoding),
  );
  // Some senders prefix the scheme, e.g. "sha256=abc123".
  const supplied = provided.startsWith("sha256=") ? provided.slice(7) : provided;

  return candidates.some((expected) => {
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

interface NormalizedEvent {
  event: string;
  status: string;
  messageId?: string;
  channel?: Channel;
  from?: string;
  body?: string;
}

function normalize(payload: Record<string, unknown>): NormalizedEvent {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = data[key] ?? payload[key];
      if (typeof value === "string" && value) return value;
    }
    return undefined;
  };

  const event = pick("event", "type", "event_type", "event_name") ?? "unknown";
  // "message.delivered" -> "DELIVERED"
  const status = pick("status") ?? event.split(".").pop()!.toUpperCase();

  return {
    event,
    status,
    messageId: pick("message_id", "messageId", "id"),
    channel: pick("channel") as Channel | undefined,
    from: pick("from", "phone_international", "format_e164", "phone", "to"),
    body: pick("body", "text", "message", "content"),
  };
}

/** Records an inbound message and has Claude answer it. */
async function handleInbound(conversation: Conversation, event: NormalizedEvent) {
  const body = (event.body ?? "").trim();
  const now = new Date().toISOString();

  conversation.messages.push({
    messageId: event.messageId ?? `inbound-${now}`,
    direction: "inbound",
    body,
    channel: event.channel ?? "sent",
    status: "RECEIVED",
    events: [{ status: "RECEIVED", at: now }],
    createdAt: now,
  });
  await saveConversation(conversation);

  // Sent handles STOP/START/HELP itself. Answering on top of that would send a
  // message to someone who just opted out.
  if (OPT_OUT.has(body.toUpperCase())) return;

  const draft = await draftFollowUp({
    name: conversation.name,
    inquiry: conversation.inquiry,
    history: conversation.messages
      .slice(0, -1)
      .map(({ direction, body }) => ({ direction, body })),
    inbound: body,
  });

  // Still no `channel` — the reply routes the same way the first message did.
  const result = await sendMessage({ to: [conversation.phone], text: draft.reply });
  const recipient = result.recipients[0];
  const sentAt = new Date().toISOString();

  const outbound: MessageRecord = {
    messageId: recipient.message_id,
    direction: "outbound",
    body: draft.reply,
    channel: recipient.channel,
    status: result.status,
    events: [{ status: result.status, at: sentAt }],
    createdAt: sentAt,
  };

  const latest = (await getConversation(conversation.phone)) ?? conversation;
  latest.messages.push(outbound);
  await saveConversation(latest);
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Keep the raw delivery so the exact field names can be read off live traffic.
  await recordWebhookSample({
    receivedAt: new Date().toISOString(),
    headers: Object.fromEntries(request.headers),
    payload,
  });

  const event = normalize(payload);

  try {
    if (event.event.endsWith("received")) {
      const conversation = event.from ? await getConversation(event.from) : null;
      if (conversation) await handleInbound(conversation, event);
      // An inbound from a number with no conversation is ignored on purpose —
      // this app only continues threads it started.
      return NextResponse.json({ ok: true });
    }

    // Everything else is a lifecycle update on a message we sent.
    if (!event.messageId) return NextResponse.json({ ok: true, ignored: "no message id" });

    const conversation = await findConversationByMessageId(event.messageId);
    if (!conversation) return NextResponse.json({ ok: true, ignored: "unknown message" });

    const message = conversation.messages.find((m) => m.messageId === event.messageId);
    if (!message) return NextResponse.json({ ok: true, ignored: "unknown message" });

    message.status = event.status;
    // The moment auto-detect becomes concrete: "sent" -> "sms" | "whatsapp".
    if (event.channel) message.channel = event.channel;
    if (!message.events.some((e) => e.status === event.status)) {
      message.events.push({ status: event.status, at: new Date().toISOString() });
    }
    await saveConversation(conversation);

    return NextResponse.json({ ok: true });
  } catch (error) {
    // Never 500 a webhook for an application-side failure — that invites retries.
    console.error("[webhook] handler failed", error);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
