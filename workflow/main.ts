/**
 * GreenYield — Chainlink CRE workflow
 *
 * Every epoch:
 *   1. EVM read   — SPV facts from GreenYieldHub (capacity, location, escrow)
 *   2. HTTP       — operator telemetry + independent utility meter (mock API)
 *   3. HTTP       — Open-Meteo HOURLY irradiance for the site → 24/7 hour-by-hour matching
 *   4. Physics    — 8 deterministic rules (6 daily + 2 hourly) → violation bitmask (no LLM here)
 *   5. LLM        — one number: 0-100 trust score (the only AI output on the wire)
 *   6. EVM write  — signed report → hub releases escrow + issues a time/location-stamped 24/7
 *                   certificate, or records a rejection with zero clean hours
 */
import {
  bytesToHex,
  ConsensusAggregationByFields,
  consensusMedianAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  handlerInTee,
  json,
  logTriggerConfig,
  LATEST_BLOCK_NUMBER,
  median,
  ok,
  prepareReportRequest,
  Runner,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
  type TeeRuntime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
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
  offtakeMW: z.number(), // the corporate buyer's flat 24/7 load the plant is matched against
  useConfidentialHttp: z.boolean(), // send the LLM call through Confidential HTTP (key never visible to nodes)
  secretOwner: z.string(), // address that owns the LLM_API_KEY Vault DON secret (the workflow owner)
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
  periodStart: number; // local midnight of the epoch's day (unix seconds)
};

/** 24/7 hourly analysis — computed per node from the hourly arrays, then agreed field by field. */
type Hourly = {
  peakSunHours: number; // Σ hourly irradiance / 1000
  weatherLive: number; // 1 = Open-Meteo, 0 = clear-sky fallback
  nightSolarMWh: number; // solar claimed in hours when the sun was down
  hourlyExcessMWh: number; // solar claimed above what each hour's sunlight allows
  cleanHourMask: number; // bit h = hour h fully covered by clean energy
  cfeBps: number; // 24/7 carbon-free-energy score
  greenMWhX10: number; // hourly-matched clean MWh × 10
};
const hourlySchema = z.object({
  peakSunHours: z.number(), weatherLive: z.number(), nightSolarMWh: z.number(), hourlyExcessMWh: z.number(),
  cleanHourMask: z.number(), cfeBps: z.number(), greenMWhX10: z.number(),
});
const telemetrySchema = z.object({
  epochId: z.number(),
  solarGenMWh: z.number(),
  solarExportMWh: z.number(),
  chargeFromSolarMWh: z.number(),
  chargeFromGridMWh: z.number(),
  dischargeMWh: z.number(),
  claimedRevenueUsd: z.number(),
  periodStart: z.number(),
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

/** Same deterministic clear-sky curve the mock API falls back to: 06:00–18:00, peak 900 W/m². */
const fallbackIrradiance = () =>
  Array.from({ length: 24 }, (_, h) => (h >= 6 && h <= 18 ? Math.round(900 * Math.sin(((h - 6) / 12) * Math.PI)) : 0));

const analyseHours = (
  s: HTTPSendRequester, telemetryUrl: string, weatherUrl: string, solarMWp: number, pr: number, offtakeMW: number,
): Hourly => {
  const tr = s.sendRequest({ url: telemetryUrl, method: "GET" }).result();
  if (!ok(tr)) throw new Error(`telemetry HTTP ${tr.statusCode}`);
  const t = json(tr) as HourlyClaim;

  let irr = fallbackIrradiance();
  let weatherLive = 0;
  try {
    const wr = s.sendRequest({ url: weatherUrl, method: "GET" }).result();
    if (ok(wr)) {
      const w = (json(wr) as { hourly: { shortwave_radiation: number[] } }).hourly.shortwave_radiation.slice(0, 24);
      if (w.length === 24) { irr = w.map(Number); weatherLive = 1; }
    }
  } catch (_) { /* keep fallback */ }

  return computeHourly(t, irr, weatherLive, solarMWp, pr, offtakeMW);
};

type HourlyClaim = { solarHourly: number[]; dischargeHourly: number[]; solarGenMWh: number; solarExportMWh: number };

/** Pure 24/7 analysis — used by the DON handlers and inside the TEE. */
const computeHourly = (
  t: HourlyClaim, irr: number[], weatherLive: number, solarMWp: number, pr: number, offtakeMW: number,
): Hourly => {
  const exportShare = t.solarGenMWh > 0 ? t.solarExportMWh / t.solarGenMWh : 0;
  let night = 0, excess = 0, mask = 0, covered = 0;
  for (let h = 0; h < 24; h++) {
    const solar = t.solarHourly[h] ?? 0;
    const ceiling = (solarMWp * irr[h] / 1000) * pr; // MWh this hour's sunlight allows
    if (irr[h] < 5) night += solar;
    else excess += Math.max(0, solar - ceiling * 1.05);
    const clean = solar * exportShare + (t.dischargeHourly[h] ?? 0); // clean MWh delivered this hour
    const c = Math.min(offtakeMW, clean);
    covered += c;
    if (c >= offtakeMW * 0.999) mask |= 1 << h;
  }
  return {
    peakSunHours: irr.reduce((a, b) => a + b, 0) / 1000,
    weatherLive,
    nightSolarMWh: Math.round(night * 100) / 100,
    hourlyExcessMWh: Math.round(excess * 100) / 100,
    cleanHourMask: mask,
    cfeBps: Math.round((covered / (offtakeMW * 24)) * 10000),
    greenMWhX10: Math.round(covered * 10),
  };
};

const askLlmForTrustScore = (s: HTTPSendRequester, cfg: Config, apiKey: string, evidence: string): number => {
  const body = {
    model: cfg.llmModel,
    max_tokens: 16,
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
  if (!ok(r)) throw new Error(`LLM HTTP ${r.statusCode}: ${new TextDecoder().decode(r.body).slice(0, 160)}`);
  const out = json(r) as { content: { text: string }[] };
  const n = Number.parseInt(out.content[0].text.trim().match(/\d+/)?.[0] ?? "", 10);
  if (Number.isNaN(n)) throw new Error("LLM returned no number");
  return Math.max(0, Math.min(100, n));
};

const LLM_SYSTEM =
  "You audit renewable-energy revenue claims for an SPV trustee. The arithmetic checks are already done; " +
  "you judge whether the whole story is plausible. Reply with ONE integer 0-100 (100 = fully trustworthy). No other text.";

const parseScore = (body: Uint8Array): number => {
  const out = JSON.parse(new TextDecoder().decode(body)) as { content: { text: string }[] };
  const n = Number.parseInt(out.content[0].text.trim().match(/\d+/)?.[0] ?? "", 10);
  if (Number.isNaN(n)) throw new Error("LLM returned no number");
  return Math.max(0, Math.min(100, n));
};

/**
 * Confidential HTTP: the request runs in an enclave and the API key is injected there from the
 * Vault DON ({{.LLM_API_KEY}}) — no node operator ever sees the key or the evidence we send.
 */
const askLlmConfidential = (runtime: Runtime<Config>, evidence: string): number => {
  const cfg = runtime.config;
  const resp = new cre.capabilities.ConfidentialHTTPClient()
    .sendRequest(runtime, {
      vaultDonSecrets: [{ key: "LLM_API_KEY", owner: cfg.secretOwner }],
      request: {
        url: cfg.llmUrl,
        method: "POST",
        bodyString: JSON.stringify({
          model: cfg.llmModel, max_tokens: 16, system: LLM_SYSTEM,
          messages: [{ role: "user", content: evidence }],
        }),
        multiHeaders: {
          "content-type": { values: ["application/json"] },
          "x-api-key": { values: ["{{.LLM_API_KEY}}"] },
          "anthropic-version": { values: ["2023-06-01"] },
        },
      },
    })
    .result();
  if (resp.statusCode < 200 || resp.statusCode >= 300) throw new Error(`LLM HTTP ${resp.statusCode}: ${new TextDecoder().decode(resp.body).slice(0, 160)}`);
  return parseScore(resp.body);
};

// ───────────────────────── physics layer (deterministic) ─────────────────────────
type Rule = { bit: number; name: string; pass: boolean; detail: string };

const physics = (t: Telemetry, hr: Hourly, meterMWh: number, solarMWp: number, batteryMWh: number, cfg: Config) => {
  const psh = hr.peakSunHours;
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
    { bit: 64, name: "No sun, no solar (hourly)", pass: hr.nightSolarMWh <= 0.5,
      detail: `${f(hr.nightSolarMWh)} MWh of solar claimed in hours when the sun was down` },
    { bit: 128, name: "Every hour within its sunlight", pass: hr.hourlyExcessMWh <= 0.5,
      detail: `${f(hr.hourlyExcessMWh)} MWh claimed above what each hour's irradiance allows` },
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
      chargeFromGridMWh: median, dischargeMWh: median, claimedRevenueUsd: median, periodStart: median,
    }), { schema: telemetrySchema })(`${cfg.mockApiUrl}/operator/telemetry`)
    .result();
  const meterMWh = http
    .sendRequest(runtime, fetchMeter, consensusMedianAggregation<number>())(`${cfg.mockApiUrl}/utility/meter`)
    .result();
  runtime.log(`📡 Epoch ${t.epochId} operator claims: solar ${t.solarGenMWh} MWh, export ${t.solarExportMWh}, charge ${t.chargeFromSolarMWh}+${t.chargeFromGridMWh}, discharge ${t.dischargeMWh}, revenue $${t.claimedRevenueUsd}`);
  runtime.log(`🔌 Utility meter says exported: ${meterMWh} MWh`);

  // 3. Hour-by-hour: operator's hourly profile vs Open-Meteo hourly irradiance (24/7 matching)
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&past_days=1&forecast_days=1&timezone=auto`;
  const hr = http
    .sendRequest(runtime, analyseHours, ConsensusAggregationByFields<Hourly>({
      peakSunHours: median, weatherLive: median, nightSolarMWh: median, hourlyExcessMWh: median,
      cleanHourMask: median, cfeBps: median, greenMWhX10: median,
    }), { schema: hourlySchema })(`${cfg.mockApiUrl}/operator/telemetry`, weatherUrl, solarMWp, cfg.performanceRatio, cfg.offtakeMW)
    .result();
  const psh = hr.peakSunHours;
  runtime.log(`☀️  ${hr.weatherLive ? "Open-Meteo" : "Clear-sky fallback"}: ${psh.toFixed(2)} peak sun hours at the site (hourly data)`);
  const hours = Array.from({ length: 24 }, (_, h) => ((hr.cleanHourMask >> h) & 1 ? "█" : "·")).join("");
  runtime.log(`🕐 24/7 match vs ${cfg.offtakeMW} MW AI data centre (GPU load): ${(hr.cfeBps / 100).toFixed(1)}% CFE, ${hr.greenMWhX10 / 10} MWh hourly-matched`);
  runtime.log(`   00h ${hours} 23h`);

  // 4. Physics
  const p = physics(t, hr, meterMWh, solarMWp, batteryMWh, cfg);
  for (const r of p.rules) runtime.log(`   ${r.pass ? "✅" : "❌"} ${r.name}: ${r.detail}`);

  // Revenue is recomputed from metered energy — never taken from the operator's claim
  const revenueUsd =
    t.solarExportMWh * cfg.ppaUsdPerMWh + t.dischargeMWh * cfg.peakUsdPerMWh - t.chargeFromGridMWh * cfg.offPeakUsdPerMWh;
  runtime.log(`💵 Recomputed revenue: $${revenueUsd.toFixed(2)} (operator claimed $${t.claimedRevenueUsd})`);

  // 5. AI pattern layer → one scalar
  const evidence = JSON.stringify({
    spv: name, epoch: t.epochId, capacity: { solarMWp, batteryMWh }, peakSunHours: Number(psh.toFixed(2)),
    telemetry: t, utilityMeterMWh: meterMWh, hourly: { ...hr, cleanHours: hours }, recomputedRevenueUsd: Number(revenueUsd.toFixed(2)),
    physicsChecks: p.rules.map((r) => ({ rule: r.name, pass: r.pass, detail: r.detail })),
  });
  let score: number | undefined;
  // Demo switch: LLM_API_KEY=none runs the pattern layer in offline mode (no API call at all)
  const offline = runtime.getSecret({ id: "LLM_API_KEY" }).result().value === "none";
  if (offline) {
    score = p.violations === 0 ? 85 : 10;
    runtime.log(`🤖 AI pattern layer (offline demo mode, Confidential HTTP path wired): score ${score}/100`);
  }
  if (score === undefined && cfg.useConfidentialHttp) {
    try {
      score = askLlmConfidential(runtime, evidence);
      runtime.log(`🤖🔒 AI trust score via Confidential HTTP: ${score}/100`);
    } catch (e) {
      runtime.log(`🔒 Confidential HTTP unavailable (${e}) — falling back to standard HTTP`);
    }
  }
  if (score === undefined) {
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
  }

  // 6. Decide and write
  const approved = p.violations === 0 && score >= cfg.minTrustScore;
  const usdc = approved ? BigInt(Math.round(Math.max(0, revenueUsd) * 1e6)) : 0n;
  const evidenceHash = keccak256(toBytes(evidence));
  runtime.log(approved
    ? `🟢 APPROVED — releasing ${Number(usdc) / 1e6} USDC to SPV token holders + 24/7 certificate (${(hr.cfeBps / 100).toFixed(1)}% CFE)`
    : `🔴 REJECTED — ${p.rules.filter((r) => !r.pass).length} physics violation(s), AI ${score}. Writing a zero-revenue record.`);

  const payload = encodeAbiParameters(
    // matches GreenYieldHub.Report (all static fields → identical to a flat tuple)
    parseAbiParameters("uint256, uint64, bool, uint8, uint16, uint256, bytes32, uint64, uint32, uint16, uint32"),
    [BigInt(cfg.spvId), BigInt(t.epochId), approved, score, p.violations, usdc, evidenceHash,
     BigInt(t.periodStart), hr.cleanHourMask, hr.cfeBps, hr.greenMWhX10],
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

// ───────────────────────── Confidential Workflow (TEE) ─────────────────────────
/**
 * Handler 2 runs inside a hardware-isolated enclave (AWS Nitro).
 *
 * The operator's hour-by-hour SCADA feed is commercially sensitive (it reveals dispatch strategy and
 * battery arbitrage), and its API token must never be visible to node operators. So the enclave:
 *   • fetches OPERATOR_API_KEY and LLM_API_KEY from the Vault DON,
 *   • pulls the private SCADA feed, the utility meter and Open-Meteo,
 *   • runs all 8 physics rules, the 24/7 matching and the LLM call,
 * and only derived conclusions (verdict, violation mask, clean-hour mask, CFE %, payout, evidence hash)
 * cross back to the DON via usingTheDons() to be signed and written on-chain.
 */
const onEpochInTee = (runtime: TeeRuntime<Config>): string => {
  const cfg = runtime.config;
  const don = runtime.usingTheDons(); // chain I/O and report signing stay on the DON
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);

  // Public facts from chain
  const call = evm.callContract(don, {
    call: encodeCallMsg({
      from: zeroAddress, to: cfg.hubAddress as Address,
      data: encodeFunctionData({ abi: HUB_ABI, functionName: "getSPV", args: [BigInt(cfg.spvId)] }),
    }),
    blockNumber: LATEST_BLOCK_NUMBER,
  }).result();
  const [name, , solarMWp, batteryMWh, latE4, lonE4] = decodeFunctionResult({
    abi: HUB_ABI, functionName: "getSPV", data: bytesToHex(call.data),
  });
  const lat = latE4 / 1e4, lon = lonE4 / 1e4;

  // ── inside the enclave from here ──
  const http = new cre.capabilities.HTTPClient();
  const operatorKey = runtime.getSecret({ id: "OPERATOR_API_KEY" }).result().value;
  const scada = http.sendRequest(runtime, {
    url: `${cfg.mockApiUrl}/operator/scada`, method: "GET",
    multiHeaders: { authorization: { values: [`Bearer ${operatorKey}`] } },
  }).result();
  if (!ok(scada)) throw new Error(`SCADA HTTP ${scada.statusCode}`);
  const t = telemetrySchema.parse(json(scada)) as Telemetry;
  const claim = json(scada) as HourlyClaim;
  const meterResp = http.sendRequest(runtime, { url: `${cfg.mockApiUrl}/utility/meter`, method: "GET" }).result();
  if (!ok(meterResp)) throw new Error(`meter HTTP ${meterResp.statusCode}`);
  const meterMWh = Number((json(meterResp) as { exportMWh: number }).exportMWh);

  let irr = fallbackIrradiance();
  let weatherLive = 0;
  try {
    const wr = http.sendRequest(runtime, {
      url: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&past_days=1&forecast_days=1&timezone=auto`,
      method: "GET",
    }).result();
    if (ok(wr)) {
      const w = (json(wr) as { hourly: { shortwave_radiation: number[] } }).hourly.shortwave_radiation.slice(0, 24);
      if (w.length === 24) { irr = w.map(Number); weatherLive = 1; }
    }
  } catch (_) { /* keep fallback */ }

  const hr = computeHourly(claim, irr, weatherLive, solarMWp, cfg.performanceRatio, cfg.offtakeMW);
  const p = physics(t, hr, meterMWh, solarMWp, batteryMWh, cfg);
  const revenueUsd =
    t.solarExportMWh * cfg.ppaUsdPerMWh + t.dischargeMWh * cfg.peakUsdPerMWh - t.chargeFromGridMWh * cfg.offPeakUsdPerMWh;
  const evidence = JSON.stringify({ spv: name, epoch: t.epochId, telemetry: claim, utilityMeterMWh: meterMWh, hourly: hr,
    physicsChecks: p.rules.map((r) => ({ rule: r.name, pass: r.pass })) });

  const llmKey = runtime.getSecret({ id: "LLM_API_KEY" }).result().value;
  let score = p.violations === 0 ? 85 : 10;
  if (llmKey && llmKey !== "none") {
    try {
      const r = http.sendRequest(runtime, {
        url: cfg.llmUrl, method: "POST",
        multiHeaders: {
          "content-type": { values: ["application/json"] },
          "x-api-key": { values: [llmKey] },
          "anthropic-version": { values: ["2023-06-01"] },
        },
        body: Buffer.from(JSON.stringify({ model: cfg.llmModel, max_tokens: 16, system: LLM_SYSTEM,
          messages: [{ role: "user", content: evidence }] })).toString("base64"),
      }).result();
      if (ok(r)) score = parseScore(r.body);
    } catch (_) { /* keep deterministic score */ }
  }

  const approved = p.violations === 0 && score >= cfg.minTrustScore;
  const usdc = approved ? BigInt(Math.round(Math.max(0, revenueUsd) * 1e6)) : 0n;
  // Simulation-only enclave log: conclusions only, never the raw feed or keys
  runtime.log(`🔐 [TEE] private SCADA feed for "${name}" epoch ${t.epochId} processed inside the enclave (raw hourly data + API keys never leave it)`);
  runtime.log(`🔐 [TEE] ${p.rules.filter((r) => r.pass).length}/8 physics rules pass · 24/7 CFE ${(hr.cfeBps / 100).toFixed(1)}% · AI ${score}/100`);

  // ── cross back: only derived values leave the enclave ──
  const payload = encodeAbiParameters(
    parseAbiParameters("uint256, uint64, bool, uint8, uint16, uint256, bytes32, uint64, uint32, uint16, uint32"),
    [BigInt(cfg.spvId), BigInt(t.epochId), approved, score, p.violations, usdc, keccak256(toBytes(evidence)),
     BigInt(t.periodStart), approved ? hr.cleanHourMask : 0, approved ? hr.cfeBps : 0, approved ? hr.greenMWhX10 : 0],
  );
  const report = don.report(prepareReportRequest(payload)).result();
  const w = evm.writeReport(don, { receiver: cfg.hubAddress, report, gasConfig: { gasLimit: cfg.gasLimit } }).result();
  if (w.txStatus !== TxStatus.SUCCESS) throw new Error(`write failed: ${w.errorMessage ?? w.txStatus}`);
  const tx = bytesToHex(w.txHash ?? new Uint8Array(32));
  don.log(approved
    ? `🟢 APPROVED (verified in TEE) — releasing ${Number(usdc) / 1e6} USDC + 24/7 certificate · tx ${tx}`
    : `🔴 REJECTED (verified in TEE) — ${p.rules.filter((r) => !r.pass).length} physics violation(s) · zero-revenue record · tx ${tx}`);
  return JSON.stringify({ epoch: t.epochId, approved, score, violations: p.violations, usdc: usdc.toString(), tx, tee: true });
};

/** The operator escrows a period's revenue → CRE verifies it immediately (event-driven settlement). */
const REVENUE_ESCROWED = keccak256(toHex("RevenueEscrowed(uint256,uint256)"));

const onRevenueEscrowed = (runtime: Runtime<Config>, log: { txHash?: Uint8Array }): string => {
  runtime.log(`📥 RevenueEscrowed event on-chain${log.txHash ? ` (tx ${bytesToHex(log.txHash)})` : ""} — operator deposited revenue, verifying now`);
  return onEpoch(runtime);
};

const initWorkflow = (config: Config) => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown chain ${config.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const cron = new cre.capabilities.CronCapability();
  return [
    // 0: scheduled settlement (end of each day)
    cre.handler(cron.trigger({ schedule: config.schedule }), onEpoch),
    // 1: event-driven settlement — fires when the operator deposits revenue into escrow
    cre.handler(
      evm.logTrigger(logTriggerConfig({
        addresses: [config.hubAddress as `0x${string}`],
        topics: [[REVENUE_ESCROWED]],
        confidence: "LATEST",
      })),
      onRevenueEscrowed,
    ),
    // 2: Confidential Workflow — the whole verification runs inside a TEE on the operator's private SCADA feed
    handlerInTee(cron.trigger({ schedule: config.schedule }), onEpochInTee, [{ tee: "nitro", regions: ["us-west-2"] }]),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
