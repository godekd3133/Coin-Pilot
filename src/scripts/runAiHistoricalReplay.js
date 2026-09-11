import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import AIAdvisorService from '../ai/aiAdvisorService.js';
import { collectScalpingCandidates } from '../backtest/scalpingBacktest.js';
import { scoreAdviceOutcome } from '../ai/monitoringSessionService.js';

dotenv.config();

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarizeRows(rows) {
  const summary = {};
  for (const row of rows) {
    const current = summary[row.provider] || {
      responses: 0,
      hits: 0,
      misses: 0,
      flat: 0,
      calm: 0,
      abstained: 0,
      vetoGood: 0,
      vetoMissedOpportunity: 0,
      vetoFlat: 0,
      signedMovePercentTotal: 0,
      directionalCount: 0
    };
    current.responses += 1;
    if (row.verdict === 'HIT') current.hits += 1;
    if (row.verdict === 'MISS') current.misses += 1;
    if (row.verdict === 'FLAT') current.flat += 1;
    if (row.verdict === 'CALM') current.calm += 1;
    if (row.verdict === 'ABSTAINED') current.abstained += 1;
    if (row.vetoVerdict === 'VETO_GOOD') current.vetoGood += 1;
    if (row.vetoVerdict === 'VETO_MISSED_OPPORTUNITY') current.vetoMissedOpportunity += 1;
    if (row.vetoVerdict === 'VETO_FLAT') current.vetoFlat += 1;
    if (Number.isFinite(row.signedMovePercent)) {
      current.signedMovePercentTotal += row.signedMovePercent;
      current.directionalCount += 1;
    }
    summary[row.provider] = current;
  }
  for (const current of Object.values(summary)) {
    const scored = current.hits + current.misses;
    current.hitRate = scored > 0 ? current.hits / scored : null;
    current.averageSignedMovePercent = current.directionalCount > 0
      ? current.signedMovePercentTotal / current.directionalCount
      : null;
    delete current.signedMovePercentTotal;
    delete current.directionalCount;
  }
  return summary;
}

function buildReplayEvent(market, candidate, sampleIndex) {
  const rebound = candidate.rebound;
  const type = rebound.reboundConfirmed ? 'BUY_SIGNAL' : 'REBOUND_CANDIDATE';
  return {
    id: `historical-replay-${sampleIndex}-${market}`,
    key: `HISTORICAL_REPLAY:${market}:${candidate.timestamp || candidate.index}`,
    type,
    action: rebound.reboundConfirmed ? 'BUY' : 'WAIT',
    coin: market,
    price: candidate.currentPrice,
    reason: rebound.reboundConfirmed
      ? 'historical fixed-window confirmed rebound'
      : `historical rebound candidate: ${(rebound.rejectionReasons || []).join(', ') || 'candidate facts present'}`,
    signalKey: rebound.signalKey || String(candidate.timestamp || candidate.index),
    timestamp: candidate.timestamp,
    source: 'historical_replay',
    snapshot: {
      indicators: {
        rsi: rebound.rsi,
        previousRsi: rebound.previousRsi,
        rsiRecovery: rebound.rsiRecovery,
        volumeRatio: rebound.volumeRatio,
        closeStrength: rebound.closeStrength,
        trendSlopePercent: rebound.trendSlopePercent,
        signalRangePercent: rebound.signalRangePercent
      },
      rebound,
      freshness: { valid: true, ageSeconds: 0 },
      marketRegime: { confirmed: true },
      replay: { horizonCandles: true, futureTimestamp: candidate.futureCandle?.candle_date_time_utc || null }
    }
  };
}

async function main() {
  const candleFile = path.resolve(process.env.AI_REPLAY_CANDLES_FILE || '.cap-study-candles.json');
  const outputFile = path.resolve(process.env.AI_REPLAY_OUTPUT_FILE || '/tmp/coinpilot-ai-historical-replay.json');
  const provider = process.env.AI_REPLAY_PROVIDER || 'gpt';
  const maxSamples = Math.max(1, Math.floor(number(process.env.AI_REPLAY_MAX_SAMPLES, 20)));
  const horizonCandles = Math.max(1, Math.floor(number(process.env.AI_REPLAY_HORIZON_CANDLES, 5)));
  const minimumSpacingCandles = Math.max(1, Math.floor(number(process.env.AI_REPLAY_MIN_SPACING_CANDLES, 5)));
  const neutralBandPercent = Math.max(0, number(process.env.AI_REPLAY_NEUTRAL_BAND_PERCENT, 0.1));
  const marketsFilter = (process.env.AI_REPLAY_MARKETS || '').split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  const raw = JSON.parse(fs.readFileSync(candleFile, 'utf8'));
  const markets = marketsFilter.length > 0 ? marketsFilter : Object.keys(raw).filter(key => key.startsWith('KRW-'));
  const baseConfig = {
    signalProfile: process.env.SCALP_SIGNAL_PROFILE || 'rsi_rebound',
    rsiPeriod: number(process.env.SCALP_RSI_PERIOD, 14),
    rsiOversold: number(process.env.SCALP_RSI_OVERSOLD, 30),
    rsiOverbought: number(process.env.SCALP_RSI_OVERBOUGHT, 70),
    oversoldLookback: number(process.env.SCALP_OVERSOLD_LOOKBACK, 1),
    minReboundPercent: number(process.env.SCALP_MIN_REBOUND_PERCENT, 0.15),
    minRsiRecovery: number(process.env.SCALP_MIN_RSI_RECOVERY, 2),
    minVolumeRatio: number(process.env.SCALP_MIN_VOLUME_RATIO, 1),
    volumeLookback: number(process.env.SCALP_VOLUME_LOOKBACK, 20),
    minCloseStrength: number(process.env.SCALP_MIN_CLOSE_STRENGTH, 0.65),
    trendPeriod: number(process.env.SCALP_TREND_PERIOD, 30),
    trendSlopeLookback: number(process.env.SCALP_TREND_SLOPE_LOOKBACK, 3),
    minTrendSlopePercent: number(process.env.SCALP_MIN_TREND_SLOPE_PERCENT, -0.2),
    requirePreviousHighBreak: process.env.SCALP_REQUIRE_PREVIOUS_HIGH_BREAK !== 'false'
  };

  const candidates = markets.flatMap(market => {
    const result = collectScalpingCandidates(raw[market] || [], baseConfig, {
      horizonCandles,
      minimumSpacingCandles
    });
    return result.candidates.map(candidate => ({ market, ...candidate }));
  }).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const selected = candidates.slice(0, maxSamples);
  if (selected.length === 0) throw new Error('고정 candle window에서 replay 후보를 찾지 못했습니다.');

  const advisor = new AIAdvisorService({ timeoutMs: number(process.env.AI_ADVISOR_TIMEOUT_MS, 30_000) });
  const rows = [];
  const failures = [];
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const event = buildReplayEvent(candidate.market, candidate, index);
    const response = await advisor.ask({
      provider,
      event,
      context: {
        mode: 'HISTORICAL_REPLAY',
        source: candleFile,
        warning: '과거 고정 candle window replay입니다. 이 결과는 live/promotion 증거가 아닙니다.'
      },
      session: { name: 'AI historical replay', horizon: `${horizonCandles} candles` }
    });
    const completed = (response.results || []).filter(result =>
      result.provider !== 'local-brief' && result.status === 'COMPLETED' && result.advice
    );
    if (completed.length === 0) {
      failures.push({ index, market: candidate.market, status: response.status });
    }
    for (const result of completed) {
      const scored = scoreAdviceOutcome(result.advice, candidate.priceChangePercent, neutralBandPercent, event.action);
      rows.push({
        index,
        market: candidate.market,
        timestamp: candidate.timestamp,
        eventType: event.type,
        provider: result.provider,
        action: scored.action,
        confidence: scored.confidence,
        verdict: scored.verdict,
        vetoVerdict: scored.vetoVerdict,
        priceChangePercent: scored.priceChangePercent,
        signedMovePercent: scored.signedMovePercent,
        latencyMs: result.latencyMs
      });
    }
    console.error(`[AI replay] ${index + 1}/${selected.length} ${candidate.market} ${event.type} ${completed.length ? 'completed' : 'failed'}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'historical_replay',
    candleFile,
    provider,
    maxSamples,
    selectedSamples: selected.length,
    horizonCandles,
    minimumSpacingCandles,
    neutralBandPercent,
    runtimeConfig: baseConfig,
    responseCount: rows.length,
    failures,
    summary: summarizeRows(rows),
    rows,
    note: '고정 historical candle replay이며 live order, wallet settlement, promotion gate를 대체하지 않습니다.'
  };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    outputFile,
    selectedSamples: report.selectedSamples,
    responseCount: report.responseCount,
    failures: report.failures.length,
    summary: report.summary,
    note: report.note
  }, null, 2));
  if (process.argv.includes('--require-provider') && report.responseCount === 0) process.exitCode = 2;
}

main().catch(error => {
  console.error(`❌ AI historical replay 오류: ${error.message}`);
  process.exitCode = 1;
});
