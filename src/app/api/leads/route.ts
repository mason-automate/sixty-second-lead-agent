import { NextResponse } from "next/server";
import { draftFirstReply } from "@/lib/claude";
import { sendMessage } from "@/lib/sent";
import { saveConversation } from "@/lib/store";
import type { Conversation, MessageRecord } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Two ways to send the first message, and the choice is a real tradeoff:
 *
 *   "text"     — Claude's own words go out verbatim. WhatsApp only accepts
 *                free-form text inside the 24-hour customer service window,
 *                which opens when the contact messages you first. The demo
 *                pre-roll (every handset texts the sending number once) opens
 *                that window as a side effect, so this works while filming.
 *   "template" — Sends the Meta-approved `lead_response` template instead.
 *                Delivers to a cold contact on either channel, but the body is
 *                fixed, so only the name is personalized.
 */
const FIRST_MESSAGE_MODE = process.env.SENT_FIRST_MESSAGE_MODE ?? "text";
const TEMPLATE_NAME = process.env.SENT_TEMPLATE_NAME ?? "lead_response";

function toE164(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function POST(request: Request) {
  try {
    const { name, phone, message } = await request.json();
    if (!name || !phone) {
      return NextResponse.json({ error: "name and phone are required" }, { status: 400 });
    }

    const to = toE164(phone);
    const inquiry = String(message ?? "").trim();

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
      inquiry,
      createdAt: now,
      messages: [outbound],
    };
    await saveConversation(conversation);

    return NextResponse.json({ conversation, draft });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
