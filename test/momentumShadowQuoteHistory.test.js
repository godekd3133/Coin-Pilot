import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MOMENTUM_SHADOW_QUOTE_REPORT_FILE,
  DEFAULT_MOMENTUM_SHADOW_QUOTE_RUNTIME_DIR,
  DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_FILE,
  projectMomentumShadowQuoteHistory,
  resolveMomentumShadowQuoteRuntimeFile,
  summarizeMomentumShadowQuoteHistory
} from '../src/research/momentumShadowQuoteHistory.js';

test('quote evidence defaults to a persistent ignored runtime instead of tmp', () => {
  assert.match(DEFAULT_MOMENTUM_SHADOW_QUOTE_RUNTIME_DIR, /\.coinpilot-runtime\/momentum-shadow$/);
  assert.match(DEFAULT_MOMENTUM_SHADOW_QUOTE_REPORT_FILE, /quote-quality\.json$/);
  assert.match(DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_FILE, /quote-history\.jsonl$/);
  assert.equal(DEFAULT_MOMENTUM_SHADOW_QUOTE_REPORT_FILE.includes('/private/tmp/'), false);
  assert.equal(DEFAULT_MOMENTUM_SHADOW_QUOTE_HISTORY_FILE.includes('/private/tmp/'), false);
  assert.equal(
    resolveMomentumShadowQuoteRuntimeFile('quote-history.jsonl', {
      MOMO_SHADOW_RUNTIME_DIR: '/tmp/coinpilot-persistent-quotes'
    }),
    '/tmp/coinpilot-persistent-quotes/quote-history.jsonl'
  );
});

test('quote history summarizes repeated ceiling violations without treating them as fills', () => {
  const now = Date.parse('2026-09-16T12:00:00.000Z');
  const projection = summarizeMomentumShadowQuoteHistory({
    now,
    maxAgeSeconds: 900,
    records: [
      {
        generatedAt: '2026-09-16T10:00:00.000Z',
        complete: true,
        errors: 0,
        summary: {
          markets: {
            'KRW-BTC': { p95: 0.03, overCeiling: 0 },
            'KRW-DOGE': { p95: 0.9, overCeiling: 5 }
          }
        }
      },
      {
        generatedAt: '2026-09-16T11:00:00.000Z',
        complete: true,
        errors: 0,
        summary: {
          markets: {
            'KRW-BTC': { p95: 0.04, overCeiling: 0 },
            'KRW-DOGE': { p95: 0.8, overCeiling: 5 }
          }
        }
      },
      {
        generatedAt: '2026-09-16T11:30:00.000Z',
        complete: false,
        errors: 1,
        summary: {
          markets: {
            'KRW-BTC': { p95: 0.05, overCeiling: 0 },
            'KRW-DOGE': { p95: 0.7, overCeiling: 0 }
          }
        }
      },
      {
        generatedAt: '2026-09-16T12:01:00.000Z',
        complete: true,
        errors: 0,
        summary: { markets: { 'KRW-DOGE': { p95: 99, overCeiling: 99 } } }
      },
      'malformed record'
    ]
  });

  assert.equal(projection.available, true);
  assert.equal(projection.reportCount, 3);
  assert.equal(projection.completeReportCount, 2);
  assert.equal(projection.errorReportCount, 1);
  assert.equal(projection.fresh, false);
  assert.deepEqual(projection.latestOverCeilingMarkets, []);
  assert.deepEqual(projection.repeatedOverCeilingMarkets, ['KRW-DOGE']);
  assert.equal(projection.markets['KRW-DOGE'].reportCount, 3);
  assert.equal(projection.markets['KRW-DOGE'].overCeilingReports, 2);
  assert.equal(projection.markets['KRW-DOGE'].overCeilingRate, 2 / 3);
  assert.equal(projection.markets['KRW-DOGE'].latestP95, 0.7);
  assert.equal(projection.markets['KRW-DOGE'].maxP95, 0.9);
  assert.equal(projection.markets['KRW-DOGE'].topOfBookDepth.twoSidedDepthReportCount, 0);
  assert.equal(projection.markets['KRW-DOGE'].topOfBookDepth.status, 'INSUFFICIENT_DEPTH_REPORT_HISTORY');
  assert.equal(projection.promoted, false);
  assert.equal(projection.researchOnly, true);
});

test('quote history depth projection preserves legacy gaps and stays insufficient below 30 reports', () => {
  const now = Date.parse('2026-09-16T12:00:00.000Z');
  const depth = (minimumBidNotionalKrw, minimumAskNotionalKrw) => ({
    requestedSampleCount: 5,
    bidSampleCount: 5,
    askSampleCount: 5,
    minimumBidNotionalKrw,
    minimumAskNotionalKrw
  });
  const projection = summarizeMomentumShadowQuoteHistory({
    now,
    maxReports: 48,
    minimumDepthReports: 30,
    records: [
      {
        generatedAt: '2026-09-16T11:40:00.000Z',
        complete: true,
        errors: 0,
        summary: { markets: { 'KRW-BTC': { p95: 0.05 } } }
      },
      {
        generatedAt: '2026-09-16T11:50:00.000Z',
        complete: true,
        errors: 0,
        summary: { markets: { 'KRW-BTC': { p95: 0.05, topOfBookDepth: depth(100_000, 90_000) } } }
      },
      {
        generatedAt: '2026-09-16T12:00:00.000Z',
        complete: true,
        errors: 0,
        summary: { markets: { 'KRW-BTC': { p95: 0.06, topOfBookDepth: depth(80_000, 70_000) } } }
      }
    ]
  });
  const depthSummary = projection.markets['KRW-BTC'].topOfBookDepth;

  assert.equal(projection.windowLimit, 48);
  assert.equal(projection.minimumDepthReports, 30);
  assert.equal(depthSummary.twoSidedDepthReportCount, 2);
  assert.equal(depthSummary.missingDepthReportCount, 1);
  assert.equal(depthSummary.p05PerReportMinimumBidNotionalKrw, 80_000);
  assert.equal(depthSummary.status, 'INSUFFICIENT_DEPTH_REPORT_HISTORY');
});

test('quote history projector reads JSONL suffix and hides the filesystem path', () => {
  const file = path.join(os.tmpdir(), `coinpilot-quote-history-${process.pid}-${Date.now()}.jsonl`);
  const now = Date.now();
  fs.writeFileSync(file, [
    JSON.stringify({
      generatedAt: new Date(now - 120_000).toISOString(),
      complete: true,
      errors: 0,
      summary: { markets: { 'KRW-DOGE': { p95: 0.9, overCeiling: 5 } } }
    }),
    '{not-json}',
    JSON.stringify({
      generatedAt: new Date(now + 120_000).toISOString(),
      complete: true,
      errors: 0,
      summary: { markets: { 'KRW-DOGE': { p95: 9, overCeiling: 5 } } }
    })
  ].join('\n'), 'utf8');

  try {
    const projection = projectMomentumShadowQuoteHistory({ historyFile: file, now });
    assert.equal(projection.available, true);
    assert.equal(projection.reportFile, path.basename(file));
    assert.equal(projection.reportFile.includes(path.dirname(file)), false);
    assert.equal(projection.reportCount, 1);
    assert.equal(projection.markets['KRW-DOGE'].overCeilingReports, 1);
    assert.deepEqual(projection.repeatedOverCeilingMarkets, []);
    assert.equal(projection.promoted, false);
    assert.equal(projection.researchOnly, true);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});
