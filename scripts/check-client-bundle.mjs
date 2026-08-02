#!/usr/bin/env node
/**
 * Credential leak guard (SEC-1, implementation.md Step 1.7).
 *
 * Fails the build if a server-only secret name or a value-shaped token appears
 * in client-side output. Builder credentials reaching the browser would let
 * anyone place attributed orders against the client's builder account, so this
 * is a hard gate rather than a warning.
 *
 * Run after `next build`.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIRS = [".next/static", ".open-next/assets"];

/** Secret NAMES that must never be referenced in client code. */
const FORBIDDEN_NAMES = [
  "POLYMARKET_BUILDER_SECRET",
  "POLYMARKET_BUILDER_PASSPHRASE",
  "POLYMARKET_BUILDER_API_KEY",
  "PRIVY_APP_SECRET",
  "POLYGON_RPC_URL",
];

/** Value shapes that indicate a real secret was inlined. */
const FORBIDDEN_PATTERNS = [
  { name: "private key", re: /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/ },
];

const ALLOWED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".txt", ".map", ".html", ".css"]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const findings = [];
let scanned = 0;

for (const dir of CLIENT_DIRS) {
  for (const file of walk(dir)) {
    const ext = file.slice(file.lastIndexOf("."));
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;

    scanned += 1;
    const content = readFileSync(file, "utf8");

    for (const name of FORBIDDEN_NAMES) {
      if (content.includes(name)) {
        findings.push({ file, kind: "secret name", detail: name });
      }
    }
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      const match = content.match(re);
      if (match) {
        findings.push({ file, kind: name, detail: `${match[0].slice(0, 10)}…` });
      }
    }
  }
}

if (scanned === 0) {
  console.error(
    "check:secrets found no client output to scan.\n" +
      "Run `npm run build` first — a guard that scans nothing proves nothing.",
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`\n✗ Secret material found in client bundle (${findings.length}):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}\n    ${f.kind}: ${f.detail}`);
  }
  console.error(
    "\nServer-only values must be read via getCloudflareContext() inside " +
      "server code, never imported into a Client Component.\n",
  );
  process.exit(1);
}

console.log(`✓ No secret material in client bundle (${scanned} files scanned)`);
