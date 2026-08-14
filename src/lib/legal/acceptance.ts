/**
 * Acceptance state for the legal documents (FR-6.4).
 *
 * Pure — no client, no network — so the decision "must this user be prompted?"
 * is unit-testable in isolation, the same way `fees.ts`, `redeem.ts` and
 * `activity.ts` keep their logic out of their I/O.
 *
 * **Acceptance is recorded in two places, deliberately.** Privy owns a
 * first-class `hasAcceptedTerms` boolean, set through its `useAcceptTerms()`
 * hook (documented for whitelabel flows where terms are accepted outside
 * Privy's own modal — exactly our case). That flag is readable server-side off
 * the identity token we already verify, so the common path costs no extra API
 * call. But it is a bare boolean: it cannot say *which revision* was accepted,
 * and it says "terms" where we also require the Risk Disclosure. The version
 * therefore rides alongside it in Privy custom metadata, and **both must agree**
 * for a user to pass.
 *
 * ⚠️ Privy's `CustomMetadata` is a flat bag of `string | number | boolean` —
 * no nested objects. Hence two scalar keys rather than one structured record.
 */

/** Metadata keys. Namespaced, because the bag is shared with anything else that writes to it. */
export const ACCEPTED_VERSION_KEY = "legal_accepted_version";
export const ACCEPTED_AT_KEY = "legal_accepted_at";

export type AcceptanceState = {
  /** Privy's own flag, set via `useAcceptTerms()`. */
  hasAcceptedTerms: boolean;
  /** The revision the user accepted, or `null` when we have no record. */
  version: string | null;
  /** ISO timestamp of acceptance, or `null`. Evidence only — never gates anything. */
  acceptedAt: string | null;
};

/**
 * Reads acceptance out of Privy's flat metadata bag.
 *
 * Defensive about types on purpose: the bag is writable by anything holding the
 * app secret, and `CustomMetadata` permits numbers and booleans in every slot.
 * A non-string where a version is expected reads as "no record" rather than
 * being coerced — a version of `"true"` or `"0"` would silently compare unequal
 * forever and lock the user in a prompt loop with no way to diagnose it.
 */
export function readAcceptance(
  metadata: Record<string, string | number | boolean> | undefined,
  hasAcceptedTerms: boolean,
): AcceptanceState {
  return {
    hasAcceptedTerms,
    version: readString(metadata?.[ACCEPTED_VERSION_KEY]),
    acceptedAt: readString(metadata?.[ACCEPTED_AT_KEY]),
  };
}

/**
 * Whether the user must be prompted before using the app.
 *
 * Fails closed on both counts: a missing Privy flag *or* a version that isn't
 * the current one means "not accepted". The version comparison is what makes
 * bumping `ACCEPTANCE_VERSION` (see `documents.ts`) re-prompt the entire user
 * base — which is the intended behaviour when a document materially changes,
 * and the reason that constant carries a warning not to bump it casually.
 */
export function needsAcceptance(state: AcceptanceState, currentVersion: string): boolean {
  if (!state.hasAcceptedTerms) return true;
  return state.version !== currentVersion;
}

/**
 * Same decision, taken straight from a verified session.
 *
 * `AuthenticatedUser` already carries both gating fields — `verifySession`
 * parsed them out of the identity token — so server callers should use this
 * rather than reconstructing an `AcceptanceState` around a metadata bag they
 * do not have. Passing `undefined` metadata to `readAcceptance` on a route
 * would silently drop the version half of the check and let a stale acceptance
 * through.
 */
export function userNeedsAcceptance(
  user: { hasAcceptedTerms: boolean; legalVersion: string | null },
  currentVersion: string,
): boolean {
  return needsAcceptance(
    { hasAcceptedTerms: user.hasAcceptedTerms, version: user.legalVersion, acceptedAt: null },
    currentVersion,
  );
}

function readString(value: string | number | boolean | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
