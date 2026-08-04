import { NextResponse } from "next/server";

import { runSigningChecks } from "@/lib/polymarket/signing-spike";

/**
 * Signing verification probe (implementation.md Step 1.6).
 *
 * Must return `passed: true` with `runtime: "workerd"` before order signing is
 * built on top of Workers. A pass under `next dev` reports `runtime: "node"`
 * and does NOT satisfy the acceptance check — the whole point is the deployed
 * target, so the runtime is echoed back rather than assumed.
 *
 * Safe to leave enabled: every key is ephemeral and generated per request, no
 * secret is read, no network call is made, and nothing is submitted anywhere.
 */
export async function GET() {
  const report = await runSigningChecks();

  return NextResponse.json(report, {
    status: report.passed ? 200 : 500,
    headers: { "cache-control": "no-store" },
  });
}
