import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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
const tradingRouteSource = fs.readFileSync(path.join(projectRoot, 'src/api/routes/trading.js'), 'utf8');
const coreReadinessFunctionSource = redesignSource.match(
  /function isCoreTradingSnapshotReady\(\{[\s\S]*?\n {4}\}/
)?.[0];
const isCoreTradingSnapshotReady = coreReadinessFunctionSource
  ? new Function(`${coreReadinessFunctionSource}; return isCoreTradingSnapshotReady;`)()
  : null;
const readinessStart = redesignSource.indexOf('    function classifyReadiness(readiness) {');
const readinessEnd = redesignSource.indexOf('\n    function symbolOf(', readinessStart);
const readinessClassificationFunctionSource = readinessStart >= 0 && readinessEnd > readinessStart
  ? redesignSource.slice(readinessStart, readinessEnd).trim()
  : null;
const classifyReadiness = readinessClassificationFunctionSource
  ? new Function(`${readinessClassificationFunctionSource}; return classifyReadiness;`)()
  : null;
const optionalPercentFunctionSource = redesignSource.match(
  /function formatOptionalPercent\(value, decimals = 2\) \{[\s\S]*?\n {4}\}/
)?.[0];
const formatOptionalPercent = optionalPercentFunctionSource
  ? new Function('formatPercent', `${optionalPercentFunctionSource}; return formatOptionalPercent;`)(
    (value, decimals = 2) => `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(decimals)}%`
  )
  : null;
const paperStatusClassificationSource = redesignSource.match(
  /const notStarted = status\?\.available === false && status\?\.reason === ['"]paper_validation_session_not_started['"];\s*const knownStatus = status\?\.available === true \|\| notStarted;/
)?.[0];
const classifyPaperStatus = paperStatusClassificationSource
  ? new Function('status', `${paperStatusClassificationSource}; return { notStarted, knownStatus };`)
  : null;

test('redesign 외부 번들도 브라우저가 실행할 수 있는 문법이다', () => {
  assert.doesNotThrow(() => new Function(redesignSource));
});

test('redesign은 백그라운드 탭이 다시 보일 때 paper 상태를 즉시 갱신한다', () => {
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"]/);
  assert.match(redesignSource, /if \(!document\.hidden\)\s*loadCore\(\{ quiet: true \}\)/);
});

test('PWA shell은 redesign asset version과 service worker cache version을 함께 갱신한다', () => {
  const scriptAsset = indexSource.match(/<script\s+src=["'](\/pilot-redesign\.js\?v=[^"']+)["']/)?.[1];
  assert.equal(scriptAsset, '/pilot-redesign.js?v=observer-readonly-123');
  assert.match(indexSource, /<link\s+rel=["']stylesheet["']\s+href=["']\/pilot-redesign\.css\?v=20260924-07["']/);
  assert.match(serviceWorkerSource, /const CACHE_NAME = ['"]coinpilot-shell-v136['"]/);
  assert.match(serviceWorkerSource, new RegExp(`['"]${scriptAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(serviceWorkerSource, /['"]\/pilot-redesign\.css\?v=20260924-07['"]/);
  assert.match(serviceWorkerSource, /NETWORK_FIRST_SHELL_PATHS/);
  assert.match(serviceWorkerSource, /fetch\(request\)[\s\S]*ignoreSearch: true/);
});

test('service worker does not replace failed third-party requests with the local HTML shell', () => {
  const handlers = {};
  vm.runInNewContext(serviceWorkerSource, {
    URL,
    self: {
      location: { origin: 'https://coinpilot.example' },
      addEventListener(name, handler) { handlers[name] = handler; }
    }
  });

  let intercepted = false;
  handlers.fetch({
    request: {
      method: 'GET',
      url: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR'
    },
    respondWith() { intercepted = true; }
  });

  assert.equal(intercepted, false);
});

test('PWA manifest icon과 service worker app shell의 모든 정적 자산이 실제로 존재한다', () => {
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.equal(manifest.id, '/?source=pwa');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  assert.ok(manifest.icons.every(icon => icon.type === 'image/png'));

  const svgIconSource = fs.readFileSync(path.join(projectRoot, 'public/icon.svg'), 'utf8');
  assert.match(svgIconSource, /<svg[^>]*width="512"[^>]*height="512"[^>]*viewBox="0 0 512 512"/);

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
    '/auth-client.js',
    '/pilot-redesign.css?v=20260924-07',
    '/pilot-redesign.js?v=observer-readonly-123'
  ];
  for (const asset of shellAssets) {
    assert.match(
      serviceWorkerSource,
      new RegExp(`['"]${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
      `service worker app shell missing: ${asset}`
    );
  }
});

test('core trading readiness requires a matching live mode, finite account balance, and selected-market price', () => {
  assert.equal(typeof isCoreTradingSnapshotReady, 'function');
  const readySnapshot = {
    status: { mode: 'DRY_RUN' },
    account: { mode: 'DRY_RUN', krwBalance: 10_000 },
    marketPrices: [{ coin: 'KRW-BTC', price: 100 }],
    selectedCoin: 'KRW-BTC'
  };

  assert.equal(isCoreTradingSnapshotReady(readySnapshot), true);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, status: null }), false);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, account: null }), false);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, marketPrices: null }), false);
  assert.equal(isCoreTradingSnapshotReady({
    ...readySnapshot,
    account: { ...readySnapshot.account, mode: 'LIVE' }
  }), false);
  assert.equal(isCoreTradingSnapshotReady({
    ...readySnapshot,
    account: { ...readySnapshot.account, krwBalance: Number.NaN }
  }), false);
  assert.equal(isCoreTradingSnapshotReady({ ...readySnapshot, selectedCoin: 'KRW-ETH' }), false);
  assert.equal(isCoreTradingSnapshotReady({
    ...readySnapshot,
    marketPrices: [{ coin: 'KRW-BTC', price: 0 }]
  }), false);
});

test('readiness classifies passed, blocked, stale, and unknown states without false green', () => {
  assert.equal(typeof classifyReadiness, 'function');
  const report = {
    available: true,
    filename: 'scalping_validation.json',
    generatedAt: '2026-09-21T00:00:00.000Z',
    validationMode: 'fixed_config',
    promoted: true,
    freshness: { fresh: false, reason: 'stale', ageSeconds: 172_800, maxAgeSeconds: 86_400 }
  };
  const staleButGatePassed = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report,
    runtime: { dryRun: true, applies: false },
    liveGate: { checked: true, passed: true, enforced: false, enforcedFreshness: false }
  });

  assert.equal(staleButGatePassed.ready, false);
  assert.equal(staleButGatePassed.stale, true);
  assert.equal(staleButGatePassed.stateLabel, '보류');
  assert.equal(staleButGatePassed.gate.passed, true);
  assert.equal(staleButGatePassed.gate.enforcedFreshness, false);
  assert.equal(staleButGatePassed.currentEvidence, false);
  assert.deepEqual(staleButGatePassed.reasons, ['점검 결과가 오래됐습니다.']);

  const ready = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'READY',
    currentEvidence: true,
    report: { ...report, freshness: { fresh: true, reason: 'fresh', ageSeconds: 60, maxAgeSeconds: 86_400 } },
    runtime: { dryRun: false, applies: true },
    liveGate: { checked: true, passed: true, enforced: true, enforcedFreshness: false }
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.stateLabel, '통과');

  const paperReady = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'READY',
    currentEvidence: true,
    report: { ...report, freshness: { fresh: true, reason: 'fresh', ageSeconds: 60, maxAgeSeconds: 86_400 } },
    runtime: { dryRun: true, applies: false },
    liveGate: { checked: true, passed: true, enforced: false, enforcedFreshness: false }
  });
  assert.equal(paperReady.stateLabel, '통과');

  const settingsMismatch = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report: { ...report, freshness: { fresh: true, reason: 'fresh' } },
    liveGate: { checked: true, passed: false, code: 'runtime_config_mismatch' }
  });
  assert.equal(settingsMismatch.stateLabel, '보류');
  assert.equal(settingsMismatch.headline, '실제 주문 조건을 충족하지 못했습니다.');
  assert.deepEqual(settingsMismatch.reasons, ['현재 설정과 점검 당시 설정이 다릅니다. 현재 설정으로 다시 점검하세요.']);

  const incompleteSettings = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report: { ...report, freshness: { fresh: true, reason: 'fresh' } },
    liveGate: { checked: true, passed: false, code: 'report_config_incomplete' },
    blockerDetails: [
      { code: 'report_not_promoted' },
      { code: 'report_config_incomplete' },
      { code: 'confidence_gate_failed' }
    ]
  });
  assert.deepEqual(incompleteSettings.reasons, [
    '점검에 필요한 설정 정보가 빠져 있습니다.',
    '전략 점검 기준을 충족하지 못했습니다.'
  ]);

  const unknown = classifyReadiness(null);
  assert.equal(unknown.ready, false);
  assert.equal(unknown.stateLabel, '확인 필요');
  assert.deepEqual(unknown.reasons, ['점검 결과를 불러오지 못했습니다.']);

  const invalidTimestamp = classifyReadiness({
    source: 'configured_scalping_validation_report',
    status: 'BLOCKED',
    currentEvidence: false,
    report: { available: true, freshness: { fresh: false, reason: 'future_timestamp' } },
    liveGate: { checked: true, passed: true }
  });
  assert.equal(invalidTimestamp.stateLabel, '확인 필요');
  assert.deepEqual(invalidTimestamp.reasons, ['작성 시각을 확인할 수 없습니다.']);
});

test('optional percent formatting preserves unavailable values instead of coercing null to zero', () => {
  assert.equal(typeof formatOptionalPercent, 'function');
  assert.equal(formatOptionalPercent(null), '—');
  assert.equal(formatOptionalPercent(undefined), '—');
  assert.equal(formatOptionalPercent(''), '—');
  assert.equal(formatOptionalPercent(0), '+0.00%');
  assert.equal(formatOptionalPercent('0.3'), '+0.30%');
});

test('offline recovery queues exactly a fresh read without locking ordinary successful polls', () => {
  const loadCore = redesignSource
    .split('async function loadCore(')[1]
    ?.split('function clearDynamicStateForOffline()')[0];
  assert.ok(loadCore);
  assert.match(loadCore, /quiet\s*=\s*false,\s*afterNetworkRestore\s*=\s*false/);
  assert.match(loadCore, /if \(afterNetworkRestore\)\s*refreshAfterCurrent\s*=\s*true/);
  assert.doesNotMatch(loadCore.split('const requestGeneration')[1]?.split('const period')[0] || '', /state\.coreReady\s*=\s*false/);
  assert.match(loadCore, /const currentSnapshot = Object\.fromEntries\(settled\.map/);
  assert.match(loadCore, /status: loaded\.status \? currentSnapshot\.status : null/);
  assert.match(loadCore, /account: loaded\.account \? currentSnapshot\.account : null/);
  assert.match(loadCore, /marketPrices: loaded\.marketPrices \? currentSnapshot\.marketPrices : null/);
  assert.match(loadCore, /state\.connected\s*=\s*state\.coreReady/);
  assert.match(loadCore, /if \(state\.coreReady\)\s*state\.lastSync\s*=/);
  assert.match(redesignSource, /function recoverOnline\(\)[\s\S]*?loadCore\(\{\s*afterNetworkRestore:\s*true\s*\}\)/);
  assert.match(redesignSource, /function enterOfflineMode\(\)[\s\S]*?refreshAfterCurrent\s*=\s*false/);
  assert.match(redesignSource, /state\.coreReady\s*=\s*isCoreTradingSnapshotReady\(/);
  assert.match(redesignSource, /state\.coreReady !== true/);
  assert.match(redesignSource, /state\.actualMode === ['"]DRY_RUN['"]/);
});

test('iOS와 Android 설치 메타가 visible shell에 함께 선언된다', () => {
  assert.match(indexSource, /<meta\s+name="mobile-web-app-capable"\s+content="yes"/);
  assert.match(indexSource, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/);
  assert.match(indexSource, /<meta\s+name="apple-mobile-web-app-title"\s+content="CoinPilot"/);
  assert.match(indexSource, /<meta\s+name="apple-mobile-web-app-status-bar-style"/);
  assert.match(indexSource, /<link\s+rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"/);
});

test('visible redesign shell owns PWA registration and installation controls', () => {
  assert.match(redesignSource, /function initProgressiveInstall\(\)/);
  assert.match(redesignSource, /navigator\.serviceWorker\.register\(['"]\/sw\.js['"]\)/);
  assert.match(redesignSource, /beforeinstallprompt/);
  assert.match(redesignSource, /updatefound/);
  assert.match(redesignSource, /controllerchange/);
  assert.match(redesignSource, /pilot-pwa-update/);
  assert.match(redesignSource, /reload-pwa/);
  assert.match(redesignSource, /waiting\.postMessage\(\{ type: ['"]SKIP_WAITING['"] \}\)/);
  assert.match(redesignSource, /setTimeout\(reloadOnce, 2000\)/);
  assert.match(redesignSource, /if \(isIos \|\| isStandalone\(\) \|\| !isSecureContext \|\| !serviceWorkerSupported \|\| serviceWorkerFailed\) return;/);
  assert.match(redesignSource, /window\.isSecureContext === true/);
  assert.match(redesignSource, /HTTPS 필요/);
  assert.match(redesignSource, /이 주소에서는 설치할 수 없습니다\. 보안 연결\(HTTPS\) 주소로 다시 여세요/);
  assert.match(redesignSource, /appinstalled/);
  assert.match(redesignSource, /function openInstallGuide\(\)/);
  assert.match(redesignSource, /pilot-install-guide-steps/);
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"], refreshInstallState\)/);
  assert.match(redesignSource, /window\.addEventListener\(['"]pageshow['"], refreshInstallState\)/);
  assert.match(redesignSource, /serviceWorkerSupported/);
  assert.match(redesignSource, /serviceWorkerFailed/);
  assert.match(redesignSource, /설치 상태를 확인할 수 없습니다\. 브라우저 메뉴에서 설치 항목을 확인하세요/);
  assert.match(redesignSource, /설치 상태 확인 불가/);
  assert.match(redesignSource, /설치 확인 중/);
  assert.match(redesignSource, /!serviceWorkerSupported/);
  assert.match(redesignSource, /id="pilot-pwa-install"/);
  assert.match(redesignSource, /id="pilot-pwa-state"/);
  assert.match(redesignSource, /initProgressiveInstall\(\);/);
  assert.match(indexSource, /beforeinstallprompt[\s\S]*if \(isIos \|\| isStandalone \|\| !isSecureContext\) return;/);
  assert.match(indexSource, /window\.isSecureContext === true/);
  assert.match(indexSource, /HTTPS 필요/);
  assert.match(serviceWorkerSource, /SKIP_WAITING/);
});

test('설치·오프라인 안내는 사용자 조건과 다음 행동만 표시한다', () => {
  const guide = redesignSource.split('function openInstallGuide() {')[1]?.split('const renderInstallState')[0];
  const update = redesignSource.match(/<section class="pilot-pwa-update"[\s\S]*?<\/section>/)?.[0];
  const offline = redesignSource.match(/<section class="pilot-offline-banner"[\s\S]*?<\/section>/)?.[0];
  assert.ok(guide && update && offline);
  assert.match(guide, /보안 연결\(HTTPS\) 주소로 다시 여세요/);
  assert.match(guide, /브라우저 메뉴에서 설치 항목을 확인하세요/);
  assert.match(guide, /Safari에서 CoinPilot을 엽니다/);
  assert.match(guide, /홈 화면에 추가/);
  assert.match(guide, /설치 방법/);
  assert.doesNotMatch(guide, /service worker|설치 이벤트|HTTPS로 노출|localhost|127\.0\.0\.1/i);
  assert.match(update, /새 버전이 나왔습니다/);
  assert.match(update, /새로고침하면 새 버전이 적용됩니다/);
  assert.match(update, />새로고침<\/button>/);
  assert.doesNotMatch(update, /paper\/live|최신 설치앱 화면/);
  assert.match(offline, /계좌와 시세를 불러올 수 없습니다/);
  assert.match(offline, /연결이 복구될 때까지 주문과 설정을 사용할 수 없습니다/);
  assert.doesNotMatch(offline, /화면 껍데기|서버 API|service worker/i);
  assert.match(redesignSource, /setText\('pilot-mode-subtitle', ''\)/);
});

test('SPA navigation exposes its landmark and current view to assistive technology', () => {
  assert.match(redesignSource, /<nav class="pilot-sidebar-nav" aria-label="주 메뉴">/);
  assert.doesNotMatch(redesignSource, /<aside class="pilot-sidebar" aria-label="주 메뉴">/);
  assert.match(redesignSource, /data-pilot-view="overview" aria-current="page"/);
  assert.match(redesignSource, /function syncViewNavigation\(view\)/);
  assert.match(redesignSource, /button\.setAttribute\(['"]aria-current['"], ['"]page['"]\)/);
  assert.match(redesignSource, /button\.removeAttribute\(['"]aria-current['"]\)/);
  assert.match(redesignSource, /syncViewNavigation\(nextView\)/);
  assert.match(redesignSource, /syncViewNavigation\(view\)/);
});

test('활성 paper evidence 세션 중 UI도 설정·최적화 mutation을 잠근다', () => {
  assert.match(redesignSource, /function paperEvidenceMutationLock\(\)/);
  assert.match(redesignSource, /isPaperEvidenceMutationLocked/);
  assert.match(redesignSource, /paperEvidenceMutationReason/);
  assert.match(redesignSource, /data-pilot-action="save-settings"/);
  assert.match(redesignSource, /data-pilot-action="run-optimization"/);
  assert.match(redesignSource, /#pilot-auto-optimization/);
  assert.match(redesignSource, /#pilot-optimization-interval/);
  assert.match(redesignSource, /모의투자 실행 중에는 설정을 바꿀 수 없습니다/);
  assert.match(redesignSource, /모의투자 실행 중에는 설정을 바꿀 수 없습니다\. 먼저 모의투자를 중지하세요/);
});

test('paper/live 주문 확인 취소는 서버 호출 없이 사용자에게 명시적으로 표시된다', () => {
  assert.match(
    redesignSource,
    /if \(!window\.confirm\([\s\S]*?\)\) \{\s*showToast\(`\$\{symbolOf\(coin\)\} \$\{actionText\}를 취소했습니다`, ['"]info['"]\);\s*return;\s*\}/
  );
});

test('모의투자 설정 경고는 내부 변경 필드 대신 사용자용 안내를 표시한다', () => {
  assert.match(redesignSource, /설정이 바뀌어 이 모의투자 기록은 현재 설정과 일치하지 않습니다/);
  assert.doesNotMatch(redesignSource, /pilot-momentum-shadow-config-drift/);
  assert.doesNotMatch(redesignSource, /최근 owner 재시작/);
});

test('same-window scalping variant evidence is visible without hiding invalid markets', () => {
  assert.match(redesignSource, /same_window_scalping_variant_comparison/);
  assert.match(redesignSource, /report.reportFreshness/);
  assert.match(redesignSource, /최신 데이터를 다시 모으기 전까지 수익성을 판단하는 데 쓰지 마세요/);
  assert.match(redesignSource, /requestedMarketCount/);
  assert.match(redesignSource, /invalidMarketCount/);
  assert.match(redesignSource, /유효 시장/);
  assert.match(redesignSource, /실거래 적용 불가/);
  assert.match(redesignSource, /같은 기간의 시장 자료로 설정별 결과를 비교합니다\. 유효하지 않은 시장이 있거나 학습 구간 기준을 통과하지 못한 결과는 실제 거래 적용 여부를 판단하는 데 쓸 수 없습니다/);
});

test('paper UI는 in-flight analysis cycle을 정상 수신과 구분해 표시한다', () => {
  assert.match(redesignSource, /analysisHealth\.analysisActive === true/);
  assert.match(redesignSource, /(?:분석 cycle 진행 중|분석 진행 중)/);
  assert.match(indexSource, /analysisDataHealth\.analysisActive/);
});

test('대시보드 세션 카드에는 현재 상태와 청산 횟수만 표시한다', () => {
  const cards = redesignSource.split('function renderGateCards() {')[1]?.split('function renderChartPeriodButtons() {')[0];
  assert.ok(cards);
  assert.match(cards, /paper\.closedTradeCount/);
  assert.doesNotMatch(cards, /paperMinimumTrades|paperMinimumDays|freshnessCohort/);
});

test('mobile redesigned shell은 두 줄 고정 네비게이션 아래에 콘텐츠 여백을 확보한다', () => {
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-app\s*\{[\s\S]*padding-bottom:\s*calc\(148px\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-sidebar-nav\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,\s*1fr\)/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-gate-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-gate-card\s*\{[\s\S]*min-height:\s*98px/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*360px\)[\s\S]*\.pilot-mode-banner\s*\{[\s\S]*display:\s*grid/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*360px\)[\s\S]*\.pilot-pwa-update\s*\{[\s\S]*display:\s*grid/
  );
});

test('mobile fixed navigation stays compact enough to leave the first viewport readable', () => {
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-nav-button\s*\{[\s\S]*min-height:\s*44px[\s\S]*font-size:\s*9px/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-nav-button\s+i\s*\{[\s\S]*font-size:\s*16px/
  );
});

test('모의투자 시작은 paper 경로를 사용하고 server blocker를 숨기거나 완화하지 않는다', () => {
  const startPaper = redesignSource.split('async function startPaper(')[1]?.split('async function stopPaper()')[0];
  assert.ok(startPaper);
  assert.match(startPaper, /if \(isReadOnlyObserver\(\)\)/);
  assert.match(startPaper, /requestJSON\('\/paper-validation\/start'/);
  assert.match(startPaper, /모의투자 시작 실패: \$\{error\.message\}/);
  assert.doesNotMatch(startPaper, /minReboundPercent|minVolumeRatio|자동 완화/);
});

test('smart order UI는 mixed fill 결과를 성공으로 오인하지 않는다', () => {
  assert.match(redesignSource, /result\.success === false \? 'warning' : 'success'/);
  assert.match(redesignSource, /result\.failures/);
  assert.match(tradingRouteSource, /orders\.length === 0 \? 409 : 207/);
});

test('validation UI는 오래된 report를 최신 raw window 근거와 구분한다', () => {
  assert.match(redesignSource, /validationReportFreshness/);
  assert.match(redesignSource, /report\.reportFreshness/);
  assert.match(redesignSource, /최신 데이터를 다시 모으기 전까지/);
  assert.match(indexSource, /최신 raw window 재점검 필요/);
  assert.match(indexSource, /report\.reportFreshness/);
});

test('전략 준비 UI는 간결한 결과와 선택형 판정 상세를 분리하고 주기 갱신 뒤에도 열림을 유지한다', () => {
  const validation = redesignSource.split('function renderValidationDetail() {')[1]?.split('function renderPaperDetail() {')[0];
  const audit = redesignSource.split('function renderGateAuditDetails(readiness) {')[1]?.split('function renderValidationDetail() {')[0];
  const classification = redesignSource.split('function classifyReadiness(readiness) {')[1]?.split('function symbolOf(')[0];
  const gateCards = redesignSource.split('function renderGateCards() {')[1]?.split('function renderChartPeriodButtons()')[0];
  assert.ok(validation && audit && classification);
  assert.ok(gateCards);
  assert.match(validation, /classifyReadiness\(readiness\)/);
  assert.match(validation, /renderGateAuditDetails\(readiness\)/);
  assert.match(validation, /stateLabel/);
  assert.match(validation, /reasons\.map/);
  assert.match(validation, /report\?\.generatedAt/);
  assert.match(validation, /const auditWasOpen = target\.querySelector\('\.pilot-validation-audit'\)\?\.open === true/);
  assert.match(validation, /if \(auditWasOpen\)[\s\S]*?audit\.open = true/);
  assert.doesNotMatch(validation, /filename|\.json|LIVE gate|enforcedFreshness|pilot-validation-evidence|승격|정산|evidence/i);
  assert.match(audit, /report\.filename/);
  assert.match(audit, /report\.generatedAt/);
  assert.match(audit, /freshness\.ageSeconds/);
  assert.match(audit, /gate\.passed/);
  assert.match(audit, /gate\.enforced/);
  assert.match(audit, /gate\.enforcedFreshness/);
  assert.match(audit, /runtime\.dryRun/);
  assert.match(audit, /<details class="pilot-validation-audit">/);
  assert.match(audit, /실제 체결 여부나 지속적인 수익은 확인할 수 없습니다/);
  assert.match(gateCards, /classifyReadiness\(state\.strategyReadiness\)/);
  assert.match(gateCards, /'점검 통과'/);
  assert.match(gateCards, /'주문 조건 미충족'/);
  assert.match(gateCards, /'확인 필요'/);
  assert.match(classification, /readiness\?\.currentEvidence === true/);
  assert.match(classification, /gate\.checked === true/);
  assert.match(classification, /gate\.passed === true/);
  assert.match(classification, /freshness\?\.fresh === true/);
  assert.match(classification, /report_not_current: '점검 결과가 오래됐습니다\.'/);
  assert.match(classification, /runtime_config_mismatch: '현재 설정과 점검 당시 설정이 다릅니다\. 현재 설정으로 다시 점검하세요\.'/);
  assert.match(classification, /slice\(0,\s*2\)/);
  assert.match(redesignSource, /가상 자금으로 거래합니다\./);
});

test('research UI는 higher-timeframe 결과를 strict/live gate와 분리해 표시한다', () => {
  assert.match(redesignSource, /strategyResearch/);
  assert.match(redesignSource, /\/strategy-research/);
  assert.match(redesignSource, /과거 데이터로 설정별 결과를 비교한 자료입니다\. 실제 주문을 내거나 실거래 조건을 바꾸지는 않습니다/);
  assert.match(redesignSource, /과거 데이터로 설정별 결과를 비교한 자료입니다/);
  assert.match(redesignSource, /실제 주문을 내거나 실거래 조건을 바꾸지는 않습니다/);
  assert.match(indexSource, /pilot-redesign-root/);
});

test('모의투자 현황은 연구 원자료를 사용자 화면에 렌더하지 않는다', () => {
  const render = redesignSource.split('function renderMomentumShadow() {')[1]?.split('function renderAll() {')[0];
  assert.ok(render);
  assert.match(render, /pilot-momentum-shadow-card/);
  assert.match(render, /markedEquity/);
  assert.match(render, /markedReturnPercent/);
  assert.match(render, /realizedTradeConfidence/);
  assert.match(render, /promotionBlockers/);
  assert.match(render, /observationDays/);
  assert.match(render, /정리되지 않은 비교용 포지션/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-profitability-gate span\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-execution-note\s*\{/);
  assert.doesNotMatch(render, /SIGTERM|config drift|quoteQuality|paperForwardCohort|profitabilityEvidence|실거래 증거|증거 저장/);
});

test('strategy analysis mounts the existing historical-research and read-only shadow P&L renderers', () => {
  const mount = redesignSource.split('function mountPageEnhancements() {')[1]?.split('renderShell();')[0];
  assert.ok(mount);
  assert.match(mount, /pilot-strategy-research-panel/);
  assert.match(mount, /id="pilot-strategy-research"/);
  assert.match(mount, /id="pilot-strategy-research-meta"/);
  assert.match(mount, /pilot-momentum-shadow-panel/);
  assert.match(mount, /id="pilot-momentum-shadow"/);
  assert.match(mount, /id="pilot-momentum-shadow-meta"/);
  assert.match(mount, /actual fill|실제 fill|실제 체결/);
});

test('shadow P&L UI separates full-cohort quote cost from matched-only cost scenarios', () => {
  const renderer = redesignSource.split('function renderMomentumShadow() {')[1]?.split('function renderAll() {')[0];
  assert.ok(renderer);
  assert.match(renderer, /book\.tradeCostAudit/);
  assert.match(renderer, /book\.entryCostFloor/);
  assert.match(renderer, /entryCostFloor\.runtimeGuardActive/);
  assert.match(renderer, /entryCostFloor\.blockedPendingEntries/);
  assert.match(renderer, /대기 주문 .*건을 막았습니다/);
  assert.match(renderer, /이전 실행 기록 · 비용 하한 미달 · 차단 조건 적용 여부 확인 불가/);
  assert.match(renderer, /보유 중인 자산 감시는 계속합니다/);
  assert.match(renderer, /book\.profitConcentration/);
  assert.match(renderer, /수익 상위 거래 비중/);
  assert.match(renderer, /최대 승리 1건 제외: 95% 신뢰 구간 하한/);
  assert.match(renderer, /결과 확인용이며 실거래 적용 기준은 아님/);
  assert.match(renderer, /book\.observedDrawdown/);
  assert.match(renderer, /observedMddSampleCount/);
  assert.match(renderer, /riskControls\.drawdownPercent/);
  assert.match(renderer, /riskControls\.maxPortfolioDrawdownPercent/);
  assert.match(renderer, /현재 최대 낙폭/);
  assert.match(renderer, /전체 관측 최대 낙폭/);
  assert.match(renderer, /장중 최고점은 포함하지 않음/);
  assert.match(renderer, /book\.executionModel === ['"]candle_close['"]/);
  assert.match(renderer, /expandedCostAuditBooks/);
  assert.match(renderer, /dataset\.shadowAuditBook/);
  assert.match(renderer, /data-shadow-audit-book=/);
  assert.match(renderer, /costAuditOpen/);
  assert.match(renderer, /quoteMatchedTradeCount/);
  assert.match(renderer, /unmatchedSpreadCostTradeCount/);
  assert.match(renderer, /full\.quoteSpreadAdjustedMedianScenarioNetPnlKrw/);
  assert.match(renderer, /full\.costFloorStressNetPnlKrw/);
  assert.match(renderer, /호가 자료가 없는 거래의 비용은 0으로 계산하지 않았습니다/);
  assert.doesNotMatch(renderer, /executeTrade\(|data-pilot-action=/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-cost-audit\s*\{/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-cost-grid\s*\{/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-momentum-shadow-cost-grid/);
});

test('AI 자문 화면은 저장 파일명과 CLI 구현 방식을 설명하지 않는다', () => {
  const shell = redesignSource.split('function aiDeskMarkup() {')[1]?.split('function mountAiDesk() {')[0];
  assert.ok(shell);
  assert.doesNotMatch(shell, /ai_monitoring_sessions\.json|Codex CLI|Claude CLI|API key 미사용|snapshot을 보냅니다|provider 상태/);
  assert.match(shell, /AI 의견은 참고용이며 자동매매 주문을 실행하지 않습니다/);
  assert.doesNotMatch(shell, /pilot-ai-policy-badge|주문 실행 없음/);
});

test('가상 계좌 초기화 확인은 금액과 삭제 범위를 자연스럽게 설명한다', () => {
  const resetWallet = redesignSource.split('async function resetWallet() {')[1]?.split('async function startPaper(')[0];
  const startPaper = redesignSource.split('async function startPaper(')[1]?.split('async function stopPaper()')[0];
  assert.ok(resetWallet && startPaper);
  assert.match(resetWallet, /모의 계좌를 얼마로 다시 시작할까요/);
  assert.match(resetWallet, /모의 계좌를 \$\{formatWon\(seed\)\}으로 다시 시작할까요\?\\n/);
  assert.match(startPaper, /저장된 초기 금액/);
  assert.match(startPaper, /\$\{startingAmount\}으로 새 모의투자를 시작할까요\?\\n/);
  assert.match(resetWallet + startPaper, /보유 코인과 전략별 포지션·매매 기록은 사라집니다/);
});

test('준비 현황은 실전 상태와 별도로 read-only quote-cost evidence를 표시한다', () => {
  const history = redesignSource.split('data-pilot-page="history"')[1]?.split('function mountPageEnhancements()')[0];
  const paper = redesignSource.split('function renderPaperDetail() {')[1]?.split('function renderSettings() {')[0];
  assert.ok(history && paper);
  assert.match(history, /pilot-validation-detail/);
  assert.match(history, /pilot-paper-detail/);
  assert.match(history, /pilot-quote-cost-detail/);
  assert.doesNotMatch(history, /pilot-strategy-research-panel|pilot-momentum-shadow-panel|pilot-optimization-history|pilot-backtest-results/);
  assert.match(paper, /riskMonitor\?\.failClosed/);
  assert.match(paper, /평가 수익률/);
  assert.match(paper, /평가 자산·수익률에는 미청산 포지션 평가손익이 포함됩니다/);
  assert.match(paper, /openPositionMarkNote/);
  assert.match(paper, /openCount > 0/);
  assert.match(paper, /strictEvaluation\?\.signalWindowCoverage/);
  assert.match(paper, /고유 신호 시점/);
  assert.match(paper, /같은 시점 추가/);
  assert.ok(redesignStyleSource.includes('.pilot-paper-mark-note {'));
  assert.match(paper, /riskMonitor\.watchdogTelemetryVersion/);
  assert.match(paper, /위험 점검 사이 최대 간격/);
  assert.match(paper, /signalAvailability\?\.signalFunnel/);
  assert.match(paper, /signalTelemetry\?\.available === true/);
  assert.match(paper, /완료된 캔들 기준 집계 · 참고용/);
  assert.match(paper, /\['확정', signalFunnel\.confirmedWindows\]/);
  assert.match(paper, /이 수치에 따라 조건을 자동으로 낮추지 않습니다/);
  assert.ok(redesignStyleSource.includes('.pilot-paper-signal-funnel-steps {'));
  assert.ok(redesignStyleSource.includes('grid-template-columns: repeat(5, minmax(0, 1fr));'));
  assert.ok(redesignStyleSource.includes('.pilot-paper-signal-step {'));
  assert.ok(redesignStyleSource.includes('min-width: 0;'));
  assert.match(paper, /analysisDataHealth\?\.failClosed/);
  assert.match(paper, /초기화하면 가상 잔액과 보유 코인, 전략별 포지션·매매 기록이 삭제됩니다/);
  assert.doesNotMatch(paper, /MFE|MAE|counterfactual|signal evidence|wallet settlement/);
});

test('paper 세션 미지원·오류 상태는 빈 세션으로 취급하지 않고 초기화 버튼도 숨긴다', () => {
  assert.equal(typeof classifyPaperStatus, 'function');
  assert.deepEqual(classifyPaperStatus({ available: false, reason: 'paper_validation_session_not_started' }), {
    notStarted: true,
    knownStatus: true
  });
  for (const status of [
    null,
    { available: false, reason: 'unsupported' },
    { available: false, error: 'paper status unavailable' },
    { available: false }
  ]) {
    assert.deepEqual(classifyPaperStatus(status), { notStarted: false, knownStatus: false });
  }
  assert.deepEqual(classifyPaperStatus({ available: true, active: false }), {
    notStarted: false,
    knownStatus: true
  });

  const paperRenderer = redesignSource.split('function renderPaperDetail() {')[1]?.split('function renderSettings() {')[0];
  assert.ok(paperRenderer);
  const unknownBranch = paperRenderer.split('if (!knownStatus) {')[1]?.split('const stateLabel')[0];
  assert.ok(unknownBranch);
  assert.doesNotMatch(unknownBranch, /data-pilot-action="start-paper-reset"/);
});

test('전략 점검 상세는 신선도와 gate 적용 여부를 별도로 표시한다', () => {
  const validation = redesignSource.split('function renderValidationDetail() {')[1]?.split('function renderPaperDetail() {')[0];
  const audit = redesignSource.split('function renderGateAuditDetails(readiness) {')[1]?.split('function renderValidationDetail() {')[0];
  assert.ok(validation && audit);
  assert.match(validation, /classifyReadiness\(readiness\)/);
  assert.match(validation, /마지막 점검/);
  assert.match(validation, /renderGateAuditDetails\(readiness\)/);
  assert.match(audit, /<dt>작성 시점<\/dt>/);
  assert.match(audit, /실제 주문 조건 확인/);
  assert.match(audit, /작성 시점 반영 여부/);
  assert.match(audit, /현재 거래 모드/);
  assert.match(redesignStyleSource, /\.pilot-validation-audit-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('quote cost research UI separates fresh quote samples, modeled cost, and insufficient depth history', () => {
  const renderer = redesignSource.split('function renderQuoteExecutionEvidence() {')[1]?.split('function renderStrategyResearch() {')[0];
  assert.ok(renderer);
  assert.match(renderer, /state\.momentumShadow\?\.quoteQualitySnapshot/);
  assert.match(renderer, /snapshot\.complete === true/);
  assert.match(renderer, /snapshot\.fresh === true/);
  assert.match(renderer, /costCompatibility/);
  assert.match(renderer, /allObservedMarketCostCompatibility/);
  assert.match(renderer, /cadence\.expectedIntervalSeconds/);
  assert.match(renderer, /cadence\.freshnessLimitSeconds/);
  assert.match(renderer, /cadence\.gapsOverFreshnessLimit/);
  assert.match(renderer, /assumedRoundTripCostPercent/);
  assert.match(renderer, /row\?\.topOfBookDepth/);
  assert.match(renderer, /minimumBidNotionalKrw/);
  assert.match(renderer, /매수 잔량 하위 5% 기준/);
  assert.match(renderer, /양쪽 호가 잔량/);
  assert.match(renderer, /확인 필요/);
  assert.match(renderer, /호가 차이와 1단계 잔량만으로 실제 체결이나 실현 손익을 알 수 없습니다/);
  assert.match(renderer, /expandedBeforeRefresh/);
  assert.match(renderer, /disclosure\.open = true/);
  assert.doesNotMatch(renderer, /data-pilot-action=|executeTrade\(/);
  assert.match(redesignSource, /id="pilot-quote-cost-detail"/);
  assert.match(redesignSource, /호가와 거래 비용/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-overview/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-market-grid/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-quote-cost-market-grid/);
});

test('quote-cost panel shows the separate paper candidate preflight and its modeled round-trip cost', () => {
  const renderer = redesignSource.split('function renderQuoteExecutionEvidence() {')[1]?.split('function renderStrategyResearch() {')[0];
  assert.ok(renderer);
  assert.match(renderer, /state\.momentumShadow\?\.candidateReadiness/);
  assert.match(renderer, /candidateReadiness\?\.executionCost/);
  assert.match(renderer, /candidate_cost_below_round_trip_cost_floor/);
  assert.match(renderer, /executionCost\.candidateRoundTripCostPercent/);
  assert.match(renderer, /executionCost\.requiredRoundTripCostPercent/);
  assert.match(renderer, /모의투자 후보 시작 전 점검/);
  assert.match(renderer, /왕복 비용 가정/);
  assert.match(renderer, /왕복 거래 비용 가정이 최소 기준에 못 미칩니다/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-preflight\.is-blocked/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-quote-cost-preflight/);
});

test('quote-cost panel exposes all candidate preflight variants in a mobile-safe disclosure', () => {
  const renderer = redesignSource.split('function renderQuoteExecutionEvidence() {')[1]?.split('function renderStrategyResearch() {')[0];
  assert.ok(renderer);
  assert.match(renderer, /expandedCandidatesBeforeRefresh/);
  assert.match(renderer, /candidateReadinessVariants/);
  assert.match(renderer, /readinessVariants\.map/);
  assert.match(renderer, /모의투자 후보별 시작 전 점검/);
  assert.match(renderer, /costValue/);
  assert.match(renderer, /launchAllowed/);
  assert.match(renderer, /실제 주문이나 체결, 수익을 뜻하거나 실제 거래 적용을 승인하는 것은 아닙니다/);
  assert.match(renderer, /pilot-quote-cost-candidates/);
  assert.match(redesignStyleSource, /\.pilot-quote-cost-candidate-grid/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*480px\)[\s\S]*\.pilot-quote-cost-candidate-grid/);
});
