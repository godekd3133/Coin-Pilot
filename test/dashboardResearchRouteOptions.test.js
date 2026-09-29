import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';

const SYNTHETIC_DASHBOARD_TOKEN = 'synthetic-dashboard-route-option-token';

class TemporaryStateDashboardServer extends DashboardServer {
  getOptimizationStateFile() {
    return this.tradingSystem.config.benchmarkOptimizationStateFile;
  }
}

test('DashboardServer passes the synthetic paper-forward cohort root to research routes', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dashboard-research-route-'));
  const cohortRoot = path.join(tempRoot, 'paper-forward-cohort');
  fs.mkdirSync(cohortRoot, { recursive: true });

  const bookConfigKeys = [
    'momentumShadowFixedDir',
    'momentumShadowRegimeDir',
    'momentumShadowBenchmarkDir',
    'momentumShadowVolatilityDir',
    'momentumShadowNextOpenDir',
    'momentumShadowFixedHoldDir',
    'momentumShadowFixedHoldLossCapDir',
    'momentumShadowFixedHoldLossCapNoDogeDir',
    'momentumShadowFixedHoldSpreadDir',
    'momentumShadowFixedHoldRelativeDir',
    'momentumShadowFixedHoldQuoteCrossDir'
  ];
  const config = {
    virtualPortfolioFile: path.join(tempRoot, 'portfolio.json'),
    manualOrderIdempotencyFile: path.join(tempRoot, 'manual-order-idempotency.json'),
    benchmarkOptimizationStateFile: path.join(tempRoot, 'optimization-state.json'),
    momentumShadowCandidateDir: path.join(tempRoot, 'momentum-shadow-candidate'),
    momentumShadowCandidateSlotFile: path.join(tempRoot, 'momentum-shadow-candidate-slot.json'),
    momentumShadowQuoteHistoryFile: path.join(tempRoot, 'momentum-shadow-quote-history.jsonl'),
    momentumShadowQuoteReportFile: path.join(tempRoot, 'momentum-shadow-quote-quality.json')
  };
  bookConfigKeys.forEach(key => {
    config[key] = path.join(tempRoot, key);
  });

  const trader = {
    readOnlyObserver: true,
    dryRun: true,
    isRunning: false,
    virtualPortfolioFile: config.virtualPortfolioFile,
    liveExecutionEvidenceFile: path.join(tempRoot, 'live-execution-evidence.jsonl'),
    config
  };

  const previousOwnerDirs = process.env.MOMO_SHADOW_OWNER_DIRS;
  process.env.MOMO_SHADOW_OWNER_DIRS = '';
  let dashboard = null;

  try {
    dashboard = new TemporaryStateDashboardServer(trader, 0, {
      env: {
        ...process.env,
        DASHBOARD_TOKEN: SYNTHETIC_DASHBOARD_TOKEN,
        DASHBOARD_READ_ONLY_TOKEN: '',
        DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_ALLOW_INSECURE: '',
        DASHBOARD_CORS_ORIGINS: '',
        DASHBOARD_TLS_CERT_FILE: '',
        DASHBOARD_TLS_KEY_FILE: '',
        STAGING_OUTPUT_DIR: path.join(tempRoot, 'logs')
      },
      paperForwardCohortRootDir: cohortRoot
    });
    const server = await dashboard.start();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/momentum-shadow`, {
      headers: { Authorization: `Bearer ${SYNTHETIC_DASHBOARD_TOKEN}` }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.paperForwardCohort.rootName, path.basename(cohortRoot));
    assert.equal(body.paperForwardCohort.sessionCount, 0);
    assert.equal(body.paperForwardCohort.researchOnly, true);
    assert.equal(body.paperForwardCohort.promoted, false);
  } finally {
    try {
      if (dashboard) {
        try {
          await dashboard.stop();
        } finally {
          await dashboard.logger.flush();
        }
      }
    } finally {
      if (previousOwnerDirs === undefined) delete process.env.MOMO_SHADOW_OWNER_DIRS;
      else process.env.MOMO_SHADOW_OWNER_DIRS = previousOwnerDirs;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});
