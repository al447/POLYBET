import type { ReactNode } from "react";

/**
 * Minimal shared UI primitives.
 *
 * Plain Tailwind rather than shadcn/ui: the Worker bundle is already at 2.9 MiB
 * gzipped against a 10 MiB paid cap, and these four helpers are all the
 * Milestone 1 screens need. Introduce shadcn when real trading UI lands in
 * Week 2 and the component surface justifies it.
 *
 * Server components by default — none of these hold state.
 */

export function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Row({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span
        className={`truncate text-right text-zinc-200 ${mono ? "font-mono text-xs" : ""}`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

export function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  const color = {
    ok: "bg-emerald-400",
    warn: "bg-amber-400",
    bad: "bg-red-400",
    idle: "bg-zinc-600",
  }[tone];
  return (
    <span
      aria-hidden
      className={`inline-block size-2 shrink-0 rounded-full ${color}`}
    />
  );
}

/** `0x1234…cdef` — full value belongs in a `title` attribute, never truncated silently. */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
