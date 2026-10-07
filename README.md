# ☀️🔋 GreenYield SPV — Chainlink CRE as the trustee for the clean power that runs AI

> **AI needs 24/7 power. 24/7 power needs capital. Capital needs trust. Chainlink CRE provides the trust.**
>
> An operator lies about generation — and physics catches it before a single dollar moves.

🎥 **Demo video:** _add YouTube link_ · 📊 **Live demo:** https://greenyield-spv.ask-jev.workers.dev · 🧾 **Evidence:** [`evidence/`](evidence/) · ⛓️ **Hub on Sepolia:** [`0xa987…bB74`](https://sepolia.etherscan.io/address/0xa987b3279C86aF07396209Be3197c57af70ebB74)

## The problem

GPUs never sleep. AI data centres draw power around the clock, yet today's green certificates are settled **annually** — a data centre can run on fossil power all night and "offset" it with solar bought at noon. Buyers are moving to **24/7 carbon-free energy**: every hour, matched with clean power on the same grid.

Meeting that demand means building **solar + battery** plants, and that needs capital. Tokenizing the plants opens that capital to anyone — like a REIT owns a hotel, an **SPV owns the plant**, the **operator runs it**, and **token holders own the revenue**. But the operator reports the numbers. Who checks them?

## The solution

A **Chainlink CRE workflow is the SPV's independent trustee**. Every epoch it:

1. **Reads the SPV from chain** — capacity, battery size, GPS location, escrowed revenue.
2. **Pulls the operator's claim and an independent utility meter** (HTTP, median consensus across nodes).
3. **Pulls real hourly sunlight** for the site from **Open-Meteo**.
4. **Runs 8 deterministic physics rules** — the sun is the limit · one electron, one place · a battery cannot create energy · the meter is the referee · battery ratings · *no sun, no solar (hourly)* · *every hour within its sunlight*.
5. **Asks an LLM for one number** — a 0–100 trust score — over **Confidential HTTP**, so the API key and evidence never reach node operators. (Offline score in the recorded demo; physics decides either way.)
6. **Matches every hour against a 15 MW AI data centre's 24/7 load** → clean-hour bitmask + CFE %.
7. **Writes a signed report on-chain.** Approved → escrowed USDC is released pro-rata to SPV token holders **and a time- and location-stamped 24/7 certificate** is recorded. Rejected → an auditable zero-revenue record with **zero certified hours**.

| Epoch | Operator says | Physics (8 rules) | 24/7 match | On-chain result |
|---|---|---|---|---|
| 🚨 Fraud | 1,409 MWh, incl. solar at 2 a.m. | ❌ 7 fail | claims 89% | **REJECTED** · 0 USDC · 0 certified hours |
| ✅ Honest | 370 MWh: 210 sold, 160 stored, discharged after sunset | ✅ 8 / 8 | **61.1 %** (sun by day, battery by night) | **APPROVED** · 24,222 USDC to holders · certificate issued |

Full CLI output: [`evidence/simulation-2026-10-07.log`](evidence/simulation-2026-10-07.log).

## Confidential Workflow (TEE)

Handler 2 registers with `handlerInTee` (AWS Nitro, `us-west-2`) and runs the **entire verification inside the enclave**:

- `OPERATOR_API_KEY` and `LLM_API_KEY` are fetched from the Vault DON **inside** the enclave.
- The operator's **private hour-by-hour SCADA feed** (`/operator/scada`, token-protected) is fetched inside the enclave. Hourly dispatch reveals battery-arbitrage strategy, so it is commercially sensitive.
- The 8 physics rules, the 24/7 matching and the LLM call all run on that raw data in enclave memory.
- Only **derived conclusions** (verdict, violation mask, clean-hour mask, CFE %, payout, evidence hash) cross back via `usingTheDons()` to be signed by the DON and written on-chain. Chain reads and writes stay on the DON.

Code: [`onEpochInTee` in `workflow/main.ts`](workflow/main.ts). Run it: `CHAIN=sepolia TEE=1 DRY=1 ./run-demo.sh` (simulation; live deployment of Confidential Workflows is private beta).

✅ **Simulated successfully** — the CLI reports `Trigger requested TEE Execution … AWS Nitro in us-west-2`; fraud epoch rejected (1/8 rules), honest epoch approved (8/8, 24,222 USDC, 61.1% CFE). Log: [`evidence/tee-simulation-2026-10-07.log`](evidence/tee-simulation-2026-10-07.log).

## Why it has to be on-chain

- **Investor protection without trusting the operator.** Revenue sits in escrow and only the CRE-verified report can release it; the contract also caps payouts at the escrow and refuses replayed epochs.
- **Fractional, global ownership.** `SPVToken` shares accrue USDC pro-rata and holders pull it with `claim()` — no loops, any number of holders.
- **Certificates nobody can inflate.** Each 24/7 certificate (period, clean-hour bitmask, CFE %, matched MWh, grid region, GPS) is a public, immutable record that any protocol can read — collateral for green lending, proof for a data centre's ESG report, input to a green bond.
- **An auditable trail of rejections.** Fraud attempts are recorded too, with an evidence hash of every input the workflow saw.

## Chains

The same workflow and contracts run on any CRE-supported EVM testnet; `CHAIN` in `.env` picks one:

| `CHAIN` | Network | CRE chain name | Simulation forwarder |
|---|---|---|---|
| `base` (default) | Base Sepolia | `ethereum-testnet-sepolia-base-1` | `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |
| `fuji` | Avalanche Fuji | `avalanche-testnet-fuji` | `0x2e7371a5d032489e4f60216d8d898a4c10805963` |
| `sepolia` | Ethereum Sepolia | `ethereum-testnet-sepolia` | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |

## How CRE is used — the orchestration layer

| CRE feature | Where | What it does here |
|---|---|---|
| **Cron trigger** | [`workflow/main.ts:396`](workflow/main.ts#L396) | Scheduled end-of-day settlement |
| **EVM log trigger** | [`workflow/main.ts:402`](workflow/main.ts#L402) | Operator calls `escrowRevenue()` → `RevenueEscrowed` → CRE settles immediately |
| **EVM read** | [`workflow/main.ts:270`](workflow/main.ts#L270) | `getSPV()` — capacity, battery, location, escrow |
| **HTTP + consensus** | [`workflow/main.ts:287`](workflow/main.ts#L287), [`:293`](workflow/main.ts#L293), [`:301`](workflow/main.ts#L301) | Operator telemetry, utility meter, Open-Meteo hourly irradiance; `ConsensusAggregationByFields` / median |
| **Confidential HTTP + Vault DON secret** | [`workflow/main.ts:208`](workflow/main.ts#L208) | LLM trust score; `{{.LLM_API_KEY}}` injected inside the enclave |
| **Secrets** | [`workflow/main.ts:329`](workflow/main.ts#L329) | `runtime.getSecret` for the standard-HTTP fallback |
| **Confidential Workflow (`handlerInTee`)** | `workflow/main.ts` → `onEpochInTee` | Whole verification in a TEE on the operator's private SCADA feed; only conclusions cross back via `usingTheDons()` |
| **Report + EVM write** | [`workflow/main.ts:374`](workflow/main.ts#L374) | ABI-encoded report → KeystoneForwarder → `GreenYieldHub.onReport()` |
| **Receiver contract** | [`contracts/src/GreenYieldHub.sol:105`](contracts/src/GreenYieldHub.sol#L105) | Forwarder-gated `_processReport`: escrow release, `SPVToken.distribute`, certificate |

**Consensus-safe AI:** only one scalar (the trust score) crosses the node boundary; everything else is derived deterministically from consensus-agreed data. The LLM never does arithmetic and never has the final say.

## Quick start

**Prerequisites:** Node.js 20+, [Bun](https://bun.sh), [Foundry](https://getfoundry.sh), the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux) and a CRE account.

```bash
git clone https://github.com/NekoBite/ChainlinkSgGreen.git && cd ChainlinkSgGreen
./run-demo.sh            # first run creates .env and stops
```

Fill in `.env`:
- `CHAIN` — `base` (Base Sepolia, default), `fuji` (Avalanche Fuji) or `sepolia` (Ethereum Sepolia)
- `CRE_ETH_PRIVATE_KEY` — a **testnet-only** wallet with gas on that chain (only needed for deploy/broadcast)
- `LLM_API_KEY` — an Anthropic API key, or `none` to run the AI layer in offline mode

Then:

```bash
DRY=1 ./run-demo.sh      # pure CRE simulation — no gas, nothing written on-chain
TEE=1 DRY=1 ./run-demo.sh # same, through the Confidential Workflow handler (TEE)
./run-demo.sh            # deploys once to $CHAIN, then simulates with --broadcast
CHAIN=fuji ./run-demo.sh # same workflow on Avalanche Fuji
./run-demo.sh fraud      # a single lying epoch
./run-demo.sh honest     # a single honest epoch (EVM log trigger: escrow deposit → settlement)
```

The script checks tools, logs in to CRE, deploys the contracts once, starts the mock operator/meter API and the dashboard at http://localhost:8788, then runs the fraud epoch (cron trigger) and the honest epoch (EVM log trigger).

## The 24/7 certificate

Annual RECs let night-time fossil power be "offset" by midday solar. 24/7 carbon-free energy (CFE) matching requires clean power **every hour, on the same grid**.

- **Time:** the operator reports 24 hourly values; the workflow checks each hour against Open-Meteo hourly irradiance.
- **Place:** the certificate carries the grid region (`TH-EGAT-Central`), the site's coordinates and `periodStart` (local midnight).
- **Matching:** each hour, solar delivered + battery discharge is compared with a flat 15 MW AI data-centre load → a 24-bit clean-hour mask and a CFE percentage.
- **Only verified epochs earn a certificate;** rejected epochs record zero hours.

Honest-epoch revenue, recomputed from metered energy (never taken from the operator's claim): 210 MWh PPA × $55 = $11,550 · 140.8 MWh evening peak × $90 = $12,672 · **total $24,222**. With live weather, an hour with too little sunlight caps generation, so the figure can be slightly lower.

## Repository layout

```
contracts/   Foundry: GreenYieldHub (registry + escrow + CRE receiver), SPVToken (dividend shares), MockUSDC
workflow/    CRE TypeScript workflow (main.ts, config, workflow.yaml)
mock-api/    Mock operator telemetry + utility meter + dashboard server (port 8788)
dashboard/   Live dashboard (reads Sepolia)
docs/demo/   Static hosted demo page
evidence/    Simulation logs and on-chain proof
run-demo.sh  One-command demo
```

## Hosted demo (Cloudflare Workers)

```bash
npx wrangler login     # opens a browser once
npx wrangler deploy    # publishes docs/demo → https://greenyield-spv.<your-subdomain>.workers.dev
```

## Developer commands

```bash
cd contracts && forge test                         # contract tests (3/3 pass)
cd workflow && bun install && npx tsc --noEmit     # type check
cre workflow build ./workflow --target staging-settings
cre workflow simulate ./workflow --target staging-settings --non-interactive --trigger-index 0 [--broadcast]
cre workflow simulate ./workflow --target staging-settings --non-interactive --trigger-index 1 \
  --evm-tx-hash <escrowRevenue tx> --evm-event-index <log index> --broadcast
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Need ≥ 0.02 … ETH/AVAX` | Use `DRY=1`, or get gas from the Base Sepolia / Avalanche Fuji faucet |
| `cre login` doesn't open a browser | Copy the URL from the terminal into a browser |
| `InvalidSender` / no new on-chain record | Wrong forwarder: run `cre workflow supported-chains`, set `FORWARDER=0x…` in `.env`, delete `.deployed-<chain>`, rerun |
| `epoch done` | That epoch was already settled; rerunning the script starts a new epoch |
| `LLM HTTP 401` | Invalid Anthropic key; fix it or set `LLM_API_KEY=none` |

> ⚠️ Demo only. Real SPV tokens are securities and need KYC and transfer restrictions (e.g. ERC-3643). Operator telemetry and the utility meter are mocked; the weather data is live.

