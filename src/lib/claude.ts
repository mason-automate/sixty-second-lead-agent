import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

/**
 * The drafting half of the agent: Claude writes the reply, Sent delivers it.
 *
 * Model choice is `claude-sonnet-5` — this is a short, latency-sensitive
 * drafting task and the whole premise is a reply inside 60 seconds. Thinking is
 * disabled and effort is `low` for the same reason: there is nothing here that
 * benefits from deliberation, and every extra second is visible on camera.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

const client = new Anthropic();

/**
 * The product knowledge, loaded once at startup.
 *
 * It is small enough (a few pages) to sit in the system prompt in full, so there
 * is no vector store, no chunking, and no retrieval step here. Retrieval would
 * only add a way for the model to miss a fact it already had. If this ever grows
 * past a few tens of thousands of tokens, revisit — not before.
 *
 * `next.config.ts` traces this file into the serverless bundle explicitly.
 */
const KNOWLEDGE_BASE = readFileSync(
  join(process.cwd(), "knowledge", "callneo.md"),
  "utf8",
);

/**
 * Replies go out over SMS as well as WhatsApp, so they inherit SMS's
 * constraints — and SMS compliance rules are not optional.
 */
const SYSTEM_PROMPT = `You write SMS and WhatsApp replies for CallNeo, an AI phone receptionist for service businesses.

You are texting someone who submitted the contact form at callneo.ai and opted in to text messages. Your goal is to answer what they asked, honestly and briefly, and move them toward booking a short call.

Hard rules, all of them non-negotiable:
- Length: if this is the first reply, 130 characters or fewer. Otherwise 150 or fewer. Shorter is better — these are text messages, not emails.
- Do NOT write an opt-out line. It is appended automatically after you, and writing your own would duplicate it.
- ASCII only. No em dashes, curly quotes, smart apostrophes, or ellipses — they silently switch the message to UCS-2 encoding, which halves the characters per SMS segment. Use - and '.
- Never use "YES" as a reply token you ask for. It is a registered opt-in keyword on this campaign and would trigger a duplicate confirmation text. Ask for a letter like R or D, or a time.
- Write like a person texting, not like marketing copy. No exclamation stacking, no emoji.
- One question per message at most. Never stack questions.

Answering product questions:
- Use ONLY the knowledge base below. If the answer is not in it, say you will cover it on the call. Never invent pricing, timelines, included volume, integrations, or capabilities — these messages go to real prospects, and a made-up number is a real problem.
- A short honest answer plus a next step beats a complete answer that does not fit.

Which message you are writing:
- If the conversation so far is only the lead's initial inquiry, this is the FIRST reply: say "CallNeo" by name.
- Otherwise you are continuing an existing conversation: do not reintroduce yourself.

Set intent to "booking" only when the person has proposed or accepted a specific time. When they have, put that time in bookingDate and bookingTime as short strings (for example "Tue Jul 30" and "2:15pm MT"); otherwise leave both as empty strings.

Nothing books the call automatically yet, so never claim it is scheduled. Do not say you have set it up, booked it, or put it on the calendar. Say a person will confirm the time. Recording the intent is your job; confirming it is a human's.

<knowledge_base>
${KNOWLEDGE_BASE}
</knowledge_base>`;

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "The message body to send. Under 160 characters, ASCII only.",
    },
    intent: {
      type: "string",
      enum: ["greeting", "question", "booking", "optout", "other"],
      description: "What this exchange is doing.",
    },
    bookingDate: {
      type: "string",
      description: 'Short date if intent is "booking", e.g. "Tue Jul 30". Empty string otherwise.',
    },
    bookingTime: {
      type: "string",
      description: 'Short time if intent is "booking", e.g. "2:15pm MT". Empty string otherwise.',
    },
  },
  required: ["reply", "intent", "bookingDate", "bookingTime"],
  additionalProperties: false,
} as const;

export interface Draft {
  reply: string;
  intent: "greeting" | "question" | "booking" | "optout" | "other";
  bookingDate: string;
  bookingTime: string;
}

/** One SMS segment in GSM-7. Past this the message splits and costs double. */
const MAX_LENGTH = 160;

/**
 * Appended in code, never written by the model.
 *
 * Two reasons. It is a compliance artifact, and compliance text should not
 * depend on a model remembering to include it. And because the suffix is added
 * afterwards, the body above it can be safely trimmed to fit — trimming a reply
 * the model wrote the opt-out into would silently drop it.
 */
const OPT_OUT_SUFFIX = " Reply STOP to opt out.";

/** Cuts to a budget at a sentence boundary if there is one, else a word boundary. */
function trimToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  if (sentenceEnd > budget * 0.6) return cut.slice(0, sentenceEnd + 1);
  return cut.replace(/\s+\S*$/, "").trim();
}

/**
 * Replaces the characters that silently switch an SMS from GSM-7 to UCS-2,
 * which cuts the segment size from 160 characters to 70. A single curly
 * apostrophe is enough to do it, and it is invisible in a text editor.
 */
function toGsmSafe(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .trim();
}

async function callClaude(messages: Anthropic.MessageParam[]): Promise<Draft> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    // Trivial drafting task on a latency budget — no reasoning needed.
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: REPLY_SCHEMA },
    },
    messages,
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to draft this reply");
  }

  const text = response.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Claude returned no text block");
  }
  return JSON.parse(text.text) as Draft;
}

/**
 * Draft, then enforce the length in code rather than trusting the prompt.
 *
 * Models cannot count characters — they see tokens. Asking for "under 160"
 * reliably produces 161-163, and asking a second time does not fix it. So the
 * prompt gets a comfortable target, and the hard guarantee lives here.
 */
async function draft(
  messages: Anthropic.MessageParam[],
  budget: number,
): Promise<Draft> {
  const result = await callClaude(messages);
  result.reply = toGsmSafe(result.reply);
  if (result.reply.length <= budget) return result;

  // One repair pass — a rewrite usually lands well under, and reads better
  // than a machine trim.
  const repaired = await callClaude([
    ...messages,
    { role: "assistant", content: result.reply },
    {
      role: "user",
      content: `That reply is ${result.reply.length} characters. The limit is ${budget}. Rewrite it to ${budget - 20} characters or fewer, keeping the meaning and the same intent and booking values.`,
    },
  ]);
  repaired.reply = toGsmSafe(repaired.reply);

  const best = repaired.reply.length <= result.reply.length ? repaired : result;
  if (best.reply.length > budget) {
    console.warn(`[claude] trimming reply from ${best.reply.length} to ${budget} chars`);
    best.reply = trimToBudget(best.reply, budget);
  }
  return best;
}

/**
 * The hero message: the reply that goes out seconds after the form submit.
 *
 * This is the only message that carries the opt-out line, which is appended
 * here rather than drafted — so it is always present and always intact.
 */
export async function draftFirstReply(lead: {
  name: string;
  inquiry: string;
}): Promise<Draft> {
  const result = await draft(
    [
      {
        role: "user",
        content: `New lead from the contact form.

Name: ${lead.name}
What they wrote: ${lead.inquiry}`,
      },
    ],
    MAX_LENGTH - OPT_OUT_SUFFIX.length,
  );

  // Belt and braces: strip an opt-out line if the model wrote one anyway.
  result.reply =
    result.reply.replace(/\s*reply\s+stop\b[^.!?]*[.!?]?\s*$/i, "").trim() +
    OPT_OUT_SUFFIX;
  return result;
}

/**
 * Continues the conversation after the lead texts back.
 *
 * The history is replayed as real alternating turns rather than flattened into
 * a transcript. The Claude API is stateless — it keeps nothing between calls —
 * so the whole conversation is re-sent every time. This is also the shape tool
 * calls require, since `tool_use` and `tool_result` blocks live in this array.
 */
export function draftFollowUp(params: {
  name: string;
  inquiry: string;
  history: Array<{ direction: "outbound" | "inbound"; body: string }>;
  inbound: string;
}): Promise<Draft> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `New lead from the contact form.

Name: ${params.name}
What they wrote: ${params.inquiry}`,
    },
  ];

  for (const message of params.history) {
    messages.push({
      // Our outbound messages are the assistant's prior turns; theirs are the user's.
      role: message.direction === "outbound" ? "assistant" : "user",
      content: message.body,
    });
  }

  messages.push({ role: "user", content: params.inbound });
  // No opt-out line mid-conversation — it goes on the first message only.
  return draft(messages, MAX_LENGTH - 10);
}
