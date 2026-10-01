import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  getMomentumShadowHistoricalEvidence
} from '../../research/momentumShadowCandidateProfiles.js';
import { envNumber, envString } from '../../config/envConfig.js';
import { summarizePaperForwardCohort } from '../../research/paperForwardCohort.js';
import { assessScalpingValidationReportFreshness } from '../../research/scalpingValidationFreshness.js';
import {
  projectLiveExecutionEvidenceStatus
} from '../../research/liveExecutionEvidence.js';
import { createRequestLocalFileSnapshot } from '../../research/requestLocalFileSnapshot.js';
import {
  PROJECT_ROOT,
  DEFAULT_MOMENTUM_SHADOW_PROJECTION_CACHE_MS,
  MAX_MOMENTUM_SHADOW_PROJECTION_CACHE_MS,
  readMomentumShadowQuoteHistoryRecords,
  projectMomentumShadowQuoteQualitySnapshot,
  projectMomentumShadowCandidateReadiness,
  projectMomentumShadowVolatilityReadiness,
  projectMomentumShadowNextOpenReadiness,
  projectMomentumShadowFixedHoldReadiness,
  momentumShadowBookDefinitions,
  projectMomentumShadowBook,
  resolveReportFile
} from '../../research/momentumShadowProjections.js';


/**
 * Read-only strategy research projection. This endpoint intentionally forces
 * the promotion boundary to false even if a hand-edited report contains a
 * truthy value; research artifacts never authorize orders.
 */
export default function createResearchRoutes(server, {
  paperForwardCohortRootDir = PROJECT_ROOT,
  momentumShadowProjectionCacheMs = DEFAULT_MOMENTUM_SHADOW_PROJECTION_CACHE_MS,
  projectionClock = () => Date.now()
} = {}) {
  const projectionCacheMs = Number(momentumShadowProjectionCacheMs);
  if (!Number.isFinite(projectionCacheMs) || projectionCacheMs < 0 ||
    projectionCacheMs > MAX_MOMENTUM_SHADOW_PROJECTION_CACHE_MS) {
    throw new TypeError(
      `momentumShadowProjectionCacheMs must be between 0 and ${MAX_MOMENTUM_SHADOW_PROJECTION_CACHE_MS}`
    );
  }
  if (typeof projectionClock !== 'function') {
    throw new TypeError('projectionClock must be a function');
  }
  let cachedMomentumShadowProjection = null;
  let cachedMomentumShadowProjectionAt = null;
  const router = express.Router();

  const getLiveExecutionEvidenceStatus = (fileSnapshot = null) => projectLiveExecutionEvidenceStatus({
    filePath: server?.tradingSystem?.liveExecutionEvidenceFile ||
      envString('LIVE_EXECUTION_EVIDENCE_FILE', null) ||
      '.coinpilot-runtime/live-execution/evidence.jsonl',
    liveMode: server?.tradingSystem?.dryRun === false,
    runtimeWriteError: server?.tradingSystem?.liveExecutionEvidenceWriteError,
    runtimeDataError: server?.tradingSystem?.liveExecutionEvidenceDataError,
    fileSnapshot
  });

  router.get('/live-execution-evidence', (req, res) => {
    return res.json(getLiveExecutionEvidenceStatus(createRequestLocalFileSnapshot()));
  });

  // This diagnostic-only route reads many local ledgers synchronously. A
  // bounded per-router cache shares dashboard refresh bursts; it never feeds
  // the trading gate, and the response reports the projection's age.
  router.get('/momentum-shadow', (req, res) => {
    const observedAt = Number(projectionClock());
    const now = Number.isFinite(observedAt) ? observedAt : Date.now();
    const cacheAgeMs = cachedMomentumShadowProjectionAt === null
      ? null
      : Math.max(0, now - cachedMomentumShadowProjectionAt);
    if (projectionCacheMs > 0 && cachedMomentumShadowProjection &&
      cacheAgeMs !== null && cacheAgeMs < projectionCacheMs) {
      return res.json({
        ...cachedMomentumShadowProjection,
        projectionFetchedAt: new Date(cachedMomentumShadowProjectionAt).toISOString(),
        projectionAgeMs: cacheAgeMs
      });
    }

    const fileSnapshot = createRequestLocalFileSnapshot();
    const fallbackInitialBalance = envNumber('MOMO_SHADOW_INITIAL_BALANCE', null) || 100_000_000;
    const quoteHistorySource = readMomentumShadowQuoteHistoryRecords(server, fileSnapshot);
    const books = momentumShadowBookDefinitions(server)
      .map(definition => projectMomentumShadowBook(
        definition,
        fallbackInitialBalance,
        server,
        quoteHistorySource,
        fileSnapshot
      ));
    const candidateReadiness = projectMomentumShadowCandidateReadiness(server, fileSnapshot);
    const paperForwardCohort = summarizePaperForwardCohort({
      rootDir: paperForwardCohortRootDir
    });
    const lossCapNoDogeReadiness = projectMomentumShadowFixedHoldReadiness(server, {
      stopLossPercent: 4,
      excludeDoge: true
    }, fileSnapshot);
    lossCapNoDogeReadiness.historicalEvidence = getMomentumShadowHistoricalEvidence('loss_cap_no_doge');
    const candidateReadinessVariants = [
      { key: 'baseline', label: '기본 전략', readiness: candidateReadiness },
      {
        key: 'volatility',
        label: '변동성에 따라 비중 조절',
        readiness: projectMomentumShadowVolatilityReadiness(server, fileSnapshot)
      },
      {
        key: 'next_open',
        label: '거래 비용 반영 · 다음 날 시가 진입',
        readiness: projectMomentumShadowNextOpenReadiness(server, fileSnapshot)
      },
      {
        key: 'fixed_2d',
        label: '2일 뒤 청산',
        readiness: projectMomentumShadowFixedHoldReadiness(server, {}, fileSnapshot)
      },
      {
        key: 'fixed_2d_loss_cap',
        label: '2일 보유 · 종가 기준 손실 제한',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { stopLossPercent: 4 }, fileSnapshot)
      },
      {
        key: 'fixed_2d_loss_cap_no_doge',
        label: '2일 보유 · 도지코인 제외 · 손실 제한',
        readiness: lossCapNoDogeReadiness
      },
      {
      key: 'fixed_2d_relative',
        label: '2일 보유 · 비트코인 대비 강한 추세',
        readiness: projectMomentumShadowFixedHoldReadiness(server, {
          relativeTrendMinPercent: 0
        }, fileSnapshot)
      },
      {
        key: 'fixed_2d_spread',
        label: '2일 보유 · 호가 제한',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { spreadGuard: true }, fileSnapshot)
      },
      {
        key: 'fixed_2d_quote_cross',
        label: '2일 보유 · 매수·매도 호가 기준',
        readiness: projectMomentumShadowFixedHoldReadiness(server, { quoteCross: true }, fileSnapshot)
      }
    ];
    const projection = {
      available: books.some(book => book.available),
      researchOnly: true,
      promoted: false,
      projectionReason: 'momentum_shadow_is_diagnostic_only_and_never_authorizes_orders',
      liveExecutionEvidence: getLiveExecutionEvidenceStatus(fileSnapshot),
      quoteQualitySnapshot: projectMomentumShadowQuoteQualitySnapshot(server, fileSnapshot),
      paperForwardCohort,
      candidateReadiness,
      candidateReadinessVariants,
      books
    };
    const completedAtValue = Number(projectionClock());
    cachedMomentumShadowProjectionAt = Number.isFinite(completedAtValue) ? completedAtValue : Date.now();
    cachedMomentumShadowProjection = projectionCacheMs > 0 ? projection : null;
    return res.json({
      ...projection,
      projectionFetchedAt: new Date(cachedMomentumShadowProjectionAt).toISOString(),
      projectionAgeMs: 0
    });
  });

  router.get('/strategy-research', (req, res) => {
    const reportFile = resolveReportFile(server);
    if (!reportFile) {
      return res.json({
        available: false,
        researchOnly: true,
        promoted: false,
        reason: 'research_report_not_configured'
      });
    }
    // Project only the basename — the absolute report path is local
    // filesystem detail, not dashboard evidence.
    const reportFileName = path.basename(reportFile);
    if (!fs.existsSync(reportFile)) {
      return res.json({
        available: false,
        researchOnly: true,
        promoted: false,
        reportFile: reportFileName,
        reason: 'research_report_not_found'
      });
    }

    try {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('research report 형식이 잘못되었습니다.');
      }
      return res.json({
        ...report,
        available: true,
        researchOnly: true,
        promoted: false,
        reportFile: reportFileName,
        reportFreshness: assessScalpingValidationReportFreshness(report.generatedAt),
        projectionReason: 'research_artifact_never_authorizes_live_orders'
      });
    } catch (error) {
      return res.status(500).json({
        available: false,
        researchOnly: true,
        promoted: false,
        reportFile: reportFileName,
        reason: 'research_report_invalid',
        error: error.message
      });
    }
  });

  return router;
}
