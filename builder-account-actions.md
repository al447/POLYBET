# Polymarket Builder Account — Outstanding Actions

> **Created:** 2026-08-15 · Checked against the live account config on that date.
> Scope: the **non-code** side of the Builder Program — profile, credentials, fee rate, tier, ownership.
> Related: [deployment.md](deployment.md) §7 (operational limits) · [implementation.md](implementation.md) §1 (credentials checklist) · [CLAUDE.md](CLAUDE.md) (builder fees, tiers, traps)

## Status at a glance

| # | Item | State |
|---|---|---|
| 0 | `handoverDir()` date bug in the provisioning script | 🚩 blocks items 3 and 4 |
| 1 | Builder profile ownership → client | ⏸ scheduled, held by developer by decision |
| 2 | Verified tier application | 🔴 never submitted — longest pole |
| 3 | Profile fee rate effective + matching `.dev.vars` | ⚠️ never confirmed |
| 4 | Milestone 1 acceptance order on mainnet | ⚠️ never run |

## Already done — no action needed

- **P-1 builder code** — set (66-char `bytes32`), pushed as a Cloudflare secret and exported at build time.
- **P-2 / P-3 / P-4 API key, secret, passphrase** — all set locally and pushed as secrets.
- **P-5 payout wallet** — resolved 2026-08-04: there is no configurable payout wallet, fees go to the profile owner. Not a separate item.
- **Fee rate decision (OI-6)** — 50 bps taker / 0 bps maker, in `.dev.vars` as `BUILDER_FEE_BPS_TAKER=50`, `BUILDER_FEE_BPS_MAKER=0`.

---

## 0. 🚩 Code fix — do this first, or every command below misfires

`handoverDir()` in [scripts/provision-builder.mjs](scripts/provision-builder.mjs) (lines 61-64) resolves to `~/.polymarket-handover/<today>`, recomputed on every run with **no override** — the script only ever reads `process.argv[2]` (the command name).

The profile-owner wallet was generated on **2026-08-04**. So on any other day, `status`, `verify-fees` and `handover` all fail at `readWalletFile()` with:

```
No wallet found at ~/.polymarket-handover/<today>/wallet.txt
  Run: node scripts/provision-builder.mjs new-wallet
```

**That instruction is the dangerous path.** `new-wallet` generates a *different* EOA which owns no builder profile. Minting credentials against it produces keys that attribute nothing, while the real profile — its code, its keys, and its accrued volume history — stays behind on the 2026-08-04 wallet.

**Fix:** in `handoverDir()`, fall back to the most recent existing dated directory when today's is absent, plus a `HANDOVER_DATE` env override. Contained to that one function.

**Do not** work around this by copying the key into a new dated folder each day — that multiplies copies of the private key that controls all commission revenue.

---

## 1. Builder profile ownership → client

**Scheduled, not yet due. Held by the developer for now, by decision (2026-08-15).**

`~/.polymarket-handover/2026-08-04/` holds `wallet.txt` (mode 0600) and a generated `HANDOVER.md`. The wallet matches the `0xdd288d80…D0Ba` owner recorded in [implementation.md](implementation.md) §1.

Per [deployment.md](deployment.md) §7.4: there is **no configurable payout wallet**, so all builder commission accrues to whoever holds this key, and it cannot be reassigned. Migrating later means a new profile, a new `bytes32` code, new API credentials, and forfeiting the attributed volume history the Verified tier application rests on.

When it does go across:

1. Deliver `HANDOVER.md` + `wallet.txt` over a secure channel — not email, not chat.
2. Client confirms they control `0xdd288d80…D0Ba`.
3. `rm -rf ~/.polymarket-handover/2026-08-04` — the script's own closing instruction.
4. Record the date in [deployment.md](deployment.md); it is not recoverable from the repo.

Until then: keep the directory at 0600 and don't duplicate it.

---

## 2. 🔴 Submit the Verified tier application

Never submitted. Was due at the **start of Week 3** ([implementation.md](implementation.md) Step 3.8). Now the longest pole in the schedule.

| Tier | Relay tx/day |
|---|---|
| Unverified (current) | **100** |
| Verified | 10,000 |

The 100/day cap is shared across dev, QA, demos and production, and **every Deposit Wallet deployment spends one**. That cannot support a public launch. Approval takes **several business days** and is entirely outside our control.

**Action:** email `builder@polymarket.com` with:

- the **P-2 builder API key**
- the use case
- expected volume
- a **live demo URL**

The URL is the only dependency. It wants P-8 (custom domain), still unwired — the app is on `*.workers.dev`. Given the approval clock, send the `workers.dev` URL now and follow up once DNS lands, rather than holding the application.

✅ **Done when:** submitted and acknowledged, then tracked to resolution.

---

## 3. ⚠️ Verify the profile fee rate is effective

Two rates must agree:

| Rate | What it is |
|---|---|
| On the builder profile | What **actually charges** users |
| `BUILDER_FEE_BPS_*` in `.dev.vars` | What we **disclose** before they commit |

Drift means every fee shown in the UI is wrong.

Set on 2026-08-04 with the ~4-day lead time documented in [deployment.md](deployment.md) §7.2, so effective from 2026-08-08 — but **never confirmed since**. `fetchBuilderFeeRates` returns only the *effective* rate, so `verify-fees` fails legitimately during the lead-time window, and nobody re-ran it afterwards. We are well past that window now.

```bash
npm run builder:provision -- status        # keys + rates actually on the profile
npm run builder:provision -- verify-fees   # asserts profile == .dev.vars
```

A failure now is a **real mismatch**, not the lead-time artefact.

⚠️ If correcting it: the Builders panel takes **percent, not basis points**. 50 bps is entered as `0.5`. Entering `50` means 50% and is rejected as over-cap. And any change takes ~4 days to take effect — orders placed inside that window earn 0.

---

## 4. ⚠️ Run the Milestone 1 acceptance order

`npm run smoke:builder -- --live` has **never been run**.

It is the only thing that proves the chain end to end: credentials → CLOB auth → Deposit Wallet → a signed order carrying our builder code → the fill appearing under that code in `listBuilderTrades`. Everything else about attribution is inference — no order has ever been placed through this platform.

**Prerequisites:**

- ~$50 pUSD in the builder wallet (client-funded — **status unknown, confirm with client**)
- ideally [deployment.md](deployment.md) §5's nine post-deploy checks passing first, since a failure there changes what this test means

```bash
npm run smoke:builder -- --token <tokenId> --amount 1 --live   # ⚠️ real money
```

✅ **Done when:** the fill appears under our builder code in `listBuilderTrades`.

---

## Not currently open

- **Rotating P-2…P-4** — available any time via `npm run builder:provision -- derive-keys`. Only do it if the credentials are believed exposed. Note `/api/builder/sign` returns the key and passphrase (not the secret) to any signed-in user *by design* — that is accepted residual exposure, not a leak.
- **Rotating P-1** — impossible without a new profile. See item 1.

---

## Execution order

1. **Fix `handoverDir()`** (item 0) — unblocks everything else.
2. **`status` + `verify-fees`** (item 3) — cheap, immediate answers.
3. **Send the Verified tier email** (item 2) — external clock, start it early in the day.
4. **Confirm wallet funding**, then the live smoke test (item 4).
5. **Handover** (item 1) whenever you choose to send it.

## Expected results

```bash
npm run builder:provision -- status
```
Profile wallet `0xdd288d80…D0Ba`, a non-zero builder API key count with one matching `.dev.vars`, and the live fee rates.

```bash
npm run builder:provision -- verify-fees
```
Pass, asserting 50 bps taker / 0 bps maker against the profile.

Items 1 and 2 have no command — they complete when the client confirms wallet receipt, and when Polymarket acknowledges the tier application. **Record both in [deployment.md](deployment.md) when they happen**; neither is recoverable from the repo.
