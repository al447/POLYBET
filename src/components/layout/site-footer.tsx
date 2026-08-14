import Link from "next/link";

import { LEGAL_DOCUMENTS } from "@/lib/legal/documents";

/**
 * Global footer — the persistent home for the legal documents (FR-6.4).
 *
 * Privy renders the same two links inside its signup modal (`config.legal` in
 * `providers.tsx`), which covers the "at signup" half of the requirement. This
 * covers the other half: they have to stay reachable afterwards, from anywhere,
 * without hunting. A user who wants to re-read what they accepted should not
 * have to sign out to find it.
 *
 * The risk line is not decoration. This app's chrome looks like a trading
 * dashboard, and a one-line reminder that positions can expire worthless is the
 * cheapest place to be honest about that on every page.
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-zinc-800/80">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl">
          Prediction markets carry risk. Positions can expire worthless and funds are not insured.
          Not investment advice.
        </p>

        <nav className="flex shrink-0 items-center gap-4">
          <Link
            href={LEGAL_DOCUMENTS.risk.path}
            className="transition hover:text-zinc-400"
          >
            {LEGAL_DOCUMENTS.risk.title}
          </Link>
          <Link
            href={LEGAL_DOCUMENTS.terms.path}
            className="transition hover:text-zinc-400"
          >
            {LEGAL_DOCUMENTS.terms.title}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
