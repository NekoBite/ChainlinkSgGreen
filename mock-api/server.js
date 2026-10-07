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
const hubFile = path.join(dir, "..", ".deployed-v2");

// ── Site & weather ────────────────────────────────────────────────
// Lopburi, Thailand. Hourly irradiance for *yesterday* (local time) from Open-Meteo —
// the same query the CRE workflow makes, so honest claims line up with real physics.
const SITE = { lat: 14.8, lon: 100.6, solarMWp: 150, pr: 0.85 };
const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${SITE.lat}&longitude=${SITE.lon}&hourly=shortwave_radiation&past_days=1&forecast_days=1&timezone=auto`;
// Deterministic fallback (same curve as the workflow): clear-sky bell 06:00–18:00, peak 900 W/m²
const fallbackIrradiance = () => Array.from({ length: 24 }, (_, h) => (h >= 6 && h <= 18 ? Math.round(900 * Math.sin(((h - 6) / 12) * Math.PI)) : 0));
let weather = { source: "fallback", irradiance: fallbackIrradiance(), periodStart: 0 };
async function loadWeather() {
  try {
    const r = await fetch(WEATHER_URL, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    const irr = d.hourly.shortwave_radiation.slice(0, 24).map(Number);
    if (irr.length === 24) {
      const periodStart = Math.floor(Date.parse(d.hourly.time[0] + ":00Z") / 1000) - d.utc_offset_seconds;
      weather = { source: "open-meteo", irradiance: irr, periodStart };
    }
  } catch (e) { console.log("weather fetch failed, using clear-sky fallback:", e.message); }
  if (!weather.periodStart) { const n = new Date(); weather.periodStart = Math.floor(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - 1) / 1000) - 7 * 3600; }
}

// ── What really happened at the plant (honest story) ─────────────────
// 370 MWh solar: 210 exported under the PPA, 160 stored in the battery.
// The battery discharges 140.8 MWh (90% round trip) into the evening peak 18:00–23:00,
// so the corporate buyer's 24/7 contract is clean well after sunset.
const shapeSolar = (totalMWh, irr) => {
  const ceil = irr.map((w) => (SITE.solarMWp * w / 1000) * SITE.pr);
  const sum = irr.reduce((a, b) => a + b, 0) || 1;
  // spread the day's energy along the sun, never above 95% of what the sun allowed that hour
  return irr.map((w, h) => +Math.min((totalMWh * w) / sum, ceil[h] * 0.95).toFixed(2));
};
const EVENING = [18, 19, 20, 21, 22, 23];
const dischargeProfile = (total) => Array.from({ length: 24 }, (_, h) => (EVENING.includes(h) ? +(total / EVENING.length).toFixed(4) : 0));

function buildClaims() {
  const solarHourly = shapeSolar(370, weather.irradiance);
  const gen = +solarHourly.reduce((a, b) => a + b, 0).toFixed(2);
  const charge = +Math.min(160, Math.max(0, gen - 210)).toFixed(2);
  const honest = {
    solarGenMWh: gen, solarExportMWh: +(gen - charge).toFixed(2), chargeFromSolarMWh: charge, chargeFromGridMWh: 0,
    dischargeMWh: +(charge * 0.88).toFixed(2), solarHourly, dischargeHourly: dischargeProfile(+(charge * 0.88).toFixed(2)),
  };
  honest.claimedRevenueUsd = Math.round(honest.solarExportMWh * 55 + honest.dischargeMWh * 90);
  // The lie: triple the day, and "solar" at night (20:00–04:00) to fake round-the-clock clean power
  const fraudSolar = solarHourly.map((x, h) => +(x * 3.2 + (h <= 4 || h >= 20 ? 25 : 0)).toFixed(2));
  const fg = +fraudSolar.reduce((a, b) => a + b, 0).toFixed(2);
  const fraud = {
    solarGenMWh: fg, solarExportMWh: +(fg * 0.75).toFixed(2), chargeFromSolarMWh: +(fg * 0.3).toFixed(2), chargeFromGridMWh: 0,
    dischargeMWh: 260, solarHourly: fraudSolar, dischargeHourly: dischargeProfile(260),
  };
  fraud.claimedRevenueUsd = Math.round(fraud.solarExportMWh * 55 + fraud.dischargeMWh * 90);
  return { honest, fraud, meterMWh: +(honest.solarExportMWh + honest.dischargeMWh).toFixed(2) };
}
let CLAIMS = buildClaims();
let METER = CLAIMS.meterMWh; // utility revenue meter — never lies

let state = { mode: "honest", epochId: Math.floor(Date.now() / 1000) };

const HUB_ABI = parseAbi([
  "function getSPV(uint256) view returns (string,address,uint32,uint32,int32,int32,uint256,uint256)",
  "function epochCount() view returns (uint256)",
  "function certificates(uint256) view returns (uint64 periodStart,uint32 cleanHourMask,uint16 cfeBps,uint32 greenMWhX10)",
  "function gridRegion(uint256) view returns (string)",
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
    const c = await client.readContract({ address: hub, abi: HUB_ABI, functionName: "certificates", args: [BigInt(i)] }).catch(() => [0n, 0, 0, 0]);
    epochs.push({ periodStart: Number(c[0]), cleanHourMask: Number(c[1]), cfePct: Number(c[2]) / 100, greenMWh: Number(c[3]) / 10, epochId: e[1].toString(), approved: e[2], aiScore: e[3], violations: e[4], claimedUsdc: Number(e[5]) / 1e6, paidUsdc: Number(e[6]) / 1e6, timestamp: Number(e[8]) });
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
  const region = await client.readContract({ address: hub, abi: HUB_ABI, functionName: "gridRegion", args: [0n] }).catch(() => "");
  return { hub, token, name, region, solarMWp, batteryMWh, escrowUsdc: Number(escrow) / 1e6, totalPaidUsdc: Number(totalPaid) / 1e6, epochs: epochs.reverse(), holders };
}

const send = (res, code, obj, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(type === "application/json" ? JSON.stringify(obj) : obj);
};

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (url === "/operator/telemetry") return send(res, 200, { epochId: state.epochId, periodStart: weather.periodStart, ...CLAIMS[state.mode] });
    // Private SCADA feed (hour-by-hour dispatch data) — requires the operator's API token.
    // Only the CRE Confidential Workflow (inside the TEE) holds that token.
    if (url === "/operator/scada") {
      const auth = req.headers.authorization || "";
      const want = process.env.OPERATOR_API_KEY || "";
      if (!auth.startsWith("Bearer ") || (want && auth !== `Bearer ${want}`)) return send(res, 401, { error: "operator token required" });
      return send(res, 200, { epochId: state.epochId, periodStart: weather.periodStart, ...CLAIMS[state.mode] });
    }
    if (url === "/utility/meter") return send(res, 200, { epochId: state.epochId, exportMWh: METER });
    if (req.method === "POST" && (url === "/operator/fraud" || url === "/operator/honest")) {
      await loadWeather(); CLAIMS = buildClaims(); METER = CLAIMS.meterMWh;
      state = { mode: url.endsWith("fraud") ? "fraud" : "honest", epochId: state.epochId + 1 };
      console.log(`operator now ${state.mode.toUpperCase()}, epoch ${state.epochId}`);
      return send(res, 200, state);
    }
    if (url === "/state") return send(res, 200, { ...state, claim: CLAIMS[state.mode], meterMWh: METER, weather, site: SITE, chain: await chainState() });
    if (url === "/" || url === "/index.html") return send(res, 200, fs.readFileSync(path.join(dir, "..", "dashboard", "index.html")), "text/html");
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, async () => { await loadWeather(); CLAIMS = buildClaims(); METER = CLAIMS.meterMWh; console.log(`weather: ${weather.source}`); })
  .on("listening", () => console.log(`☀️  GreenYield mock API + dashboard on http://localhost:${PORT}`));
