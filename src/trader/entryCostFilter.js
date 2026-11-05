// Entry cost filter: the price of getting in and out right now, measured from
// the live orderbook during the delayed scalping revalidation.
//
//   cost% = spread% (buy at the ask, sell at the bid) + one tick%
//
// A cheap coin can lose most of a rebound to its tick size alone (a 300 KRW
// coin with a 1 KRW tick moves 0.33% per tick). The tick is read from the
// orderbook's own price ladder, so no exchange tick table has to be kept.
// Modes: 'off', 'observe' (default: record what it would reject, never block),
// 'enforce' (cancel entries whose cost exceeds takeProfit × maxTakeProfitRatio).

import fs from 'node:fs';
import { writeDurableJson } from '../runtime/durableJson.js';

export function measureEntryCost(orderbook) {
  const units = Array.isArray(orderbook?.orderbook_units) ? orderbook.orderbook_units : [];
  const asks = units.map(unit => Number(unit.ask_price)).filter(price => price > 0);
  const bids = units.map(unit => Number(unit.bid_price)).filter(price => price > 0);
  if (asks.length === 0 || bids.length === 0) return null;
  const bestAsk = Math.min(...asks);
  const bestBid = Math.max(...bids);
  if (!(bestAsk > bestBid)) return null;
  const mid = (bestAsk + bestBid) / 2;
  const ladder = [...asks.sort((a, b) => a - b), ...bids.sort((a, b) => a - b)];
  let tick = bestAsk - bestBid;
  for (let index = 1; index < ladder.length; index++) {
    const step = Math.abs(ladder[index] - ladder[index - 1]);
    if (step > 1e-12 && step < tick) tick = step;
  }
  const spreadPercent = (bestAsk - bestBid) / mid * 100;
  const tickPercent = tick / mid * 100;
  return {
    bestAsk,
    bestBid,
    tick: Number(tick.toPrecision(6)),
    spreadPercent: Number(spreadPercent.toFixed(4)),
    tickPercent: Number(tickPercent.toFixed(4)),
    costPercent: Number((spreadPercent + tickPercent).toFixed(4))
  };
}

/** Observations survive restarts so observe mode can build up evidence. */
export function loadEntryCostStats(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const stats = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isFinite(stats?.checked) || !Array.isArray(stats?.lastSamples)) return null;
    return { ...createEntryCostStats(), ...stats };
  } catch {
    return null;
  }
}

export function saveEntryCostStats(file, stats) {
  if (!file) return;
  try {
    writeDurableJson(file, stats);
  } catch (error) {
    console.error(`진입 비용 기록 저장 실패: ${error.message}`);
  }
}

export function createEntryCostStats() {
  return { checked: 0, wouldReject: 0, rejected: 0, unavailable: 0, lastSamples: [] };
}

export function judgeEntryCost(measurement, { takeProfitPercent, maxTakeProfitRatio }) {
  const limitPercent = Number(takeProfitPercent) * Number(maxTakeProfitRatio);
  if (!measurement || !(limitPercent > 0)) return { measured: Boolean(measurement), tooHigh: false, limitPercent };
  return { measured: true, tooHigh: measurement.costPercent > limitPercent, limitPercent: Number(limitPercent.toFixed(4)) };
}
