#!/usr/bin/env node
/**
 * Fails while any legal page still contains draft content (FR-6.4).
 *
 * The failure this exists to prevent: a Terms of Service skeleton reaching
 * production. Templated contract text reads as a real, binding contract to
 * every user who sees it, and it renders identically to a reviewed one — so
 * unlike most bugs there is no symptom to notice. Nothing else in the pipeline
 * would catch it: it typechecks, it lints, it renders, and the bundle guard
 * only looks for secrets.
 *
 * Sibling of `check-client-bundle.mjs`, and wired into CI the same way. Keep it
 * ahead of `deploy` in the runbook, not after.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Draft content is wrapped in this component — see components/legal/legal-document.tsx. */
const DRAFT_MARKER = "<NeedsCounsel";

const LEGAL_DIRS = ["src/app/terms", "src/app/risk-disclosure"];

function filesIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

const offenders = [];
let scanned = 0;

for (const dir of LEGAL_DIRS) {
  const files = filesIn(dir);
  if (files.length === 0) {
    console.error(`✗ ${dir} is missing or empty — FR-6.4 requires both legal documents.`);
    process.exit(1);
  }
  for (const file of files) {
    scanned += 1;
    const source = readFileSync(file, "utf8");
    const count = source.split(DRAFT_MARKER).length - 1;
    if (count > 0) offenders.push({ file, count });
  }
}

if (offenders.length > 0) {
  console.error("✗ Legal documents still contain unreviewed draft content.\n");
  for (const { file, count } of offenders) {
    console.error(`  ${file} — ${count} unreviewed section${count === 1 ? "" : "s"}`);
  }
  console.error(
    [
      "",
      "Each marks a clause requiring a legal or commercial decision that engineering",
      "cannot make. Replace the content with counsel-approved text and remove the",
      "<NeedsCounsel> wrapper.",
      "",
      "Do NOT simply delete the markers — that ships an unreviewed contract silently,",
      "which is the exact outcome this check exists to prevent.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`✓ Legal documents reviewed — ${scanned} file(s), no draft content.`);
