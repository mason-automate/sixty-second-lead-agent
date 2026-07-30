import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  BOOKING_TIMEZONE,
  bookingEnabled,
  createBooking,
  describeSlots,
  getAvailability,
} from "@/lib/cal";
import { draftFollowUp } from "@/lib/claude";
import type { Draft } from "@/lib/claude";
import { sendMessage } from "@/lib/sent";
import {
  findConversationByMessageId,
  getConversation,
  recordWebhookSample,
  saveConversation,
} from "@/lib/store";
import { LIFECYCLE } from "@/lib/types";
import type { Channel, Conversation, Lifecycle, MessageRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Receives Sent's message events and drives two things:
 *
 *   - the live status panel (QUEUED -> PROCESSED -> ROUTED -> SENT ->
 *     DELIVERED -> READ, plus the channel Sent resolved)
 *   - the conversational loop, on `message.received`
 *
 * The payload shape below was captured from live deliveries via
 * `POST /v3/webhooks/{id}/test`, not from documentation:
 *
 *   {
 *     "field": "message",
 *     "event": "message.routed",          // absent on generic `message` tests
 *     "timestamp": "2026-07-29T02:12:24Z",
 *     "payload": {                        // note: `payload`, not `data`
 *       "message_id": "...",
 *       "message_status": "ROUTED",       // note: `message_status`, not `status`
 *       "channel": "sms",
 *       "outbound_number": "+1...",
 *       // inbound instead carries: inbound_number, text, received_at
 *     }
 *   }
 */

/** Sent's opt-out keywords. It handles these itself; replying would be a violation. */
const OPT_OUT = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

/** Reject deliveries older than this, so a captured request cannot be replayed. */
const MAX_SIGNATURE_AGE_SECONDS = 300;

/**
 * Sent signs webhooks with the Standard Webhooks scheme. It is not documented
 * anywhere I could find, so for the record — this was recovered by brute-forcing
 * a known-good delivery:
 *
 *   key       = base64-decode(signing secret with the "whsec_" prefix removed)
 *   content   = `{x-webhook-id}.{x-webhook-timestamp}.{raw request body}`
 *   signature = base64(HMAC-SHA256(key, content))
 *   header    = `x-webhook-signature: v1,<signature>`
 *
 * The body must be the raw bytes as received. Parsing and re-serialising the
 * JSON changes it and the digest will not match.
 */
function verifySignature(rawBody: string, request: Request): { ok: boolean; reason: string } {
  const secret = process.env.SENT_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook] SENT_WEBHOOK_SECRET is not set — skipping signature check");
    return { ok: true, reason: "unverified (no secret configured)" };
  }

  const header = request.headers.get("x-webhook-signature");
  const id = request.headers.get("x-webhook-id");
  const timestamp = request.headers.get("x-webhook-timestamp");
  if (!header || !id || !timestamp) return { ok: false, reason: "missing signature headers" };

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_SIGNATURE_AGE_SECONDS) {
    return { ok: false, reason: `timestamp outside replay window (${Math.round(age)}s)` };
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  // The header can carry several space-separated `v<n>,<signature>` entries.
  const matched = header.split(" ").some((part) => {
    const supplied = part.includes(",") ? part.slice(part.indexOf(",") + 1) : part;
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  });

  return matched ? { ok: true, reason: "verified" } : { ok: false, reason: "signature mismatch" };
}

interface NormalizedEvent {
  event: string;
  status: string;
  messageId?: string;
  channel?: Channel;
  text?: string;
  /** Both numbers, because which one is the contact depends on direction. */
  numbers: string[];
  isInbound: boolean;
}

function normalize(body: Record<string, unknown>): NormalizedEvent {
  const data = (body.payload ?? body.data ?? body) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

  const event = str(body.event) ?? str(body.field) ?? "unknown";
  const text = str(data.text) ?? str(data.body);
  const isInbound = event.endsWith("received") || Boolean(text && data.received_at);

  // Lifecycle events carry message_status; fall back to the event suffix.
  const status =
    str(data.message_status) ??
    str(data.status) ??
    (isInbound ? "RECEIVED" : event.split(".").pop()!.toUpperCase());

  return {
    event,
    status,
    messageId: str(data.message_id),
    channel: str(data.channel) as Channel | undefined,
    text,
    numbers: [
      str(data.inbound_number),
      str(data.outbound_number),
      str(data.from),
      str(data.phone_international),
    ].filter((n): n is string => Boolean(n)),
    isInbound,
  };
}

/**
 * Lifecycle webhooks do not arrive in order. A real WhatsApp delivery came in
 * as SENT -> READ -> DELIVERED, and last-write-wins left the headline status on
 * DELIVERED for a message the recipient had already read.
 *
 * So the displayed status only ever moves forward through LIFECYCLE. Anything
 * outside it (FAILED, BLOCKED, SCHEDULED) is not part of the happy path and
 * always wins — those must never be masked by a late in-order event.
 */
function advanceStatus(current: string, incoming: string): string {
  const rank = (s: string) => LIFECYCLE.indexOf(s.toUpperCase() as Lifecycle);
  const [a, b] = [rank(current), rank(incoming)];
  if (b === -1 || a === -1) return incoming;
  return b > a ? incoming : current;
}

/**
 * Inbound events carry both numbers and the synthetic payloads use them
 * inconsistently, so rather than guess which field holds the contact, try each
 * against the store and take whichever names a conversation we started.
 */
async function findConversationByNumber(numbers: string[]): Promise<Conversation | null> {
  // Sent sends numbers as bare digits ("18018223533") while conversations are
  // keyed on E.164 ("+18018223533"), so the raw value never matches. Lifecycle
  // events hid this because they are looked up by message_id instead — only an
  // actual inbound reply exercises this path.
  const candidates = numbers.flatMap((number) => {
    const digits = number.replace(/\D/g, "");
    return [number, `+${digits}`, digits];
  });

  for (const candidate of new Set(candidates)) {
    const conversation = await getConversation(candidate);
    if (conversation) return conversation;
  }
  return null;
}

/**
 * Books the call when the lead accepted a slot, then sends the Meta-approved
 * `booking_confirmation` template.
 *
 * Three guards, each protecting against a different failure:
 *
 *  - `conversation.booking` — Sent retries webhooks, and a retry must not put a
 *    second call on the calendar. Presence of the record is the idempotency key.
 *  - slot must be one we just offered — the model returns an opaque identifier,
 *    so a hallucinated or reformatted value fails the lookup instead of
 *    booking a time nobody agreed to.
 *  - an email must exist — Cal.com requires an attendee email.
 *
 * A failure never breaks the reply. The lead still gets the message; it just
 * says a person will confirm, which is the honest outcome when booking failed.
 */
async function maybeBook(
  conversation: Conversation,
  draft: Draft,
  slots: Array<{ label: string; value: string }>,
): Promise<void> {
  if (!draft.bookingSlot || conversation.booking || !bookingEnabled()) return;

  if (!slots.some((s) => s.value === draft.bookingSlot)) {
    console.warn(`[booking] ignoring slot not offered this turn: ${draft.bookingSlot}`);
    return;
  }
  if (!conversation.email) {
    console.warn(`[booking] no email on ${conversation.phone} — cannot book`);
    return;
  }

  try {
    const booking = await createBooking({
      start: draft.bookingSlot,
      name: conversation.name,
      email: conversation.email,
      phone: conversation.phone,
    });

    conversation.booking = {
      uid: booking.uid,
      start: booking.start ?? draft.bookingSlot,
      bookedAt: new Date().toISOString(),
    };
    await saveConversation(conversation);

    // The approved template, whose {{name}}/{{date}}/{{time}} exist for exactly
    // this. Sent as a template rather than free-form so a confirmation still
    // lands if the session window has closed by the time the call is booked.
    const when = new Date(conversation.booking.start);
    const fmt = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { ...opts, timeZone: BOOKING_TIMEZONE }).format(when);

    const confirmation = await sendMessage({
      to: [conversation.phone],
      template: {
        name: process.env.SENT_BOOKING_TEMPLATE ?? "booking_confirmation",
        parameters: {
          name: conversation.name,
          date: fmt({ weekday: "short", month: "short", day: "numeric" }),
          time: fmt({ hour: "numeric", minute: "2-digit" }),
        },
      },
    });

    // Recorded like any other send. The panel is the only view of what the
    // handset received, so a message missing from it is a message we cannot
    // account for — and its lifecycle webhooks would find no message to update.
    const recipient = confirmation.recipients[0];
    conversation.messages.push({
      messageId: recipient.message_id,
      direction: "outbound",
      body: recipient.body ?? "Booking confirmation",
      channel: recipient.channel,
      status: confirmation.status,
      events: [{ status: confirmation.status, at: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    });
    await saveConversation(conversation);
  } catch (error) {
    // Deliberately swallowed: the lead's reply still goes out. Booking is the
    // bonus, the reply is the product.
    console.error("[booking] failed", error);
  }
}

/** Records an inbound message and has Claude answer it. */
async function handleInbound(conversation: Conversation, event: NormalizedEvent) {
  const body = (event.text ?? "").trim();
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

  // Real open slots, fetched before drafting so the model can only offer times
  // that exist. A failure here degrades to "no times listed", which the prompt
  // handles by promising a human follow-up — never a booking we can't make.
  let slots: Array<{ label: string; value: string }> = [];
  if (bookingEnabled() && !conversation.booking) {
    try {
      slots = describeSlots(await getAvailability());
    } catch (error) {
      console.warn("[booking] availability lookup failed", error);
    }
  }

  const draft = await draftFollowUp({
    name: conversation.name,
    inquiry: conversation.inquiry,
    history: conversation.messages
      .slice(0, -1)
      .map(({ direction, body }) => ({ direction, body })),
    inbound: body,
    slots,
  });

  await maybeBook(conversation, draft, slots);

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
  const verification = verifySignature(rawBody, request);

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Keep the raw delivery so the contract can be read off live traffic. rawBody
  // is kept verbatim because signature verification is byte-sensitive — a
  // re-serialized payload will not reproduce the sender's digest.
  await recordWebhookSample({
    receivedAt: new Date().toISOString(),
    signature: verification,
    headers: Object.fromEntries(request.headers),
    rawBody,
    payload,
  });

  if (!verification.ok) {
    // Rejecting an unverified delivery is the correct default. It is worth
    // being able to turn off: rejecting also stops the traffic you need in
    // order to work out an undocumented signing scheme in the first place.
    if (process.env.SENT_WEBHOOK_ENFORCE !== "false") {
      console.warn(`[webhook] rejected: ${verification.reason}`);
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
    console.warn(`[webhook] UNVERIFIED, processing anyway: ${verification.reason}`);
  }

  const event = normalize(payload);

  try {
    if (event.isInbound) {
      const conversation = await findConversationByNumber(event.numbers);
      // An inbound from a number with no conversation is ignored on purpose —
      // this app only continues threads it started. Logged rather than passed
      // over in silence, because "the reply did nothing" is indistinguishable
      // from "the webhook never arrived" without it.
      if (!conversation) {
        console.warn(`[webhook] inbound from ${event.numbers.join("/")} matched no conversation`);
        return NextResponse.json({ ok: true, ignored: "no conversation for number" });
      }
      await handleInbound(conversation, event);
      return NextResponse.json({ ok: true });
    }

    // Everything else is a lifecycle update on a message we sent.
    if (!event.messageId) return NextResponse.json({ ok: true, ignored: "no message id" });

    const conversation = await findConversationByMessageId(event.messageId);
    if (!conversation) return NextResponse.json({ ok: true, ignored: "unknown message" });

    const message = conversation.messages.find((m) => m.messageId === event.messageId);
    if (!message) return NextResponse.json({ ok: true, ignored: "unknown message" });

    message.status = advanceStatus(message.status, event.status);
    // The moment auto-detect becomes concrete: "sent" -> "sms" | "whatsapp".
    if (event.channel) message.channel = event.channel;
    if (!message.events.some((e) => e.status === event.status)) {
      message.events.push({ status: event.status, at: new Date().toISOString() });
    }
    await saveConversation(conversation);

    return NextResponse.json({ ok: true });
  } catch (error) {
    // Never 500 a webhook for an application-side failure — a non-2xx
    // permanently kills the webhook on Sent's side.
    //
    // The reason is echoed into the response body because Sent stores it on
    // the delivery record: `GET /v3/webhooks/{id}/events` then shows exactly
    // why a handler failed. Without it the only symptom is a bare
    // `{"ok":false}` and no way to tell a Claude failure from a send failure.
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[webhook] handler failed", error);
    return NextResponse.json({ ok: false, error: detail }, { status: 200 });
  }
}
