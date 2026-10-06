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

| 期次 | 运营方报告 | 6 条物理规则 | AI 打分 | 链上结果 |
|---|---|---|---|---|
| 🚨 说谎 | 发电 520 MWh，营收 $44,500 | ❌ 6 条全破 | 低分 | **REJECTED**，付款 0，拒绝记录永久上链 |
| ✅ 诚实 | 发电 210 MWh | ✅ 6/6 通过 | 高分 | **APPROVED**，**17,822 USDC** 按持股 50/30/20 分给持有人 |

诚实期营收（由合约计价重新计算，不采信运营方的数字）：
- 光伏直售 PPA：210 MWh × $55 = **$11,550**
- 储能套利：140.8 MWh × $90（晚高峰卖出）− 160 MWh × $40（低谷买入）= **$6,272**
- 合计 **$17,822**

## 🧠 两层架构

**1. 物理层 —— 确定性代码，不靠 AI**
| # | 规则 | 检查 |
|---|---|---|
| 1 | 太阳是上限 | 发电 ≤ 装机 MWp × 当天日照小时（**Open-Meteo 实时数据**）× 0.85 |
| 2 | 一个电子只能去一个地方 | 直售 + 充入电池 ≤ 发电量 |
| 3 | 电池不能凭空造电 | 放电 ≤ 充电 × 90% 往返效率 |
| 4 | 电表是裁判 | 申报的总上网电量 ≤ 电网公司电表读数 |
| 5–6 | 额定容量 | 每天充 / 放电 ≤ 电池容量（1 次循环） |

**2. 模式层 —— LLM**：看完整个故事是否说得通，**只返回一个 0–100 的数字**。
只有这一个标量穿过 DON 共识边界，所以多节点结果一致。

## 🏗️ CRE 工作流（`workflow/main.ts`）

```
Cron 触发 ─▶ EVM Read  GreenYieldHub.getSPV()   → 装机、电池、经纬度、托管余额
          ─▶ HTTP      运营方遥测 + 电网电表          (mock-api，共识取中位数)
          ─▶ HTTP      Open-Meteo 日照数据             (真实公开 API)
          ─▶ 计算      6 条物理规则 → 违规位掩码
          ─▶ HTTP      Anthropic Claude → 信任分 0-100
          ─▶ EVM Write 签名报告 → KeystoneForwarder → GreenYieldHub.onReport()
                       通过：释放托管 USDC 给 SPVToken 持有人（按持股领取）
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
| `InvalidSender` / 链上没有新记录 | Forwarder 地址不对：运行 `cre workflow supported-chains`，找到 Sepolia 的 mock forwarder，在 `.env` 加 `FORWARDER=0x...`，删掉 `.deployed` 后重跑 |
| `epoch done` | 这一期已经结算过；重跑脚本时会自动换新的期号 |
| 端口 8788 被占用 | `PORT=8789 node mock-api/server.js`，并把 `workflow/config.staging.json` 里的 `mockApiUrl` 一起改掉 |

> ⚠️ Demo only. Real SPV tokens are securities and would need KYC / transfer restrictions (e.g. ERC-3643).
