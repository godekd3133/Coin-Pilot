import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const redesignSource = fs.readFileSync(
  path.join(projectRoot, 'public/pilot-redesign.js'),
  'utf8'
);
const redesignStyleSource = fs.readFileSync(
  path.join(projectRoot, 'public/pilot-redesign.css'),
  'utf8'
);
const indexSource = fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.join(projectRoot, 'public/sw.js'), 'utf8');
const manifestSource = fs.readFileSync(path.join(projectRoot, 'public/manifest.webmanifest'), 'utf8');

test('redesign 외부 번들도 브라우저가 실행할 수 있는 문법이다', () => {
  assert.doesNotThrow(() => new Function(redesignSource));
});

test('redesign은 백그라운드 탭이 다시 보일 때 paper 상태를 즉시 갱신한다', () => {
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"]/);
  assert.match(redesignSource, /if \(!document\.hidden\)\s*loadCore\(\{ quiet: true \}\)/);
});

test('PWA shell은 redesign asset version과 service worker cache version을 함께 갱신한다', () => {
  const scriptAsset = indexSource.match(/<script\s+src=["'](\/pilot-redesign\.js\?v=[^"']+)["']/)?.[1];
  assert.equal(scriptAsset, '/pilot-redesign.js?v=observer-readonly-23');
  assert.match(indexSource, /<link\s+rel=["']stylesheet["']\s+href=["']\/pilot-redesign\.css\?v=20260914-04["']/);
  assert.match(serviceWorkerSource, /const CACHE_NAME = ['"]coinpilot-shell-v29['"]/);
  assert.match(serviceWorkerSource, new RegExp(`['"]${scriptAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(serviceWorkerSource, /['"]\/pilot-redesign\.css\?v=20260914-04['"]/);
});

test('PWA manifest icon과 service worker app shell의 모든 정적 자산이 실제로 존재한다', () => {
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\//);
    const file = path.join(projectRoot, 'public', icon.src.slice(1));
    assert.equal(fs.existsSync(file), true, `manifest icon missing: ${icon.src}`);
    assert.ok(fs.statSync(file).size > 0, `manifest icon empty: ${icon.src}`);
  }

  const shellAssets = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/icon.svg',
    '/icon-192.png',
    '/icon-512.png',
    '/apple-touch-icon.png',
    '/pilot-redesign.css?v=20260914-04',
    '/pilot-redesign.js?v=observer-readonly-23'
  ];
  for (const asset of shellAssets) {
    assert.match(
      serviceWorkerSource,
      new RegExp(`['"]${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
      `service worker app shell missing: ${asset}`
    );
  }
});

test('visible redesign shell owns PWA registration and installation controls', () => {
  assert.match(redesignSource, /function initProgressiveInstall\(\)/);
  assert.match(redesignSource, /navigator\.serviceWorker\.register\(['"]\/sw\.js['"]\)/);
  assert.match(redesignSource, /beforeinstallprompt/);
  assert.match(redesignSource, /if \(isIos \|\| isStandalone\(\)\) return;/);
  assert.match(redesignSource, /appinstalled/);
  assert.match(redesignSource, /function openInstallGuide\(\)/);
  assert.match(redesignSource, /pilot-install-guide-steps/);
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"], refreshInstallState\)/);
  assert.match(redesignSource, /window\.addEventListener\(['"]pageshow['"], refreshInstallState\)/);
  assert.match(redesignSource, /id="pilot-pwa-install"/);
  assert.match(redesignSource, /id="pilot-pwa-state"/);
  assert.match(redesignSource, /initProgressiveInstall\(\);/);
  assert.match(indexSource, /beforeinstallprompt[\s\S]*if \(isIos \|\| isStandalone\) return;/);
});

test('paper UI는 in-flight analysis cycle을 정상 수신과 구분해 표시한다', () => {
  assert.match(redesignSource, /analysisHealth\.analysisActive === true/);
  assert.match(redesignSource, /(?:분석 cycle 진행 중|분석 진행 중)/);
  assert.match(indexSource, /analysisDataHealth\.analysisActive/);
});

test('paper 카드가 strict와 relaxed diagnostic 손익을 분리하고 모바일에서 접힌다', () => {
  assert.match(redesignSource, /shadowEvaluation/);
  assert.match(redesignSource, /looseShadowEvaluation/);
  assert.match(redesignSource, /maxFavorableExcursionPercent/);
  assert.match(redesignSource, /maxAdverseExcursionPercent/);
  assert.match(redesignSource, /(?:진단용 relaxed 장부|참고용 비교 장부)/);
  assert.match(redesignSource, /(?:strict 승격 제외|실제 자산·전환과 무관)/);
  assert.match(redesignStyleSource, /\.pilot-paper-diagnostics\s*\{/);
  assert.match(redesignStyleSource, /\.pilot-paper-diagnostic-grid\s*\{/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-paper-diagnostic-grid\s*\{\s*grid-template-columns:\s*1fr/);
});

test('paper UI는 relaxed 실행경계 차단 telemetry를 표시한다', () => {
  assert.match(redesignSource, /shadowEntryExecutionBlockedEntries/);
  assert.match(redesignSource, /(?:실행경계 차단|진입 경계 차단)/);
  assert.match(redesignSource, /(?:차단 counterfactual|가상 정산)/);
  assert.match(redesignSource, /(?:실제 체결·strict 승격 제외|실제 체결 아님 · 전환 무관)/);
  assert.match(redesignSource, /(?:손실 방향|손실 회피)/);
  assert.match(redesignSource, /놓친 (?:이익 방향|이익)/);
  assert.match(indexSource, /shadowEntryExecutionBlockedEntries/);
  assert.match(indexSource, /(?:실행경계 차단|진입 경계 차단)/);
});

test('validation UI는 historical candle continuity 실패를 수익률과 분리해 표시한다', () => {
  assert.match(redesignSource, /(?:캔들 연속성 실패|캔들 공백)/);
  assert.match(redesignSource, /quality\.gapCount/);
  assert.match(indexSource, /(?:캔들 연속성 실패|캔들 공백)/);
  assert.match(indexSource, /quality\.largestGapSeconds/);
});

test('research UI는 higher-timeframe 결과를 strict/live gate와 분리해 표시한다', () => {
  assert.match(redesignSource, /strategyResearch/);
  assert.match(redesignSource, /\/strategy-research/);
  assert.match(redesignSource, /(?:promoted=false|실제 주문으로 이어지지 않으며)/);
  assert.match(redesignSource, /(?:대체 전략 연구|전략 비교·참고용)/);
  assert.match(redesignSource, /(?:연구 전용|참고용)/);
  assert.match(indexSource, /pilot-redesign-root/);
});

test('momentum shadow UI는 두 장부의 평가자산을 읽기 전용 연구 결과로 표시한다', () => {
  assert.match(redesignSource, /momentumShadow/);
  assert.match(redesignSource, /\/momentum-shadow/);
  assert.match(redesignSource, /방어형 모멘텀 비교/);
  assert.match(redesignSource, /평가수익률/);
  assert.match(redesignSource, /(?:주문 승인과 무관|실제 주문과 무관)/);
  assert.match(redesignSource, /configurationWarning/);
  assert.match(redesignSource, /benchmark.gateOpen/);
  assert.match(redesignSource, /heartbeatAgeSeconds/);
  assert.match(redesignSource, /benchmarkTrendMinPercent/);
  assert.match(redesignSource, /promotionBlockers/);
  assert.match(redesignSource, /riskControls/);
  assert.match(redesignSource, /보호중단 발동/);
  assert.match(redesignSource, /candidateReadiness/);
  assert.match(redesignSource, /다음 (?:risk-capped|리스크 제한) 후보/);
  assert.match(redesignSource, /benchmarkThresholdSummary/);
  assert.match(redesignSource, /기준 시장 임계값 비교/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-grid\s*\{/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-card\s*\{/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*980px\)[\s\S]*\.pilot-momentum-shadow-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(redesignSource, /daily_momentum_robustness_grid/);
  assert.match(redesignSource, /보호중단 모의 후보/);
  assert.match(redesignSource, /최악 (?:segment|구간)/);
});
