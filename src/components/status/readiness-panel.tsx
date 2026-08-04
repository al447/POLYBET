import { describeBuilderConfig } from "@/lib/polymarket/builder";
import { hasBuilderCredentials, serverEnv } from "@/lib/env";
import { isAuthConfigured } from "@/lib/auth/public-config";
import { Card, Row, StatusDot } from "@/components/ui/primitives";

/**
 * Build readiness (implementation.md §1).
 *
 * Milestone 1 blocks on credentials the client supplies, not on code. This
 * panel makes the remaining gaps visible on the page instead of buried in a
 * JSON health endpoint, so "what is still missing" is answerable without a
 * terminal.
 *
 * Reports presence only — never a secret value (SEC-4). Remove or gate this
 * before public launch; it is a build-phase instrument, not a user feature.
 */
export async function ReadinessPanel() {
  const env = await serverEnv();
  const builder = describeBuilderConfig(env);
  const live = hasBuilderCredentials(env);

  const feeBps = builder.feeBps;
  const feesUnset = feeBps !== null && feeBps.taker === 0 && feeBps.maker === 0;

  return (
    <Card
      title="Build readiness"
      action={
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            live
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-zinc-700/40 text-zinc-400"
          }`}
        >
          {live ? "live" : "mock mode"}
        </span>
      }
    >
      <div className="space-y-1">
        <Row
          label="Auth (P-6)"
          value={<Presence ok={isAuthConfigured} />}
        />
        <Row
          label="Builder credentials (P-1…P-4)"
          value={<Presence ok={builder.configured} />}
        />
        <Row
          label="Builder fee"
          value={
            feeBps === null ? (
              <span className="text-amber-400">invalid</span>
            ) : feesUnset ? (
              <span
                className="inline-flex items-center gap-1.5 text-amber-400"
                title="Zero fees means zero revenue on attributed volume"
              >
                <StatusDot tone="warn" />0 bps — unset (OI-6)
              </span>
            ) : (
              <span className="text-zinc-200">
                {feeBps.taker} bps taker · {feeBps.maker} bps maker
              </span>
            )
          }
        />
      </div>

      {builder.problems.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-zinc-800 pt-4">
          {builder.problems.map((problem) => (
            <li
              key={problem}
              className="flex items-start gap-2 font-mono text-xs text-zinc-500"
            >
              <span className="mt-1">
                <StatusDot tone="idle" />
              </span>
              {problem}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Presence({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${ok ? "text-emerald-400" : "text-zinc-500"}`}
    >
      <StatusDot tone={ok ? "ok" : "idle"} />
      {ok ? "configured" : "missing"}
    </span>
  );
}
