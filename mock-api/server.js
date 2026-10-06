// Demo props: a fake operator (can lie), a fake utility meter (never lies),
// and the dashboard, which reads real results back from Sepolia.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http as rpc, parseAbi } from "viem";
import { sepolia } from "viem/chains";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const hubFile = path.join(dir, "..", ".deployed");

// Physical truth for this epoch (what really happened at the plant)
const TRUTH = { solarGenMWh: 210, solarExportMWh: 210, chargeFromSolarMWh: 0, chargeFromGridMWh: 160, dischargeMWh: 140.8 };
const METER = TRUTH.solarExportMWh + TRUTH.dischargeMWh; // utility revenue meter: 350.8 MWh

const CLAIMS = {
  honest: { ...TRUTH, claimedRevenueUsd: 17822 },
  fraud: { solarGenMWh: 520, solarExportMWh: 500, chargeFromSolarMWh: 100, chargeFromGridMWh: 160, dischargeMWh: 260, claimedRevenueUsd: 44500 },
};

let state = { mode: "honest", epochId: Math.floor(Date.now() / 1000) };

const HUB_ABI = parseAbi([
  "function getSPV(uint256) view returns (string,address,uint32,uint32,int32,int32,uint256,uint256)",
  "function epochCount() view returns (uint256)",
  "function epochs(uint256) view returns (uint256 spvId,uint64 epochId,bool approved,uint8 aiScore,uint16 violations,uint256 claimedUsdc,uint256 paidUsdc,bytes32 evidenceHash,uint64 timestamp)",
]);
const TOKEN_ABI = parseAbi(["function claimable(address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const HOLDERS = { "Investor A (deployer)": null, "Investor B": "0x1111111111111111111111111111111111111111", "Investor C": "0x2222222222222222222222222222222222222222" };
const client = createPublicClient({ chain: sepolia, transport: rpc(RPC) });

async function chainState() {
  if (!fs.existsSync(hubFile)) return { error: "not deployed yet — run ./run-demo.sh" };
  const hub = fs.readFileSync(hubFile, "utf8").trim();
  const owner = (process.env.DEPLOYER || "").trim();
  const [name, token, solarMWp, batteryMWh, , , escrow, totalPaid] = await client.readContract({ address: hub, abi: HUB_ABI, functionName: "getSPV", args: [0n] });
  const n = Number(await client.readContract({ address: hub, abi: HUB_ABI, functionName: "epochCount" }));
  const epochs = [];
  for (let i = Math.max(0, n - 10); i < n; i++) {
    const e = await client.readContract({ address: hub, abi: HUB_ABI, functionName: "epochs", args: [BigInt(i)] });
    epochs.push({ epochId: e[1].toString(), approved: e[2], aiScore: e[3], violations: e[4], claimedUsdc: Number(e[5]) / 1e6, paidUsdc: Number(e[6]) / 1e6, timestamp: Number(e[8]) });
  }
  const holders = [];
  for (const [label, addr0] of Object.entries(HOLDERS)) {
    const addr = addr0 || owner;
    if (!addr) continue;
    const [c, b] = await Promise.all([
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "claimable", args: [addr] }),
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [addr] }),
    ]);
    holders.push({ label, addr, shares: Number(b / 10n ** 18n), claimableUsdc: Number(c) / 1e6 });
  }
  return { hub, token, name, solarMWp, batteryMWh, escrowUsdc: Number(escrow) / 1e6, totalPaidUsdc: Number(totalPaid) / 1e6, epochs: epochs.reverse(), holders };
}

const send = (res, code, obj, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(type === "application/json" ? JSON.stringify(obj) : obj);
};

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (url === "/operator/telemetry") return send(res, 200, { epochId: state.epochId, ...CLAIMS[state.mode] });
    if (url === "/utility/meter") return send(res, 200, { epochId: state.epochId, exportMWh: METER });
    if (req.method === "POST" && (url === "/operator/fraud" || url === "/operator/honest")) {
      state = { mode: url.endsWith("fraud") ? "fraud" : "honest", epochId: state.epochId + 1 };
      console.log(`operator now ${state.mode.toUpperCase()}, epoch ${state.epochId}`);
      return send(res, 200, state);
    }
    if (url === "/state") return send(res, 200, { ...state, claim: CLAIMS[state.mode], meterMWh: METER, chain: await chainState() });
    if (url === "/" || url === "/index.html") return send(res, 200, fs.readFileSync(path.join(dir, "..", "dashboard", "index.html")), "text/html");
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`☀️  GreenYield mock API + dashboard on http://localhost:${PORT}`));
