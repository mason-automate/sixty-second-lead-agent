#!/usr/bin/env node
/**
 * Register this app's webhook endpoint with Sent, or list what is registered.
 *
 *   node scripts/register-webhook.mjs                       # list
 *   node scripts/register-webhook.mjs https://your.app      # register
 *   node scripts/register-webhook.mjs https://your.app test # register + fire synthetic events
 *
 * Reads SENT_API_KEY from the environment (or .env.local).
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
  console.error("SENT_API_KEY is not set");
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
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

const [appUrl, andTest] = process.argv.slice(2);

if (!appUrl) {
  console.log(JSON.stringify(await api("GET", "/webhooks"), null, 2));
  process.exit(0);
}

const created = await api("POST", "/webhooks", {
  url: new URL("/api/webhooks/sent", appUrl).toString(),
  event_types: ["message"],
});
console.log(JSON.stringify(created, null, 2));

const id = created?.data?.id ?? created?.id;
if (!id) {
  console.error("Could not read a webhook id from the response — nothing else to do.");
  process.exit(1);
}
console.log(`\nSave the signing secret as SENT_WEBHOOK_SECRET (shown above, if returned).`);

if (andTest === "test") {
  console.log("\nFiring synthetic events...");
  console.log(JSON.stringify(await api("POST", `/webhooks/${id}/test`), null, 2));
  console.log("\nNow check /api/messages?debug=1 to see the payload shape Sent actually sends.");
}
