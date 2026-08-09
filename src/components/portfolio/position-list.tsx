import Image from "next/image";
import Link from "next/link";
import type { Position } from "@polymarket/bindings/data";

/**
 * Open positions table (FR-4.2, FR-4.3).
 *
 * ⚠️ Every money field here is already a human decimal from the Data API —
 * NOT 6-decimal base units. Do not reach for `fees.ts`'s `fromBaseUnits`;
 * it would divide by 10^6 and silently render every row as ~0.
 *
 * Rows link by **`eventSlug`**, not `slug`: our detail route resolves through
 * `getCachedEventBySlug`, so a market slug would 404. A position missing an
 * eventSlug renders unlinked rather than pointing at a broken URL.
 */
export function PositionList({ positions }: { positions: Position[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900/60 text-xs tracking-wide text-zinc-500 uppercase">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Market</th>
            <th className="px-4 py-3 text-right font-medium">Shares</th>
            <th className="px-4 py-3 text-right font-medium">Avg entry</th>
            <th className="px-4 py-3 text-right font-medium">Mark</th>
            <th className="px-4 py-3 text-right font-medium">Value</th>
            <th className="px-4 py-3 text-right font-medium">PnL</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {positions.map((position) => (
            <PositionRow key={`${position.conditionId}-${position.tokenId ?? ""}`} position={position} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionRow({ position }: { position: Position }) {
  const pnl = num(position.cashPnl);
  const percent = position.percentPnl;
  const isYes = (position.outcome ?? "").toLowerCase() === "yes";

  const title = (
    <div className="flex min-w-0 items-center gap-3">
      {position.icon ? (
        <Image
          src={position.icon}
          alt=""
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-full object-cover"
          unoptimized
        />
      ) : (
        <div className="size-8 shrink-0 rounded-full bg-zinc-800" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="truncate font-medium text-zinc-200">{position.title ?? "Untitled market"}</p>
        <p className="mt-0.5 flex items-center gap-2">
          <span className={`text-xs font-semibold ${isYes ? "text-emerald-400" : "text-red-400"}`}>
            {position.outcome ?? "—"}
          </span>
          {position.redeemable ? (
            <span className="rounded border border-amber-800/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
              Resolved
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );

  return (
    <tr className="transition hover:bg-zinc-900/40">
      <td className="max-w-0 px-4 py-3">
        {position.eventSlug ? (
          <Link href={`/market/${position.eventSlug}`} className="block min-w-0">
            {title}
          </Link>
        ) : (
          title
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-300">{num(position.size).toFixed(2)}</td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-400">{cents(position.avgPrice)}</td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-400">{cents(position.curPrice)}</td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-200">
        ${num(position.currentValue).toFixed(2)}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}
        {typeof percent === "number" && Number.isFinite(percent) ? (
          <span className="block text-xs opacity-70">{percent >= 0 ? "+" : "−"}{Math.abs(percent).toFixed(1)}%</span>
        ) : null}
      </td>
    </tr>
  );
}

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cents(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}¢` : "—";
}
