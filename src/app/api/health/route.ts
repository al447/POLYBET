import { NextResponse } from "next/server";

import { describeBuilderConfig } from "@/lib/polymarket/builder";
import { hasBuilderCredentials, secretPresence, serverEnv } from "@/lib/env";

/**
 * Health and configuration readiness.
 *
 * Reports whether each secret is PRESENT — never its value (SEC-4). Used as the
 * uptime probe and as the fastest way to see which of P-1..P-9 are still
 * outstanding.
 */
export async function GET() {
  const env = await serverEnv();
  const builder = describeBuilderConfig(env);

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mode: hasBuilderCredentials(env) ? "live" : "mock",
    secrets: secretPresence(env),
    builder: {
      configured: builder.configured,
      codeValid: builder.codeValid,
      feeBps: builder.feeBps,
      caps: builder.caps,
      problems: builder.problems,
    },
  });
}
