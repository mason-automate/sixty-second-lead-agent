import type { Channel } from "@/lib/types";

/**
 * The field the whole build is about. One API call went out with no `channel`
 * set; this is what Sent decided, per contact.
 */
const STYLES: Record<Channel, { label: string; className: string }> = {
  sent: {
    label: "auto-detect",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  sms: {
    label: "sms",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  },
  whatsapp: {
    label: "whatsapp",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
  rcs: {
    label: "rcs",
    className: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  },
};

export function ChannelBadge({ channel }: { channel: Channel }) {
  const style = STYLES[channel] ?? STYLES.sent;
  const unresolved = channel === "sent";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-xs ${style.className}`}
      title={
        unresolved
          ? 'Sent has not routed this message yet. "sent" is the auto-detect placeholder.'
          : `Sent routed this message over ${style.label}`
      }
    >
      <span className="opacity-60">channel:</span>
      <span className="font-semibold">{style.label}</span>
      {unresolved && <span className="animate-pulse opacity-60">…</span>}
    </span>
  );
}
