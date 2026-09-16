import dotenv from 'dotenv';
import fs from 'node:fs';
import {
  DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG,
  simulateHigherTimeframeMomentum,
  simulateHigherTimeframeMomentumPortfolio,
  walkForwardValidateHigherTimeframeMomentum
} from '../research/higherTimeframeMomentum.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function loadCandleCache(filePath) {
  if (!filePath) {
    throw new Error(
      'higher-timeframe momentum diagnostic은 raw candle cache가 필요합니다. ' +
      'SCALP_HTF_MOMENTUM_CANDLES_FILE 또는 첫 번째 인자로 cache 경로를 지정하세요.'
    );
  }
  if (!fs.existsSync(filePath)) throw new Error(`지정한 candle cache가 없습니다: ${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`candle cache를 읽을 수 없습니다 (${filePath}): ${error.message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`candle cache 형식이 잘못되었습니다: ${filePath}`);
  }
  return parsed?.candles && typeof parsed.candles === 'object' && !Array.isArray(parsed.candles)
    ? parsed.candles
    : parsed;
}

function resolveMarkets(cache) {
  const explicit = (process.env.SCALP_HTF_MOMENTUM_MARKETS || 'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL')
    .split(',')
    .map(market => market.trim().toUpperCase())
    .filter(Boolean);
  const markets = [...new Set(explicit)];
  const missing = markets.filter(market => !Array.isArray(cache[market]));
  if (missing.length > 0) {
    throw new Error(`candle cache에 시장 데이터가 없습니다: ${missing.join(', ')}`);
  }
  return markets;
}

function buildVariantConfig(overrides = {}) {
  return {
    ...DEFAULT_HIGHER_TIMEFRAME_MOMENTUM_CONFIG,
    baseCandleUnit: number(process.env.SCALP_HTF_BASE_CANDLE_UNIT, 15),
    ...overrides
  };
}

function buildVariants() {
  return [
    {
      name: '1h_rsi65_trend7d',
      config: buildVariantConfig({
        timeframeMinutes: 60,
        minRsi: 65,
        trendLookbackMinutes: 7 * 24 * 60,
        minTrendReturnPercent: 0
      })
    },
    {
      name: '1h_rsi65_trend14d',
      config: buildVariantConfig({
        timeframeMinutes: 60,
        minRsi: 65,
        trendLookbackMinutes: 14 * 24 * 60,
        minTrendReturnPercent: 0
      })
    },
    {
      name: '1h_rsi70_trend7d',
      config: buildVariantConfig({
        timeframeMinutes: 60,
        minRsi: 70,
        trendLookbackMinutes: 7 * 24 * 60,
        minTrendReturnPercent: 0
      })
    },
    {
      name: '1h_rsi65_crossup_trend7d',
      config: buildVariantConfig({
        timeframeMinutes: 60,
        minRsi: 65,
        requireRsiCrossUp: true,
        trendLookbackMinutes: 7 * 24 * 60,
        minTrendReturnPercent: 0
      })
    },
    {
      name: '4h_rsi65_trend14d',
      config: buildVariantConfig({
        timeframeMinutes: 240,
        minRsi: 65,
        trendLookbackMinutes: 14 * 24 * 60,
        minTrendReturnPercent: 0,
        maxHoldMinutes: 48 * 60
      })
    }
  ];
}

function summarizeMetrics(metrics) {
  return {
    finalBalance: metrics.finalBalance,
    finalEquity: metrics.finalEquity,
    netProfit: metrics.netProfit,
    totalReturnPercent: metrics.totalReturnPercent,
    tradeCount: metrics.tradeCount,
    winningTrades: metrics.winningTrades,
    losingTrades: metrics.losingTrades,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    grossProfit: metrics.grossProfit,
    grossLoss: metrics.grossLoss,
    maxDrawdownPercent: metrics.maxDrawdownPercent,
    fees: metrics.fees,
    signals: metrics.signals,
    skippedSignals: metrics.skippedSignals,
    tradeReturnConfidence: metrics.tradeReturnConfidence
  };
}

function aggregateMetrics(results, initialBalance) {
  const metrics = results.map(result => result.metrics);
  const tradeCount = metrics.reduce((sum, value) => sum + value.tradeCount, 0);
  const winningTrades = metrics.reduce((sum, value) => sum + value.winningTrades, 0);
  const losingTrades = metrics.reduce((sum, value) => sum + value.losingTrades, 0);
  const netProfit = metrics.reduce((sum, value) => sum + value.netProfit, 0);
  const grossProfit = metrics.reduce((sum, value) => sum + (Number(value.grossProfit) || 0), 0);
  const grossLoss = metrics.reduce((sum, value) => sum + (Number(value.grossLoss) || 0), 0);
  return {
    initialBalance: initialBalance * results.length,
    netProfit,
    totalReturnPercent: initialBalance * results.length > 0
      ? (netProfit / (initialBalance * results.length)) * 100
      : 0,
    tradeCount,
    winningTrades,
    losingTrades,
    winRate: tradeCount > 0 ? (winningTrades / tradeCount) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdownPercent: metrics.length > 0 ? Math.max(...metrics.map(value => value.maxDrawdownPercent)) : 0,
    fees: metrics.reduce((sum, value) => sum + value.fees, 0),
    signals: metrics.reduce((sum, value) => sum + value.signals, 0),
    skippedSignals: metrics.reduce((sum, value) => sum + value.skippedSignals, 0),
    tradeReturnConfidence: null,
    // Keep these values visible in the source for reviewers; they are not used
    // for a promotion decision because each market has its own return path.
    diagnosticGrossProfit: grossProfit,
    diagnosticGrossLoss: grossLoss
  };
}

function walkForwardOptions() {
  return {
    folds: Math.max(1, Math.floor(number(process.env.SCALP_HTF_FOLDS, 3))),
    minimumTrainingFraction: number(process.env.SCALP_HTF_MIN_TRAINING_FRACTION, 0.5),
    validationFraction: number(process.env.SCALP_HTF_VALIDATION_FRACTION, 0.15),
    minimumTrainingTrades: Math.max(0, Math.floor(number(process.env.SCALP_HTF_MIN_TRAINING_TRADES, 3))),
    minimumValidationTrades: Math.max(1, Math.floor(number(process.env.SCALP_HTF_MIN_VALIDATION_TRADES, 5))),
    minimumTrainingProfitFactor: number(process.env.SCALP_HTF_MIN_TRAINING_PF, 1),
    minimumProfitFactor: number(process.env.SCALP_HTF_MIN_VALIDATION_PF, 1.05),
    minimumTrainingReturnPercent: number(process.env.SCALP_HTF_MIN_TRAINING_RETURN, 0),
    minimumReturnPercent: number(process.env.SCALP_HTF_MIN_VALIDATION_RETURN, 0.1),
    maximumDrawdownPercent: number(process.env.SCALP_HTF_MAX_DRAWDOWN, 15),
    minimumConfidenceLowerBoundPercent: number(process.env.SCALP_HTF_MIN_CONFIDENCE_LOWER, 0)
  };
}

function summarizeFold(fold) {
  return {
    fold: fold.fold,
    trainRange: fold.trainRange,
    validationRange: fold.validationRange,
    training: summarizeMetrics(fold.training),
    validation: summarizeMetrics(fold.validation),
    unknownBoundaryPositionCount: fold.unknownBoundaryPositionCount,
    trainingPasses: fold.trainingPasses,
    validationPasses: fold.validationPasses,
    passed: fold.passed
  };
}

export function runHigherTimeframeMomentumStudy({
  inputFile = process.env.SCALP_HTF_MOMENTUM_CANDLES_FILE || process.argv[2],
  outputFile = process.env.SCALP_HTF_MOMENTUM_OUTPUT_FILE || 'higher_timeframe_momentum_diagnostic.json',
  markets = null
} = {}) {
  const cache = loadCandleCache(inputFile);
  const selectedMarkets = markets || resolveMarkets(cache);
  const validationOptions = walkForwardOptions();
  const variants = buildVariants();
  const results = [];

  for (const variant of variants) {
    const marketResults = selectedMarkets.map(market => {
      const config = { ...variant.config, market };
      const simulation = simulateHigherTimeframeMomentum(cache[market], config);
      const walkForward = walkForwardValidateHigherTimeframeMomentum(cache[market], config, validationOptions);
      return {
        market,
        config,
        dataQuality: simulation.dataQuality,
        full: {
          metrics: summarizeMetrics(simulation.metrics),
          unknownBoundaryPositionCount: simulation.unknownBoundaryPositions.length,
          rejectionCounts: simulation.rejectionCounts,
          signalCount: simulation.signals.length
        },
        walkForward: {
          available: walkForward.available,
          foldCount: walkForward.foldCount,
          allFoldsPassed: walkForward.allFoldsPassed,
          folds: walkForward.folds.map(summarizeFold)
        }
      };
    });
    const portfolioCandles = Object.fromEntries(
      selectedMarkets.map(market => [market, cache[market]])
    );
    const portfolio = simulateHigherTimeframeMomentumPortfolio(
      portfolioCandles,
      {
        ...variant.config,
        maxPositions: number(
          process.env.SCALP_HTF_MAX_POSITIONS,
          variant.config.maxPositions
        ),
        portfolioPositionFraction: number(
          process.env.SCALP_HTF_PORTFOLIO_POSITION_FRACTION,
          variant.config.portfolioPositionFraction
        )
      }
    );
    const allMarketFoldsPassed = marketResults.length > 0 &&
      marketResults.every(result => result.walkForward.allFoldsPassed);
    const portfolioEligibleForFurtherShadow = allMarketFoldsPassed &&
      portfolio.available === true &&
      portfolio.unknownBoundaryPositions.length === 0;
    results.push({
      name: variant.name,
      config: variant.config,
      fullAggregate: aggregateMetrics(
        marketResults.map(result => ({
          metrics: result.full.metrics,
          trades: []
        })),
        variant.config.initialBalance
      ),
      portfolio: {
        available: portfolio.available,
        metrics: summarizeMetrics(portfolio.metrics),
        entryCount: portfolio.entryCount,
        blockedEntryCount: portfolio.blockedEntryCount,
        unknownBoundaryPositionCount: portfolio.unknownBoundaryPositions.length,
        dataQuality: portfolio.dataQuality
      },
      markets: marketResults,
      allMarketFoldsPassed,
      eligibleForFurtherShadow: portfolioEligibleForFurtherShadow,
      promoted: false,
      promotionReason: 'higher_timeframe_momentum_is_research_only_and_not_wired_to_live_gate'
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    study: 'higher_timeframe_momentum_walk_forward_diagnostic',
    validationMode: 'research_only_completed_higher_timeframe_signal',
    candleSource: 'raw_cache',
    candleCacheFile: inputFile,
    markets: selectedMarkets,
    validationOptions,
    variants: results,
    promoted: false,
    promotionReason: 'research_lane_is_not_connected_to_runtime_or_live_promotion',
    note: '15분 원천봉을 완료된 1시간/4시간 봉으로 집계하고 다음 원천봉에서 진입합니다. 각 시장·각 walk-forward validation fold를 모두 통과해도 이 report는 연구·shadow 후보일 뿐이며 live 주문을 승인하지 않습니다.'
  };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const report = runHigherTimeframeMomentumStudy();
    for (const variant of report.variants) {
      const aggregate = variant.fullAggregate;
      console.log(`\n${variant.name}`);
      console.log(`  full: ${aggregate.tradeCount} trades / ${aggregate.totalReturnPercent.toFixed(4)}% / PF ${Number.isFinite(aggregate.profitFactor) ? aggregate.profitFactor.toFixed(2) : '∞'}`);
      const portfolio = variant.portfolio;
      console.log(`  portfolio: ${portfolio.available ? `${portfolio.metrics.tradeCount} trades / ${portfolio.metrics.totalReturnPercent.toFixed(4)}% / PF ${Number.isFinite(portfolio.metrics.profitFactor) ? portfolio.metrics.profitFactor.toFixed(2) : '∞'} / blocked ${portfolio.blockedEntryCount}` : 'DATA_QUALITY_FAIL'}`);
      console.log(`  all market folds passed: ${variant.allMarketFoldsPassed ? 'YES' : 'NO'}`);
      for (const market of variant.markets) {
        const metrics = market.full.metrics;
        console.log(`  ${market.market}: ${metrics.tradeCount} trades / ${metrics.totalReturnPercent.toFixed(4)}% / WF ${market.walkForward.allFoldsPassed ? 'PASS' : 'FAIL'}`);
      }
    }
    console.log(`\nreport: ${process.env.SCALP_HTF_MOMENTUM_OUTPUT_FILE || 'higher_timeframe_momentum_diagnostic.json'}`);
    console.log('판정: 연구 전용 · promotion/live 연결 없음');
  } catch (error) {
    console.error('❌ higher-timeframe momentum diagnostic 오류:', error.message);
    process.exitCode = 1;
  }
}
