# Polymarket Builder Account — Outstanding Actions

> **Created:** 2026-08-15 · **Updated:** 2026-08-23 (Verified tier application submitted).
> Scope: the **non-code** side of the Builder Program — profile, credentials, fee rate, tier, ownership.
> Related: [deployment.md](deployment.md) §7 (operational limits) · [implementation.md](implementation.md) §1 (credentials checklist) · [CLAUDE.md](CLAUDE.md) (builder fees, tiers, traps)

## Status at a glance

| # | Item | State |
|---|---|---|
| 0 | `handoverDir()` date bug in the provisioning script | 🚩 blocks items 3 and 4 |
| 1 | Builder profile ownership → client | ⏸ scheduled, held by developer by decision |
| 2 | Verified tier application | 🟡 **submitted 2026-08-23** — awaiting reply |
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

## 2. 🟡 Verified tier application — SUBMITTED 2026-08-23

Emailed `builder@polymarket.com` on **2026-08-23** from `sayemabedin.bd@gmail.com`, subject *"Verified tier application — Polybets (polybets.xyz)"*. **Awaiting reply** — Polymarket states a few business days.

| Tier | Relay tx/day |
|---|---|
| Unverified (current) | **100** |
| Verified (applied for) | 10,000 |

The 100/day cap is shared across dev, QA, demos and production, and **every Deposit Wallet deployment spends one**. That cannot support a public launch. Approval is entirely outside our control and **gates launch** — see [implementation.md](implementation.md) Step 4.7's go/no-go.

**What was sent** (the four things `docs.polymarket.com/programs/builders/tiers.md` asks for, verified against that page the same day):

| Field | Value sent |
|---|---|
| Builder API key (P-2) | the live key from `.dev.vars` |
| Live demo URL | **`https://polybets.xyz`** — see below |
| Expected volume | **$50k–250k/month** for the first three months, flagged as a pre-launch projection |
| Use case | white-label CLOB frontend, non-custodial client-side signing, shipped feature list, plus *why* 10,000/day is needed (Deposit Wallet deployments cap **onboarding**, not order throughput) |

The application also **states plainly that attributed volume is currently zero**, rather than leaving a reviewer to discover it. Polymarket's own upgrade steps put *"Route orders through Polymarket and demonstrate consistent usage"* before the email, and we have not done that — item 4 is the mitigation and should land while this is under review.

⚠️ **This section previously said to send the `workers.dev` URL because P-8 was unwired. That was stale.** Verified 2026-08-23: `polybets.xyz` resolves to Cloudflare and serves this Worker (`x-opennext: 1`, `/api/health` → `mode: "live"`, all five secrets present, `problems: []`). The custom domain is live, so the real URL went in the application. Note this confirms *the domain serves the app* — it is **not** a pass of [deployment.md](deployment.md) §5's nine post-deploy checks, which remain unrun.

**Draft archived outside the repo** at `…/scratchpad/EMAIL-paste-this.txt` — it contains the builder API key, so it must never be moved into the project directory.

✅ **Done when:** Polymarket replies and the tier is granted. Track it with the leaderboard check in item 4 — once we have any volume, our row on `data-api.polymarket.com/v1/builders/leaderboard` carries a `verified` boolean, and that is the **only programmatic confirmation that exists**.

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

**Measured 2026-08-23 — our builder code has zero attributed volume**, on every window the public board offers:

```
GET data-api.polymarket.com/v1/builders/volume?timePeriod=DAY    40,101 rows — ours NOT LISTED
                                              ?timePeriod=WEEK    7,418 rows — ours NOT LISTED
                                              ?timePeriod=MONTH   2,200 rows — ours NOT LISTED
                                              ?timePeriod=ALL       611 rows — ours NOT LISTED
```

That makes this item the mitigation for item 2's weakest point, not just a Milestone 1 formality. It is now **urgent rather than merely outstanding**: the docs say to allow up to 24h for matched volume to appear, so an order placed during the review window shows up while a reviewer is looking.

**Prerequisites:**

- ≥$5 pUSD in any wallet (does **not** have to be the profile-owner wallet — `builderCode` is passed separately into `placeMarketOrder`). Client funding status still unconfirmed
- the first run also **deploys a Deposit Wallet, spending 1 of the 100 daily relay transactions**
- ideally [deployment.md](deployment.md) §5's nine post-deploy checks passing first, since a failure there changes what this test means

**🚩 Use `--amount 5`, not `--amount 1`.** This line said `1` until 2026-08-23 and would have failed. The CLOB's `min_order_size` is **5 shares, not a dollar figure** — shares are `usd / price` and a price never exceeds `1.00`, so **$5 buys ≥5 shares at any price** while $1 is rejected upstream on any market priced above 0.20. Same arithmetic as `MIN_COPY_USD = 5` in the copy-trade engine; don't tidy it back down.

```bash
export POLYMARKET_PRIVATE_KEY=0x...   # a wallet holding ≥$5 pUSD
export POLYMARKET_BUILDER_CODE=$(awk -F= '/^POLYMARKET_BUILDER_CODE=/{print $2}' .dev.vars)
npm run smoke:builder -- --token <tokenId> --amount 5 --live   # ⚠️ real money
```

**Picking a token id** — note the keyset response key is **`events`**, not `data`:

```bash
curl -s "https://gamma-api.polymarket.com/events/keyset?active=true&closed=false&order=volume&ascending=false&limit=40" \
| python3 -c "
import json,sys
for e in json.load(sys.stdin).get('events',[]):
    for m in e.get('markets') or []:
        if m.get('closed') or not m.get('acceptingOrders'): continue
        p=[float(x) for x in json.loads(m.get('outcomePrices') or '[]')]
        if p and 0.15<p[0]<0.85: print(m['slug'], p[0], json.loads(m['clobTokenIds'])[0])
"
```

Then confirm the market before spending: `curl -s "https://clob.polymarket.com/book?token_id=<id>"` returns `tick_size`, `min_order_size` and live depth. A deep book at a mid-range price fills $5 with no slippage; extreme prices (0.0005 / 0.9995) make the share math awkward.

✅ **Done when:** the fill appears under our builder code in `listBuilderTrades` (`npm run smoke:builder` with no `--live` re-checks just this), **and** our code appears on `data-api.polymarket.com/v1/builders/volume`. Once it does, the `verified` boolean on `/v1/builders/leaderboard` becomes readable — the only programmatic way to confirm item 2 was granted.

---

## Not currently open

- **Rotating P-2…P-4** — available any time via `npm run builder:provision -- derive-keys`. Only do it if the credentials are believed exposed. Note `/api/builder/sign` returns the key and passphrase (not the secret) to any signed-in user *by design* — that is accepted residual exposure, not a leak.
- **Rotating P-1** — impossible without a new profile. See item 1.

---

## Execution order

*(Updated 2026-08-23 — item 2 was pulled to the front and sent, because its clock is external and the app was already live on `polybets.xyz`. The rest still stands.)*

1. ~~**Send the Verified tier email** (item 2)~~ — ✅ done 2026-08-23, awaiting reply.
2. **Confirm wallet funding, then the live smoke test** (item 4) — now the priority: it puts real volume under the code while item 2 is being reviewed, and it is the only route to a programmatic confirmation later.
3. **Fix `handoverDir()`** (item 0) — unblocks item 3.
4. **`status` + `verify-fees`** (item 3) — cheap, immediate answers.
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

Item 1 has no command — it completes when the client confirms wallet receipt. **Record it in [deployment.md](deployment.md) when it happens**; it is not recoverable from the repo.

Item 2 gains a command only *after* item 4 lands. Until our code has volume there is no per-builder profile endpoint to query — `/v1/builders/<code>`, `/v1/builders/profile?builderCode=…` and `clob.polymarket.com/builder/<code>` all **404** (probed 2026-08-23). The `verified` flag lives only on the leaderboard row:

```bash
curl -s "https://data-api.polymarket.com/v1/builders/leaderboard?timePeriod=ALL" | grep 0x5eb653d0
```

Until then, Polymarket's reply email is the sole confirmation — keep it.
