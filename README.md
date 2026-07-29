# 60-Second Lead Agent

An AI agent that texts every lead back in 60 seconds — on whatever app they actually use.

A lead submits a form. Claude drafts a personal reply. The app makes **one** API call to [Sent](https://sent.dm) with **no `channel` field**, and Sent decides per contact whether that goes out as an SMS or a WhatsApp message. A live panel shows the delivery lifecycle as webhooks land: `QUEUED → PROCESSED → ROUTED → SENT → DELIVERED → READ`.

When the lead texts back, Claude keeps the conversation going and books the call.

---

## The idea

Most "speed to lead" tools are SMS-only. That is a problem, because the channel someone actually reads is not your choice to make — it is theirs.

Sent is channel-agnostic messaging infrastructure. You send a message; Sent handles routing, per-channel formatting, fallbacks, and compliance after the send. The interesting line in this whole repo is the one that *isn't* there:

```ts
// src/lib/sent.ts
await sendMessage({ to: ["+18015550100"], text: draft.reply });
//   ^ no `channel` — that omission is Sent's auto-detect mode
```

Passing an explicit `channel: ["sms", "whatsapp"]` array is a different feature: a **broadcast**, one independent message per channel. Omitting it entirely is what makes Sent pick.

## How it works

```text
  lead form
      │
      ▼
  POST /api/leads ──► Claude drafts the reply (claude-sonnet-5)
      │
      ▼
  POST https://api.sent.dm/v3/messages     ← one call, no channel field
      │
      ├──► contact A resolves to sms       ──► delivered
      └──► contact B resolves to whatsapp  ──► delivered ──► read
      │
      ▼
  POST /api/webhooks/sent  ← lifecycle events land here
      │
      ▼
  GET /api/messages  ← the panel polls this (~1s)
```

| Route | Job |
| --- | --- |
| `/` | Lead form and the live status panel |
| `POST /api/leads` | Draft with Claude, send via Sent, persist the message id |
| `POST /api/webhooks/sent` | Receive lifecycle events and inbound replies |
| `GET /api/messages` | What the panel polls. `?debug=1` returns the last raw webhook |

## Run it

```bash
git clone https://github.com/<you>/sixty-second-lead-agent
cd sixty-second-lead-agent
npm install
cp .env.example .env.local   # add SENT_API_KEY and ANTHROPIC_API_KEY
npm run dev
```

That is enough to draft and send. Storage falls back to an in-memory map, so the panel works locally with no database.

To check the drafting side on its own — no Sent call, nothing reaches a phone:

```bash
npm run draft
```

It drafts a first reply and a follow-up, then checks both against the rules that actually bite: length, GSM-7 safety, and the `YES` keyword collision below.

To receive delivery events you need a public URL. Deploy to Vercel, add an [Upstash Redis](https://upstash.com) database (free tier; serverless functions are stateless, so the webhook receiver and the panel cannot share memory), then register the endpoint:

```bash
node scripts/register-webhook.mjs https://your-app.vercel.app test
```

The trailing `test` fires synthetic events at your endpoint, so you can build and rehearse the panel before sending anything real.

## The knowledge base, and why there's no vector database

The agent answers product questions from [`knowledge/callneo.md`](knowledge/callneo.md), which is loaded into the system prompt in full on every call.

No embeddings, no chunking, no retrieval step. That is a deliberate choice, not a shortcut. Retrieval exists to solve one problem — content too large for the context window — and a single product's FAQ is a few pages against a 1M-token window. Adding retrieval here would introduce a failure mode that full context does not have: a chunk that scores badly does not get retrieved, and the model then answers confidently without the fact it needed. Everything in context means it always has everything.

The rule that makes it safe is in the system prompt: **if the answer is not in the knowledge base, offer the call — never invent it.** These messages go to real prospects, so a fabricated price or integration is a business problem, not a bug. Editing the markdown file is how you change what the agent is allowed to say.

## Things worth knowing

Learned the hard way against the live API:

- **The send response does not contain the resolved channel.** `POST /v3/messages` returns `channel: "sent"` for every recipient — that is the auto-detect placeholder. The real `sms`/`whatsapp` value arrives later, on the `message.routed` webhook. The panel is where you see routing happen, not the send response.
- **There is no message list endpoint.** `GET /v3/messages` returns 405. You can only fetch a message whose id you already hold, which is why the webhook receiver and its storage are load-bearing rather than decorative.
- **Cloudflare fronts the API and blocks unusual User-Agents** with HTTP 403 and the body `error code: 1010`. That reads exactly like an auth failure. Set an explicit `User-Agent` on server-side requests.
- **WhatsApp needs the 24-hour window open for free-form text.** Business-initiated messages outside that window need an approved template. Set `SENT_FIRST_MESSAGE_MODE=template` for cold contacts.
- **Reply keywords matter.** `YES` is a registered opt-in keyword on a 10DLC campaign, so asking a lead to "reply YES" also triggers the carrier opt-in confirmation — a duplicate message. Ask for a letter instead.
- **ASCII only.** A single em dash or curly apostrophe flips an SMS from GSM-7 to UCS-2, cutting the segment size from 160 characters to 70.

## Stack

- [Next.js](https://nextjs.org) App Router on Vercel, with polling — deliberately boring
- [Sent](https://sent.dm) for SMS and WhatsApp delivery — [github.com/sentdm](https://github.com/sentdm)
- [Claude](https://platform.claude.com) (`claude-sonnet-5`) for drafting
- [Upstash Redis](https://upstash.com) for state, optional in development

## License

MIT
