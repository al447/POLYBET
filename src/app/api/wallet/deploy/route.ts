import { NextResponse } from "next/server";

import { getAuthProvider, requireUser, UnauthorizedError } from "@/lib/auth/session";
import { MissingBuilderCredentialsError } from "@/lib/polymarket/builder";
import { createUserClient, ensureDepositWallet } from "@/lib/polymarket/clob";
import { serverEnv } from "@/lib/env";

/**
 * Provisions the user's Deposit Wallet (FR-1.2).
 *
 * Deploys gaslessly through the Relayer — the user never needs POL.
 *
 * Each deployment consumes one relay transaction from a daily budget that is
 * only 100 on the Unverified tier, shared across dev, QA and production. The
 * `isWalletDeployed` check inside `ensureDepositWallet` is what stops a retry
 * loop from burning the day's allowance.
 */
export async function POST() {
  try {
    const user = await requireUser();
    const provider = await getAuthProvider();
    if (!provider) {
      return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
    }

    const env = await serverEnv();
    const signer = await provider.createSigner(user);
    const ctx = await createUserClient({ env, signer });
    const result = await ensureDepositWallet(ctx);

    return NextResponse.json({
      address: result.address,
      alreadyDeployed: result.alreadyDeployed,
      transactionHash: result.transactionHash ?? null,
    });
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
      { error: "wallet_provisioning_failed", message: safeMessage(error) },
      { status: 502 },
    );
  }
}

/** Surfaces an error message without leaking keys or signatures (SEC-4). */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/0x[0-9a-fA-F]{40,}/g, "0x<redacted>");
}
