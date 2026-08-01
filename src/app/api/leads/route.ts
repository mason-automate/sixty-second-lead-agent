import { NextResponse } from "next/server";
import { draftFirstReply } from "@/lib/claude";
import {
  checkOrigin,
  checkRateLimits,
  clientIp,
  corsHeaders,
  validatePhone,
  validateText,
} from "@/lib/guards";
import { sendMessage } from "@/lib/sent";
import { saveConversation } from "@/lib/store";
import type { Conversation, MessageRecord } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Two ways to send the first message. Only one of them works for a new lead.
 *
 *   "template" — sends the approved `lead_response` template. The default, and
 *                the only mode that reaches a contact you have not heard from.
 *                The body is fixed, so only the name is personalized.
 *   "text"     — sends Claude's own words verbatim. Valid ONLY once the contact
 *                has messaged you, which opens the session window.
 *
 * Messaging platforms separate business-initiated messages from replies inside
 * an open conversation, and this applies on SMS as well as WhatsApp. A cold
 * free-form send is rejected — but the API returns success and QUEUED, and the
 * message fails roughly 37ms later with no reason exposed anywhere, so "text"
 * looks like it works right up until nothing arrives.
 *
 * The conversation satisfies the rule on its own: template first, the lead's
 * reply opens the window, and every message after that is free-form (see
 * handleInbound in the webhook route). Leave this alone.
 */
const FIRST_MESSAGE_MODE = process.env.SENT_FIRST_MESSAGE_MODE ?? "template";
const TEMPLATE_NAME = process.env.SENT_TEMPLATE_NAME ?? "lead_response";

function toE164(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** Preflight. A JSON body makes the browser ask before it will POST here. */
export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request) {
  const cors = corsHeaders(request);
  const reply = (body: unknown, status: number) =>
    NextResponse.json(body, { status, headers: cors });

  try {
    const originFailure = checkOrigin(request);
    if (originFailure) {
      return reply({ error: originFailure.error }, originFailure.status);
    }

    const { name, phone, email, message } = await request.json();
    if (!name || !phone) {
      return reply({ error: "name and phone are required" }, 400);
    }

    const to = toE164(phone);
    const inquiry = String(message ?? "").trim();

    // Everything that can reject the request runs before Claude is called and
    // before anything is sent — a rejected lead should cost neither a token nor
    // a message.
    const failure =
      validatePhone(to) ??
      validateText(String(name), inquiry) ??
      (await checkRateLimits(clientIp(request), to));
    if (failure) {
      return reply({ error: failure.error }, failure.status);
    }

    // 1. Claude drafts the reply.
    const draft = await draftFirstReply({ name, inquiry });

    // 2. Sent delivers it. Note there is no `channel` here — that omission is
    //    the whole point. One call, and Sent picks SMS or WhatsApp per contact.
    const result =
      FIRST_MESSAGE_MODE === "template"
        ? await sendMessage({ to: [to], template: { name: TEMPLATE_NAME, parameters: { name } } })
        : await sendMessage({ to: [to], text: draft.reply });

    const recipient = result.recipients[0];
    const now = new Date().toISOString();

    const outbound: MessageRecord = {
      messageId: recipient.message_id,
      direction: "outbound",
      // What Sent actually put on the wire, which in template mode is the
      // approved template body, NOT Claude's draft. Showing the draft here
      // would put text on the panel that the handset never received.
      body: recipient.body ?? draft.reply,
      // "sent" — unresolved. The webhook rewrites this once Sent routes it.
      channel: recipient.channel,
      status: result.status,
      events: [{ status: result.status, at: now }],
      createdAt: now,
    };

    const conversation: Conversation = {
      phone: to,
      name,
      // Optional on the form, required by Cal.com — without it the agent can
      // still converse, it just cannot put the call on the calendar.
      ...(typeof email === "string" && email.trim() ? { email: email.trim() } : {}),
      inquiry,
      createdAt: now,
      messages: [outbound],
    };
    await saveConversation(conversation);

    return reply({ conversation, draft }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return reply({ error: detail }, 500);
  }
}
