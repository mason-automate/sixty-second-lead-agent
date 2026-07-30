/**
 * Minimal client for the Cal.com v2 API (https://cal.com/docs/api-reference/v2).
 *
 * Two things to know before changing anything here:
 *
 *  1. **The `cal-api-version` header is pinned per endpoint, and Cal.com's own
 *     docs disagree about the right value** — the bookings page has shown both
 *     `2024-08-13` and `2026-02-25`, the slots page both `2024-08-13` and
 *     `2024-09-04`. Sending the wrong one doesn't error; it silently selects an
 *     older response shape. So both are env config with conservative defaults:
 *     when a response shape looks wrong, change the env var, not this file.
 *  2. **Slot responses have shifted shape across versions.** `parseSlots`
 *     accepts every form seen rather than assuming one, because the failure is
 *     otherwise an empty availability list, which reads as "no times free"
 *     rather than as a bug.
 */

const BASE_URL = process.env.CAL_API_BASE ?? "https://api.cal.com/v2";
const SLOTS_VERSION = process.env.CAL_API_VERSION_SLOTS ?? "2024-09-04";
const BOOKINGS_VERSION = process.env.CAL_API_VERSION_BOOKINGS ?? "2024-08-13";

/** IANA zone the lead's times are interpreted in. Cal.com wants UTC on the wire. */
export const BOOKING_TIMEZONE = process.env.CAL_TIMEZONE ?? "America/Denver";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function call<T>(
  path: string,
  version: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${requireEnv("CAL_API_KEY")}`,
      "cal-api-version": version,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const text = await response.text();
  let payload: { status?: string; data?: T; error?: unknown };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Cal.com returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || payload.status === "error") {
    throw new Error(
      `Cal.com ${init.method} ${path} failed (HTTP ${response.status}): ${JSON.stringify(payload.error ?? payload).slice(0, 300)}`,
    );
  }
  return payload.data as T;
}

/**
 * Slots have been returned as a date-keyed map of `{time}` objects, a date-keyed
 * map of bare strings, and a flat array. Normalize all of them to ISO strings.
 */
function parseSlots(data: unknown): string[] {
  const times: string[] = [];

  const pushEntry = (entry: unknown) => {
    if (typeof entry === "string") times.push(entry);
    else if (entry && typeof entry === "object" && "time" in entry) {
      const { time } = entry as { time?: unknown };
      if (typeof time === "string") times.push(time);
    }
  };

  const slots = (data as { slots?: unknown })?.slots ?? data;
  if (Array.isArray(slots)) slots.forEach(pushEntry);
  else if (slots && typeof slots === "object") {
    for (const value of Object.values(slots)) {
      if (Array.isArray(value)) value.forEach(pushEntry);
      else pushEntry(value);
    }
  }

  // Sorted and de-duplicated so the prompt sees a stable, ascending list.
  return [...new Set(times)].sort();
}

/**
 * Free slots between now and `days` out, as ISO-8601 UTC strings.
 *
 * Fetched *before* Claude drafts, so the model can only ever propose a time
 * that is genuinely open. Offering a slot and discovering on booking that it is
 * taken is a worse experience than never offering it.
 */
export async function getAvailability(days = 5): Promise<string[]> {
  const start = new Date();
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

  const data = await call<unknown>("/slots", SLOTS_VERSION, {
    method: "GET",
    query: {
      eventTypeId: requireEnv("CAL_EVENT_TYPE_ID"),
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: BOOKING_TIMEZONE,
    },
  });

  return parseSlots(data);
}

export interface Booking {
  id: number;
  uid: string;
  start: string;
  status: string;
}

/**
 * `start` must be UTC — Cal.com interprets the instant, not a local wall clock.
 * Always pass a slot string straight from getAvailability() rather than one
 * reconstructed from the model's prose.
 */
export async function createBooking(params: {
  start: string;
  name: string;
  email: string;
  phone?: string;
}): Promise<Booking> {
  return call<Booking>("/bookings", BOOKINGS_VERSION, {
    method: "POST",
    body: {
      start: params.start,
      eventTypeId: Number(requireEnv("CAL_EVENT_TYPE_ID")),
      // name/email/timeZone are nested under `attendee`; flat fields are silently ignored.
      attendee: {
        name: params.name,
        email: params.email,
        timeZone: BOOKING_TIMEZONE,
        ...(params.phone ? { phoneNumber: params.phone } : {}),
      },
      metadata: { source: "sixty-second-lead-agent" },
    },
  });
}

/** True when enough is configured to attempt a booking at all. */
export function bookingEnabled(): boolean {
  return Boolean(process.env.CAL_API_KEY && process.env.CAL_EVENT_TYPE_ID);
}

/**
 * Human labels for the prompt, paired with the exact ISO value to book.
 * The model picks a label; the app books the value — so a mis-parsed date can
 * never become a wrong booking, it can only fail the lookup.
 */
export function describeSlots(slots: string[], limit = 8): Array<{ label: string; value: string }> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: BOOKING_TIMEZONE,
  });

  return slots.slice(0, limit).map((value) => ({
    label: formatter.format(new Date(value)),
    value,
  }));
}
