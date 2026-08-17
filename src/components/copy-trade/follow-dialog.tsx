"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  COPY_EXECUTION_MODE,
  DEFAULT_COPY_SETTINGS,
  MIN_COPY_USD,
  type CopySettings,
} from "@/lib/copy-trade/types";

/**
 * Where the user sets what following a trader will cost them.
 *
 * 🚩 The caps are the product. Everything else on the copy-trade page is a way
 * of choosing whom to follow; this dialog is the only thing standing between a
 * stranger's trading and the user's balance, so it opens with conservative
 * numbers already filled in and cannot be submitted without them. There is no
 * "no limit" option, and adding one would defeat every guard in `engine.ts`.
 *
 * Hand-rolled rather than a dialog library, matching `ui/menu.tsx` — the
 * Worker bundle is already ~48% of the paid cap and this needs a backdrop, an
 * Escape key and a focus trap's worth of behaviour, not a dependency.
 */

type Props = {
  trader: { address: string; name: string; avatar?: string };
  initial?: CopySettings;
  onConfirm: (settings: CopySettings) => void;
  onClose: () => void;
};

export function FollowDialog({ trader, initial, onConfirm, onClose }: Props) {
  const start = initial ?? DEFAULT_COPY_SETTINGS;

  const [mode, setMode] = useState<"fixed" | "percent">(start.sizing.mode);
  const [fixedUsd, setFixedUsd] = useState(String(
    start.sizing.mode === "fixed" ? start.sizing.usd : 25,
  ));
  const [percent, setPercent] = useState(String(
    start.sizing.mode === "percent" ? start.sizing.percentOfTheirNotional : 0.2,
  ));
  const [perTrade, setPerTrade] = useState(String(start.perTradeCapUsd));
  const [daily, setDaily] = useState(String(start.dailyCapUsd));
  const [total, setTotal] = useState(String(start.totalCapUsd));

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    // Click-outside through a document listener rather than an `onClick` on the
    // backdrop, matching `ui/menu.tsx`. It also fixes a real annoyance: a drag
    // that starts inside a number field and releases over the backdrop is a
    // click on the backdrop, and would otherwise discard the form.
    const onPointerDown = (event: PointerEvent) => {
      const panel = dialogRef.current;
      if (panel && !panel.contains(event.target as Node)) onClose();
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    // Focus moves into the dialog so a keyboard user is not left behind on the
    // button that opened it.
    dialogRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  const values = {
    size: mode === "fixed" ? Number(fixedUsd) : Number(percent),
    perTrade: Number(perTrade),
    daily: Number(daily),
    total: Number(total),
  };

  // Every field must be a positive number, and the caps must not contradict
  // each other — a daily cap below the per-trade cap would silently make the
  // per-trade cap unreachable.
  const problems: string[] = [];
  if (!isPositive(values.size)) problems.push("Enter how much to copy per trade.");
  if (!isPositive(values.perTrade) || values.perTrade < MIN_COPY_USD) {
    problems.push(`The per-trade cap must be at least $${MIN_COPY_USD}.`);
  }
  if (!isPositive(values.daily) || values.daily < values.perTrade) {
    problems.push("The daily cap must be at least the per-trade cap.");
  }
  if (!isPositive(values.total) || values.total < values.perTrade) {
    problems.push("The total cap must be at least the per-trade cap.");
  }

  function submit() {
    if (problems.length > 0) return;
    onConfirm({
      sizing:
        mode === "fixed"
          ? { mode: "fixed", usd: values.size }
          : { mode: "percent", percentOfTheirNotional: values.size },
      perTradeCapUsd: values.perTrade,
      dailyCapUsd: values.daily,
      totalCapUsd: values.total,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Copy ${trader.name}`}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 outline-none"
      >
        <h2 className="text-lg font-semibold text-zinc-100">Copy {trader.name}</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {COPY_EXECUTION_MODE === "simulated"
            ? "Dry run — copies are worked out and recorded, but no order is placed."
            : "Each copy waits for you to place it. Nothing is signed without your click."}
        </p>

        <fieldset className="mt-6">
          <legend className="text-sm font-medium text-zinc-300">Size each copy</legend>
          <div className="mt-2 flex gap-2">
            <ModeButton active={mode === "fixed"} onClick={() => setMode("fixed")}>
              Fixed amount
            </ModeButton>
            <ModeButton active={mode === "percent"} onClick={() => setMode("percent")}>
              % of their trade
            </ModeButton>
          </div>

          {mode === "fixed" ? (
            <Field
              label="Amount per copy"
              prefix="$"
              value={fixedUsd}
              onChange={setFixedUsd}
              hint="The same amount every time, however large their trade was."
            />
          ) : (
            <Field
              label="Percent of their trade"
              suffix="%"
              value={percent}
              onChange={setPercent}
              hint="0.2% of a $12,000 buy is about $24."
            />
          )}
        </fieldset>

        <fieldset className="mt-6 space-y-3">
          <legend className="text-sm font-medium text-zinc-300">Hard limits</legend>
          <Field label="Most per copy" prefix="$" value={perTrade} onChange={setPerTrade} />
          <Field label="Most per day" prefix="$" value={daily} onChange={setDaily} />
          <Field label="Most at once" prefix="$" value={total} onChange={setTotal} />
        </fieldset>

        {problems.length > 0 ? (
          <ul className="mt-4 space-y-1">
            {problems.map((problem) => (
              <li key={problem} className="text-xs text-amber-300/90">
                {problem}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 cursor-pointer rounded-lg border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={problems.length > 0}
            className="flex-1 cursor-pointer rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {initial ? "Save limits" : "Start copying"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "border-blue-500 bg-blue-500/10 text-blue-300"
          : "border-zinc-800 text-zinc-400 hover:border-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  prefix,
  suffix,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  hint?: string;
}) {
  return (
    <label className="mt-3 block">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="mt-1 flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
        {prefix ? <span className="text-sm text-zinc-500">{prefix}</span> : null}
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full bg-transparent text-sm text-zinc-100 outline-none"
        />
        {suffix ? <span className="text-sm text-zinc-500">{suffix}</span> : null}
      </span>
      {hint ? <span className="mt-1 block text-xs text-zinc-600">{hint}</span> : null}
    </label>
  );
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
