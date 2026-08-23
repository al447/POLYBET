/**
 * A hard ceiling on any single await, for use inside a Suspense boundary.
 *
 * 🚩 This exists because of a specific production failure, not as a general
 * utility. Measured on the deployed Worker 2026-08-23: 18 of 20 requests to
 * `/` never completed. The shell and `FeaturedHero` arrived in under a second
 * and then `DiscoverySection` — the one homepage boundary with no ceiling —
 * simply never resolved, holding the response stream open past Cloudflare's
 * 100s limit and turning into a 504.
 *
 * Every route that was NOT `/` returned in 0.29-1.56s on every sample, which
 * is what rules out the earlier site-wide "colo queueing" diagnosis: a
 * saturated isolate would have made `/terms` slow too, and it never was.
 *
 * The bound is deliberately on the WHOLE operation rather than its parts.
 * Every upstream call underneath is already capped (`gammaFetch` at 6s,
 * `price-history.ts` at 6s) and Gamma answers in ~150ms when probed directly —
 * so the fetches are demonstrably not what runs long. What has no bound is the
 * cache layer beneath them (an R2 read and write per entry, plus a regional
 * Cache API round trip), and a component cannot fix that from the inside. A
 * whole-operation ceiling holds no matter which layer misbehaves.
 *
 * ⚠️ The losing branch is left running on purpose: its cache writes still land,
 * so a render that times out warms the entry for the next visitor instead of
 * wasting the work. **This is the part to suspect if a ceiling fails to fix a
 * hang.** If a dangling promise is itself what holds the stream open, adding
 * more of them helps nothing — the fix is then to abort the losing work rather
 * than orphan it, and this is the one place to change it.
 */
export function withBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
