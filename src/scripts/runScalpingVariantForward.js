import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import UpbitAPI from '../api/upbit.js';
import MultiCoinTrader from '../trader/multiCoinTrader.js';
import { SCALPING_VARIANTS } from './compareScalpingVariants.js';
import { buildPaperRunnerConfig } from '../research/paperRunnerConfig.js';
import {
  buildForwardVariantDefinitions,
  createSharedMarketSnapshot,
  resolveForwardVariantNames,
  summarizeVariantLedger
} from '../research/forwardVariantRunner.js';
import {
  acquirePaperSessionLock,
  assertNoConcurrentPaperSessions
} from '../research/paperSessionConcurrency.js';

dotenv.config();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function resolveExplicitMarkets() {
  const raw = process.env.SCALP_FORWARD_MARKETS || process.env.SCALP_VARIANT_MARKETS || '';
  if (!raw || raw.trim().toUpperCase() === 'ALL') return null;
  return [...new Set(raw.split(',').map(market => market.trim().toUpperCase()).filter(Boolean))];
}

async function resolveMarkets(upbit) {
  const explicit = resolveExplicitMarkets();
  if (explicit?.length) return explicit;

  const excluded = new Set(['KRW-USDT', 'KRW-USDC', 'KRW-DAI', 'KRW-USD1']);
  const markets = (await upbit.getMarkets())
    .filter(item => item.market?.startsWith('KRW-') && !excluded.has(item.market))
    .map(item => item.market);
  const tickers = await upbit.getTicker(markets);
  const limit = number(
    number(process.env.SCALP_VARIANT_MARKET_COUNT, 3)
  );
  return (tickers || [])
    .filter(ticker => Number.isFinite(ticker?.acc_trade_price_24h))
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, Math.max(1, limit))
    .map(ticker => ticker.market);
}

async function fetchSharedSnapshot(upbit, markets, candleUnit, candleCount) {
  const tickers = await upbit.getTicker(markets);
  const candlesByMarket = new Map();
  for (const market of markets) {
    const candles = await upbit.getMinuteCandles(market, candleUnit, candleCount);
    candlesByMarket.set(market, candles);
  }
  return createSharedMarketSnapshot({
    markets,
    tickers,
    candlesByMarket,
    capturedAt: new Date().toISOString()
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function createRunDirectory() {
  const explicit = process.env.SCALP_FORWARD_VARIANT_OUTPUT_DIR;
  const runDir = path.resolve(explicit || path.join(
    '.paper-forward-variants',
    `run-${Date.now()}`
  ));
  const manifestFile = path.join(runDir, 'variant_manifest.json');
  if (fs.existsSync(manifestFile) && process.env.SCALP_FORWARD_VARIANT_RESET !== 'true') {
    throw new Error(`기존 variant run이 있습니다: ${manifestFile}. 새 output directory를 사용하세요.`);
  }
  fs.mkdirSync(runDir, { recursive: true });
  return { runDir, manifestFile };
}

async function stopTraders(traders, reason, lastSnapshot) {
  const summaries = [];
  for (const { name, trader, overrides } of traders) {
    trader.stop(reason);
    await trader.stopPaperValidationSession();
    const currentAssets = lastSnapshot
      ? await trader.calculateTotalAssets(lastSnapshot.priceMap)
      : null;
    summaries.push({
      ...summarizeVariantLedger(trader.paperValidation, name, currentAssets),
      overrides
    });
  }
  return summaries;
}

export async function runForwardVariantSession({
  durationSeconds = null,
  maxCycles = null
} = {}) {
  const { runDir, manifestFile } = createRunDirectory();
  const names = resolveForwardVariantNames(
    process.env.SCALP_FORWARD_VARIANT_NAMES,
    SCALPING_VARIANTS
  );
  const definitions = buildForwardVariantDefinitions(names, SCALPING_VARIANTS);
  const intervalMs = Math.max(
    1_000,
    number(process.env.SCALP_FORWARD_VARIANT_INTERVAL_MS, 5_000)
  );
  const candleUnit = Math.max(1, number(process.env.SCALP_CANDLE_UNIT, 1));
  const candleCount = Math.max(50, number(process.env.SCALP_CANDLE_COUNT, 120));
  const seedMoney = Math.max(5_000, number(
    process.env.SCALP_FORWARD_VARIANT_SEED_MONEY,
    number(process.env.PAPER_SMOKE_SEED_MONEY, 1_000_000)
  ));
  const configuredDuration = durationSeconds === null
    ? number(
      process.env.SCALP_FORWARD_VARIANT_SECONDS,
      process.env.SCALP_FORWARD_VARIANT_MODE === 'true' ? 0 : 60
    )
    : durationSeconds;
  let traders = [];
  let lastSnapshot = null;
  let cycles = 0;
  let stopReason = 'stopped_cleanly';
  let failure = null;
  let stopRequested = false;

  const upbit = new UpbitAPI('', '', {
    requestTimeoutMs: number(process.env.UPBIT_REQUEST_TIMEOUT_MS, 10_000)
  });
  const markets = await resolveMarkets(upbit);
  if (markets.length === 0) throw new Error('forward variant 대상 market이 없습니다.');

  assertNoConcurrentPaperSessions({ workspaceRoot: process.cwd() });
  const lock = acquirePaperSessionLock({ workspaceRoot: process.cwd() });
  const manifest = {
    schemaVersion: 1,
    researchOnly: true,
    runner: 'shared_snapshot_scalping_variant_forward',
    startedAt: new Date().toISOString(),
    active: true,
    runDir,
    markets,
    candleUnit,
    candleCount,
    intervalMs,
    seedMoney,
    variants: definitions.map(definition => ({
      name: definition.name,
      overrides: definition.overrides,
      paperFile: path.join(runDir, definition.name, 'paper_validation.json')
    }))
  };
  writeJson(manifestFile, manifest);

  try {
    traders = definitions.map(({ name, overrides }) => {
      const variantDir = path.join(runDir, name);
      const config = buildPaperRunnerConfig({
        portfolioFile: path.join(variantDir, 'dry_portfolio.json'),
        paperFile: path.join(variantDir, 'paper_validation.json'),
        markets,
        seedMoney,
        diagnosticShadowsEnabled: false,
        variantOverrides: overrides
      });
      return { name, overrides, trader: new MultiCoinTrader(config) };
    });

    for (const { name, overrides, trader } of traders) {
      await trader.startPaperValidationSession({
        reset: true,
        seedMoney,
        minDays: number(process.env.SCALP_PAPER_MIN_DAYS, 7),
        minTrades: number(process.env.SCALP_PAPER_MIN_TRADES, 20)
      });
      trader.paperValidation.researchVariant = {
        name,
        overrides,
        runner: manifest.runner
      };
      trader.savePaperValidation();
      trader.isRunning = true;
      trader.newsData = null;
    }

    const onSignal = () => {
      stopRequested = true;
      stopReason = 'signal_stop';
      for (const { trader } of traders) trader.stop(stopReason);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const startedAtMs = Date.now();
    while (!stopRequested &&
      (configuredDuration <= 0 || Date.now() - startedAtMs < configuredDuration * 1000) &&
      (maxCycles === null || cycles < maxCycles)) {
      lastSnapshot = await fetchSharedSnapshot(upbit, markets, candleUnit, candleCount);
      await Promise.all(traders.map(({ trader }) => trader.executeTradingCycleFromSnapshot(lastSnapshot)));
      cycles += 1;
      if (traders.some(({ trader }) => trader.isRunning !== true)) {
        stopReason = 'variant_owner_stopped';
        break;
      }
      if (!stopRequested &&
        (configuredDuration <= 0 || Date.now() - startedAtMs < configuredDuration * 1000) &&
        (maxCycles === null || cycles < maxCycles)) {
        await sleep(intervalMs);
      }
    }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  } catch (error) {
    failure = {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      recordedAt: new Date().toISOString()
    };
    stopReason = 'runner_error';
  } finally {
    const summaries = traders.length > 0
      ? await stopTraders(traders, stopReason, lastSnapshot)
      : [];
    manifest.active = false;
    manifest.endedAt = new Date().toISOString();
    manifest.cycles = cycles;
    manifest.stopReason = stopReason;
    manifest.failure = failure;
    manifest.lastSnapshotAt = lastSnapshot?.capturedAt || null;
    manifest.summaries = summaries;
    writeJson(manifestFile, manifest);
    lock.release();
  }

  if (failure) throw new Error(`shared snapshot variant runner 오류: ${failure.message}`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runForwardVariantSession()
    .then(manifest => {
      console.log(JSON.stringify({
        state: 'completed',
        runDir: manifest.runDir,
        cycles: manifest.cycles,
        stopReason: manifest.stopReason,
        summaries: manifest.summaries
      }, null, 2));
    })
    .catch(error => {
      console.error(`❌ shared snapshot variant runner 오류: ${error.message}`);
      process.exitCode = 1;
    });
}
