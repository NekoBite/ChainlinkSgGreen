# ☀️🔋 GreenYield SPV — Chainlink CRE

> **运营方说谎，物理定律先抓住它——一分钱都还没动。**
> *An operator lies about generation, and physics catches it before a single dollar moves.*

酒店不拥有大楼（REIT 拥有），航空公司不拥有飞机（租赁公司 / SPV 拥有）。
绿色资产也一样：**运营方负责维护，SPV 拥有资产，代币持有人拥有收益权。**
**Chainlink CRE** 当受托人兼审计员：核对数据 → 让 AI 打分 → 在链上分钱（或拒绝）。

---

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
