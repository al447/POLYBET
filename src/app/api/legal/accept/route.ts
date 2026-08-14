import { NextResponse } from "next/server";

import { getAuthProvider, requireUser, UnauthorizedError } from "@/lib/auth/session";
import { ACCEPTANCE_VERSION } from "@/lib/legal/documents";

/**
 * Records the user's acceptance of the legal documents (FR-6.4).
 *
 * The client half of acceptance — Privy's own `hasAcceptedTerms` flag — is set
 * in the browser by `useAcceptTerms()`, because this SDK exposes no server-side
 * equivalent. This route writes the other half: *which revision* was accepted,
 * and when. Both are required to pass the gate (`lib/legal/acceptance.ts`), so
 * a user who sets one and not the other is prompted again rather than let
 * through on a record we cannot produce.
 *
 * ⚠️ **The version comes from the server constant, never from the request
 * body.** A client-supplied version would let a caller record acceptance of a
 * revision they were never shown — which is precisely the evidence this
 * endpoint exists to create, so accepting it from the untrusted side would make
 * the whole record worthless.
 */
export async function POST() {
  try {
    const user = await requireUser();

    const provider = await getAuthProvider();
    if (!provider) {
      // Unreachable in practice — requireUser() resolves through the same
      // provider — but returning 503 beats a non-null assertion on the path
      // that produces a compliance record.
      return NextResponse.json(
        { error: "auth_not_configured", message: "Authentication is not configured." },
        { status: 503 },
      );
    }

    await provider.recordLegalAcceptance(user, ACCEPTANCE_VERSION);

    return NextResponse.json(
      { ok: true, version: ACCEPTANCE_VERSION },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "acceptance_failed", message: safeMessage(error) },
      { status: 502 },
    );
  }
}

/** Surfaces an error message without leaking keys or signatures (SEC-4). Mirrors `api/orders`. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/0x[0-9a-fA-F]{40,}/g, "0x<redacted>");
}
