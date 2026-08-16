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
 * Same decision, taken from a verified session — **on the version alone.**
 *
 * 🚩 **Privy's `hasAcceptedTerms` does not survive into an identity token, so
 * the server cannot read it.** `parseUserFromIdentityTokenPayload` in
 * `@privy-io/node` builds its `User` with a literal `has_accepted_terms:
 * false` — the claim simply isn't in the JWT, and the SDK fills the field with
 * a constant. Checking it server-side therefore fails **every** user forever,
 * however many times they accept: the gate closes, and the next order comes
 * back 451 `terms_not_accepted`. That is a real bug this project shipped, not
 * a hypothetical.
 *
 * Gating on the version instead is not a weakening. The version is written
 * only by `/api/legal/accept`, behind `requireUser()`, into Privy custom
 * metadata — a bag the browser has no API to write, since `setCustomMetadata`
 * requires the app secret. So it is server-controlled evidence, where the
 * boolean is a flag the client sets on itself. It also says *which* revision
 * was accepted, which the boolean never could.
 *
 * The client-side gate still checks both (`needsAcceptance`), because there
 * the flag comes from Privy's real user object and is genuine.
 */
export function userNeedsAcceptance(
  user: { legalVersion: string | null },
  currentVersion: string,
): boolean {
  return user.legalVersion !== currentVersion;
}

function readString(value: string | number | boolean | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
