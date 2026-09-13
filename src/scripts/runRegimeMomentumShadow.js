import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import UpbitAPI from '../api/upbit.js';
import RegimeMomentumStrategy from '../strategy/regimeMomentumStrategy.js';
import { createNotifier } from '../utils/notify.js';

/**
 * Research-only forward shadow runner for the regime-momentum defense
 * overlay candidate. The current ~400-day audit is negative in absolute
 * return, so this process can only accumulate diagnostic forward evidence.
 *
 * Fully self-contained: owns its own ledger directory and lockfile, fetches
 * daily candles on a slow cadence, and simulates the candidate contract
 * against real completed candles. It does NOT touch the shared runtime,
 * the strict paper ledger, or any live-order path — diagnostic evidence
 * accumulation only. promoted/live are impossible from this process.
 *
 *   node src/scripts/runRegimeMomentumShadow.js
 *
 * Ledger: .paper-momentum-shadow-v1/ledger.json (override MOMO_SHADOW_DIR).
 * No result from this runner can authorize live orders or promotion.
 */
dotenv.config();

const DIR = process.env.MOMO_SHADOW_DIR || '.paper-momentum-shadow-v1';
const LOCK = path.join(DIR, '.momentum-shadow.lock');
const LEDGER = path.join(DIR, 'ledger.json');
const POLL_MS = Number(process.env.MOMO_SHADOW_POLL_MS) || 5 * 60 * 1000;
const MARKETS = (process.env.MOMO_SHADOW_MARKETS || 'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL')
  .split(',').map((m) => m.trim()).filter(Boolean);
const COST_PERCENT = Number(process.env.MOMO_SHADOW_COST_PERCENT) || 0.2;
const POSITION_FRACTION = Number(process.env.MOMO_SHADOW_POSITION_FRACTION) || 0.25;
const MAX_POSITIONS = Number(process.env.MOMO_SHADOW_MAX_POSITIONS) || 4;
const TREND_MIN_PERCENT = Number(process.env.MOMO_SHADOW_TREND_MIN_PERCENT) || 0;
const BREADTH_MIN = Number(process.env.MOMO_SHADOW_BREADTH_MIN) || 1;
const HISTORY_DAYS = 200;
// 'fixed': exit at maxHoldHours / SL / TP (trade-based).
// 'regime': hold while trailing 7d trend stays > trendMinPercent (regime switch).
const MODE = process.env.MOMO_SHADOW_MODE === 'regime' ? 'regime' : 'fixed';

const strategyConfig = {
  candleUnitMinutes: 1440,
  rsiEntryThreshold: 0,          // pure trend gate: RSI disabled
  trendLookbackHours: 168,       // 7d
  requireUpBar: true,
  // regime mode holds while the trend gate stays open; disable the fixed cap.
  maxHoldHours: Number(process.env.MOMO_SHADOW_MAX_HOLD_HOURS)
    || (MODE === 'regime' ? 24 * 365 : 72),
  stopLossPercent: Number(process.env.MOMO_SHADOW_STOP_LOSS_PERCENT) || 0,
  takeProfitPercent: Number(process.env.MOMO_SHADOW_TAKE_PROFIT_PERCENT) || 0
};

const upbit = new UpbitAPI('', '', { requestTimeoutMs: 10_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notify = createNotifier({ topic: process.env.MOMO_SHADOW_NTFY_TOPIC || '' });
const bookName = `${DIR.replace(/[^a-z0-9]+/gi, '-')}·${MODE}`;

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return null; }
}
function saveLedger(l) {
  l.heartbeatAt = new Date().toISOString();
  l.ownerPid = process.pid;
  const tmp = `${LEDGER}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, LEDGER);
}
function acquireLock() {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  } catch {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    try { process.kill(cur.pid, 0); console.error(`FAIL_CLOSED: shadow lock held by live pid ${cur.pid}`); process.exit(2); }
    catch { /* stale lock: take over */ }
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }
}

async function fetchDailyCandles(market) {
  return upbit.requestWithRetry(async () => {
    const res = await axios.get('https://api.upbit.com/v1/candles/days',
      upbit.getRequestConfig({ params: { market, count: HISTORY_DAYS } }));
    return res.data;
  });
}

function toBars(candles, now = new Date()) {
  // Upbit's /candles/days includes today's still-forming candle; only
  // completed daily bars are eligible for signals and exits.
  const todayUtc = now.toISOString().slice(0, 10);
  return candles
    .filter((c) => String(c.candle_date_time_utc).slice(0, 10) !== todayUtc)
    .map((c) => ({
      ts: c.candle_date_time_utc,
      trade_price: c.trade_price,
      high_price: c.high_price,
      low_price: c.low_price,
      opening_price: c.opening_price,
      candle_acc_trade_volume: c.candle_acc_trade_volume
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

function trailingTrend(bars, i, days = 7) {
  if (i < days) return null;
  return ((bars[i].trade_price - bars[i - days].trade_price) / bars[i - days].trade_price) * 100;
}

async function cycle(ledger, strategies) {
  const series = {};
  for (const m of MARKETS) {
    try { series[m] = toBars(await fetchDailyCandles(m)); }
    catch (e) { ledger.fetchErrors = (ledger.fetchErrors || 0) + 1; continue; }
    await sleep(200);
  }
  const now = Date.now();
  const nowIso = new Date().toISOString();

  // exits first (mark to latest completed daily close)
  for (const [m, pos] of Object.entries(ledger.positions)) {
    const bars = series[m];
    if (!bars || !bars.length) continue;
    const last = bars[bars.length - 1];
    let ex = strategies[m].checkPosition(
      { entryPrice: pos.entryPrice, entryTimeMs: pos.entryTimeMs }, last.trade_price, now);
    if (!ex.exit && MODE === 'regime') {
      const t = trailingTrend(bars, bars.length - 1);
      if (t != null && t <= TREND_MIN_PERCENT) {
        ex = { exit: 'REGIME_OFF', profitPercent: ((last.trade_price - pos.entryPrice) / pos.entryPrice) * 100 };
      }
    }
    if (ex.exit) {
      const profit = ex.profitPercent - COST_PERCENT;
      ledger.balance += pos.size * (1 + profit / 100);
      ledger.trades.push({ market: m, entry: pos, exitTs: last.ts, exitPrice: last.trade_price, exit: ex.exit, profitPercent: profit });
      delete ledger.positions[m];
      notify.send(`momentum close ${m.replace('KRW-', '')}`,
        `${ex.exit} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}% · ${bookName} · bal ${Math.round(ledger.balance).toLocaleString()}`,
        [profit >= 0 ? 'white_check_mark' : 'x']);
    }
  }

  // breadth: count markets with trailing trend above threshold
  const trends = {};
  for (const m of MARKETS) {
    const bars = series[m];
    if (!bars || bars.length < 9) continue;
    trends[m] = trailingTrend(bars, bars.length - 1);
  }
  const breadth = Object.values(trends).filter((t) => t != null && t > TREND_MIN_PERCENT).length;

  // entries
  for (const m of MARKETS) {
    if (ledger.positions[m]) continue;
    if (Object.keys(ledger.positions).length >= MAX_POSITIONS) break;
    const bars = series[m];
    if (!bars || bars.length < strategies[m].getMinCandleCount()) continue;
    const r = strategies[m].analyze(bars, now);
    if (r.signal !== 'BUY') continue;
    if (r.trendPercent <= TREND_MIN_PERCENT) { ledger.gateBlocked = (ledger.gateBlocked || 0) + 1; continue; }
    if (breadth < BREADTH_MIN) { ledger.breadthBlocked = (ledger.breadthBlocked || 0) + 1; continue; }
    strategies[m].consumeSignal(r.signalKey);
    const size = ledger.balance * POSITION_FRACTION;
    if (size < 5000) continue;
    ledger.balance -= size;
    ledger.positions[m] = { entryPrice: r.referencePrice, entryTs: bars[bars.length - 1].ts, entryTimeMs: now, size, trendPercent: r.trendPercent, breadth };
    ledger.entries = (ledger.entries || 0) + 1;
    notify.send(`momentum open ${m.replace('KRW-', '')}`,
      `7d trend +${r.trendPercent.toFixed(1)}% · breadth ${breadth} · size ${Math.round(size).toLocaleString()} · ${bookName}`,
      ['chart_with_upwards_trend']);
  }

  ledger.lastCycleAt = nowIso;
  ledger.cycles = (ledger.cycles || 0) + 1;
  ledger.breadth = breadth;
  ledger.trends = trends;
  saveLedger(ledger);
  console.log(`[${nowIso}] cycle ${ledger.cycles} bal=${Math.round(ledger.balance)} open=${Object.keys(ledger.positions).join(',') || 'none'} breadth=${breadth} trades=${ledger.trades.length}`);
}

async function main() {
  acquireLock();
  const strategies = {};
  for (const m of MARKETS) strategies[m] = new RegimeMomentumStrategy(strategyConfig);
  let ledger = loadLedger();
  if (!ledger) {
    ledger = {
      diagnosticOnly: true, promoted: false,
      startedAt: new Date().toISOString(),
      config: { mode: MODE, ...strategyConfig, trendMinPercent: TREND_MIN_PERCENT, breadthMin: BREADTH_MIN, costPercent: COST_PERCENT, positionFraction: POSITION_FRACTION, maxPositions: MAX_POSITIONS, markets: MARKETS },
      balance: Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000,
      positions: {}, trades: [], cycles: 0
    };
  } else {
    const active = { mode: MODE, ...strategyConfig, trendMinPercent: TREND_MIN_PERCENT, breadthMin: BREADTH_MIN, costPercent: COST_PERCENT, positionFraction: POSITION_FRACTION, maxPositions: MAX_POSITIONS, markets: MARKETS };
    if (JSON.stringify(ledger.config) !== JSON.stringify(active)) {
      ledger.configDrift = { previous: ledger.config, changedAt: new Date().toISOString() };
      ledger.config = active;
    }
  }
  console.log(`momentum shadow started: ${MARKETS.join(',')} hold=${strategyConfig.maxHoldHours}h trend>${TREND_MIN_PERCENT}% breadth>=${BREADTH_MIN}`);
  while (true) {
    try { await cycle(ledger, strategies); }
    catch (e) { console.error('cycle error:', e.message); }
    await sleep(POLL_MS);
  }
}

main();
