// 페이퍼 검증 상태 read-model — getPaperValidationStatus의 770줄 투영.
// paperValidationJournal.js에서 추출 — 저널 상태는 journal 필드를 통해 접근한다.
import {
  DEFAULT_PAPER_EXECUTION_MIN_PAIRS,
  evaluatePaperExecutionRobustnessGate,
  summarizePaperExecutionComparison
} from '../research/paperExecutionComparison.js';
import {
  MARKET_QUALITY_DEFAULTS,
  selectFreshMarketCohort
} from '../research/marketQuality.js';
import {
  PAPER_EXIT_EVIDENCE_SCHEMA,
  summarizePaperExitEvidence
} from '../research/paperExitEvidence.js';
import {
  calculateTradeReturnConfidence,
  evaluateStatisticalConfidenceGate
} from '../backtest/tradeConfidence.js';
import {
  envNumber
} from '../config/envConfig.js';
export class PaperValidationStatus {
  constructor(journal) {
    this.journal = journal;
  }




  async getPaperValidationStatus({ includeCurrentAssets = true } = {}) {
    const session = this.journal.paperValidation;
    if (!session) {
      return {
        available: false,
        active: false,
        eligible: false,
        reason: 'paper_validation_session_not_started'
      };
    }

    const persistedAssets = session.snapshots?.at(-1)?.totalAssets ?? session.baselineAssets;
    const currentAssets = includeCurrentAssets
      ? await this.journal.owner.calculateTotalAssets()
      : persistedAssets !== null && persistedAssets !== undefined && Number.isFinite(Number(persistedAssets))
        ? Number(persistedAssets)
        : null;
    const startedAtMs = new Date(session.startedAt).getTime();
    const elapsedDays = Math.max(0, (Date.now() - startedAtMs) / 86_400_000);
    const heartbeatAt = session.telemetry?.heartbeatAt || session.startedAt;
    const heartbeatMs = new Date(heartbeatAt).getTime();
    // 미래·누락·비정형 heartbeat는 검증 불가 — 신선하다고 간주하지 않는다.
    const heartbeatAgeMs = Number.isFinite(heartbeatMs) && Date.now() >= heartbeatMs
      ? Date.now() - heartbeatMs
      : null;
    const heartbeatLimitMs = Math.max(120_000, (Number(this.journal.owner.config.checkInterval) || 60_000) * 5);
    const ownerProcessAlive = this.journal.owner.isProcessAlive(session.processId);
    const orphaned = session.active === true &&
      (ownerProcessAlive === false || heartbeatAgeMs === null || heartbeatAgeMs > heartbeatLimitMs);
    const orphanReason = orphaned
      ? ownerProcessAlive === false ? 'owner_process_missing' : 'heartbeat_stale'
      : null;
    const configComparison = this.journal.owner.comparePaperValidationConfig(session.configSnapshot);
    const experimentComparison = this.journal.owner.comparePaperExperimentConfig(session.paperExperiments);
    const configSnapshotComplete = session.configSnapshotComplete === true;
    const snapshots = [
      { timestamp: session.startedAt, totalAssets: session.baselineAssets },
      ...(session.snapshots || [])
    ].filter(snapshot => Number.isFinite(Number(snapshot.totalAssets)));
    let peak = 0;
    let maxDrawdownPercent = 0;
    for (const snapshot of snapshots) {
      const assets = Number(snapshot.totalAssets);
      peak = Math.max(peak, assets);
      if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - assets) / peak) * 100);
    }

    const startedTrades = [];
    const startedAtTime = new Date(session.startedAt).getTime();
    const strictLedgerTrades = Array.isArray(session.strictTrades)
      ? session.strictTrades
      : [];
    const seenTradeKeys = new Set();
    for (const trade of strictLedgerTrades) {
      const exitTime = new Date(trade.exitTime || 0).getTime();
      const exitKey = Number.isFinite(exitTime) ? new Date(exitTime).toISOString() : String(trade.exitTime || '');
      const key = trade.ledgerKey || `${trade.coin || 'unknown'}:${trade.id || 'no-id'}:${exitKey}:${trade.action || 'CLOSE'}`;
      if ((trade.action === 'CLOSE' || trade.action === 'PARTIAL_CLOSE') &&
        exitTime >= startedAtTime && !seenTradeKeys.has(key)) {
        startedTrades.push(trade);
        seenTradeKeys.add(key);
      }
    }
    for (const [coin, strategy] of this.journal.owner.strategies.entries()) {
      for (const trade of strategy.tradeHistory || []) {
        const exitTime = new Date(trade.exitTime || 0).getTime();
        const exitKey = Number.isFinite(exitTime) ? new Date(exitTime).toISOString() : String(trade.exitTime || '');
        const key = trade.ledgerKey || `${coin}:${trade.id || 'no-id'}:${exitKey}:${trade.action || 'CLOSE'}`;
        if ((trade.action === 'CLOSE' || trade.action === 'PARTIAL_CLOSE') &&
          exitTime >= startedAtTime && !seenTradeKeys.has(key)) {
          trade.coin = trade.coin || coin;
          startedTrades.push(trade);
          seenTradeKeys.add(key);
        }
      }
    }

    const hasLiveStrategyState = this.journal.owner.strategies.size > 0;
    const strictOpenPositions = hasLiveStrategyState
      ? this.journal.owner.getStrictOpenPositionSnapshot()
      : (Array.isArray(session.strictOpenPositions) ? session.strictOpenPositions : []);

    const realizedProfit = startedTrades.reduce((sum, trade) => sum + (Number(trade.profit) || 0), 0);
    const strictWinningTrades = startedTrades.filter(trade => Number(trade.profit) > 0).length;
    const strictLosingTrades = startedTrades.filter(trade => Number(trade.profit) <= 0).length;
    const strictRecentTrades = startedTrades.slice(-5).map(trade => ({
      action: trade.action || 'CLOSE',
      coin: trade.coin || null,
      reason: trade.reason || null,
      entryPrice: Number.isFinite(Number(trade.entryPrice)) ? Number(trade.entryPrice) : null,
      exitPrice: Number.isFinite(Number(trade.exitPrice)) ? Number(trade.exitPrice) : null,
      profit: Number.isFinite(Number(trade.profit)) ? Number(trade.profit) : null,
      profitPercent: Number.isFinite(Number(trade.profitPercent)) ? Number(trade.profitPercent) : null,
      maxFavorableExcursionPercent: Number.isFinite(Number(trade.maxFavorableExcursionPercent))
        ? Number(trade.maxFavorableExcursionPercent)
        : null,
      maxAdverseExcursionPercent: Number.isFinite(Number(trade.maxAdverseExcursionPercent))
        ? Number(trade.maxAdverseExcursionPercent)
        : null,
      exitTime: trade.exitTime || null
    }));
    const shadow = session.shadow || {};
    const shadowClosedTrades = Array.isArray(shadow.closedTrades) ? shadow.closedTrades : [];
    const shadowRealizedProfit = Number(shadow.realizedProfit) || 0;
    const shadowTotalInvested = Number(shadow.totalInvested) || 0;
    const shadowWinners = Number(shadow.winningTrades) || shadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const shadowLosers = Number(shadow.losingTrades) || shadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const shadowProfitFactor = shadowLosers > 0
      ? shadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(shadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : shadowWinners > 0 ? Infinity : 0;
    const looseShadow = session.looseShadow || {};
    const looseClosedTrades = Array.isArray(looseShadow.closedTrades) ? looseShadow.closedTrades : [];
    const exitEvidence = {
      schema: PAPER_EXIT_EVIDENCE_SCHEMA,
      researchOnly: true,
      promoted: false,
      strict: summarizePaperExitEvidence(startedTrades, { profitField: 'profit' }),
      shadow: summarizePaperExitEvidence(shadowClosedTrades, { profitField: 'netProfit' }),
      looseShadow: summarizePaperExitEvidence(looseClosedTrades, { profitField: 'netProfit' }),
      note: '실제 종료 경로를 집계한 읽기 전용 paper evidence입니다. 조기 청산·실제 fill·wallet settlement·수익성은 추정하지 않습니다.'
    };
    const executionOutcomeComparison = summarizePaperExecutionComparison({
      strictTrades: startedTrades,
      shadowTrades: shadowClosedTrades,
      looseShadowTrades: looseClosedTrades
    });
    const diagnosticShadowsEnabled = session.paperExperiments?.diagnosticShadows?.enabled !== false;
    const executionRobustnessGate = evaluatePaperExecutionRobustnessGate(
      executionOutcomeComparison,
      {
        required: diagnosticShadowsEnabled,
        minimumPairs: Number(session.thresholds?.minExecutionPairs) || DEFAULT_PAPER_EXECUTION_MIN_PAIRS
      }
    );
    const looseRealizedProfit = Number(looseShadow.realizedProfit) || 0;
    const looseTotalInvested = Number(looseShadow.totalInvested) || 0;
    const looseWinners = Number(looseShadow.winningTrades) || looseClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const looseLosers = Number(looseShadow.losingTrades) || looseClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const looseProfitFactor = looseLosers > 0
      ? looseClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(looseClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : looseWinners > 0 ? Infinity : 0;
    const winnerShadow = session.winnerShadow || {};
    const winnerShadowClosedTrades = Array.isArray(winnerShadow.closedTrades) ? winnerShadow.closedTrades : [];
    const winnerShadowRealizedProfit = Number(winnerShadow.realizedProfit) || 0;
    const winnerShadowTotalInvested = Number(winnerShadow.totalInvested) || 0;
    const winnerShadowWinners = Number(winnerShadow.winningTrades) || winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).length;
    const winnerShadowLosers = Number(winnerShadow.losingTrades) || winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).length;
    const winnerShadowProfitFactor = winnerShadowLosers > 0
      ? winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) > 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
        Math.abs(winnerShadowClosedTrades.filter(trade => Number(trade.netProfit) <= 0).reduce((sum, trade) => sum + Number(trade.netProfit), 0))
      : winnerShadowWinners > 0 ? Infinity : 0;
    const summarizeDiagnosticTrades = trades => trades.slice(-5).map(trade => ({
      coin: trade.coin || null,
      reason: trade.reason || null,
      entryPrice: Number.isFinite(Number(trade.entryPrice)) ? Number(trade.entryPrice) : null,
      exitPrice: Number.isFinite(Number(trade.exitPrice)) ? Number(trade.exitPrice) : null,
      netProfit: Number.isFinite(Number(trade.netProfit)) ? Number(trade.netProfit) : null,
      profitPercent: Number.isFinite(Number(trade.profitPercent)) ? Number(trade.profitPercent) : null,
      maxFavorableExcursionPercent: Number.isFinite(Number(trade.maxFavorableExcursionPercent))
        ? Number(trade.maxFavorableExcursionPercent)
        : null,
      maxAdverseExcursionPercent: Number.isFinite(Number(trade.maxAdverseExcursionPercent))
        ? Number(trade.maxAdverseExcursionPercent)
        : null,
      exitTimestamp: trade.exitTimestamp || trade.exitTime || null,
      winnerExtended: trade.winnerExtended === true,
      rejectionReasons: Array.isArray(trade.rejectionReasons) ? trade.rejectionReasons.slice() : []
    }));
    const shadowRecentTrades = summarizeDiagnosticTrades(shadowClosedTrades);
    const looseRecentTrades = summarizeDiagnosticTrades(looseClosedTrades);
    const winnerShadowRecentTrades = summarizeDiagnosticTrades(winnerShadowClosedTrades);
    const summarizeDiagnosticPositions = book => Object.entries(book?.positions || {})
      .map(([coin, position]) => ({
        coin: position?.coin || coin,
        entryPrice: Number.isFinite(Number(position?.entryPrice)) ? Number(position.entryPrice) : null,
        investAmount: Number.isFinite(Number(position?.investAmount)) ? Number(position.investAmount) : null,
        entryTimestamp: position?.entryTimestamp || position?.entryTime || null,
        signalKey: position?.signalKey || null,
        maxFavorableExcursionPercent: Number.isFinite(Number(position?.maxFavorableExcursionPercent))
          ? Number(position.maxFavorableExcursionPercent)
          : null,
        maxAdverseExcursionPercent: Number.isFinite(Number(position?.maxAdverseExcursionPercent))
          ? Number(position.maxAdverseExcursionPercent)
          : null,
        rejectionReasons: Array.isArray(position?.rejectionReasons) ? position.rejectionReasons.slice() : []
      }))
      .sort((left, right) => String(left.coin).localeCompare(String(right.coin)));
    const shadowOpenPositions = summarizeDiagnosticPositions(shadow);
    const looseOpenPositions = summarizeDiagnosticPositions(looseShadow);
    const winnerShadowOpenPositions = summarizeDiagnosticPositions(winnerShadow);
    const winnerShadowBlockedEntries = Array.isArray(winnerShadow.blockedEntries)
      ? winnerShadow.blockedEntries
      : [];
    const winnerShadowSettledBlockedEntries = winnerShadowBlockedEntries
      .filter(entry => entry?.status === 'settled' && entry.counterfactual);
    const winnerShadowPendingBlockedEntries = winnerShadowBlockedEntries
      .filter(entry => entry?.status === 'pending');
    const winnerShadowNotFilledBlockedEntries = winnerShadowBlockedEntries
      .filter(entry => entry?.status === 'not_filled');
    const winnerShadowCounterfactualProfit = winnerShadowSettledBlockedEntries
      .reduce((sum, entry) => sum + (Number(entry.counterfactual?.netProfit) || 0), 0);
    const winnerShadowCounterfactualWinners = winnerShadowSettledBlockedEntries
      .filter(entry => Number(entry.counterfactual?.netProfit) > 0).length;
    const winnerShadowCounterfactualLosers = winnerShadowSettledBlockedEntries.length - winnerShadowCounterfactualWinners;
    const winnerShadowCounterfactualProfitFactor = winnerShadowCounterfactualLosers > 0
      ? winnerShadowSettledBlockedEntries
        .filter(entry => Number(entry.counterfactual?.netProfit) > 0)
        .reduce((sum, entry) => sum + Number(entry.counterfactual.netProfit), 0) /
        Math.abs(winnerShadowSettledBlockedEntries
          .filter(entry => Number(entry.counterfactual?.netProfit) <= 0)
          .reduce((sum, entry) => sum + Number(entry.counterfactual.netProfit), 0))
      : winnerShadowCounterfactualWinners > 0 ? Infinity : 0;
    const summarizeRejectionOutcomes = closedTrades => {
      const grouped = new Map();
      for (const trade of closedTrades) {
        for (const reason of Array.isArray(trade.rejectionReasons) ? trade.rejectionReasons : []) {
          const entry = grouped.get(reason) || {
            reason,
            tradeCount: 0,
            winningTrades: 0,
            losingTrades: 0,
            netProfit: 0
          };
          const netProfit = Number(trade.netProfit) || 0;
          entry.tradeCount += 1;
          entry.netProfit += netProfit;
          if (netProfit > 0) entry.winningTrades += 1;
          else entry.losingTrades += 1;
          grouped.set(reason, entry);
        }
      }
      return [...grouped.values()]
        .map(entry => ({
          ...entry,
          winRate: entry.tradeCount > 0 ? (entry.winningTrades / entry.tradeCount) * 100 : 0,
          profitFactor: entry.losingTrades > 0
            ? (closedTrades
              .filter(trade => Array.isArray(trade.rejectionReasons) && trade.rejectionReasons.includes(entry.reason) && Number(trade.netProfit) > 0)
              .reduce((sum, trade) => sum + Number(trade.netProfit), 0) /
              Math.abs(closedTrades
                .filter(trade => Array.isArray(trade.rejectionReasons) && trade.rejectionReasons.includes(entry.reason) && Number(trade.netProfit) <= 0)
                .reduce((sum, trade) => sum + Number(trade.netProfit), 0)))
            : entry.winningTrades > 0 ? Infinity : 0
        }))
        .sort((a, b) => b.tradeCount - a.tradeCount || b.netProfit - a.netProfit);
    };
    const shadowRejectionOutcomes = summarizeRejectionOutcomes(shadowClosedTrades);
    const looseRejectionOutcomes = summarizeRejectionOutcomes(looseClosedTrades);
    const shadowExecutionBoundary = this.journal.owner.getExecutionBoundaryBlockedEntrySummary(shadow);
    const looseExecutionBoundary = this.journal.owner.getExecutionBoundaryBlockedEntrySummary(looseShadow);
    const strictLossCircuitBreaker = this.journal.owner.getLossCircuitBreakerStatus('strict');
    const shadowLossCircuitBreaker = this.journal.owner.getLossCircuitBreakerStatus('shadow');
    const looseShadowLossCircuitBreaker = this.journal.owner.getLossCircuitBreakerStatus('looseShadow');
    const winnerShadowLossCircuitBreaker = this.journal.owner.getLossCircuitBreakerStatus('winnerShadow');
    const baselineAssets = Number(session.baselineAssets) || 0;
    const returnPercent = baselineAssets > 0 ? ((currentAssets / baselineAssets) - 1) * 100 : 0;
    const thresholds = session.thresholds || {};
    const strictTradeConfidence = calculateTradeReturnConfidence(startedTrades);
    const strictConfidenceGate = evaluateStatisticalConfidenceGate({
      tradeReturnConfidence: strictTradeConfidence
    }, {
      required: true,
      minimumTrades: Number(thresholds.minTrades) || 20,
      minimumLowerBoundPercent: Number.isFinite(Number(thresholds.minConfidenceLowerBoundPercent))
        ? Number(thresholds.minConfidenceLowerBoundPercent)
        : 0
    });
    const interruptions = Array.isArray(session.interruptions) ? session.interruptions : [];
    const maxHeartbeatGapMinutes = Number(thresholds.maxHeartbeatGapMinutes) || 15;
    const maxAllowedHeartbeatGapMs = maxHeartbeatGapMinutes * 60 * 1000;
    const heartbeatContinuityEligible = !orphaned && interruptions.every(interruption =>
      Number(interruption.gapMs) <= maxAllowedHeartbeatGapMs
    );
    const riskMonitor = this.journal.owner.getRiskMonitorStatus();
    const analysisDataHealth = this.journal.owner.getAnalysisDataHealthStatus();
    const currentDiagnosticOpenPositions = this.journal.owner.getPaperDiagnosticOpenPositionSnapshot();
    const endedWithOpenPositions = session.endedWithOpenPositions === true ||
      (orphaned && strictOpenPositions.length > 0);
    const endedWithDiagnosticOpenPositions = session.endedWithDiagnosticOpenPositions === true ||
      ((session.active === false || orphaned) && currentDiagnosticOpenPositions.length > 0);
    const continuityEligible = heartbeatContinuityEligible &&
      riskMonitor.continuityEligible &&
      analysisDataHealth.continuityEligible;
    const minimumResearchDays = Number(thresholds.minDays) || 7;
    const minimumResearchTrades = Number(thresholds.minTrades) || 20;
    const minimumReturnPercent = Number(thresholds.minReturnPercent) || 0.2;
    const maximumDrawdownPercent = Number(thresholds.maxDrawdownPercent) || 15;
    const eligible = session.active !== true &&
      !orphaned &&
      continuityEligible &&
      !endedWithDiagnosticOpenPositions &&
      configSnapshotComplete &&
      configComparison.consistent === true &&
      experimentComparison.consistent === true &&
      elapsedDays >= minimumResearchDays &&
      startedTrades.length >= minimumResearchTrades &&
      strictConfidenceGate.passed &&
      executionRobustnessGate.passed &&
      returnPercent >= minimumReturnPercent &&
      maxDrawdownPercent <= maximumDrawdownPercent;
    const promotionBlockers = [];
    if (session.active === true) {
      promotionBlockers.push('관찰 세션이 아직 진행 중이라 최종 수익성 판정을 할 수 없습니다.');
    }
    if (orphaned) {
      promotionBlockers.push(orphanReason === 'heartbeat_stale'
        ? 'owner heartbeat가 오래되어 관찰 연속성을 확인할 수 없습니다.'
        : 'owner process가 현재 관찰 중 상태가 아닙니다.');
    }
    if (!configSnapshotComplete) {
      promotionBlockers.push('전략 설정 snapshot이 불완전해 동일 조건을 재현할 수 없습니다.');
    }
    if (configComparison.consistent !== true) {
      promotionBlockers.push('전략 설정 변경 이력이 있어 동일 조건 비교를 할 수 없습니다.');
    }
    if (experimentComparison.consistent !== true) {
      promotionBlockers.push('paper 연구 실험 설정이 달라 동일 조건 비교를 할 수 없습니다.');
    }
    if (!executionRobustnessGate.passed) {
      if (executionRobustnessGate.reason === 'execution_comparison_pairs_insufficient') {
        promotionBlockers.push(`실행 경계 비교 표본이 ${executionRobustnessGate.pairedCount}/${executionRobustnessGate.minimumPairs}쌍으로 부족합니다.`);
      } else if (executionRobustnessGate.reason === 'execution_positive_to_negative_flip_detected') {
        promotionBlockers.push(`동일 신호에서 strict 양수·shadow 음수 부호 변경 ${executionRobustnessGate.strictPositiveDiagnosticNegativeCount}건이 확인되었습니다.`);
      } else if (executionRobustnessGate.reason === 'diagnostic_pair_profit_not_positive') {
        promotionBlockers.push('동일 신호 paired diagnostic 손익이 양수가 아니어서 실행 경계 강건성을 확인할 수 없습니다.');
      } else if (executionRobustnessGate.reason === 'execution_outcome_sign_flip_detected') {
        promotionBlockers.push(`동일 신호 실행 결과 부호 변경 ${executionRobustnessGate.signFlipCount}건이 확인되었습니다.`);
      }
    }
    if (continuityEligible !== true) {
      promotionBlockers.push('시세·분석·heartbeat 연속성이 깨져 관찰을 증명할 수 없습니다.');
    }
    if (elapsedDays < minimumResearchDays) {
      promotionBlockers.push(`관찰 기간 ${elapsedDays.toFixed(2)}/${minimumResearchDays}일로 부족합니다.`);
    }
    if (startedTrades.length < minimumResearchTrades) {
      promotionBlockers.push(`청산 표본이 ${startedTrades.length}/${minimumResearchTrades}회로 부족합니다.`);
    }
    if (strictConfidenceGate.passed !== true) {
      if (strictTradeConfidence.sampleCount < minimumResearchTrades) {
        promotionBlockers.push(`거래수익 95% 통계 하한을 계산할 유효 표본이 ${strictTradeConfidence.sampleCount}/${minimumResearchTrades}건으로 부족합니다.`);
      } else if (!Number.isFinite(Number(strictTradeConfidence.lowerBoundPercent))) {
        promotionBlockers.push('거래수익 95% 통계 하한을 계산할 수 없습니다.');
      } else if (Number(strictTradeConfidence.lowerBoundPercent) < 0) {
        promotionBlockers.push('거래수익 95% 하한이 0% 미만이라 안정적인 양수 수익을 확인할 수 없습니다.');
      }
    }
    if (returnPercent < minimumReturnPercent) {
      promotionBlockers.push(`실현 순수익률 ${returnPercent.toFixed(2)}%가 기준 ${minimumReturnPercent}%보다 낮습니다.`);
    }
    if (maxDrawdownPercent > maximumDrawdownPercent) {
      promotionBlockers.push(`최대 낙폭 ${maxDrawdownPercent.toFixed(2)}%가 기준 ${maximumDrawdownPercent}%를 초과합니다.`);
    }
    if (strictOpenPositions.length > 0) {
      promotionBlockers.push(`미청산 strict 포지션 ${strictOpenPositions.length}개가 있어 평가손익만으로는 전환할 수 없습니다.`);
    }
    if (endedWithDiagnosticOpenPositions) {
      promotionBlockers.push('미청산 diagnostic 포지션이 있어 비교 장부를 완결할 수 없습니다.');
    }
    const telemetry = session.telemetry || null;
    // Freshness cohort selection is deliberately diagnostic-only. It makes
    // the next isolated paper run reproducible when a universe contains
    // inactive markets, but it never changes this session's target list,
    // strict metrics, or live-promotion gate.
    const configuredMinimumMarketObservations = envNumber('SCALP_MARKET_QUALITY_MIN_OBSERVATIONS');
    const configuredMaximumFreshnessBlockRate = envNumber('SCALP_MARKET_QUALITY_MAX_STALE_RATE');
    const marketFreshnessCohort = selectFreshMarketCohort({
      markets: session.targetCoins || this.journal.owner.targetCoins,
      telemetry: telemetry || {},
      minObservations: Number.isFinite(configuredMinimumMarketObservations) && configuredMinimumMarketObservations > 0
        ? configuredMinimumMarketObservations
        : MARKET_QUALITY_DEFAULTS.minObservations,
      maxFreshnessBlockRate: Number.isFinite(configuredMaximumFreshnessBlockRate) && configuredMaximumFreshnessBlockRate >= 0 && configuredMaximumFreshnessBlockRate <= 1
        ? configuredMaximumFreshnessBlockRate
        : MARKET_QUALITY_DEFAULTS.maxFreshnessBlockRate,
      maxMarkets: session.targetCoins?.length || this.journal.owner.targetCoins.length || Infinity
    });
    const signalTelemetryAvailable = telemetry?.signalTelemetryVersion === 1 &&
      Boolean(telemetry.signalTelemetryCoverageStartedAt);
    const uniqueSignalWindows = signalTelemetryAvailable
      ? Number(telemetry.uniqueSignalWindows) || 0
      : null;
    const uniqueSignalWindowsByCoin = signalTelemetryAvailable
      ? telemetry.uniqueSignalWindowsByCoin || {}
      : {};
    const uniqueReasonCounts = signalTelemetryAvailable
      ? telemetry.uniqueReasonCounts || {}
      : {};
    const uniqueRejectionCounts = signalTelemetryAvailable
      ? telemetry.uniqueRejectionCounts || {}
      : {};
    const strictReboundCandidates = telemetry && Number.isFinite(Number(telemetry.strictReboundCandidates))
      ? Number(telemetry.strictReboundCandidates)
      : Number(telemetry?.shadowCandidates) || 0;
    const strictConfirmedCandidates = telemetry && Number.isFinite(Number(telemetry.strictConfirmedCandidates))
      ? Number(telemetry.strictConfirmedCandidates)
      : 0;
    const oversoldObservations = telemetry && Number.isFinite(Number(telemetry.oversoldObservations))
      ? Number(telemetry.oversoldObservations)
      : strictReboundCandidates;
    // A quiet market (no prior oversold + bullish rebound candidates) is not
    // filter starvation. Only show tuning guidance when a real strict
    // rebound candidate existed, no strict candidate was confirmed, and no
    // BUY was emitted. This prevents automatic-looking advice from turning a
    // normal lack of setups into an unjustified parameter relaxation.
    const filterStarvation = Boolean(telemetry && telemetry.cycles >= 20 &&
      telemetry.buyCandidates === 0 && strictReboundCandidates > 0 &&
      strictConfirmedCandidates === 0);
    const marketQuiet = Boolean(telemetry && telemetry.cycles >= 20 &&
      telemetry.buyCandidates === 0 && strictReboundCandidates === 0 &&
      strictConfirmedCandidates === 0 && oversoldObservations === 0);
    const oversoldObservedNoRebound = Boolean(telemetry && telemetry.cycles >= 20 &&
      telemetry.buyCandidates === 0 && oversoldObservations > 0 &&
      strictReboundCandidates === 0 && strictConfirmedCandidates === 0);
    const rsiProximityTelemetry = telemetry?.rsiProximity || {};
    const configuredRsiOversold = Number(this.journal.owner.config.rsiOversold ?? this.journal.owner.strategyConfig?.rsiOversold ?? 30);
    const rsiProximity = {
      version: Number(rsiProximityTelemetry.version) || 1,
      threshold: Number.isFinite(Number(rsiProximityTelemetry.threshold))
        ? Number(rsiProximityTelemetry.threshold)
        : Number.isFinite(configuredRsiOversold) ? configuredRsiOversold : null,
      nearThresholdBand: Number.isFinite(Number(rsiProximityTelemetry.nearThresholdBand))
        ? Number(rsiProximityTelemetry.nearThresholdBand)
        : 5,
      uniqueAvailableWindows: Number(rsiProximityTelemetry.uniqueAvailableWindows) || 0,
      uniqueAvailableWindowsByCoin: rsiProximityTelemetry.uniqueAvailableWindowsByCoin || {},
      minimumPreviousRsi: Number.isFinite(Number(rsiProximityTelemetry.minimumPreviousRsi))
        ? Number(rsiProximityTelemetry.minimumPreviousRsi)
        : null,
      minimumPreviousRsiByCoin: rsiProximityTelemetry.minimumPreviousRsiByCoin || {},
      nearThresholdWindows: Number(rsiProximityTelemetry.nearThresholdWindows) || 0,
      nearThresholdWindowsByCoin: rsiProximityTelemetry.nearThresholdWindowsByCoin || {}
    };
    const signalFunnelTelemetry = telemetry?.signalFunnel || {};
    const signalFunnel = {
      version: Number(signalFunnelTelemetry.version) || 1,
      availableWindows: Number(signalFunnelTelemetry.availableWindows) || 0,
      oversoldWindows: Number(signalFunnelTelemetry.oversoldWindows) || 0,
      bullishWindows: Number(signalFunnelTelemetry.bullishWindows) || 0,
      priceReboundWindows: Number(signalFunnelTelemetry.priceReboundWindows) || 0,
      rsiRecoveryWindows: Number(signalFunnelTelemetry.rsiRecoveryWindows) || 0,
      volumeWindows: Number(signalFunnelTelemetry.volumeWindows) || 0,
      candleRangeWindows: Number(signalFunnelTelemetry.candleRangeWindows) || 0,
      closeStrengthWindows: Number(signalFunnelTelemetry.closeStrengthWindows) || 0,
      trendWindows: Number(signalFunnelTelemetry.trendWindows) || 0,
      previousHighBreakWindows: Number(signalFunnelTelemetry.previousHighBreakWindows) || 0,
      profileWindows: Number(signalFunnelTelemetry.profileWindows) || 0,
      confirmedWindows: Number(signalFunnelTelemetry.confirmedWindows) || 0
    };
    const lastSignalEvidenceByCoin = telemetry?.lastSignalEvidenceByCoin || {};
    const suggestedAdjustments = [];
    if (filterStarvation) {
      const reasonCounts = signalTelemetryAvailable && Object.keys(uniqueReasonCounts).length > 0
        ? uniqueReasonCounts
        : telemetry.reasonCounts || {};
      const reasonText = Object.keys(reasonCounts).join(' ');
      const rejectionCounts = signalTelemetryAvailable && Object.keys(uniqueRejectionCounts).length > 0
        ? uniqueRejectionCounts
        : telemetry.rejectionCounts || {};
      const rejectionSuggestions = {
        previous_rsi_not_oversold: 'oversoldLookback=3 후보를 별도 holdout 검증',
        volume_confirmation_failed: 'minVolumeRatio=0.8 후보를 별도 holdout 검증',
        price_rebound_below_threshold: 'minReboundPercent=0.10 후보를 별도 holdout 검증',
        price_rebound_above_threshold: 'maxReboundPercent=0.40 후보를 별도 holdout 검증',
        previous_high_break_failed: '직전 고가 돌파 필터 유지/완화 프로파일을 병렬 비교',
        rsi_recovery_below_threshold: 'minRsiRecovery=1 후보를 별도 holdout 검증',
        close_strength_failed: 'minCloseStrength=0.55 후보를 별도 holdout 검증',
        trend_filter_failed: 'minTrendSlopePercent=-0.5 후보를 별도 holdout 검증',
        signal_range_too_narrow: 'minSignalRangePercent=0.2/0.4 후보를 별도 holdout 검증'
      };
      const keepFilterSuggestions = {
        previous_rsi_not_oversold: '현재 RSI 과매도 필터 유지',
        volume_confirmation_failed: 'minVolumeRatio=1.0 필터 유지',
        price_rebound_below_threshold: 'minReboundPercent=0.15 필터 유지',
        price_rebound_above_threshold: '과대 반등 상한은 별도 검증 전 적용 금지',
        previous_high_break_failed: '직전 고가 돌파 필터 유지',
        rsi_recovery_below_threshold: 'minRsiRecovery=2 필터 유지',
        close_strength_failed: 'minCloseStrength=0.65 필터 유지',
        trend_filter_failed: 'minTrendSlopePercent=-0.2 필터 유지',
        signal_range_too_narrow: '신호 변동폭 하한은 별도 검증 전 비활성 유지'
      };
      const shadowOutcomeByReason = new Map(
        shadowRejectionOutcomes.map(outcome => [outcome.reason, outcome])
      );
      const rankedRejections = Object.entries(rejectionCounts)
        .sort((a, b) => b[1] - a[1]);
      const outcomeBackedRejections = rankedRejections
        .filter(([reason]) => {
          const outcome = shadowOutcomeByReason.get(reason);
          return outcome?.tradeCount >= 3 && outcome.netProfit < 0;
        });
      const reasonsToSuggest = [
        ...outcomeBackedRejections,
        ...rankedRejections
      ].filter(([reason], index, entries) => entries.findIndex(([candidate]) => candidate === reason) === index)
        .slice(0, 3);
      reasonsToSuggest
        .forEach(([reason, count]) => {
          const outcome = shadowOutcomeByReason.get(reason);
          if (outcome?.tradeCount >= 3 && outcome.netProfit < 0) {
            suggestedAdjustments.push(`${keepFilterSuggestions[reason] || reason} · shadow ${outcome.tradeCount}회 손익 ${outcome.netProfit.toFixed(2)}원/PF ${Number.isFinite(outcome.profitFactor) ? outcome.profitFactor.toFixed(2) : '∞'} → 완화 금지 (${count}회 거절)`);
          } else if (rejectionSuggestions[reason]) {
            suggestedAdjustments.push(`${rejectionSuggestions[reason]} (${count}회)`);
          }
        });
      if (suggestedAdjustments.length === 0 && reasonText.includes('최소 반등률')) {
        suggestedAdjustments.push('다음 홀드아웃에서 minReboundPercent=0.10 후보를 별도 검증');
      }
      if (suggestedAdjustments.length === 0 && reasonText.includes('거래량')) {
        suggestedAdjustments.push('다음 홀드아웃에서 minVolumeRatio=0.8 후보를 별도 검증');
      }
      if (suggestedAdjustments.length === 0 && reasonText.includes('고가 돌파')) {
        suggestedAdjustments.push('직전 고가 돌파 필터를 유지/완화한 두 프로파일을 병렬 비교');
      }
      if (suggestedAdjustments.length === 0) {
        suggestedAdjustments.push('현재 시장에는 유효한 반등 후보가 없음; 파라미터 자동 완화 금지');
      }
    }

    return {
      available: true,
      active: session.active === true && !orphaned,
      eligible,
      state: eligible ? 'PASS' : session.active === false || orphaned ? 'STOPPED' : 'RUNNING',
      orphaned,
      sessionId: session.sessionId,
      strategyMode: session.strategyMode,
      strategyProfile: session.strategyProfile,
      configSnapshot: session.configSnapshot || null,
      paperExperiments: session.paperExperiments || null,
      paperExperimentConsistent: experimentComparison.consistent,
      paperExperimentDrift: experimentComparison.drift,
      configConsistent: configComparison.consistent,
      configDrift: configComparison.drift,
      configSchemaDrift: configComparison.schemaDrift,
      configValueDrift: configComparison.valueDrift,
      configBackwardCompatibleMissing: configComparison.backwardCompatibleMissing,
      configSnapshotComplete,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      processId: session.processId || null,
      processAlive: ownerProcessAlive,
      elapsedDays,
      orphanReason,
      promotionBlockers,
      baselineAssets,
      currentAssets,
      returnPercent,
      realizedProfit,
      closedTradeCount: startedTrades.length,
      strictRecentTrades,
      maxDrawdownPercent,
      baselineIncludesHoldings: session.baselineIncludesHoldings === true,
      endedWithOpenPositions,
      endedWithDiagnosticOpenPositions,
      diagnosticOpenPositions: currentDiagnosticOpenPositions,
      diagnosticOpenPositionsAtStop: Array.isArray(session.diagnosticOpenPositionsAtStop)
        ? session.diagnosticOpenPositionsAtStop
        : [],
      pendingCounterfactualCountAtStop: Number(session.pendingCounterfactualCountAtStop) || 0,
      stopReason: session.stopReason || null,
      terminalError: session.terminalError || session.lastError || null,
      thresholds,
      snapshotCount: snapshots.length,
      lastSnapshotAt: snapshots.at(-1)?.timestamp || session.startedAt,
      strictLedgerTradeCount: strictLedgerTrades.length,
      strictRiskState: session.strictRiskState || null,
      strictTradeConfidence,
      strictConfidenceGate,
      exitEvidence,
      signalWindow: this.journal.owner.getStrictSignalWindowStatus(),
      lossCircuitBreaker: strictLossCircuitBreaker,
      strictEvaluation: {
        activePositions: strictOpenPositions.length,
        positions: strictOpenPositions,
        closedTradeCount: startedTrades.length,
        signalWindowCoverage: exitEvidence.strict.signalWindowCoverage,
        realizedProfit,
        winningTrades: strictWinningTrades,
        losingTrades: strictLosingTrades,
        winRate: startedTrades.length > 0 ? (strictWinningTrades / startedTrades.length) * 100 : null,
        recentTrades: strictRecentTrades,
        tradeReturnConfidence: strictTradeConfidence,
        confidenceGate: strictConfidenceGate,
        lossCircuitBreaker: strictLossCircuitBreaker,
        note: '현재 프로세스의 strict 전략 포지션 snapshot입니다. 청산 전 손익은 currentAssets/returnPercent에 평가손익으로 반영됩니다.'
      },
      executionOutcomeComparison,
      executionRobustnessGate,
      heartbeatAt,
      heartbeatAgeMs,
      heartbeatContinuityEligible,
      continuityEligible,
      riskMonitor,
      analysisDataHealth,
      interruptionCount: interruptions.length,
      maxInterruptionMinutes: interruptions.length > 0
        ? Math.max(...interruptions.map(interruption => Number(interruption.gapMs) || 0)) / 60000
        : 0,
      storage: this.journal.owner.getStorageStatus(),
      candleFreshness: {
        maxAgeSeconds: this.journal.owner.maxCandleAgeSeconds,
        blockedSnapshots: Number(telemetry?.candleFreshnessBlockedSnapshots) || 0,
        blockedAnalyses: Number(telemetry?.candleFreshnessBlockedAnalyses) || 0,
        blockedEntries: Number(telemetry?.candleFreshnessBlockedEntries) || 0,
        blockReasons: telemetry?.candleFreshnessBlockReasons || {},
        blockedByCoin: telemetry?.candleFreshnessBlockedByCoin || {},
        observedByCoin: telemetry?.candleFreshnessObservedByCoin || {},
        ageStatsByCoin: Object.fromEntries(
          Object.entries(telemetry?.candleFreshnessAgeStatsByCoin || {})
            .map(([coin, ageStats]) => {
              const sampleCount = Number(ageStats?.sampleCount) || 0;
              return [coin, {
                sampleCount,
                validCount: Number(ageStats?.validCount) || 0,
                blockedCount: Number(ageStats?.blockedCount) || 0,
                missingTimestampCount: Number(ageStats?.missingTimestampCount) || 0,
                minAgeSeconds: Number.isFinite(Number(ageStats?.minAgeSeconds))
                  ? Number(ageStats.minAgeSeconds)
                  : null,
                maxObservedAgeSeconds: Number.isFinite(Number(ageStats?.maxObservedAgeSeconds))
                  ? Number(ageStats.maxObservedAgeSeconds)
                  : null,
                averageAgeSeconds: sampleCount > 0
                  ? (Number(ageStats?.totalAgeSeconds) || 0) / sampleCount
                  : null
              }];
            })
        ),
        blockContexts: telemetry?.candleFreshnessBlockContexts || {},
        ageStats: (() => {
          const ageStats = telemetry?.candleFreshnessAgeStats || {};
          const sampleCount = Number(ageStats.sampleCount) || 0;
          return {
            sampleCount,
            minAgeSeconds: Number.isFinite(Number(ageStats.minAgeSeconds))
              ? Number(ageStats.minAgeSeconds)
              : null,
            maxObservedAgeSeconds: Number.isFinite(Number(ageStats.maxObservedAgeSeconds))
              ? Number(ageStats.maxObservedAgeSeconds)
              : null,
            averageAgeSeconds: sampleCount > 0
              ? (Number(ageStats.totalAgeSeconds) || 0) / sampleCount
              : null
          };
        })(),
        lastBlock: telemetry?.lastCandleFreshnessBlock || null
      },
      candleDataQuality: {
        insufficientByCoin: telemetry?.insufficientCandleDataByCoin || {},
        minimumCandleCount: Math.max(50, (Number(this.journal.owner.config?.rsiPeriod) || 14) + 10)
      },
      marketFreshnessCohort: {
        diagnosticOnly: true,
        minObservations: marketFreshnessCohort.minObservations,
        maxFreshnessBlockRate: marketFreshnessCohort.maxFreshnessBlockRate,
        maxMarkets: marketFreshnessCohort.maxMarkets,
        observedMarketCount: marketFreshnessCohort.selectedRows.length + marketFreshnessCohort.excludedRows.length,
        ready: marketFreshnessCohort.selectedMarkets.length > 0,
        selectedMarkets: marketFreshnessCohort.selectedMarkets,
        selectedRows: marketFreshnessCohort.selectedRows,
        excludedRows: marketFreshnessCohort.excludedRows
      },
      telemetry,
      signalTelemetry: {
        available: signalTelemetryAvailable,
        coverageStartedAt: signalTelemetryAvailable
          ? telemetry.signalTelemetryCoverageStartedAt
          : null,
        dedupeKey: 'coin:rebound.signalKey',
        uniqueSignalWindows,
        uniqueSignalWindowsByCoin,
        uniqueReasonCounts,
        uniqueRejectionCounts,
        note: 'cycle 반복을 제거한 고유 완료 캔들 window 기준입니다. 구버전 ledger는 새 source로 다시 관측할 때부터 집계합니다.'
      },
      shadowEvaluation: {
        activePositions: Object.keys(shadow.positions || {}).length,
        entryCount: Number(shadow.entryCount) || 0,
        closedTradeCount: shadowClosedTrades.length,
        realizedProfit: shadowRealizedProfit,
        realizedReturnPercent: shadowTotalInvested > 0 ? (shadowRealizedProfit / shadowTotalInvested) * 100 : 0,
        winningTrades: shadowWinners,
        losingTrades: shadowLosers,
        winRate: shadowClosedTrades.length > 0 ? (shadowWinners / shadowClosedTrades.length) * 100 : 0,
        profitFactor: shadowProfitFactor,
        positions: shadowOpenPositions,
        lossCircuitBreaker: shadowLossCircuitBreaker,
        rejectionOutcomes: shadowRejectionOutcomes,
        executionBoundary: shadowExecutionBoundary,
        recentTrades: shadowRecentTrades,
        lastEntryAt: shadow.lastEntryAt || null,
        lastExitAt: shadow.lastExitAt || null,
        note: 'soft 후보를 별도 가상 장부로 추적한 참고치이며 strict paper 자산과 실전 승격 판정에는 포함하지 않습니다. 미청산 positions는 entry와 MFE/MAE만 표시하고 실현손익에 합산하지 않습니다.'
      },
      looseShadowEvaluation: {
        activePositions: Object.keys(looseShadow.positions || {}).length,
        entryCount: Number(looseShadow.entryCount) || 0,
        closedTradeCount: looseClosedTrades.length,
        realizedProfit: looseRealizedProfit,
        realizedReturnPercent: looseTotalInvested > 0 ? (looseRealizedProfit / looseTotalInvested) * 100 : 0,
        winningTrades: looseWinners,
        losingTrades: looseLosers,
        winRate: looseClosedTrades.length > 0 ? (looseWinners / looseClosedTrades.length) * 100 : 0,
        profitFactor: looseProfitFactor,
        positions: looseOpenPositions,
        lossCircuitBreaker: looseShadowLossCircuitBreaker,
        rejectionOutcomes: looseRejectionOutcomes,
        executionBoundary: looseExecutionBoundary,
        recentTrades: looseRecentTrades,
        lastEntryAt: looseShadow.lastEntryAt || null,
        lastExitAt: looseShadow.lastExitAt || null,
        note: '더 완화된 후보를 별도 추적한 진단용 장부이며 strict paper 자산·승격 판정에 포함하지 않습니다. 미청산 positions는 entry와 MFE/MAE만 표시하고 실현손익에 합산하지 않습니다.'
      },
      winnerShadowEvaluation: {
        enabled: session.paperExperiments?.winnerShadow?.enabled === true ||
          this.journal.owner.winnerShadowExtendMinutes > 0 || this.journal.owner.winnerShadowMaxReboundPercent > 0,
        entryContract: session.paperExperiments?.winnerShadow?.entryContract ||
          (this.journal.owner.winnerShadowMaxReboundPercent > 0
            ? 'strict_confirmed_buy_signal_with_optional_rebound_ceiling'
            : 'strict_confirmed_buy_signal'),
        winnerExtendMinutes: Number(session.paperExperiments?.winnerShadow?.winnerExtendMinutes ?? this.journal.owner.winnerShadowExtendMinutes) || 0,
        winnerExtendMinProfitPercent: Number(session.paperExperiments?.winnerShadow?.winnerExtendMinProfitPercent ?? this.journal.owner.winnerShadowExtendMinProfitPercent) || 0,
        entryMaxReboundPercent: Number(session.paperExperiments?.winnerShadow?.entryMaxReboundPercent ?? this.journal.owner.winnerShadowMaxReboundPercent) || 0,
        activePositions: Object.keys(winnerShadow.positions || {}).length,
        entryCount: Number(winnerShadow.entryCount) || 0,
        closedTradeCount: winnerShadowClosedTrades.length,
        realizedProfit: winnerShadowRealizedProfit,
        realizedReturnPercent: winnerShadowTotalInvested > 0 ? (winnerShadowRealizedProfit / winnerShadowTotalInvested) * 100 : 0,
        winningTrades: winnerShadowWinners,
        losingTrades: winnerShadowLosers,
        winRate: winnerShadowClosedTrades.length > 0 ? (winnerShadowWinners / winnerShadowClosedTrades.length) * 100 : 0,
        profitFactor: winnerShadowProfitFactor,
        positions: winnerShadowOpenPositions,
        lossCircuitBreaker: winnerShadowLossCircuitBreaker,
        reboundBlockedEntries: Number(telemetry?.winnerShadowReboundBlockedEntries) || 0,
        blockedEntryCount: winnerShadowBlockedEntries.length,
        pendingBlockedEntryCount: winnerShadowPendingBlockedEntries.length,
        notFilledBlockedEntryCount: winnerShadowNotFilledBlockedEntries.length,
        resolvedBlockedEntryCount: winnerShadowSettledBlockedEntries.length + winnerShadowNotFilledBlockedEntries.length,
        settledBlockedEntryCount: winnerShadowSettledBlockedEntries.length,
        counterfactualRealizedProfit: winnerShadowCounterfactualProfit,
        counterfactualWinningTrades: winnerShadowCounterfactualWinners,
        counterfactualLosingTrades: winnerShadowCounterfactualLosers,
        counterfactualProfitFactor: winnerShadowCounterfactualProfitFactor,
        recentBlockedEntries: winnerShadowBlockedEntries.slice(-5),
        recentTrades: winnerShadowRecentTrades,
        lastEntryAt: winnerShadow.lastEntryAt || null,
        lastExitAt: winnerShadow.lastExitAt || null,
        note: 'strict confirmed BUY 신호를 같은 entry 장부로 재생하고 winner-hold exit 후보만 적용하는 연구용 장부입니다. strict 자산·승격 판정에는 포함하지 않습니다.'
      },
      filterStarvation,
      marketQuiet,
      oversoldObservedNoRebound,
      signalAvailability: {
        oversoldObservations,
        strictReboundCandidates,
        strictConfirmedCandidates,
        uniqueSignalWindows,
        rsiProximity,
        signalFunnel,
        lastSignalEvidenceByCoin
      },
      suggestedAdjustments
    };
  }
}
