import { NextResponse } from "next/server";

import { getCachedRangeHistories } from "@/lib/polymarket/price-history";
import { isPriceRangeId, DEFAULT_PRICE_RANGE_ID } from "@/lib/polymarket/price-history-types";

/**
 * Price history for the market detail chart (FR-2.3's price view).
 *
 * Exists because the chart's range tabs re-fetch in the browser, and the rule
 * from `gamma.ts` applies to the CLOB too: the browser never talks to
 * Polymarket directly. Going through here keeps the traffic shape private and
 * — the part that actually matters — reuses `getCachedPriceHistory`, so a
 * dozen people flipping to "1M" on the same market cost one upstream call.
 *
 * **All series in one request.** A five-outcome chart is `?tokenIds=a,b,c,d,e`
 * rather than five round trips, so every line switches range together instead
 * of the chart redrawing five times.
 *
 * ⚠️ `range` is an **id** (`1h`…`max`), never a raw interval/fidelity pair.
 * Those two must be paired or the CLOB returns an empty history with a 200 —
 * see the measured table on `PRICE_RANGES`. Accepting them separately would
 * let a caller construct a combination that silently blanks the chart.
 */

/** Matches the chart legend — more lines than this is unreadable anyway. */
const MAX_SERIES = 6;

export async function GET(request: Request) {
  const url = new URL(request.url);

  const rangeParam = url.searchParams.get("range");
  if (rangeParam !== null && !isPriceRangeId(rangeParam)) {
    return NextResponse.json(
      { error: "invalid_range", message: `Unknown range "${rangeParam}".` },
      { status: 400 },
    );
  }
  const range = rangeParam ?? DEFAULT_PRICE_RANGE_ID;

  const tokenIds = (url.searchParams.get("tokenIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    // CLOB token ids are long decimal strings; anything else is a caller bug
    // or a probe, and is rejected rather than forwarded upstream.
    .filter((id) => /^\d+$/.test(id));

  if (tokenIds.length === 0) {
    return NextResponse.json(
      { error: "missing_token_ids", message: "At least one CLOB token id is required." },
      { status: 400 },
    );
  }

  const series = await getCachedRangeHistories(tokenIds.slice(0, MAX_SERIES), range);

  return NextResponse.json(
    { range, series },
    {
      headers: {
        // Mirrors the upstream cache window. Private rather than shared: this
        // is per-token and there's no benefit to a CDN copy on top of the
        // route's own `use cache` entry.
        "cache-control": "private, max-age=60",
      },
    },
  );
}
