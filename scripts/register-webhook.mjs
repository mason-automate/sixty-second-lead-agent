#!/usr/bin/env node
/**
 * Register this app's webhook endpoint with Sent, or list what is registered.
 *
 *   npm run webhook                       # list what exists
 *   npm run webhook https://your.app      # register
 *   npm run webhook https://your.app test # register, then fire a synthetic event
 *
 * Reads SENT_API_KEY from the environment (or .env.local).
 *
 * Two field names here differ from the published docs and were taken from the
 * live API instead: the create payload wants `display_name` and `endpoint_url`
 * (not `url`), and the test endpoint requires an `event_type` in the body —
 * an empty body returns "Event type is required".
 */
import { readFileSync } from "node:fs";

const BASE = process.env.SENT_API_BASE ?? "https://api.sent.dm/v3";

// Minimal .env.local loader so this works without extra dependencies.
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {
  /* no .env.local — rely on the ambient environment */
}

const API_KEY = process.env.SENT_API_KEY;
if (!API_KEY) {
  console.error("SENT_API_KEY is not set (put it in .env.local or the environment)");
  process.exit(1);
}

// Cloudflare fronts api.sent.dm and 403s unusual User-Agents with the body
// `error code: 1010`, which looks like an auth failure but is not.
async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "sixty-second-lead-agent/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || payload.success === false) {
    const detail = payload.error?.message ?? payload.message ?? text.slice(0, 200);
    throw new Error(`${method} ${path} failed (HTTP ${response.status}): ${detail}`);
  }
  return payload;
}

const [appUrl, andTest] = process.argv.slice(2);

if (!appUrl) {
  const { data } = await api("GET", "/webhooks");
  const webhooks = data?.webhooks ?? [];
  if (webhooks.length === 0) {
    console.log("No webhooks registered. Register one:\n  npm run webhook https://your-app.vercel.app");
  }
  for (const hook of webhooks) {
    console.log(`${hook.id}  ${hook.is_active ? "active  " : "inactive"}  ${hook.endpoint_url}`);
  }
  process.exit(0);
}

const endpointUrl = new URL("/api/webhooks/sent", appUrl).toString();
const created = await api("POST", "/webhooks", {
  display_name: `60-second lead agent (${new URL(appUrl).hostname})`,
  endpoint_url: endpointUrl,
  event_types: ["message"],
});

const webhook = created.data ?? created;
console.log(`Registered ${webhook.id}\n  -> ${endpointUrl}`);

if (webhook.signing_secret) {
  console.log(`\nSave this as SENT_WEBHOOK_SECRET and redeploy:\n\n  SENT_WEBHOOK_SECRET=${webhook.signing_secret}\n`);
  console.log("It is shown once. Rotate with POST /v3/webhooks/{id}/rotate-secret if you lose it.");
} else {
  console.log("\nNo signing_secret in the response — rotate one with POST /v3/webhooks/{id}/rotate-secret.");
}

if (andTest === "test") {
  // The test endpoint stops dispatching a couple of minutes after the webhook is
  // created, and then fails without logging an HTTP attempt at all. If this
  // returns an error later on, check GET /v3/webhooks/{id}/events instead — that
  // is the authoritative delivery log, not this response.
  console.log("\nFiring a synthetic message.delivered event...");
  const test = await api("POST", `/webhooks/${webhook.id}/test`, {
    event_type: "message.delivered",
  });
  console.log(JSON.stringify(test, null, 2));
  console.log("\nNow open /api/messages?debug=1 to see the payload shape Sent actually sends.");
}
