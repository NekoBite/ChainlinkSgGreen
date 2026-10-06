/**
 * GreenYield — Chainlink CRE workflow
 *
 * Every epoch:
 *   1. EVM read   — SPV facts from GreenYieldHub (capacity, location, escrow)
 *   2. HTTP       — operator telemetry + independent utility meter (mock API)
 *   3. HTTP       — Open-Meteo solar irradiance for the site (real public API)
 *   4. Physics    — 6 deterministic rules → violation bitmask (no LLM here)
 *   5. LLM        — one number: 0-100 trust score (the only AI output on the wire)
 *   6. EVM write  — signed report → hub releases escrow to holders, or records a rejection
 */
import {
  bytesToHex,
  ConsensusAggregationByFields,
  consensusMedianAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  json,
  LATEST_BLOCK_NUMBER,
  median,
  ok,
  prepareReportRequest,
  Runner,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  zeroAddress,
  type Address,
} from "viem";
import { z } from "zod";

// ───────────────────────── config ─────────────────────────
const configSchema = z.object({
  schedule: z.string(),
  mockApiUrl: z.string(),
  spvId: z.number(),
  chainSelectorName: z.string(),
  hubAddress: z.string(),
  gasLimit: z.string(),
  llmUrl: z.string(),
  llmModel: z.string(),
  performanceRatio: z.number(), // best-case PR of a solar plant
  roundTripEfficiency: z.number(), // battery RTE
  fallbackPeakSunHours: z.number(), // used only if the weather API is down
  ppaUsdPerMWh: z.number(),
  peakUsdPerMWh: z.number(),
  offPeakUsdPerMWh: z.number(),
  minTrustScore: z.number(),
});
type Config = z.infer<typeof configSchema>;

// ───────────────────────── types ─────────────────────────
type Telemetry = {
  epochId: number;
  solarGenMWh: number; // inverter output
  solarExportMWh: number; // sold direct to grid under the PPA
  chargeFromSolarMWh: number;
  chargeFromGridMWh: number; // bought off-peak
  dischargeMWh: number; // sold into the evening peak
  claimedRevenueUsd: number; // what the operator says it earned
};
const telemetrySchema = z.object({
  epochId: z.number(),
  solarGenMWh: z.number(),
  solarExportMWh: z.number(),
  chargeFromSolarMWh: z.number(),
  chargeFromGridMWh: z.number(),
  dischargeMWh: z.number(),
  claimedRevenueUsd: z.number(),
});

const HUB_ABI = parseAbi([
  "function getSPV(uint256 id) view returns (string name, address token, uint32 solarMWp, uint32 batteryMWh, int32 latE4, int32 lonE4, uint256 escrow, uint256 totalPaid)",
]);

// ───────────────────────── node-mode fetchers ─────────────────────────
const fetchTelemetry = (s: HTTPSendRequester, url: string): Telemetry => {
  const r = s.sendRequest({ url, method: "GET" }).result();
  if (!ok(r)) throw new Error(`telemetry HTTP ${r.statusCode}`);
  return telemetrySchema.parse(json(r));
};

const fetchMeter = (s: HTTPSendRequester, url: string): number => {
  const r = s.sendRequest({ url, method: "GET" }).result();
  if (!ok(r)) throw new Error(`meter HTTP ${r.statusCode}`);
  return Number((json(r) as { exportMWh: number }).exportMWh);
};

const fetchPeakSunHours = (s: HTTPSendRequester, url: string): number => {
  const r = s.sendRequest({ url, method: "GET" }).result();
  if (!ok(r)) throw new Error(`weather HTTP ${r.statusCode}`);
  const d = json(r) as { daily: { shortwave_radiation_sum: number[] } };
  return d.daily.shortwave_radiation_sum[0] / 3.6; // MJ/m² → kWh/m² = peak sun hours
};

const askLlmForTrustScore = (s: HTTPSendRequester, cfg: Config, apiKey: string, evidence: string): number => {
  const body = {
    model: cfg.llmModel,
    max_tokens: 10,
    temperature: 0,
    system:
      "You audit renewable-energy revenue claims for an SPV trustee. The arithmetic checks are already done; " +
      "you judge whether the whole story is plausible. Reply with ONE integer 0-100 (100 = fully trustworthy). No other text.",
    messages: [{ role: "user", content: evidence }],
  };
  const r = s
    .sendRequest({
      url: cfg.llmUrl,
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
      cacheSettings: { store: true, maxAge: "60s" }, // DON nodes share one LLM answer
    })
    .result();
  if (!ok(r)) throw new Error(`LLM HTTP ${r.statusCode}`);
  const out = json(r) as { content: { text: string }[] };
  const n = Number.parseInt(out.content[0].text.trim().match(/\d+/)?.[0] ?? "", 10);
  if (Number.isNaN(n)) throw new Error("LLM returned no number");
  return Math.max(0, Math.min(100, n));
};

// ───────────────────────── physics layer (deterministic) ─────────────────────────
type Rule = { bit: number; name: string; pass: boolean; detail: string };

const physics = (t: Telemetry, meterMWh: number, solarMWp: number, batteryMWh: number, psh: number, cfg: Config) => {
  const sunCeiling = solarMWp * psh * cfg.performanceRatio;
  const charged = t.chargeFromSolarMWh + t.chargeFromGridMWh;
  const f = (x: number) => x.toFixed(1);
  const rules: Rule[] = [
    { bit: 1, name: "The sun is the limit", pass: t.solarGenMWh <= sunCeiling,
      detail: `solar ${f(t.solarGenMWh)} ≤ ${solarMWp}MWp×${f(psh)}h×${cfg.performanceRatio} = ${f(sunCeiling)}` },
    { bit: 2, name: "One electron, one place", pass: t.solarExportMWh + t.chargeFromSolarMWh <= t.solarGenMWh + 0.01,
      detail: `export ${f(t.solarExportMWh)} + charge ${f(t.chargeFromSolarMWh)} ≤ generated ${f(t.solarGenMWh)}` },
    { bit: 4, name: "A battery cannot create energy", pass: t.dischargeMWh <= charged * cfg.roundTripEfficiency + 0.01,
      detail: `discharge ${f(t.dischargeMWh)} ≤ charge ${f(charged)}×${cfg.roundTripEfficiency}` },
    { bit: 8, name: "The meter is the referee", pass: t.solarExportMWh + t.dischargeMWh <= meterMWh + 0.01,
      detail: `exported ${f(t.solarExportMWh + t.dischargeMWh)} ≤ utility meter ${f(meterMWh)}` },
    { bit: 16, name: "Discharge within battery rating", pass: t.dischargeMWh <= batteryMWh,
      detail: `discharge ${f(t.dischargeMWh)} ≤ ${batteryMWh} MWh (1 cycle/day)` },
    { bit: 32, name: "Charge within battery rating", pass: charged <= batteryMWh,
      detail: `charge ${f(charged)} ≤ ${batteryMWh} MWh (1 cycle/day)` },
  ];
  const violations = rules.reduce((m, r) => (r.pass ? m : m | r.bit), 0);
  return { rules, violations, sunCeiling };
};

// ───────────────────────── handler ─────────────────────────
const onEpoch = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const http = new cre.capabilities.HTTPClient();

  // 1. On-chain facts about the SPV
  const call = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: cfg.hubAddress as Address,
        data: encodeFunctionData({ abi: HUB_ABI, functionName: "getSPV", args: [BigInt(cfg.spvId)] }),
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  const [name, , solarMWp, batteryMWh, latE4, lonE4, escrow] = decodeFunctionResult({
    abi: HUB_ABI, functionName: "getSPV", data: bytesToHex(call.data),
  });
  const lat = latE4 / 1e4, lon = lonE4 / 1e4;
  runtime.log(`🏭 SPV #${cfg.spvId} "${name}" — ${solarMWp} MWp solar, ${batteryMWh} MWh battery @ ${lat},${lon}; escrow ${Number(escrow) / 1e6} USDC`);

  // 2. Operator claim + independent utility meter
  const t = http
    .sendRequest(runtime, fetchTelemetry, ConsensusAggregationByFields<Telemetry>({
      epochId: median, solarGenMWh: median, solarExportMWh: median, chargeFromSolarMWh: median,
      chargeFromGridMWh: median, dischargeMWh: median, claimedRevenueUsd: median,
    }), { schema: telemetrySchema })(`${cfg.mockApiUrl}/operator/telemetry`)
    .result();
  const meterMWh = http
    .sendRequest(runtime, fetchMeter, consensusMedianAggregation<number>())(`${cfg.mockApiUrl}/utility/meter`)
    .result();
  runtime.log(`📡 Epoch ${t.epochId} operator claims: solar ${t.solarGenMWh} MWh, export ${t.solarExportMWh}, charge ${t.chargeFromSolarMWh}+${t.chargeFromGridMWh}, discharge ${t.dischargeMWh}, revenue $${t.claimedRevenueUsd}`);
  runtime.log(`🔌 Utility meter says exported: ${meterMWh} MWh`);

  // 3. Independent weather data
  let psh = cfg.fallbackPeakSunHours;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=shortwave_radiation_sum&past_days=1&forecast_days=1&timezone=auto`;
    psh = http.sendRequest(runtime, fetchPeakSunHours, consensusMedianAggregation<number>())(url).result();
    runtime.log(`☀️  Open-Meteo: ${psh.toFixed(2)} peak sun hours yesterday at the site`);
  } catch (e) {
    runtime.log(`☀️  Weather API unavailable, using fallback ${psh} peak sun hours`);
  }

  // 4. Physics
  const p = physics(t, meterMWh, solarMWp, batteryMWh, psh, cfg);
  for (const r of p.rules) runtime.log(`   ${r.pass ? "✅" : "❌"} ${r.name}: ${r.detail}`);

  // Revenue is recomputed from metered energy — never taken from the operator's claim
  const revenueUsd =
    t.solarExportMWh * cfg.ppaUsdPerMWh + t.dischargeMWh * cfg.peakUsdPerMWh - t.chargeFromGridMWh * cfg.offPeakUsdPerMWh;
  runtime.log(`💵 Recomputed revenue: $${revenueUsd.toFixed(2)} (operator claimed $${t.claimedRevenueUsd})`);

  // 5. AI pattern layer → one scalar
  const evidence = JSON.stringify({
    spv: name, epoch: t.epochId, capacity: { solarMWp, batteryMWh }, peakSunHours: Number(psh.toFixed(2)),
    telemetry: t, utilityMeterMWh: meterMWh, recomputedRevenueUsd: Number(revenueUsd.toFixed(2)),
    physicsChecks: p.rules.map((r) => ({ rule: r.name, pass: r.pass, detail: r.detail })),
  });
  let score: number;
  const apiKey = runtime.getSecret({ id: "LLM_API_KEY" }).result().value;
  if (!apiKey || apiKey === "none") {
    score = p.violations === 0 ? 85 : 10;
    runtime.log(`🤖 No LLM key — offline score ${score}`);
  } else {
    try {
      score = http
        .sendRequest(runtime, askLlmForTrustScore, consensusMedianAggregation<number>())(cfg, apiKey, evidence)
        .result();
      runtime.log(`🤖 AI trust score: ${score}/100`);
    } catch (e) {
      score = p.violations === 0 ? 70 : 0;
      runtime.log(`🤖 LLM failed (${e}) — fail-safe score ${score}`);
    }
  }

  // 6. Decide and write
  const approved = p.violations === 0 && score >= cfg.minTrustScore;
  const usdc = approved ? BigInt(Math.round(Math.max(0, revenueUsd) * 1e6)) : 0n;
  const evidenceHash = keccak256(toBytes(evidence));
  runtime.log(approved
    ? `🟢 APPROVED — releasing ${Number(usdc) / 1e6} USDC to SPV token holders`
    : `🔴 REJECTED — ${p.rules.filter((r) => !r.pass).length} physics violation(s), AI ${score}. Writing a zero-revenue record.`);

  const payload = encodeAbiParameters(
    parseAbiParameters("uint256, uint64, bool, uint8, uint16, uint256, bytes32"),
    [BigInt(cfg.spvId), BigInt(t.epochId), approved, score, p.violations, usdc, evidenceHash],
  );
  const report = runtime.report(prepareReportRequest(payload)).result();
  const w = evm
    .writeReport(runtime, { receiver: cfg.hubAddress, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();
  if (w.txStatus !== TxStatus.SUCCESS) throw new Error(`write failed: ${w.errorMessage ?? w.txStatus}`);
  const tx = bytesToHex(w.txHash ?? new Uint8Array(32));
  runtime.log(`⛓️  Report written. tx ${tx}`);
  return JSON.stringify({ epoch: t.epochId, approved, score, violations: p.violations, usdc: usdc.toString(), tx });
};

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onEpoch)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
