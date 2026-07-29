import type { Channel } from "./types";

/**
 * Minimal client for the Sent API (https://sent.dm).
 *
 * Verified against the live v3 API. Two things worth knowing:
 *
 *  1. Cloudflare fronts api.sent.dm and 403s unusual User-Agents with the body
 *     `error code: 1010`. That reads exactly like an auth failure but isn't, so
 *     this client always sets an explicit User-Agent.
 *  2. There is no list endpoint — `GET /v3/messages` returns 405. You can only
 *     fetch a message you already hold the id for.
 */

const BASE_URL = process.env.SENT_API_BASE ?? "https://api.sent.dm/v3";
const USER_AGENT = "sixty-second-lead-agent/1.0";

interface SentResponse<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = process.env.SENT_API_KEY;
  if (!apiKey) throw new Error("SENT_API_KEY is not set");

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  const text = await response.text();
  let payload: SentResponse<T>;
  try {
    payload = JSON.parse(text);
  } catch {
    // Cloudflare's 1010 block lands here — HTML or a bare error string.
    throw new Error(`Sent API returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || !payload.success) {
    throw new Error(
      `Sent API ${method} ${path} failed: ${payload.error?.code ?? response.status} ${payload.error?.message ?? text.slice(0, 200)}`,
    );
  }
  return payload.data;
}

export interface SendResult {
  status: string;
  recipients: Array<{
    message_id: string;
    to: string;
    /** Always "sent" here — auto-detect has not resolved yet. See sendMessage(). */
    channel: Channel;
    body: string | null;
  }>;
}

/**
 * Send one message to one or more recipients.
 *
 * `channel` is deliberately never set. Omitting it is Sent's auto-detect mode:
 * one API call, and Sent picks SMS or WhatsApp per recipient based on that
 * contact's capabilities. Passing an explicit array is a *broadcast* — it
 * creates one independent message per channel, which is a different feature.
 *
 * The response comes back with `channel: "sent"` for every recipient, because
 * routing has not happened yet. The resolved channel arrives on the
 * `message.routed` webhook.
 */
export function sendMessage(params: {
  to: string[];
  text?: string;
  template?: { name: string; parameters: Record<string, string> };
}): Promise<SendResult> {
  const { to, text, template } = params;
  if (!text && !template) throw new Error("sendMessage needs either text or template");
  return request<SendResult>("POST", "/messages", { to, ...(text ? { text } : {}), ...(template ? { template } : {}) });
}

export interface MessageStatus {
  phone_international: string;
  channel: Channel;
  status: string;
  price: string | null;
  events?: Array<{ status: string; timestamp: string }>;
}

/** Fetch one message by id. Used as a reconciliation fallback for the panel. */
export function getMessage(messageId: string): Promise<MessageStatus> {
  return request<MessageStatus>("GET", `/messages/${messageId}`);
}

export interface Webhook {
  id: string;
  url: string;
  secret?: string;
}

export function listWebhooks(): Promise<{ webhooks: Webhook[] }> {
  return request("GET", "/webhooks");
}

export function createWebhook(params: {
  url: string;
  event_types: string[];
}): Promise<Webhook> {
  return request("POST", "/webhooks", params);
}
