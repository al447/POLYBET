#!/usr/bin/env node
/**
 * Builder credential provisioning (implementation.md §1, P-1…P-5).
 *
 * Obtains the credentials that move the app out of mock mode. Read this before
 * running anything, because one part of the process is deliberately NOT
 * automated and cannot be:
 *
 *   P-1  builder code        UI ONLY — polymarket.com -> Settings -> Builders
 *   P-2  builder API key     this script (`derive-keys`) or the same panel
 *   P-3  builder secret      ditto — shown ONCE by Polymarket
 *   P-4  builder passphrase  ditto — shown ONCE by Polymarket
 *   P-5  payout wallet       NOT separate — fees go to the profile-owner
 *                            wallet itself. There is no recipient field.
 *
 * The `bytes32` builder code is assigned to a builder *profile*, and a profile
 * is created through the web UI. It is an input to this SDK, never an output:
 * every builder function takes `builderCode?: BuilderCode` as a parameter. A
 * script that "generates builder keys" without a profile produces credentials
 * that attribute nothing and earn nothing.
 *
 * ── Order of operations ────────────────────────────────────────────────────
 *   1. node scripts/provision-builder.mjs new-wallet
 *   2. Register the profile in the UI with that address (see printed steps)
 *   3. node scripts/provision-builder.mjs derive-keys      (if P-2..P-4 unseen)
 *   4. node scripts/provision-builder.mjs verify-fees
 *   5. node scripts/provision-builder.mjs handover
 *
 * ── Handling of the private key (SEC-4) ────────────────────────────────────
 * The key is never printed, never passed as an argv or env var (both leak via
 * shell history and `ps`), and never written inside the repo. It lives in a
 * 0600 file under ~/.polymarket-handover/ and is read from there on demand.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HANDOVER_ROOT = join(homedir(), ".polymarket-handover");
const DEV_VARS = ".dev.vars";

/** Fee rates agreed with the client (OI-6). Caps: taker 100, maker 50. */
const FEE_BPS = { taker: 50, maker: 0 };

const log = (msg = "") => process.stdout.write(`${msg}\n`);
const die = (msg) => {
  process.stderr.write(`\n✗ ${msg}\n\n`);
  process.exit(1);
};

/** Shows enough of a credential to confirm identity, never enough to use it. */
const mask = (value) =>
  !value ? "(empty)" : `${value.slice(0, 6)}…${value.slice(-2)} (${value.length} chars)`;

/* -------------------------------------------------------------------------- */
/* Handover directory                                                         */
/* -------------------------------------------------------------------------- */

function handoverDir() {
  const day = new Date().toISOString().slice(0, 10);
  return join(HANDOVER_ROOT, day);
}

function walletFile() {
  return join(handoverDir(), "wallet.txt");
}

/**
 * Reads the generated key.
 *
 * Refuses a key file that is group- or world-readable rather than silently
 * using it — a 0644 key file on a shared machine is already a disclosure.
 */
function readWalletFile() {
  const path = walletFile();
  if (!existsSync(path)) {
    die(
      `No wallet found at ${path}\n  Run: node scripts/provision-builder.mjs new-wallet`,
    );
  }

  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    die(
      `${path} is mode ${mode.toString(8)} — readable beyond the owner.\n` +
        `  Fix with: chmod 600 "${path}"`,
    );
  }

  const parsed = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) parsed[match[1]] = match[2];
  }
  if (!parsed.PRIVATE_KEY || !parsed.ADDRESS) die(`${path} is malformed.`);
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* .dev.vars                                                                  */
/* -------------------------------------------------------------------------- */

/** Rewrites keys in place, preserving comments, ordering, and unrelated lines. */
function updateDevVars(updates) {
  if (!existsSync(DEV_VARS)) {
    die(`${DEV_VARS} not found. Copy it from .dev.vars.example first.`);
  }

  const lines = readFileSync(DEV_VARS, "utf8").split("\n");
  const remaining = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const key = match[1];
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) rewritten.push(`${key}=${value}`);

  // 0600: this file holds live credentials once populated.
  writeFileSync(DEV_VARS, rewritten.join("\n"), { mode: 0o600 });
}

function readDevVars() {
  if (!existsSync(DEV_VARS)) return {};
  const parsed = {};
  for (const line of readFileSync(DEV_VARS, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) parsed[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* new-wallet                                                                 */
/* -------------------------------------------------------------------------- */

function cmdNewWallet() {
  const dir = handoverDir();
  const path = walletFile();

  if (existsSync(path)) {
    die(
      `A wallet already exists at ${path}\n` +
        `  Refusing to overwrite — that key may already own a builder profile.\n` +
        `  To start over, move it aside first.`,
    );
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);

  // Written, never logged. Everything below prints `account.address` only.
  writeFileSync(
    path,
    [
      "# Polymarket builder profile owner wallet",
      `# Generated ${new Date().toISOString()}`,
      "# THIS FILE CONTROLS THE BUILDER PROFILE. Treat as a live credential.",
      `ADDRESS=${account.address}`,
      `PRIVATE_KEY=${key}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  log();
  log("✓ Builder wallet generated");
  log(`  Address:  ${account.address}`);
  log(`  Key file: ${path}  (0600, outside the repo)`);
  log();
  log("  The private key was not printed and is not in your shell history.");
  log();
  log("── Next: register the builder profile (UI only) ──────────────────────");
  log();
  log("  1. Import the key above into a clean browser profile wallet");
  log("  2. Connect it at polymarket.com and accept the ToS");
  log("     ⚠ Accepting ToS on the client's behalf is a legal act — get");
  log("       written authorization, or have them click it on a screenshare.");
  log("  3. Settings → Builders → set up the builder profile");
  log(`  4. Fee rates: ${FEE_BPS.taker} bps taker, ${FEE_BPS.maker} bps maker`);
  log("  5. ⚠ There is NO payout-wallet field. Commission is paid to THIS");
  log("     address — the profile owner. It cannot be reassigned later, so");
  log("     the profile must be registered on whichever key should own the");
  log("     money permanently.");
  log("  6. Copy the bytes32 builder code into .dev.vars as");
  log("     POLYMARKET_BUILDER_CODE, plus key/secret/passphrase if shown.");
  log();
  log("  Then: node scripts/provision-builder.mjs derive-keys   (if needed)");
  log();
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Authenticates as the builder EOA.
 *
 * `wallet` is passed explicitly, and that detail is load-bearing. Omit it and
 * the SDK targets the signer's deterministic **Deposit Wallet**, which it then
 * tries to deploy during setup — and deployment goes through the Relayer, which
 * demands a builder API key. That is circular when the whole point of the call
 * is to mint the first builder API key:
 *
 *   InvariantError: Deposit Wallet deployment requires a Relayer API Key or
 *   Builder API Key in the client configuration.
 *
 * Passing the signer's own address selects EOA mode, which needs no deployment.
 * Provisioning is an auth operation, not a trading one — it never needs a
 * Deposit Wallet. User trading flows still use the Deposit Wallet path
 * (`createUserClient` in src/lib/polymarket/clob.ts).
 */
async function connect() {
  const { PRIVATE_KEY, ADDRESS } = readWalletFile();
  const { createSecureClient } = await import("@polymarket/client");
  const { privateKey } = await import("@polymarket/client/viem");

  log();
  log(`Authenticating as ${ADDRESS} (EOA mode) …`);

  const client = await createSecureClient({
    signer: privateKey(PRIVATE_KEY),
    wallet: ADDRESS,
  });

  return { client, address: ADDRESS };
}

/* -------------------------------------------------------------------------- */
/* derive-keys                                                                */
/* -------------------------------------------------------------------------- */

async function cmdDeriveKeys() {
  // Builder functions live on the /actions subpath, not the root export.
  // `createApiKey` is a different thing entirely — it mints USER CLOB creds.
  const { createBuilderApiKey, fetchBuilderApiKeys } = await import(
    "@polymarket/client/actions"
  );

  const { client } = await connect();

  // Minting a duplicate is not free — surface what already exists first.
  try {
    const existing = await fetchBuilderApiKeys(client);
    if (Array.isArray(existing) && existing.length > 0) {
      log(`  ${existing.length} builder API key(s) already exist on this profile.`);
    }
  } catch {
    // Not fatal: a profile with no keys yet can legitimately error here.
  }

  const creds = await createBuilderApiKey(client);

  const key = creds.key ?? creds.apiKey;
  if (!key || !creds.secret || !creds.passphrase) {
    die(
      `Unexpected credential shape from createBuilderApiKey: ${Object.keys(creds).join(", ")}`,
    );
  }

  updateDevVars({
    POLYMARKET_BUILDER_API_KEY: key,
    POLYMARKET_BUILDER_SECRET: creds.secret,
    POLYMARKET_BUILDER_PASSPHRASE: creds.passphrase,
  });

  log();
  log("✓ Builder credentials written to .dev.vars");
  log(`  POLYMARKET_BUILDER_API_KEY    ${mask(key)}`);
  log(`  POLYMARKET_BUILDER_SECRET     ${mask(creds.secret)}`);
  log(`  POLYMARKET_BUILDER_PASSPHRASE ${mask(creds.passphrase)}`);
  log();
  log("  Values are masked here on purpose. Polymarket shows the secret and");
  log("  passphrase ONCE — .dev.vars is now the only copy. Back it up to the");
  log("  password manager before doing anything else.");
  log();

  if (readDevVars().POLYMARKET_BUILDER_CODE) {
    log("  P-1..P-4 are all set. Next: verify-fees.");
  } else {
    log("  Still required: POLYMARKET_BUILDER_CODE (P-1), UI only.");
  }
  log();
}

/* -------------------------------------------------------------------------- */
/* status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read-only view of what actually exists on the profile.
 *
 * Mints nothing. Exists because the Builders panel and the API can disagree —
 * a freshly minted key does not always appear in the UI immediately, and
 * "No builder API keys yet" on screen is not evidence that none exist.
 */
async function cmdStatus() {
  const env = readDevVars();
  const { fetchBuilderApiKeys, fetchBuilderFeeRates } = await import(
    "@polymarket/client/actions"
  );

  const { client, address } = await connect();

  log();
  log(`Profile wallet   ${address}`);
  log(`Builder code     ${env.POLYMARKET_BUILDER_CODE || "(not set)"}`);
  log();

  let keys = [];
  try {
    keys = (await fetchBuilderApiKeys(client)) ?? [];
  } catch (error) {
    log(`Builder API keys  could not be read: ${error?.message ?? error}`);
  }

  log(`Builder API keys  ${keys.length}`);
  const configured = env.POLYMARKET_BUILDER_API_KEY;
  for (const entry of keys) {
    const id = String(typeof entry === "string" ? entry : entry.key);
    const mine = id === configured ? "  ← in .dev.vars" : "";
    const revoked = entry?.revokedAt ? "  REVOKED" : "";
    log(`  ${id.slice(0, 8)}…${revoked}${mine}`);
  }
  if (configured && !keys.some((e) => String(typeof e === "string" ? e : e.key) === configured)) {
    log(`  ⚠ the key in .dev.vars (${configured.slice(0, 8)}…) is NOT on this profile`);
  }

  if (env.POLYMARKET_BUILDER_CODE) {
    const rates = await fetchBuilderFeeRates(client, {
      builderCode: env.POLYMARKET_BUILDER_CODE,
    });
    log();
    log("Fee rates         Polymarket   .dev.vars");
    log(`  taker           ${String(rates.taker).padEnd(12)} ${env.BUILDER_FEE_BPS_TAKER ?? "?"}`);
    log(`  maker           ${String(rates.maker).padEnd(12)} ${env.BUILDER_FEE_BPS_MAKER ?? "?"}`);
  }
  log();
}

/* -------------------------------------------------------------------------- */
/* verify-fees                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Confirms the rates Polymarket has on file match what this app charges.
 *
 * A mismatch is not cosmetic: `BUILDER_FEE_BPS_*` drives every fee figure the
 * user is shown before they commit, while the profile rate is what actually
 * gets taken. Disagreement means the disclosed number is a lie.
 */
async function cmdVerifyFees() {
  const env = readDevVars();
  const builderCode = env.POLYMARKET_BUILDER_CODE;

  if (!builderCode) {
    die("POLYMARKET_BUILDER_CODE is not set in .dev.vars (P-1, UI only).");
  }

  const { fetchBuilderFeeRates } = await import("@polymarket/client/actions");

  const { client } = await connect();
  const remote = await fetchBuilderFeeRates(client, { builderCode });

  const localTaker = Number(env.BUILDER_FEE_BPS_TAKER ?? NaN);
  const localMaker = Number(env.BUILDER_FEE_BPS_MAKER ?? NaN);

  // The SDK schema transforms the wire fields (`builder_taker_fee_rate_bps`,
  // `builder_maker_fee_rate_bps`) into `{ taker, maker }` before we see them.
  const { taker: remoteTaker, maker: remoteMaker } = remote;

  if (typeof remoteTaker !== "number" || typeof remoteMaker !== "number") {
    die(
      `Unexpected fee-rate shape from fetchBuilderFeeRates: ${JSON.stringify(remote)}`,
    );
  }

  log();
  log("Builder fee rates");
  log(`  taker   .dev.vars ${localTaker}  ·  Polymarket ${remoteTaker}`);
  log(`  maker   .dev.vars ${localMaker}  ·  Polymarket ${remoteMaker}`);
  log();

  if (localTaker !== remoteTaker || localMaker !== remoteMaker) {
    die(
      "Fee rates disagree. Every fee shown to a user would be wrong.\n\n" +
        "  Before treating this as a config error, check Settings → Builders for a\n" +
        "  PENDING change. Rate edits take ~4 days to take effect, and this API\n" +
        "  returns the EFFECTIVE rate only — so a correctly-entered rate still\n" +
        "  reports the old value until its effective date passes.\n\n" +
        "  Otherwise: fix the profile, or correct .dev.vars. Remember the panel\n" +
        "  takes PERCENT (0.5) where this repo uses bps (50).\n\n" +
        `  Effective now: ${JSON.stringify(remote)}`,
    );
  }

  log("✓ Rates agree.");
  log();
}

/* -------------------------------------------------------------------------- */
/* handover                                                                   */
/* -------------------------------------------------------------------------- */

function cmdHandover() {
  const { ADDRESS, PRIVATE_KEY } = readWalletFile();
  const env = readDevVars();
  const path = join(handoverDir(), "HANDOVER.md");

  const doc = `# Polymarket Builder Account — Ownership Handover

Generated ${new Date().toISOString()}

## What this is

Everything needed to take full ownership of the Polymarket builder profile
behind your prediction-market platform. Whoever holds the private key below
controls the builder profile and its fee configuration.

## Builder profile owner wallet

| | |
|---|---|
| Address | \`${ADDRESS}\` |
| Private key | \`${PRIVATE_KEY}\` |
| Network | Polygon Mainnet (chain 137) |

## Builder configuration

| | |
|---|---|
| Builder code (P-1) | \`${env.POLYMARKET_BUILDER_CODE || "NOT YET REGISTERED"}\` |
| Taker fee | ${env.BUILDER_FEE_BPS_TAKER ?? FEE_BPS.taker} bps (${(Number(env.BUILDER_FEE_BPS_TAKER ?? FEE_BPS.taker) / 100).toFixed(2)}%) |
| Maker fee | ${env.BUILDER_FEE_BPS_MAKER ?? FEE_BPS.maker} bps |
| Commission is paid to | \`${ADDRESS}\` — the wallet above |

The API key, secret, and passphrase are delivered separately through the
password manager. They are not written here.

## Read this before you do anything else

**All commission revenue is paid to the wallet above.** Polymarket has no
separate payout setting — fees go to whichever wallet owns the builder profile,
and that cannot be reassigned afterwards.

This wallet was generated on the developer's machine, so **the developer has
seen its private key**. It was never printed to a terminal or sent over chat,
and the local copy is deleted after your confirmation — but a private key cannot
be rotated, only abandoned, and deletion on a modern SSD is not provable.

So the key that controls your revenue has been seen by someone outside your
organisation. You have two options:

1. **Accept it** — take custody now, store the key in your password manager, and
   sweep earnings to your own treasury wallet regularly.
2. **Re-register on a key only you have ever seen** — generate a wallet
   yourself, set up a fresh builder profile under it, and we repoint the
   platform at the new builder code.

**Option 2 is dramatically cheaper right now than later.** Re-registering costs
a new builder code and new API credentials, and forfeits attributed volume
history — which is currently zero. Once real volume accrues, that history is
what the Verified tier application rests on, and the cost of moving rises
sharply.

## Then

1. **Store the private key in your password manager**, then confirm receipt.
2. Tell us which option above you want.

Do not reuse this wallet for personal funds.
`;

  writeFileSync(path, doc, { mode: 0o600 });

  log();
  log("✓ Handover document written");
  log(`  ${path}  (0600)`);
  log();
  log("  Deliver by password-manager share — never chat, email, or Privnote");
  log("  (implementation.md §1.2). It contains the private key in plaintext.");
  log();
  log("  After the client confirms receipt:");
  log(`    rm -rf "${handoverDir()}"`);
  log();
}

/* -------------------------------------------------------------------------- */

const COMMANDS = {
  "new-wallet": cmdNewWallet,
  "derive-keys": cmdDeriveKeys,
  status: cmdStatus,
  "verify-fees": cmdVerifyFees,
  handover: cmdHandover,
};

const command = process.argv[2];
const run = COMMANDS[command];

if (!run) {
  log("Usage: node scripts/provision-builder.mjs <command>");
  log();
  log("  new-wallet    Generate the builder profile owner wallet");
  log("  derive-keys   Mint builder API credentials (P-2..P-4) for that wallet");
  log("  status        Read-only: keys and fee rates actually on the profile");
  log("  verify-fees   Assert Polymarket's fee rates match .dev.vars");
  log("  handover      Write the client ownership document");
  log();
  log("  P-1, the bytes32 builder code, is UI only:");
  log("  polymarket.com → Settings → Builders");
  log();
  process.exit(command ? 1 : 0);
}

await run();
