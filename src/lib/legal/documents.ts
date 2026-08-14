/**
 * Legal document registry (FR-6.4).
 *
 * Single source of truth for what the user is asked to accept, where it lives,
 * and which revision they accepted. Kept as data rather than scattered through
 * JSX because three separate things need to agree on it: the pages themselves,
 * Privy's signup-modal footer links (`config.legal` in `providers.tsx`), and —
 * next increment — the acceptance record written to Privy custom metadata.
 *
 * ⚠️ **`ACCEPTANCE_VERSION` is what re-prompts every user.** Bump it whenever
 * either document changes in a way a user would want to know about; leave it
 * alone for typo fixes. A stored acceptance that doesn't match the current
 * value is treated as no acceptance at all, so bumping it casually means
 * re-interrupting your entire user base.
 */

export type LegalDocumentId = "terms" | "risk";

export type LegalDocument = {
  id: LegalDocumentId;
  title: string;
  /** Route path — also what Privy's modal footer links to. */
  path: string;
  /** Human-facing revision date shown on the page itself. */
  revised: string;
};

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  terms: {
    id: "terms",
    title: "Terms of Service",
    path: "/terms",
    revised: "2026-08-15",
  },
  risk: {
    id: "risk",
    title: "Risk Disclosure",
    path: "/risk-disclosure",
    revised: "2026-08-15",
  },
};

/** Bump to re-prompt every user for acceptance. See the warning above. */
export const ACCEPTANCE_VERSION = "2026-08-15";

/**
 * Draft content is marked with the `<NeedsCounsel>` component
 * (`components/legal/legal-document.tsx`), and `npm run check:legal` fails
 * when any survives in `src/app/terms/` or `src/app/risk-disclosure/`.
 *
 * That guard is the point of the whole arrangement: a templated Terms of
 * Service that reaches production reads as a real contract to every user who
 * sees it, and nothing else in the pipeline would catch it. Deleting the marker
 * without replacing the text defeats the guard — replace the text.
 */
