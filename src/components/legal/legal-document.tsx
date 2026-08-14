import type { ReactNode } from "react";
import Link from "next/link";

import { LEGAL_DOCUMENTS, type LegalDocumentId } from "@/lib/legal/documents";

/**
 * Shared shell for the legal pages (FR-6.4).
 *
 * Deliberately plain: narrow measure, generous line height, real heading
 * hierarchy. These are documents people are expected to actually read, and the
 * app's dark trading chrome works against that — so this reads like a document,
 * not like a dashboard panel.
 *
 * No `@tailwindcss/typography` — it isn't a dependency, and adding a plugin to
 * style two static pages costs bundle and build surface for something a dozen
 * utility classes cover.
 */
export function LegalDocumentPage({
  id,
  children,
}: {
  id: LegalDocumentId;
  children: ReactNode;
}) {
  const doc = LEGAL_DOCUMENTS[id];
  const other = id === "terms" ? LEGAL_DOCUMENTS.risk : LEGAL_DOCUMENTS.terms;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <header className="mb-8 border-b border-zinc-800 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="mt-1 text-sm text-zinc-500">Last revised {doc.revised}</p>
      </header>

      <div className="space-y-6 text-sm leading-relaxed text-zinc-300">{children}</div>

      <footer className="mt-10 border-t border-zinc-800 pt-6 text-sm text-zinc-500">
        See also{" "}
        <Link href={other.path} className="text-emerald-400 underline underline-offset-2">
          {other.title}
        </Link>
        .
      </footer>
    </main>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-zinc-100">{heading}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * Marks content the client's counsel must replace. Visually loud on purpose —
 * if a draft ever does reach a user, it should be unmistakable that it is a
 * draft. `npm run check:legal` is what stops it reaching production at all.
 */
export function NeedsCounsel({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
      <strong className="font-semibold">Draft — pending legal review.</strong> {children}
    </p>
  );
}
