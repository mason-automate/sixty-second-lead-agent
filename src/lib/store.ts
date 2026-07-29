import { Redis } from "@upstash/redis";
import type { Conversation, MessageRecord } from "./types";

/**
 * Two storage backends, picked at runtime:
 *
 *   - Upstash Redis, when the REST env vars are present. Vercel functions are
 *     stateless, so the webhook receiver and the polling endpoint run in
 *     different invocations and cannot share memory.
 *   - An in-memory Map otherwise, so `git clone && npm install && npm run dev`
 *     works with no external accounts.
 *
 * The in-memory backend is per-process. That is fine for local dev and wrong
 * for production, which is exactly why the Redis path exists.
 */

interface Kv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  /**
   * Increment a counter that expires, and return its new value. This is the
   * primitive the rate limiter is built on.
   *
   * It lives here rather than coming from @upstash/ratelimit on purpose: that
   * package only works against Redis, and the whole point of the memory
   * backend is that `git clone && npm run dev` needs no external accounts. A
   * limiter that silently does nothing locally is worse than a simple one.
   */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

function redisKv(): Kv | null {
  // Upstash's own names, plus the ones Vercel's Upstash integration injects.
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  return {
    get: <T>(key: string) => redis.get<T>(key),
    set: async (key, value) => {
      await redis.set(key, value);
    },
    sadd: async (key, member) => {
      await redis.sadd(key, member);
    },
    smembers: (key) => redis.smembers(key),
    async incr(key, ttlSeconds) {
      const count = await redis.incr(key);
      // Only the first caller sets the expiry, so the window is fixed from the
      // first hit rather than sliding forward with every request — otherwise a
      // steady stream of traffic would keep the key alive indefinitely.
      if (count === 1) await redis.expire(key, ttlSeconds);
      return count;
    },
  };
}

function memoryKv(): Kv {
  // Survives hot reloads in `next dev`, which throws away module state.
  const g = globalThis as typeof globalThis & {
    __leadAgentStore?: {
      values: Map<string, unknown>;
      sets: Map<string, Set<string>>;
      counters: Map<string, { count: number; expiresAt: number }>;
    };
  };
  g.__leadAgentStore ??= { values: new Map(), sets: new Map(), counters: new Map() };
  const { values, sets, counters } = g.__leadAgentStore;

  return {
    async get<T>(key: string) {
      return (values.get(key) as T) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async sadd(key, member) {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async incr(key, ttlSeconds) {
      const now = Date.now();
      const existing = counters.get(key);
      const entry =
        existing && existing.expiresAt > now
          ? existing
          : { count: 0, expiresAt: now + ttlSeconds * 1000 };
      entry.count += 1;
      counters.set(key, entry);
      return entry.count;
    },
  };
}

// Built once. Calling redisKv() per use would open a new client each time.
const redis = redisKv();
const kv: Kv = redis ?? memoryKv();

export const storageBackend = redis ? "upstash-redis" : "in-memory";

const CONVERSATION_INDEX = "conversations";
const conversationKey = (phone: string) => `conversation:${phone}`;
/** Webhooks arrive keyed by message_id, so we need message_id -> phone. */
const messageIndexKey = (messageId: string) => `message:${messageId}`;

export async function saveConversation(conversation: Conversation): Promise<void> {
  await kv.set(conversationKey(conversation.phone), conversation);
  await kv.sadd(CONVERSATION_INDEX, conversation.phone);
  for (const message of conversation.messages) {
    await kv.sadd(messageIndexKey(message.messageId), conversation.phone);
  }
}

export async function getConversation(phone: string): Promise<Conversation | null> {
  return kv.get<Conversation>(conversationKey(phone));
}

export async function listConversations(): Promise<Conversation[]> {
  const phones = await kv.smembers(CONVERSATION_INDEX);
  const conversations = await Promise.all(phones.map((p) => getConversation(p)));
  return conversations
    .filter((c): c is Conversation => c !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findConversationByMessageId(
  messageId: string,
): Promise<Conversation | null> {
  const [phone] = await kv.smembers(messageIndexKey(messageId));
  return phone ? getConversation(phone) : null;
}

export async function appendMessage(
  phone: string,
  message: MessageRecord,
): Promise<void> {
  const conversation = await getConversation(phone);
  if (!conversation) return;
  conversation.messages.push(message);
  await saveConversation(conversation);
}

/**
 * The most recent webhook delivery, verbatim. Sent's webhook payload shape is
 * not published, so the app records the last one at /api/messages?debug=1 —
 * that is how you pin down the real field names against live traffic.
 */
export async function recordWebhookSample(sample: unknown): Promise<void> {
  await kv.set("webhook:last", sample);
}

export async function getWebhookSample(): Promise<unknown> {
  return kv.get("webhook:last");
}

/** Increment a rate-limit counter and report whether it is now over budget. */
export async function hitLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; count: number }> {
  const count = await kv.incr(`ratelimit:${key}`, windowSeconds);
  return { allowed: count <= limit, count };
}
