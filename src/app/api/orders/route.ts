import { NextResponse } from "next/server";

import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { describeBuilderConfig } from "@/lib/polymarket/builder";
import { canOpenPositions } from "@/lib/geo/jurisdictions";
import { serverEnv } from "@/lib/env";

/**
 * Pre-trade authorization (FR-3.5, FR-6).
 *
 * ⚠️ This route no longer places orders. Orders are built and signed **in the
 * browser by the user's own wallet** — see `lib/polymarket/browser-client.ts`.
 * Signing here would require the user to delegate their embedded wallet to us,
 * granting standing authority to trade without per-order approval, which is
 * precisely what this architecture refuses to hold.
 *
 * What survived that move, and why:
 *  1. **Authentication** — an anonymous caller has no business getting a quote.
 *  2. **Geo gate** — both our tier and, for the caller's benefit, a clear
 *     reason. Advisory by construction: a determined user can sign and submit
 *     to Polymarket directly. That was always true of a client-signed order,
 *     and it is why this was never the only control — **Polymarket enforces
 *     jurisdiction server-side regardless**. Ours exists so a restricted user
 *     sees a real explanation instead of an opaque upstream rejection.
 *  3. **Input validation** — catches malformed input before the user is asked
 *     to sign something they cannot read.
 *  4. **Fee disclosure** — the rate the user is about to pay, from server
 *     config rather than anything the page could tamper with.
 *
 * SEC-2 ("orders rebuilt server-side, never accepted from the client") is
 * narrowed rather than abandoned. Its purpose was to stop a caller dictating
 * price, size and counterparty on someone else's behalf. With client-side
 * signing that attack disappears by construction: an order is only valid if
 * the user's own key signed it, so the worst a tampered page can do is harm
 * the user operating it — never another account.
 */

type OrderRequestBody = {
  tokenId?: unknown;
  side?: unknown;
  /** BUY: USD notional. SELL: share count. */
  amount?: unknown;
  maxSpend?: unknown;
  limitPrice?: unknown;
};

export async function POST(request: Request) {
  try {
    await requireUser();

    const geoTier = request.headers.get("x-geo-tier");
    const body = (await request.json()) as OrderRequestBody;
    const parsed = parseOrderRequest(body);

    if ("error" in parsed) {
      return NextResponse.json(
        { error: "invalid_request", message: parsed.error },
        { status: 400 },
      );
    }

    // Selling is closing a position, which close-only jurisdictions permit.
    if (
      parsed.side === "BUY" &&
      geoTier &&
      !canOpenPositions(geoTier as never)
    ) {
      return NextResponse.json(
        {
          error: "close_only_region",
          tier: geoTier,
          message:
            "You can close existing positions, but cannot open new ones from your location.",
        },
        { status: 451 },
      );
    }

    const env = await serverEnv();
    const builder = describeBuilderConfig(env);

    if (!builder.codeValid) {
      return NextResponse.json(
        {
          error: "builder_not_configured",
          message:
            "Builder code is missing or malformed; orders would earn no attribution.",
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { ok: true, feeBps: builder.feeBps, side: parsed.side },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "preflight_failed", message: safeMessage(error) },
      { status: 502 },
    );
  }
}

type ParsedOrder = {
  tokenId: string;
  side: "BUY" | "SELL";
  amount: string;
  maxSpend?: string;
  limitPrice?: string;
};

function parseOrderRequest(body: OrderRequestBody): ParsedOrder | { error: string } {
  const tokenId = typeof body.tokenId === "string" ? body.tokenId.trim() : "";
  if (!/^\d+$/.test(tokenId)) return { error: "tokenId must be a numeric token id" };

  const side = typeof body.side === "string" ? body.side.toUpperCase() : "";
  if (side !== "BUY" && side !== "SELL") return { error: "side must be BUY or SELL" };

  const amount = asPositiveDecimal(body.amount);
  if (!amount) return { error: "amount must be a positive decimal" };

  const maxSpend = body.maxSpend === undefined ? undefined : asPositiveDecimal(body.maxSpend);
  if (body.maxSpend !== undefined && !maxSpend) {
    return { error: "maxSpend must be a positive decimal" };
  }

  const limitPrice = body.limitPrice === undefined ? undefined : asPositiveDecimal(body.limitPrice);
  if (body.limitPrice !== undefined && !limitPrice) {
    return { error: "limitPrice must be a positive decimal" };
  }
  if (limitPrice && (Number(limitPrice) <= 0 || Number(limitPrice) >= 1)) {
    return { error: "limitPrice must be between 0 and 1 exclusive" };
  }

  return {
    tokenId,
    side,
    amount,
    ...(maxSpend ? { maxSpend } : {}),
    ...(limitPrice ? { limitPrice } : {}),
  };
}

function asPositiveDecimal(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!/^\d*\.?\d+$/.test(text)) return undefined;
  if (Number(text) <= 0) return undefined;
  return text;
}

/** Surfaces an error message without leaking keys or signatures (SEC-4). */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/0x[0-9a-fA-F]{40,}/g, "0x<redacted>");
}
