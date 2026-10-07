# ☀️🔋 GreenYield SPV — Chainlink CRE as the trustee for the clean power that runs AI

> **AI needs 24/7 power. 24/7 power needs capital. Capital needs trust. Chainlink CRE provides the trust.**
>
> An operator lies about generation — and physics catches it before a single dollar moves.

🎥 **Demo video:** _add YouTube link_ · 📊 **Live demo:** _add link_ · 🧾 **Evidence:** [`evidence/`](evidence/) · ⛓️ **Hub on Sepolia:** [`0xa987…bB74`](https://sepolia.etherscan.io/address/0xa987b3279C86aF07396209Be3197c57af70ebB74)

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

## Why it has to be on-chain

- **Investor protection without trusting the operator.** Revenue sits in escrow and only the CRE-verified report can release it; the contract also caps payouts at the escrow and refuses replayed epochs.
- **Fractional, global ownership.** `SPVToken` shares accrue USDC pro-rata and holders pull it with `claim()` — no loops, any number of holders.
- **Certificates nobody can inflate.** Each 24/7 certificate (period, clean-hour bitmask, CFE %, matched MWh, grid region, GPS) is a public, immutable record that any protocol can read — collateral for green lending, proof for a data centre's ESG report, input to a green bond.
- **An auditable trail of rejections.** Fraud attempts are recorded too, with an evidence hash of every input the workflow saw.

## How CRE is used — the orchestration layer

| CRE feature | Where | What it does here |
|---|---|---|
| **Cron trigger** | [`workflow/main.ts:396`](workflow/main.ts#L396) | Scheduled end-of-day settlement |
| **EVM log trigger** | [`workflow/main.ts:402`](workflow/main.ts#L402) | Operator calls `escrowRevenue()` → `RevenueEscrowed` → CRE settles immediately |
| **EVM read** | [`workflow/main.ts:270`](workflow/main.ts#L270) | `getSPV()` — capacity, battery, location, escrow |
| **HTTP + consensus** | [`workflow/main.ts:287`](workflow/main.ts#L287), [`:293`](workflow/main.ts#L293), [`:301`](workflow/main.ts#L301) | Operator telemetry, utility meter, Open-Meteo hourly irradiance; `ConsensusAggregationByFields` / median |
| **Confidential HTTP + Vault DON secret** | [`workflow/main.ts:208`](workflow/main.ts#L208) | LLM trust score; `{{.LLM_API_KEY}}` injected inside the enclave |
| **Secrets** | [`workflow/main.ts:329`](workflow/main.ts#L329) | `runtime.getSecret` for the standard-HTTP fallback |
| **Report + EVM write** | [`workflow/main.ts:374`](workflow/main.ts#L374) | ABI-encoded report → KeystoneForwarder → `GreenYieldHub.onReport()` |
| **Receiver contract** | [`contracts/src/GreenYieldHub.sol:105`](contracts/src/GreenYieldHub.sol#L105) | Forwarder-gated `_processReport`: escrow release, `SPVToken.distribute`, certificate |

**Consensus-safe AI:** only one scalar (the trust score) crosses the node boundary; everything else is derived deterministically from consensus-agreed data. The LLM never does arithmetic and never has the final say.

## Run it

```bash
DRY=1 ./run-demo.sh   # pure CRE simulation — no gas needed
./run-demo.sh         # simulation with --broadcast: reports are written to Sepolia
```
Contracts: `cd contracts && forge test` (3/3 pass).

---

# 中文说明（团队用）

## 🚀 一键运行（新手看这里）

**第一次准备（大约 10 分钟，只做一次）**

1. 安装工具（Mac 打开“终端”，逐行粘贴）：
   ```bash
   curl -fsSL https://bun.sh/install | bash
   curl -L https://foundry.paradigm.xyz | bash && foundryup
   curl -sSL https://cre.chain.link/install.sh | bash
   ```
   另外安装 Node.js LTS：https://nodejs.org 。装完**关掉终端再重新打开**。
2. 下载本项目：
   ```bash
   git clone https://github.com/NekoBite/ChainlinkSgGreen.git && cd ChainlinkSgGreen
   ```
3. 准备一个**只用于测试网**的钱包（MetaMask 新建一个账户就行），然后去
   https://cloud.google.com/application/web3/faucet/ethereum/sepolia 领免费 Sepolia ETH（需要 ≥ 0.02）。
4. 运行一次 `./run-demo.sh`，它会自动生成 `.env` 文件。打开 `.env`，填入：
   - `CRE_ETH_PRIVATE_KEY=` 测试钱包的私钥（MetaMask → 账户详情 → 显示私钥）
   - `LLM_API_KEY=` Anthropic API key（没有就保持 `none`，AI 会用离线分数）

**之后每次演示只要一行：**
```bash
./run-demo.sh
```
脚本会依次：检查工具 → 检查钱包余额 → 登录 Chainlink（第一次会弹出浏览器）→ 部署合约（只有第一次）→ 打开看板 → 先跑**说谎**的一期，按回车再跑**诚实**的一期。

看板：http://localhost:8788

单独跑一期：`./run-demo.sh fraud` 或 `./run-demo.sh honest`

---

## 🎬 演示时会发生什么

- 说谎期走 **Cron 触发器**（定时结算）。
- 诚实期走 **EVM Log 触发器**：脚本先让运营方在链上存入 25,000 USDC，CRE 监听到 `RevenueEscrowed` 事件后自动核验。
- 两期都是 `cre workflow simulate --broadcast`：本地模拟 DON，但报告真实写上 Sepolia（导师确认模拟即可，无需部署）。


| 期次 | 运营方报告 | 8 条物理规则 | 24/7 绿电 | 链上结果 |
|---|---|---|---|---|
| 🚨 说谎 | 发电 ~1,400 MWh，还声称**半夜也有太阳能** | ❌ 破 7 条 | 自称 92%，**证书 0 小时** | **REJECTED**，付款 0，拒绝记录 + 空证书永久上链 |
| ✅ 诚实 | 发电 370 MWh：210 直售，160 充入电池，晚上放电 | ✅ 8/8 | **65.8%**（13/24 小时） | **APPROVED**，约 **24,222 USDC** 按 50/30/20 分给持有人 + 24/7 证书 |

诚实期营收（由合约计价重新计算，不采信运营方的数字）：
- 光伏直售 PPA：210 MWh × $55 = **$11,550**
- 储能晚高峰放电：140.8 MWh × $90 = **$12,672**（电池充的是自家太阳能，所以晚上放出来的也是绿电）
- 合计约 **$24,222**（用实时天气时，若某小时日照不足，发电会被封顶，金额略低）

## 🕐 24/7 绿电证书（时间 + 地点）

传统绿电证书（REC）**按年对账**：白天的太阳能可以"抵消"晚上的煤电。
24/7 无碳电力（CFE，Google / 微软 / EnergyTag 在推）要求**每小时、同一电网区域**都对得上。

- **时间**：运营方报 24 个小时值；工作流拿 **Open-Meteo 逐小时日照**逐小时核验。
- **地点**：链上记录电网区域（`TH-EGAT-Central`）+ 经纬度；证书带 `periodStart`（当地零点）。
- **24/7 匹配**：对一个 **15 MW 全天候企业买家**，每小时看"太阳直供 + 电池放电"能否覆盖 → 得到 24 位小时掩码 + CFE 百分比。
- **只有通过核验的期次才有证书**；被拒的期次写入 0 小时。

> 台词：*"传统绿电证书按年对账，晚上的煤电也能被白天的太阳'洗绿'。我们用 Chainlink CRE 逐小时、按地点核验——运营方说半夜两点太阳能在发电？物理定律当场驳回。"*

## 🏗️ CRE 工作流（`workflow/main.ts`）

```
触发器 0：Cron（每日定时结算）
触发器 1：EVM Log —— 运营方调用 escrowRevenue() 存入收入 → RevenueEscrowed 事件 → CRE 立即核验
        ─▶ EVM Read  GreenYieldHub.getSPV()   → 装机、电池、经纬度、托管余额
          ─▶ HTTP      运营方遥测 + 电网电表          (mock-api，共识取中位数)
          ─▶ HTTP      Open-Meteo 逐小时日照           (真实公开 API)
          ─▶ 计算      8 条物理规则 → 违规位掩码；24/7 逐小时匹配 → 小时掩码 + CFE%
          ─▶ Confidential HTTP  Anthropic Claude → 信任分 0-100
                       （API key 只在 enclave 里通过 Vault DON 注入 {{.LLM_API_KEY}}，节点运营者看不到；
                        不可用时自动退回普通 HTTP）
          ─▶ EVM Write 签名报告 → KeystoneForwarder → GreenYieldHub.onReport()
                       通过：释放托管 USDC 给 SPVToken 持有人 + 发 24/7 证书（时间 + 地点）
                       拒绝：写一条 0 收入的审计记录
```

## 📂 目录

```
contracts/   Foundry：GreenYieldHub（登记 + 托管 + CRE 接收方）、SPVToken（分红代币）、MockUSDC
workflow/    CRE TypeScript 工作流
mock-api/    假的运营方 / 电表 + 看板服务器（端口 8788）
dashboard/   演示看板（实时读 Sepolia）
run-demo.sh  一键脚本
```

## 🛠️ 开发者命令

```bash
cd contracts && forge test                       # 合约测试
cd workflow && bun install && npx tsc --noEmit   # 类型检查
cre workflow build ./workflow --target staging-settings
cre workflow simulate ./workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast
```

## ❓ 常见问题

| 现象 | 处理 |
|---|---|
| `Need ≥ 0.02 Sepolia ETH` | 去水龙头领测试币 |
| `cre login` 打不开浏览器 | 复制终端里的链接，手动粘到浏览器 |
| `InvalidSender` / 链上没有新记录 | Forwarder 地址不对：运行 `cre workflow supported-chains`，找到 Sepolia 的 mock forwarder，在 `.env` 加 `FORWARDER=0x...`，删掉 `.deployed-v2` 后重跑 |
| `epoch done` | 这一期已经结算过；重跑脚本时会自动换新的期号 |
| 端口 8788 被占用 | `PORT=8789 node mock-api/server.js`，并把 `workflow/config.staging.json` 里的 `mockApiUrl` 一起改掉 |

> ⚠️ Demo only. Real SPV tokens are securities and would need KYC / transfer restrictions (e.g. ERC-3643).
