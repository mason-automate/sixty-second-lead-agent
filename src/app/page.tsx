"use client";

import { useCallback, useEffect, useState } from "react";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Lifecycle } from "@/components/Lifecycle";
import type { Conversation } from "@/lib/types";

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [backend, setBackend] = useState<string>("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  // The Sent API has no message-list endpoint, so everything rendered below
  // arrived via the webhook receiver. Polling keeps the panel honest and the
  // stack boring — no websockets, no realtime database.
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/messages", { cache: "no-store" });
      const data = await response.json();
      setConversations(data.conversations ?? []);
      setBackend(data.storageBackend ?? "");
    } catch {
      /* transient poll failure — the next tick will pick it up */
    }
  }, []);

  useEffect(() => {
    // Fetching on mount and then on a timer is the whole point of a polling
    // panel, and both paths set state by design.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setElapsed(null);
    const startedAt = performance.now();

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, email, message }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Request failed");

      setElapsed(Math.round(performance.now() - startedAt));
      setMessage("");
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          60-Second Lead Agent
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
          A lead submits the form. Claude drafts a reply. One call to{" "}
          <code className="rounded bg-white/10 px-1 font-mono text-xs">
            POST /v3/messages
          </code>{" "}
          with no{" "}
          <code className="rounded bg-white/10 px-1 font-mono text-xs">channel</code>{" "}
          field — and Sent decides whether that person gets an SMS or a WhatsApp
          message. Watch the badge resolve.
        </p>
      </header>

      <section className="mb-12 rounded-xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-white/40">
          New lead
        </h2>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-white/50">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jordan Reyes"
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-white/50">Phone</span>
            <input
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 801 555 0100"
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-white/30"
            />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs text-white/50">
              Email <span className="text-white/30">· needed to put a call on the calendar</span>
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
            />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs text-white/50">What do you need?</span>
            <textarea
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="We miss a lot of calls after hours and I want to stop losing those jobs."
              className="resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
            />
          </label>
          {/*
            Consent is not decoration. This endpoint sends a real SMS on a
            registered A2P number, and texting someone who did not ask for it is
            how a campaign gets suspended. Unchecked by default, and required —
            a pre-ticked box is not consent.
          */}
          <label className="flex items-start gap-2.5 sm:col-span-2">
            <input
              type="checkbox"
              required
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-white"
            />
            <span className="text-xs leading-relaxed text-white/50">
              I agree to receive text messages at the number provided. Message and data
              rates may apply. Reply STOP to opt out.
            </span>
          </label>
          <div className="flex items-center gap-4 sm:col-span-2">
            <button
              type="submit"
              disabled={pending || !consent}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {pending ? "Drafting and sending…" : "Submit lead"}
            </button>
            {elapsed !== null && (
              <span className="font-mono text-xs text-emerald-400">
                drafted + sent in {(elapsed / 1000).toFixed(1)}s
              </span>
            )}
            {error && <span className="font-mono text-xs text-red-400">{error}</span>}
          </div>
        </form>
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-white/40">
            Live delivery status
          </h2>
          <span className="font-mono text-[10px] text-white/25">
            polling /api/messages · store: {backend || "…"}
          </span>
        </div>

        {conversations.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-6 py-12 text-center text-sm text-white/30">
            No messages yet. Submit a lead above.
          </p>
        ) : (
          <div className="space-y-4">
            {conversations.map((conversation) => (
              <article
                key={conversation.phone}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
              >
                <header className="mb-4 flex items-baseline gap-3">
                  <h3 className="font-medium">{conversation.name}</h3>
                  <span className="font-mono text-xs text-white/40">
                    {conversation.phone}
                  </span>
                </header>

                <ul className="space-y-3">
                  {conversation.messages.map((msg) => {
                    const isOutbound = msg.direction === "outbound";
                    const terminal =
                      msg.channel === "sms" && msg.status === "DELIVERED";

                    return (
                      <li
                        key={msg.messageId}
                        className={`rounded-lg border p-3 ${
                          isOutbound
                            ? "border-white/10 bg-black/30"
                            : "border-white/5 bg-white/[0.06]"
                        }`}
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">
                            {isOutbound ? "→ outbound" : "← inbound"}
                          </span>
                          <ChannelBadge channel={msg.channel} />
                        </div>
                        <p className="mb-2.5 text-sm leading-relaxed text-white/90">
                          {msg.body}
                        </p>
                        {isOutbound && (
                          <Lifecycle events={msg.events} terminal={terminal} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>

      <footer className="mt-16 border-t border-white/10 pt-6 text-xs text-white/30">
        Multi-channel messaging by{" "}
        <a
          href="https://sent.dm"
          className="text-white/50 underline underline-offset-2 hover:text-white/80"
        >
          Sent
        </a>
        . Routing, formatting, fallbacks, and compliance are handled after the
        send — this app never picks a channel.
      </footer>
    </main>
  );
}
