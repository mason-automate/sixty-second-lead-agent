import { LIFECYCLE } from "@/lib/types";
import type { LifecycleEvent } from "@/lib/types";

/**
 * The six states Sent reports. ROUTED is called out because it *is* the routing
 * decision — the moment the channel stops being "auto-detect" and becomes real.
 *
 * SMS legitimately stops at DELIVERED; carriers give no read receipt. Only
 * WhatsApp reaches READ.
 */
export function Lifecycle({
  events,
  terminal,
}: {
  events: LifecycleEvent[];
  terminal: boolean;
}) {
  const reachedAt = new Map(events.map((e) => [e.status.toUpperCase(), e.at]));

  return (
    <ol className="flex flex-wrap items-center gap-1">
      {LIFECYCLE.map((state, index) => {
        const at = reachedAt.get(state);
        const reached = Boolean(at);
        const isRouted = state === "ROUTED";

        return (
          <li key={state} className="flex items-center gap-1">
            {index > 0 && (
              <span
                aria-hidden
                className={`h-px w-3 ${reached ? "bg-white/30" : "bg-white/10"}`}
              />
            )}
            <span
              title={at ? new Date(at).toLocaleTimeString() : "not yet"}
              className={[
                "rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide transition-colors",
                reached
                  ? isRouted
                    ? "bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/40"
                    : "bg-white/10 text-white/80"
                  : "text-white/25",
              ].join(" ")}
            >
              {state}
            </span>
          </li>
        );
      })}
      {terminal && (
        <li className="ml-1 font-mono text-[10px] text-white/30">
          (sms has no read receipt)
        </li>
      )}
    </ol>
  );
}
