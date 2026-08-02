#!/usr/bin/env node
/**
 * Milestone 1 acceptance smoke test.
 *
 * Run this the moment the client supplies P-1..P-5. It exercises the single
 * chain that the entire commercial premise depends on:
 *
 *   credentials -> CLOB auth -> Deposit Wallet -> signed attributed order
 *   -> the fill appearing under our builder code
 *
 * If the last step fails, the platform can trade but earns nothing, which is
 * why it is pulled forward into Milestone 1 rather than left to Week 3.
 *
 * Usage:
 *   POLYMARKET_PRIVATE_KEY=0x...    # a funded test wallet (~$5 pUSD is plenty)
 *   POLYMARKET_BUILDER_CODE=0x...
 *   npm run smoke:builder -- --token <tokenId> [--amount 1] [--live]
 *
 * Without --live it stops before placing a real order. There is no testnet for
 * the production CLOB, so the final step spends real money — it is opt-in.
 */

import { createSecureClient, OrderSide } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
import {
  deployDepositWallet,
  isWalletDeployed,
  listBuilderTrades,
} from "@polymarket/client/actions";

const args = parseArgs(process.argv.slice(2));

const BUILDER_CODE = process.env.POLYMARKET_BUILDER_CODE;
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

let step = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
};
const heading = (msg) => console.log(`\n[${++step}] ${msg}`);

async function main() {
  console.log("Milestone 1 — builder attribution smoke test\n");

  /* 1. Credentials ------------------------------------------------------- */
  heading("Credentials");
  if (!BUILDER_CODE) {
    fail("POLYMARKET_BUILDER_CODE is not set (P-1)");
    return finish();
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(BUILDER_CODE)) {
    fail("POLYMARKET_BUILDER_CODE is not a 32-byte hex string");
    return finish();
  }
  pass("builder code present and well-formed");

  if (!PRIVATE_KEY) {
    fail("POLYMARKET_PRIVATE_KEY is not set (funded test wallet required)");
    return finish();
  }
  pass("signer key present");

  /* 2. CLOB auth (L1 -> L2) --------------------------------------------- */
  heading("CLOB authentication");
  const client = await createSecureClient({ signer: privateKey(PRIVATE_KEY) });
  pass("EIP-712 ClobAuth signed and L2 credentials derived");

  /* 3. Deposit Wallet ---------------------------------------------------- */
  heading("Deposit Wallet");
  const deployed = await isWalletDeployed(client);
  if (deployed) {
    pass("Deposit Wallet already deployed (no relay transaction spent)");
  } else if (!args.live) {
    console.log("  – not deployed; skipping (pass --live to deploy)");
  } else {
    const handle = await deployDepositWallet(client);
    await handle.wait();
    pass("Deposit Wallet deployed gaslessly via Relayer");
  }

  /* 4. Attributed order -------------------------------------------------- */
  heading("Builder-attributed order");
  if (!args.token) {
    console.log("  – no --token given; skipping order placement");
  } else if (!args.live) {
    console.log("  – dry run; pass --live to place a REAL order (spends money)");
  } else {
    const response = await client.placeMarketOrder({
      tokenId: args.token,
      side: OrderSide.BUY,
      amount: args.amount ?? "1",
      builderCode: BUILDER_CODE,
    });
    pass(`order placed: ${JSON.stringify(response).slice(0, 160)}`);
  }

  /* 5. Attribution ------------------------------------------------------- */
  heading("Attribution");
  const trades = listBuilderTrades(client, { builderCode: BUILDER_CODE });
  const page = await trades.next?.() ?? await firstPage(trades);
  const count = countTrades(page);

  if (count > 0) {
    pass(`${count} trade(s) attributed to this builder code`);
    console.log("\n✓ Milestone 1 acceptance: builder attribution CONFIRMED");
  } else {
    console.log("  – no attributed trades yet");
    console.log(
      "\n  Attribution can take up to 24h to appear. If an order was just\n" +
        "  placed, re-run this step later before treating it as a failure.",
    );
  }

  finish();
}

async function firstPage(paginated) {
  if (Array.isArray(paginated)) return paginated;
  if (typeof paginated?.[Symbol.asyncIterator] === "function") {
    for await (const page of paginated) return page;
  }
  return paginated;
}

function countTrades(page) {
  if (Array.isArray(page)) return page.length;
  if (Array.isArray(page?.data)) return page.data.length;
  if (Array.isArray(page?.value)) return page.value.length;
  return 0;
}

function parseArgs(argv) {
  const out = { live: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--live") out.live = true;
    else if (argv[i] === "--token") out.token = argv[++i];
    else if (argv[i] === "--amount") out.amount = argv[++i];
  }
  return out;
}

function finish() {
  if (process.exitCode) {
    console.error("\n✗ Smoke test failed. See implementation.md section 1.");
  }
}

main().catch((error) => {
  console.error("\n✗ Unexpected failure:", error?.message ?? error);
  process.exit(1);
});
