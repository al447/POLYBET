import { NextResponse } from "next/server";

import { getAuthProvider, requireUser, UnauthorizedError } from "@/lib/auth/session";
import { MissingBuilderCredentialsError } from "@/lib/polymarket/builder";
import {
  createUserClient,
  isAccountCloseOnly,
  placeMarketBuy,
  placeMarketSell,
} from "@/lib/polymarket/clob";
import { canOpenPositions } from "@/lib/geo/jurisdictions";
import { serverEnv } from "@/lib/env";

/**
 * Order placement (FR-3.5) — the security-critical route.
 *
 * Rules, in order:
 *  1. Authenticate.
 *  2. Re-check geo, both our tier and Polymarket's own closed-only flag. The
 *     proxy gate already ran, but a route that moves money does not trust an
 *     upstream header as its only control.
 *  3. Rebuild the order from primitives. The client sends tokenId/side/amount,
 *     never a constructed or signed order — accepting one would let a caller
 *     dictate price, size and counterparty.
 *  4. Attach the builder code and sign server-side.
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
    const user = await requireUser();

    const geoTier = request.headers.get("x-geo-tier");
    if (geoTier && !canOpenPositions(geoTier as never)) {
      return NextResponse.json(
        { error: "close_only_region", tier: geoTier },
        { status: 451 },
      );
    }

    const body = (await request.json()) as OrderRequestBody;
    const parsed = parseOrderRequest(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: "invalid_request", message: parsed.error }, { status: 400 });
    }

    const provider = await getAuthProvider();
    if (!provider) {
      return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
    }

    const env = await serverEnv();
    const signer = await provider.createSigner(user);
    const ctx = await createUserClient({ env, signer });

    // Upstream truth: the account itself may be restricted for reasons
    // unrelated to request IP.
    if (await isAccountCloseOnly(ctx)) {
      if (parsed.side === "BUY") {
        return NextResponse.json(
          { error: "account_close_only" },
          { status: 451 },
        );
      }
    }

    const result =
      parsed.side === "BUY"
        ? await placeMarketBuy(ctx, {
            tokenId: parsed.tokenId,
            amount: parsed.amount,
            ...(parsed.maxSpend ? { maxSpend: parsed.maxSpend } : {}),
            ...(parsed.limitPrice ? { maxPrice: parsed.limitPrice } : {}),
          })
        : await placeMarketSell(ctx, {
            tokenId: parsed.tokenId,
            shares: parsed.amount,
            ...(parsed.limitPrice ? { minPrice: parsed.limitPrice } : {}),
          });

    return NextResponse.json({ ok: true, order: result });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (error instanceof MissingBuilderCredentialsError) {
      return NextResponse.json(
        { error: "builder_not_configured", message: error.message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "order_failed", message: safeMessage(error) },
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

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/0x[0-9a-fA-F]{40,}/g, "0x<redacted>");
}
