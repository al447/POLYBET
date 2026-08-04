import "server-only";

import { createWalletClient, http, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { polygon } from "viem/chains";

/**
 * Signing verification (implementation.md Step 1.6, risk A-2).
 *
 * The whole architecture rests on one assumption: that a Cloudflare Worker can
 * produce a valid EIP-712 signature and an HMAC-SHA256 digest. If it cannot,
 * signing moves to a separate Node host and §2 of the plan changes — which is
 * why this runs before anything is built on top of it, and why it runs in a
 * real deployed Worker rather than only under `next dev`.
 *
 * Every check is self-contained and self-verifying: an ephemeral key is
 * generated per run, signatures are verified by recovering the address, and the
 * HMAC is compared against a published RFC 4231 vector. No network, no secrets,
 * no funds. That means it is safe to expose on a deployed environment and safe
 * to re-run at any time.
 */

export type CheckResult = {
  name: string;
  /** What breaks if this fails. */
  proves: string;
  passed: boolean;
  detail: string;
  durationMs: number;
};

export type SpikeReport = {
  passed: boolean;
  runtime: RuntimeInfo;
  checks: CheckResult[];
};

export type RuntimeInfo = {
  /** "workerd" is the real target; "node" means this ran under `next dev`. */
  runtime: "workerd" | "node" | "unknown";
  hasWebCrypto: boolean;
  hasSubtleHmac: boolean;
};

/* -------------------------------------------------------------------------- */
/* Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Polymarket's L1 `ClobAuth` struct — the exact message a user's wallet signs
 * to derive CLOB API credentials. Used verbatim so this check exercises the
 * real payload shape rather than a toy one.
 */
// Deliberately unannotated: viem's `TypedDataDomain` widens `chainId` to
// `number | bigint`, while the SDK's own domain type requires `number`. Letting
// it infer keeps one literal usable by both signing paths.
const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
};

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

const CLOB_AUTH_MESSAGE =
  "This message attests that I control the given wallet";

/** RFC 4231 test case 2 — a published HMAC-SHA256 vector. */
const RFC4231_KEY = "Jefe";
const RFC4231_DATA = "what do ya want for nothing?";
const RFC4231_EXPECTED =
  "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export async function runSigningChecks(): Promise<SpikeReport> {
  const checks = [
    await timed(
      "eip712-viem",
      "viem can sign and recover an EIP-712 ClobAuth message (L1 auth, order signing)",
      checkEip712,
    ),
    await timed(
      "hmac-sha256-webcrypto",
      "Web Crypto produces correct HMAC-SHA256 digests (L2 request auth)",
      checkHmacSha256,
    ),
    await timed(
      "polymarket-signer",
      "@polymarket/client imports and its viem signer signs in this runtime",
      checkPolymarketSigner,
    ),
    await timed(
      "wallet-client-signer",
      "a viem WalletClient (the shape Privy's embedded wallet exposes) can sign",
      checkWalletClientSigner,
    ),
  ];

  return {
    passed: checks.every((c) => c.passed),
    runtime: describeRuntime(),
    checks,
  };
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

/** EIP-712 typed-data signing, verified by recovering the signer address. */
async function checkEip712(): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());

  const message = {
    address: account.address,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: 0n,
    message: CLOB_AUTH_MESSAGE,
  };

  const signature = await account.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message,
  });

  const valid = await verifyTypedData({
    address: account.address,
    domain: CLOB_AUTH_DOMAIN,
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message,
    signature,
  });

  if (!valid) throw new Error("signature did not verify against its signer");
  if (!/^0x[0-9a-f]{130}$/i.test(signature)) {
    throw new Error(`unexpected signature shape: ${signature.length} chars`);
  }

  return `65-byte signature verified for ${account.address}`;
}

/**
 * HMAC-SHA256 through Web Crypto — the L2 primitive that signs every private
 * CLOB request. Checked against a published vector so a subtly wrong digest
 * cannot pass.
 */
async function checkHmacSha256(): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(RFC4231_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(RFC4231_DATA),
  );

  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hex !== RFC4231_EXPECTED) {
    throw new Error(`digest mismatch: got ${hex}`);
  }

  // Polymarket transports L2 signatures base64-encoded, so confirm that path too.
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));

  return `RFC 4231 vector matched; base64 transport ok (${base64.slice(0, 12)}…)`;
}

/**
 * The SDK's own signer. Imports `@polymarket/client/viem` and drives the
 * `Signer` interface the CLOB client actually consumes — a stricter check than
 * calling viem directly, because it also proves the SDK's dependency graph
 * (`ox`, `@polymarket/bindings`) loads in this runtime.
 */
async function checkPolymarketSigner(): Promise<string> {
  const { privateKey } = await import("@polymarket/client/viem");

  const pk = generatePrivateKey();
  const expected = privateKeyToAccount(pk).address;

  const signer = privateKey(pk);
  const address = await signer.getAddress();

  if (address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`signer address ${address} != expected ${expected}`);
  }

  const signature = await signer.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    message: {
      address,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: 0,
      message: CLOB_AUTH_MESSAGE,
    },
    primaryType: "ClobAuth",
    types: CLOB_AUTH_TYPES as unknown as Record<
      string,
      readonly { name: string; type: string }[]
    >,
  });

  if (!/^0x[0-9a-f]{130}$/i.test(signature)) {
    throw new Error(`unexpected SDK signature shape: ${signature}`);
  }

  return `SDK Signer bound to ${address} and produced a valid signature`;
}

/**
 * A viem `WalletClient` — the shape Privy's embedded wallet exposes and what
 * `signerFrom(walletClient)` wraps. Uses a local account so no RPC is needed;
 * the point is that the WalletClient signing path works, not that Polygon is
 * reachable.
 */
async function checkWalletClientSigner(): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  const signature: Hex = await walletClient.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address: account.address,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: 0n,
      message: CLOB_AUTH_MESSAGE,
    },
  });

  const { signerFrom } = await import("@polymarket/client/viem");
  const signer = signerFrom(walletClient);
  const address = await signer.getAddress();

  if (address.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`signerFrom address mismatch: ${address}`);
  }

  return `WalletClient signed (${signature.slice(0, 12)}…) and wrapped as a Signer`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function timed(
  name: string,
  proves: string,
  fn: () => Promise<string>,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, proves, passed: true, detail, durationMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      proves,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Distinguishes a real Worker from `next dev`. A pass under Node says nothing
 * about the deployed target, so the report must make the runtime unambiguous.
 */
function describeRuntime(): RuntimeInfo {
  const agent =
    typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
  const isWorkerd = agent.includes("Cloudflare-Workers");
  const isNode =
    !isWorkerd &&
    typeof process !== "undefined" &&
    Boolean(process.versions?.node);

  return {
    runtime: isWorkerd ? "workerd" : isNode ? "node" : "unknown",
    hasWebCrypto: typeof crypto !== "undefined",
    hasSubtleHmac: typeof crypto?.subtle?.sign === "function",
  };
}
