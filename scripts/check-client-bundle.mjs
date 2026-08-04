#!/usr/bin/env node
/**
 * Credential leak guard (SEC-1, implementation.md Step 1.7).
 *
 * Builder credentials reaching the browser would let anyone place attributed
 * orders against the client's builder account, so this is a hard gate rather
 * than a warning.
 *
 * Three checks, each scoped to where it produces signal rather than noise:
 *
 *   1. SOURCE  — no 64-hex private-key literal anywhere in `src/`. Catches a
 *                pasted key at the point of entry, before it can bundle.
 *   2. BUNDLE  — no server-only secret NAME in client output. This is what
 *                catches a server module being dragged into a Client Component.
 *   3. BUNDLE  — no actual secret VALUE from `.dev.vars` in client output.
 *
 * The value-shape check deliberately does NOT run against built output. Privy
 * pulls viem and @noble/curves into the client bundle, which contain 22 distinct
 * high-entropy 64-hex constants (secp256k1 n/Gx/Gy, the P-256 and ed25519
 * parameters, GLV endomorphism constants). Shape alone cannot distinguish those
 * from a real key, and a check that reports 14 findings on a clean build is one
 * everybody learns to scroll past. Checking `src/` instead gives the same
 * protection with zero vendor noise.
 *
 * Run after `next build`.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIRS = [".next/static", ".open-next/assets"];
const SOURCE_DIRS = ["src", "scripts"];

/** Secret NAMES that must never be referenced in client code. */
const FORBIDDEN_NAMES = [
  "POLYMARKET_BUILDER_SECRET",
  "POLYMARKET_BUILDER_PASSPHRASE",
  "POLYMARKET_BUILDER_API_KEY",
  "PRIVY_APP_SECRET",
  "POLYGON_RPC_URL",
];

/** A 32-byte hex value — the shape of a private key or a bytes32 builder code. */
const HEX32 = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

const BUNDLE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".json", ".txt", ".map", ".html", ".css",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"]);

/**
 * Actual secret VALUES from `.dev.vars`, if present.
 *
 * The name check is a proxy; this is the direct question — did a value we hold
 * as a secret end up in client output? It only works locally (CI has no
 * `.dev.vars`), which is exactly where someone is most likely to wire a secret
 * into a Client Component by accident and see it work.
 */
function localSecretValues() {
  if (!existsSync(".dev.vars")) return [];

  const values = [];
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;

    const [, name, raw] = match;
    if (name.startsWith("NEXT_PUBLIC_")) continue;
    // Public by design: the builder code is written into the signed order
    // struct and emitted in the on-chain `OrderFilled` event, and the browser
    // needs it to attribute orders. Flagging it would make this check red for
    // a value that is already on a public blockchain.
    if (name === "POLYMARKET_BUILDER_CODE") continue;

    const value = raw.replace(/^["']|["']$/g, "");
    // Short values collide with minified identifiers; a real credential is
    // never this short.
    if (value.length >= 12) values.push({ name, value });
  }
  return values;
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function* filesIn(dirs, extensions) {
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (extensions.has(file.slice(file.lastIndexOf(".")))) yield file;
    }
  }
}

const SECRET_VALUES = localSecretValues();
const findings = [];

// 1. Source: a private key must never be committed, even to a test fixture.
let sourcesScanned = 0;
for (const file of filesIn(SOURCE_DIRS, SOURCE_EXTENSIONS)) {
  sourcesScanned += 1;
  const content = readFileSync(file, "utf8");
  for (const [match] of content.matchAll(HEX32)) {
    findings.push({
      file,
      kind: "hardcoded 32-byte hex",
      detail: `${match.slice(0, 10)}… — keys and builder codes come from env`,
    });
    break;
  }
}

// 2 & 3. Built client output.
let bundlesScanned = 0;
for (const file of filesIn(CLIENT_DIRS, BUNDLE_EXTENSIONS)) {
  bundlesScanned += 1;
  const content = readFileSync(file, "utf8");

  for (const name of FORBIDDEN_NAMES) {
    if (content.includes(name)) {
      findings.push({ file, kind: "secret name", detail: name });
    }
  }
  for (const { name, value } of SECRET_VALUES) {
    if (content.includes(value)) {
      findings.push({ file, kind: "SECRET VALUE", detail: name });
    }
  }
}

if (bundlesScanned === 0) {
  console.error(
    "check:secrets found no client output to scan.\n" +
      "Run `npm run build` first — a guard that scans nothing proves nothing.",
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`\n✗ Secret material found (${findings.length}):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}\n    ${f.kind}: ${f.detail}`);
  }
  console.error(
    "\nServer-only values must be read via getCloudflareContext() inside " +
      "server code, never imported into a Client Component.\n",
  );
  process.exit(1);
}

console.log(
  `✓ No secret material found ` +
    `(${sourcesScanned} source files, ${bundlesScanned} bundle files, ` +
    `${SECRET_VALUES.length} local secret values cross-checked)`,
);
