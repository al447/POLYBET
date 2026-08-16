"use client";

import { useCallback, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy, useAcceptTerms, useUser } from "@privy-io/react-auth";

import { isAuthConfigured } from "@/lib/auth/public-config";
import { ACCEPTANCE_VERSION, LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import { needsAcceptance, readAcceptance } from "@/lib/legal/acceptance";

/**
 * Blocking acceptance step for the legal documents (FR-6.4).
 *
 * Sits between login and the app: a signed-in user who has not accepted the
 * current revision sees this instead of whatever they navigated to. That is the
 * literal reading of "at signup", and it means nobody reaches a trading UI
 * having acknowledged nothing.
 *
 * **Three cases deliberately pass straight through:**
 *
 *  1. **The legal pages themselves.** Blocking `/terms` and `/risk-disclosure`
 *     behind an acceptance prompt would ask the user to accept documents they
 *     cannot open — the gate links to them, so it must not gate them.
 *  2. **Mock mode** (`!isAuthConfigured`). No Privy provider is mounted, so the
 *     hooks below have no context and there is no user to record against. Same
 *     convention as `providers.tsx`: the app must keep rendering without P-6.
 *  3. **Signed-out visitors.** Nothing to accept yet, and nowhere to store it.
 *     They meet this gate on their first login instead.
 *
 * Acceptance is two writes and **both must succeed**: Privy's own flag via
 * `useAcceptTerms()`, then our versioned record via `/api/legal/accept`. If the
 * second fails the gate stays closed and reports it, because a Privy flag
 * without our version record would let the user through on the next load with
 * no evidence of *what* they accepted — which is the entire point of the record.
 */
export function AcceptanceGate({ children }: { children: ReactNode }) {
  if (!isAuthConfigured) return <>{children}</>;
  return <PrivyAcceptanceGate>{children}</PrivyAcceptanceGate>;
}

/**
 * Split out so the Privy hooks are never called in mock mode — hooks cannot be
 * called conditionally, and `<PrivyProvider>` isn't mounted there. Same
 * split as `AccountPanel` / `PrivyAccountPanel`.
 */
function PrivyAcceptanceGate({ children }: { children: ReactNode }) {
  const { ready, authenticated, user } = usePrivy();
  const { acceptTerms } = useAcceptTerms();
  const { refreshUser } = useUser();
  const pathname = usePathname();

  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Privy's flag first: it is the one the server reads off the identity
      // token, so a failure here must not leave our version record claiming an
      // acceptance that Privy doesn't corroborate.
      await acceptTerms();

      const response = await fetch("/api/legal/accept", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Couldn't record your acceptance.");
      }

      /**
       * 🚩 **Both writes have landed on Privy, and the server still can't see
       * them.** The accepted revision reaches the server as a `custom_metadata`
       * claim on the **identity token** (`privy-id-token`), which was minted at
       * login — so it carries the pre-acceptance bag until it rotates.
       *
       * Symptom without this: the gate closes, the user reaches the trading UI,
       * and the first order comes back 451 `terms_not_accepted` — "Please
       * accept the Terms of Service and Risk Disclosure before trading" — for
       * someone who just did exactly that. `refreshUser()` is documented as
       * updating "the user object and identity token in the client", which is
       * the missing step.
       *
       * (The *other* half of that bug lived server-side: the gate also checked
       * Privy's `hasAcceptedTerms`, which no identity token can carry. See
       * `userNeedsAcceptance`.)
       *
       * Left inside the `try` on purpose: if it fails, acceptance really isn't
       * usable yet, so keeping the gate open with an error beats waving the
       * user through into a trading surface that will reject them. Retrying is
       * safe — every step here is idempotent.
       */
      await refreshUser();

      // Belt and braces alongside the refresh: `needsAcceptance` below should
      // now return false on its own, but this doesn't depend on the refreshed
      // user having propagated into `usePrivy()`'s cache this render.
      setAccepted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record your acceptance.");
    } finally {
      setSubmitting(false);
    }
  }, [acceptTerms, refreshUser]);

  const isLegalPage =
    pathname === LEGAL_DOCUMENTS.terms.path || pathname === LEGAL_DOCUMENTS.risk.path;

  // Render nothing rather than a flash of the gate while Privy resolves the
  // session — `ready` is false for a beat on every load, and treating that as
  // "not accepted" would blink a legal prompt at users who already accepted.
  if (!ready) return <>{children}</>;
  if (!authenticated || !user) return <>{children}</>;
  if (isLegalPage || accepted) return <>{children}</>;

  const state = readAcceptance(user.customMetadata, user.hasAcceptedTerms);
  if (!needsAcceptance(state, ACCEPTANCE_VERSION)) return <>{children}</>;

  const returning = state.version !== null;

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-12">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
        <h1 className="text-lg font-semibold tracking-tight">
          {returning ? "We've updated our terms" : "Before you start trading"}
        </h1>

        <p className="mt-2 text-sm text-zinc-400">
          {returning
            ? "Our Terms of Service and Risk Disclosure have changed since you last accepted. Please review and accept the current versions to continue."
            : "Please read both documents before continuing. Prediction market positions can expire worthless, funds are not insured, and withdrawals cannot be reversed."}
        </p>

        <ul className="mt-4 space-y-2">
          {[LEGAL_DOCUMENTS.terms, LEGAL_DOCUMENTS.risk].map((doc) => (
            <li key={doc.id}>
              <Link
                href={doc.path}
                className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2.5 text-sm text-zinc-200 transition hover:border-zinc-700 hover:bg-zinc-900/60"
              >
                <span className="font-medium">{doc.title}</span>
                <span className="text-xs text-zinc-500">Read →</span>
              </Link>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={() => void accept()}
          disabled={submitting}
          className="mt-5 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
        >
          {submitting ? "Recording…" : "I have read and accept both documents"}
        </button>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        ) : null}

        <p className="mt-3 text-xs text-zinc-600">
          Accepting records your agreement to version {ACCEPTANCE_VERSION} of both documents against
          your account.
        </p>
      </div>
    </main>
  );
}
