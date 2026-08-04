import { NextResponse } from "next/server";

import { getAuthProvider, requireUser, UnauthorizedError } from "@/lib/auth/session";
import { MissingBuilderCredentialsError } from "@/lib/polymarket/builder";
import { createUserClient, readWalletStatus } from "@/lib/polymarket/clob";
import { serverEnv } from "@/lib/env";

/**
 * Read-only Deposit Wallet state (FR-1.2, FR-1.4).
 *
 * Deliberately separate from `POST /api/wallet/deploy`: the deposit screen
 * polls this while waiting for funds to arrive, and a polling endpoint that
 * could deploy would burn the 100/day relay allowance in minutes. Nothing here
 * spends quota or signs a transaction.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const provider = await getAuthProvider();
    if (!provider) {
      return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
    }

    const env = await serverEnv();
    const signer = await provider.createSigner(user);
    const ctx = await createUserClient({ env, signer });
    const status = await readWalletStatus(ctx);

    return NextResponse.json(
      {
        address: status.address,
        deployed: status.deployed,
        balance: status.balance,
        signerAddress: user.signerAddress,
      },
      { headers: { "cache-control": "no-store" } },
    );
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
      { error: "wallet_status_failed", message: safeMessage(error) },
      { status: 502 },
    );
  }
}

/** Surfaces an error message without leaking keys or signatures (SEC-4). */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/0x[0-9a-fA-F]{40,}/g, "0x<redacted>");
}
