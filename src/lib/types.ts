/**
 * The six lifecycle states Sent reports for a message.
 *
 * ROUTED is the interesting one: it is the moment Sent decides which channel
 * the message goes out on. SMS stops at DELIVERED (carriers give no read
 * receipt); WhatsApp continues to READ.
 */
export const LIFECYCLE = [
  "QUEUED",
  "PROCESSED",
  "ROUTED",
  "SENT",
  "DELIVERED",
  "READ",
] as const;

export type Lifecycle = (typeof LIFECYCLE)[number];

/**
 * `sent` is Sent's auto-detect placeholder — it is what you get back from
 * POST /v3/messages when you omit `channel`. It resolves to a concrete
 * channel once Sent picks one, which surfaces on the `message.routed` webhook.
 */
export type Channel = "sent" | "sms" | "whatsapp" | "rcs";

export interface LifecycleEvent {
  status: string;
  at: string;
}

export interface MessageRecord {
  messageId: string;
  direction: "outbound" | "inbound";
  body: string;
  /** Starts as "sent" (unresolved) and is rewritten when Sent routes it. */
  channel: Channel;
  status: string;
  events: LifecycleEvent[];
  createdAt: string;
}

/** Set once a call is actually on the calendar. Its presence is the idempotency guard. */
export interface BookingRecord {
  /** Cal.com booking uid. */
  uid: string;
  /** ISO-8601 UTC start, exactly as booked. */
  start: string;
  bookedAt: string;
}

export interface Conversation {
  /** E.164 phone number — doubles as the conversation key. */
  phone: string;
  name: string;
  /** Optional — Cal.com requires an attendee email, so no email means no booking. */
  email?: string;
  inquiry: string;
  createdAt: string;
  messages: MessageRecord[];
  booking?: BookingRecord;
}
