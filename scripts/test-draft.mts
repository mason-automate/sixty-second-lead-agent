/**
 * Drafts replies and checks them against the SMS rules — without calling Sent,
 * so nothing reaches a real phone.
 *
 *   npm run draft
 *
 * Useful for confirming your ANTHROPIC_API_KEY works, and for seeing whether a
 * system-prompt or knowledge-base change still produces compliant messages.
 * Requires Node 22.6+ for TypeScript type stripping.
 */
import { draftFirstReply, draftFollowUp } from "../src/lib/claude.ts";

interface Draft {
  reply: string;
  intent: string;
  bookingDate: string;
  bookingTime: string;
  bookingSlot: string;
}

function check(label: string, draft: Draft, ms: number, expect?: (d: Draft) => string | null) {
  const problems: string[] = [];
  if (draft.reply.length > 160) problems.push(`${draft.reply.length} chars — OVER 160`);
  if (!/^[\x20-\x7E]*$/.test(draft.reply)) problems.push("non-ASCII — would flip SMS to UCS-2");
  if (/\bYES\b/.test(draft.reply)) problems.push("contains 'YES' — opt-in keyword collision");
  const extra = expect?.(draft);
  if (extra) problems.push(extra);

  console.log(`\n--- ${label} (${ms}ms) ---`);
  console.log(`reply  : ${draft.reply}`);
  console.log(`meta   : intent=${draft.intent} booking="${draft.bookingDate}" "${draft.bookingTime}"`);
  console.log(`length : ${draft.reply.length}`);
  console.log(problems.length ? `FAIL   : ${problems.join("; ")}` : "PASS   : all checks");
  return problems.length === 0;
}

const lead = {
  name: "Jordan Reyes",
  inquiry: "We miss a lot of calls after hours and I want to stop losing those jobs.",
};

let failures = 0;
const time = async (fn: () => Promise<Draft>) => {
  const t = Date.now();
  return [await fn(), Date.now() - t] as const;
};

// 1. The hero message.
const [first, t1] = await time(() => draftFirstReply(lead));
if (!check("first reply", first, t1, (d) =>
  /callneo/i.test(d.reply) ? null : "first message must name CallNeo",
)) failures++;

// 2. A question the knowledge base CAN answer — $95/month is in the file.
const [priced, t2] = await time(() =>
  draftFollowUp({
    ...lead,
    history: [{ direction: "outbound", body: first.reply }],
    inbound: "How much does this cost?",
  }),
);
if (!check("pricing question (KB has the answer)", priced, t2, (d) =>
  /95/.test(d.reply) ? null : "should quote the $95 figure from the knowledge base",
)) failures++;

// 3. A question the knowledge base CANNOT answer. This is the important one:
//    the agent must deflect to the call rather than invent an integration.
const [unknown, t3] = await time(() =>
  draftFollowUp({
    ...lead,
    history: [{ direction: "outbound", body: first.reply }],
    inbound: "Does it integrate with ServiceTitan and push jobs into our dispatch board?",
  }),
);
if (!check("unknown detail (KB must NOT invent)", unknown, t3, (d) =>
  // It should hedge and route to the call rather than assert ServiceTitan support.
  /\b(call|confirm|check|specifics|not sure|find out|discuss|walk)\b/i.test(d.reply)
    ? null
    : "should deflect to the call rather than assert an integration that is not in the KB",
)) failures++;

// 3b. Higher-tier pricing. Mason's rule: name the features, never the price —
//     tier pricing depends on call volume and belongs on the discovery call.
const [tier, t3b] = await time(() =>
  draftFollowUp({
    ...lead,
    history: [{ direction: "outbound", body: first.reply }],
    inbound: "What does the next tier up cost? I want the CRM integration.",
  }),
);
if (!check("higher-tier pricing (must NOT quote a price)", tier, t3b, (d) => {
  const quoted = (d.reply.match(/\$\s?\d[\d,.]*/g) ?? []).filter((a) => !/95/.test(a));
  return quoted.length ? `quoted a higher-tier price: ${quoted.join(", ")}` : null;
})) failures++;

// 4. Booking intent + time extraction.
const [booking, t4] = await time(() =>
  draftFollowUp({
    ...lead,
    history: [{ direction: "outbound", body: first.reply }],
    inbound: "Thursday at 2pm works for me.",
  }),
);
if (!check("booking", booking, t4, (d) =>
  d.intent === "booking" && d.bookingDate && d.bookingTime
    ? null
    : `expected intent=booking with date+time, got intent=${d.intent}`,
)) failures++;

// 5. With real slots offered, the accepted one must come back as an exact,
//    unmodified value — the app books that string, so any tidying is a bug.
const SLOTS = [
  { label: "Thu, Jul 30, 10:00 AM", value: "2026-07-30T16:00:00.000Z" },
  { label: "Thu, Jul 30, 2:00 PM", value: "2026-07-30T20:00:00.000Z" },
  { label: "Fri, Jul 31, 9:00 AM", value: "2026-07-31T15:00:00.000Z" },
];
const [slotted, t5] = await time(() =>
  draftFollowUp({
    ...lead,
    history: [{ direction: "outbound", body: first.reply }],
    inbound: "Thursday at 2pm works for me.",
    slots: SLOTS,
  }),
);
if (!check("booking picks an exact offered slot", slotted, t5, (d) =>
  d.bookingSlot === "2026-07-30T20:00:00.000Z"
    ? null
    : `expected the 2pm slot value verbatim, got ${JSON.stringify(d.bookingSlot)}`,
)) failures++;

// 6. A time that is not open must not be booked. The model should say so and
//    counter-offer — inventing a slot here would book a call nobody can attend.
const [unavailable, t6] = await time(() =>
  draftFollowUp({
    ...lead,
    history: [{ direction: "outbound", body: first.reply }],
    inbound: "Can we do Saturday at 6am?",
    slots: SLOTS,
  }),
);
if (!check("declines a time that is not open", unavailable, t6, (d) =>
  d.bookingSlot === "" || SLOTS.some((s) => s.value === d.bookingSlot)
    ? null
    : `invented a slot that was never offered: ${d.bookingSlot}`,
)) failures++;

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
