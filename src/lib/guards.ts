import { hitLimit } from "./store";

/**
 * Abuse guards for POST /api/leads.
 *
 * This endpoint is public, unauthenticated, and sends a real SMS on a real
 * 10DLC number the moment it is called — and this repo is public, so the
 * endpoint is effectively documented for anyone who wants to misuse it.
 * Unsolicited traffic is how A2P campaigns get suspended, and getting this one
 * approved took four days.
 *
 * Every limit is deliberately config, not a constant. Hardcoding a domain or a
 * number here is what would turn a reusable template into someone's personal
 * project, and cloners need their own values.
 */

const num = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HOUR = 3600;
const DAY = 86400;

/** Per browser/client. Catches someone hammering the form. */
const MAX_PER_IP = num("LEADS_MAX_PER_IP", 5);
/**
 * Per destination number, and the most important of the three: it is what stops
 * the endpoint being used to text a stranger repeatedly. A low cap here is not
 * an inconvenience, it is the difference between a demo and a harassment tool.
 */
const MAX_PER_NUMBER = num("LEADS_MAX_PER_NUMBER", 3);
/** Whole-account brake. Bounds the worst case no matter how it is distributed. */
const MAX_PER_DAY = num("LEADS_MAX_PER_DAY", 50);

export interface GuardFailure {
  status: number;
  error: string;
}

/**
 * Browser submissions must come from an allowed origin when ALLOWED_ORIGINS is
 * set. Unset means unrestricted, which is the right default for a template that
 * people clone and run locally before they own a domain.
 *
 * This is not a security boundary — a script can send any Origin it likes. It
 * stops the deployed form being embedded and driven from another site, and the
 * rate limits below are what actually bound the damage.
 */
function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * CORS headers for a cross-origin browser submission — the callneo.ai form
 * posts JSON straight to this endpoint from the page, which the browser blocks
 * without these (and preflights with OPTIONS first, because a JSON body is not
 * a "simple" request).
 *
 * The origin is echoed back only when it is on the allow list, so this grants
 * nothing that checkOrigin would not already have permitted.
 */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};

  const allowed = allowedOrigins();
  const permitted = allowed.length === 0 || allowed.includes(origin);
  if (!permitted) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function checkOrigin(request: Request): GuardFailure | null {
  const allowed = allowedOrigins();
  if (allowed.length === 0) return null;

  const origin = request.headers.get("origin");
  // Non-browser callers (curl, a server-side form relay) send no Origin at all.
  // Rejecting those would break the callneo.ai integration, which posts
  // server-side; they are covered by the rate limits instead.
  if (!origin) return null;

  return allowed.includes(origin)
    ? null
    : { status: 403, error: "origin not allowed" };
}

/**
 * E.164, loosely. The point is to reject junk before it reaches Sent and to
 * make sure the rate-limit key is a stable, canonical string — not to
 * re-implement libphonenumber.
 */
export function validatePhone(e164: string): GuardFailure | null {
  return /^\+[1-9]\d{7,14}$/.test(e164)
    ? null
    : { status: 400, error: "phone must be a valid E.164 number" };
}

export function validateText(
  name: string,
  message: string,
): GuardFailure | null {
  if (name.length > 100) return { status: 400, error: "name is too long" };
  if (message.length > 2000) return { status: 400, error: "message is too long" };
  return null;
}

/**
 * Read the client IP from the proxy header Vercel sets. Absent locally, where
 * every request collapses to a single "local" bucket — fine, since the limits
 * that matter for abuse are per-number and global.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}

/**
 * Checked in ascending order of blast radius, so the message names the limit
 * the caller actually hit.
 *
 * Note these count *attempts*, not sends: the counter is incremented before the
 * message goes out. A caller cannot retry their way past a limit by making the
 * send fail.
 */
export async function checkRateLimits(
  ip: string,
  phone: string,
): Promise<GuardFailure | null> {
  const checks = [
    {
      key: `ip:${ip}`,
      limit: MAX_PER_IP,
      window: HOUR,
      error: "too many submissions from this address, try again later",
    },
    {
      key: `phone:${phone}`,
      limit: MAX_PER_NUMBER,
      window: DAY,
      error: "this number has already been messaged too many times today",
    },
    {
      key: "global",
      limit: MAX_PER_DAY,
      window: DAY,
      error: "daily send limit reached",
    },
  ];

  for (const check of checks) {
    const { allowed } = await hitLimit(check.key, check.limit, check.window);
    if (!allowed) return { status: 429, error: check.error };
  }
  return null;
}
