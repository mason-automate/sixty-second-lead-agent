# 60-Second Lead Agent

An AI agent that texts every lead back in 60 seconds — on whatever app they actually use.

A lead submits a form. Claude drafts a personal reply. The app makes **one** API call to [Sent](https://www.sent.dm/en?utm_source=masonanderson&utm_medium=x&utm_campaign=partner) with **no `channel` field**, and Sent decides per contact whether that goes out as an SMS or a WhatsApp message. A live panel shows the delivery lifecycle as webhooks land: `QUEUED → PROCESSED → ROUTED → SENT → DELIVERED → READ`.

When the lead texts back, Claude keeps the conversation going, offers times that are genuinely open on your calendar, and books the call.

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
  POST /api/webhooks/sent  ← lifecycle events and inbound replies land here
      │                      inbound reply ──► Claude answers ──► books on Cal.com
      ▼
  GET /api/messages  ← the panel polls this (~1s)
```

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

---

## Try the drafting half in two minutes

You do not need a phone number, a Sent account, or any messaging setup to see the agent work. This drafts replies and checks them against the SMS rules without sending anything:

```bash
git clone https://github.com/mason-automate/sixty-second-lead-agent
cd sixty-second-lead-agent
npm install
cp .env.example .env.local     # fill in ANTHROPIC_API_KEY only
npm run draft
```

You will see six drafts with pass/fail checks on length, ASCII safety, keyword collisions, and whether the agent invents facts it was never given. Get an Anthropic key at [platform.claude.com](https://platform.claude.com).

Sending real messages needs the setup below.

---

## What you need before you can send

Messaging is regulated infrastructure, and most of the setup time is other people approving things. Start these early — the code is the fast part.

| | What | How long |
| --- | --- | --- |
| **Required** | [Sent](https://www.sent.dm/en?utm_source=masonanderson&utm_medium=x&utm_campaign=partner) account and API key | minutes |
| **Required** | A sending number. For US SMS this means 10DLC/TCR registration — you complete a compliance form in the Sent dashboard and they register the campaign for you. **Sent assigns the number when the campaign is approved**; there is no separate provisioning step. | 1–3 business days (ours took 4 calendar days) |
| **Required** | Two approved message templates (below) | Meta review, often same day |
| **Required** | [Anthropic API key](https://platform.claude.com) | minutes |
| **Required** | Node 22.6 or newer | — |
| For the WhatsApp leg | A WhatsApp Business Account connected to Sent. The same number then serves both SMS and WhatsApp. Without it, everything simply routes to SMS and the app still works. | ~1 day, plus Meta Business Verification if you have not done it |
| For production | A public URL (Vercel) and an [Upstash Redis](https://upstash.com) database | minutes |
| Optional | A [Cal.com](https://cal.com) account, to book calls | minutes |

10DLC registration wants a live website with a privacy policy, messaging terms, and a visible opt-in — a form with an unchecked SMS consent checkbox that is not required to submit. Have that ready before you fill in the form.

---

## Setup

### 1. Install

```bash
git clone https://github.com/mason-automate/sixty-second-lead-agent
cd sixty-second-lead-agent
npm install
cp .env.example .env.local
```

`.env.example` documents every variable and why it exists. Read it — several of them prevent failures that are otherwise silent.

### 2. Create the two templates in Sent

**This step is not optional, and skipping it is the single most common way to get stuck.** The first message to a lead is business-initiated, and business-initiated messages must use an approved template. A free-form send to someone who has never messaged you returns `success: true` and `QUEUED`, then fails about 37 milliseconds later with no reason given anywhere — so it looks like it worked right up until nothing arrives.

Create these in the Sent dashboard (or `POST /v3/templates`), then **submit each one for review** — new templates are created as drafts and cannot send until reviewed. If a WhatsApp Business Account is connected, Meta reviews them; an approval applies to every channel, and a rejection blocks only WhatsApp.

| Name | Variables | Example body |
| --- | --- | --- |
| `lead_response` | `name` | `Hi {{name}}, this is Acme. Thanks for reaching out! Want a quick call, or should I send details by text? Reply STOP to opt out.` |
| `booking_confirmation` | `name`, `date`, `time` | `Hi {{name}}, your Acme call is set for {{date}} at {{time}}. Reply R to reschedule or STOP to opt out.` |

Swap in your own brand name and wording. The names are what the app looks up, and both are configurable via `SENT_TEMPLATE_NAME` and `SENT_BOOKING_TEMPLATE`.

Rules that will get a template rejected or make it cost double:

- **ASCII only.** One em dash, curly quote, or ellipsis flips the message from GSM-7 to UCS-2 encoding, which cuts an SMS segment from 160 characters to 70. Use `-` and `'`.
- **Stay under 160 characters with the variables expanded**, not as written.
- **Never ask someone to "reply YES."** `YES` is a registered opt-in keyword on a 10DLC campaign, so it triggers the carrier's opt-in confirmation as well as your reply. Ask for a letter like `R`, or a time.
- **Name your brand in the first message.** Required for SMS compliance.
- Sent also enforces two undocumented rules at creation: a template needs at least one letter before the first variable and after the last, and at least `(2 × variables) + 1` words.

### 3. Fill in the environment

At minimum:

```bash
SENT_API_KEY=            # Sent dashboard -> API keys
ANTHROPIC_API_KEY=       # platform.claude.com
SENT_FIRST_MESSAGE_MODE=template
SENT_TEMPLATE_NAME=lead_response
```

### 4. Run it

```bash
npm run dev
```

Open <http://localhost:3000> and submit the form with your own phone number. The message sends for real. Storage falls back to an in-memory map, so the panel works locally with no database — but **delivery events will not arrive yet**, because Sent needs a public URL to reach. That is step 6.

### 5. Deploy

Any host that runs Next.js works; this was built on Vercel.

```bash
npx vercel deploy --prod
```

Add an [Upstash Redis](https://upstash.com) database and set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. This is not optional in production: serverless functions are stateless, so the webhook receiver and the status panel run in different invocations and cannot share memory. Vercel's Upstash integration injects `KV_REST_API_*` aliases, which the app also reads.

Set every variable from `.env.local` in your host's environment, plus `ALLOWED_ORIGINS` (see below).

### 6. Register the webhook

This is what makes the status panel move and the conversation loop run.

```bash
npm run webhook https://your-app.vercel.app
```

It prints a `signing_secret` starting with `whsec_`. **Save it as `SENT_WEBHOOK_SECRET`** and redeploy — the receiver rejects unsigned deliveries once a secret is set, and skips verification with a warning when it is not.

To fire synthetic events and see the payload shape against your own endpoint:

```bash
npm run webhook https://your-app.vercel.app test
```

Then check `https://your-app.vercel.app/api/messages?debug=1`, which returns the most recent raw delivery.

Two things about Sent's webhooks that are worth knowing before they bite:

- **The test endpoint only works for about two minutes after the webhook is created.** After that it fails with no HTTP attempt logged at all. Do not debug this as a problem with your code — `GET /v3/webhooks/{id}/events` is the authoritative delivery log.
- **A single non-2xx response permanently stops a webhook from dispatching**, while it continues to report `is_active: true` and `consecutive_failures: 0`. If events stop arriving after a bad deploy, delete the webhook and register a new one.

### 7. Cal.com booking (optional)

Leave `CAL_API_KEY` empty and booking stays off — the agent still converses and still records the time the lead asked for, it just says a person will confirm instead of putting anything on a calendar.

To turn it on, set `CAL_API_KEY`, `CAL_EVENT_TYPE_ID` (the numeric id of the event type to book), and `CAL_TIMEZONE`. Real availability is fetched *before* Claude drafts and injected into the prompt, so the agent can only ever offer times that are actually free.

---

## How it fits together

| Route | Job |
| --- | --- |
| `/` | Lead form and the live status panel |
| `POST /api/leads` | Validate, rate limit, draft with Claude, send via Sent, persist the message id |
| `POST /api/webhooks/sent` | Receive lifecycle events and inbound replies; drive the conversation and booking |
| `GET /api/messages` | What the panel polls. `?debug=1` returns the last raw webhook |

| File | Job |
| --- | --- |
| `src/lib/sent.ts` | The Sent client. The `channel` omission lives here |
| `src/lib/claude.ts` | System prompt, reply schema, length and encoding enforcement |
| `src/lib/cal.ts` | Availability and booking |
| `src/lib/guards.ts` | Rate limits, origin checks, validation |
| `src/lib/store.ts` | Redis in production, in-memory map locally |
| `knowledge/callneo.md` | Everything the agent is allowed to say. **Replace this** |

---

## Making it yours

**Replace `knowledge/callneo.md`.** It describes CallNeo, an AI phone receptionist — the product this was built for. Clone this as-is and you will have an agent that pitches someone else's product. The file is loaded into the system prompt in full on every call, so editing the markdown is how you change what the agent knows and is allowed to say.

**Reconcile the reserved keywords with your own campaign.** `src/app/api/webhooks/sent/route.ts` keeps a `RESERVED_KEYWORDS` list that the agent stays silent on, because Sent answers those itself with your registered compliance text. This one matters: it was found the hard way when texting `HELP` got back a reply about open appointment times instead of the required help message. `YES` is the quiet one — it is a registered opt-in keyword, so a lead answering "yes" to a question would otherwise get both an AI reply and a carrier opt-in confirmation. Your campaign's registered keywords may differ from the defaults here, and drift between the two is silent.

**Set your abuse guards.** `POST /api/leads` is public, unauthenticated, and sends a real SMS on a registered number the moment it is called — and this repo is public, so the endpoint is effectively documented. Three limits ship on by default, all configurable:

| Variable | Default | What it stops |
| --- | --- | --- |
| `LEADS_MAX_PER_IP` | 5 per hour | Someone hammering the form |
| `LEADS_MAX_PER_NUMBER` | 3 per day | The endpoint being used to text a stranger repeatedly |
| `LEADS_MAX_PER_DAY` | 50 per day | The worst case, however it is distributed |
| `ALLOWED_ORIGINS` | unset (any) | The deployed form being embedded and driven from another site |

Counters increment on *attempt*, not on success, so a caller cannot retry past a limit by making the send fail. Set `ALLOWED_ORIGINS` to a comma-separated list once you have a domain. Requests with no `Origin` header at all — a curl call, or a server-side form relay — are always allowed and bounded by the rate limits instead.

**Keep the consent checkbox.** It is unchecked by default and required to submit, which is what a carrier expects to see. Texting someone who did not ask for it is how campaigns get suspended.

---

## The knowledge base, and why there's no vector database

The agent answers product questions from [`knowledge/callneo.md`](knowledge/callneo.md), which is loaded into the system prompt in full on every call.

No embeddings, no chunking, no retrieval step. That is a deliberate choice, not a shortcut. Retrieval exists to solve one problem — content too large for the context window — and a single product's FAQ is a few pages against a 1M-token window. Adding retrieval here would introduce a failure mode that full context does not have: a chunk that scores badly does not get retrieved, and the model then answers confidently without the fact it needed. Everything in context means it always has everything.

The rule that makes it safe is in the system prompt: **if the answer is not in the knowledge base, offer the call — never invent it.** These messages go to real prospects, so a fabricated price or integration is a business problem, not a bug.

---

## Things worth knowing

Learned the hard way against the live API:

- **The first message must be an approved template.** Free-form text is only accepted once the contact has messaged you, which opens a session window. A cold free-form send returns success and then fails asynchronously with no reason exposed anywhere. `SENT_FIRST_MESSAGE_MODE=template` is the correct production setting — the flow satisfies the rule by itself, since the lead's reply opens the window and every message after that is free-form.
- **The send response does not contain the resolved channel.** `POST /v3/messages` returns `channel: "sent"` for every recipient — that is the auto-detect placeholder. The real `sms`/`whatsapp` value arrives later, on the `message.routed` webhook. The panel is where you see routing happen, not the send response.
- **There is no message list endpoint.** `GET /v3/messages` returns 405. You can only fetch a message whose id you already hold, which is why the webhook receiver and its storage are load-bearing rather than decorative.
- **Lifecycle events arrive out of order.** A real WhatsApp delivery came in as `SENT → READ → DELIVERED`. The displayed status only ever moves forward; failures always win.
- **Cloudflare fronts the API and blocks unusual User-Agents** with HTTP 403 and the body `error code: 1010`. That reads exactly like an auth failure. This client always sets an explicit `User-Agent`.
- **Cal.com pins its API version per endpoint**, and its docs have published conflicting values. Sending the wrong one does not error — it silently selects an older response shape, which surfaces as "no times available" rather than as a failure. Both pins are env config for that reason.
- **ASCII only, in every message body.** A single em dash or curly apostrophe cuts the segment size from 160 characters to 70.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The API returns `success` but no message arrives | Free-form send to a contact who has never messaged you | `SENT_FIRST_MESSAGE_MODE=template`, with an approved template that exists in your account |
| `Sent API returned non-JSON (HTTP 403) ... error code: 1010` | Cloudflare blocking the User-Agent, not an auth failure | Send a normal `User-Agent` header |
| `template not found` or a validation error on send | The template name in your env does not exist in your Sent account, or was never submitted for review | Create it, submit it, wait for approval |
| The panel never leaves `QUEUED` | No webhook registered, or it is pointed at the wrong URL | `npm run webhook <your-url>` |
| Events stopped arriving after a deploy | One non-2xx response permanently killed the webhook — it still reports healthy | Delete it and register a new one |
| Sent's delivery log shows 401s | `SENT_WEBHOOK_SECRET` is wrong, or a proxy altered the body | Re-copy the secret; the signature is computed over the raw bytes |
| The panel updates, but replies get no answer | The reply was a reserved keyword — the agent stays silent on those by design | Reply with something that is not `STOP`, `HELP`, `YES`, etc. |
| The agent says the calendar is full when it is not | Wrong `cal-api-version`, or `CAL_EVENT_TYPE_ID` is unset | Check `CAL_API_VERSION_SLOTS` and the event type id |
| `429` from `/api/leads` | You hit your own rate limits | Raise the `LEADS_MAX_*` values, or wait out the window |
| `403 origin not allowed` | `ALLOWED_ORIGINS` does not list the submitting site | Add it, comma-separated |
| A browser form silently never POSTs | The submitting site's own Content-Security-Policy blocks it before the request is made | Add the app's host to that site's `connect-src` |
| `ENOENT: knowledge/callneo.md` in production | The knowledge file was not traced into the bundle | Keep `outputFileTracingIncludes` in `next.config.ts` |
| `npm run draft` fails with a syntax error | Node older than 22.6 — the script relies on type stripping | Upgrade Node |

---

## Stack

- [Next.js](https://nextjs.org) App Router on Vercel, with polling — deliberately boring
- [Sent](https://sent.dm) for SMS and WhatsApp delivery — [github.com/sentdm](https://github.com/sentdm)
- [Claude](https://platform.claude.com) (`claude-sonnet-5`) for drafting
- [Cal.com](https://cal.com) for availability and booking, optional
- [Upstash Redis](https://upstash.com) for state, optional in development

## Disclosure

This was built as a sponsored project for Sent, and the two Sent links above are referral-tagged. Everything the README says about the API was verified against the live service, including the parts that cost me an afternoon.

## License

MIT — see [LICENSE](LICENSE).
