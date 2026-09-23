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
const tradingRouteSource = fs.readFileSync(path.join(projectRoot, 'src/api/routes/trading.js'), 'utf8');

test('redesign 외부 번들도 브라우저가 실행할 수 있는 문법이다', () => {
  assert.doesNotThrow(() => new Function(redesignSource));
});

test('redesign은 백그라운드 탭이 다시 보일 때 paper 상태를 즉시 갱신한다', () => {
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"]/);
  assert.match(redesignSource, /if \(!document\.hidden\)\s*loadCore\(\{ quiet: true \}\)/);
});

test('PWA shell은 redesign asset version과 service worker cache version을 함께 갱신한다', () => {
  const scriptAsset = indexSource.match(/<script\s+src=["'](\/pilot-redesign\.js\?v=[^"']+)["']/)?.[1];
  assert.equal(scriptAsset, '/pilot-redesign.js?v=observer-readonly-95');
  assert.match(indexSource, /<link\s+rel=["']stylesheet["']\s+href=["']\/pilot-redesign\.css\?v=20260918-06["']/);
  assert.match(serviceWorkerSource, /const CACHE_NAME = ['"]coinpilot-shell-v104['"]/);
  assert.match(serviceWorkerSource, new RegExp(`['"]${scriptAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(serviceWorkerSource, /['"]\/pilot-redesign\.css\?v=20260918-06['"]/);
  assert.match(serviceWorkerSource, /NETWORK_FIRST_SHELL_PATHS/);
  assert.match(serviceWorkerSource, /fetch\(request\)[\s\S]*ignoreSearch: true/);
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
    '/pilot-redesign.css?v=20260918-06',
    '/pilot-redesign.js?v=observer-readonly-95'
  ];
  for (const asset of shellAssets) {
    assert.match(
      serviceWorkerSource,
      new RegExp(`['"]${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
      `service worker app shell missing: ${asset}`
    );
  }
});

test('offline recovery keeps mutations locked until current mode, account, and selected quote are ready', () => {
  assert.match(redesignSource, /function isCoreTradingSnapshotReady\(/);
  assert.match(redesignSource, /state\.coreReady\s*=\s*isCoreTradingSnapshotReady\(/);
  assert.match(redesignSource, /state\.coreReady !== true/);
  assert.match(redesignSource, /state\.actualMode === ['"]DRY_RUN['"]/);
  assert.match(redesignSource, /refreshAfterCurrent/);
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
  assert.match(redesignSource, /HTTPS가 아니어서/);
  assert.match(redesignSource, /appinstalled/);
  assert.match(redesignSource, /function openInstallGuide\(\)/);
  assert.match(redesignSource, /pilot-install-guide-steps/);
  assert.match(redesignSource, /document\.addEventListener\(['"]visibilitychange['"], refreshInstallState\)/);
  assert.match(redesignSource, /window\.addEventListener\(['"]pageshow['"], refreshInstallState\)/);
  assert.match(redesignSource, /serviceWorkerSupported/);
  assert.match(redesignSource, /serviceWorkerFailed/);
  assert.match(redesignSource, /설치 지원 확인 필요/);
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
  assert.match(redesignSource, /활성 모의투자 검증 세션의 설정 기록을 보호/);
  assert.match(redesignSource, /세션을 중지하기 전까지 설정·프리셋·자동 최적화 변경을 잠급니다/);
});

test('paper/live 주문 확인 취소는 서버 호출 없이 사용자에게 명시적으로 표시된다', () => {
  assert.match(
    redesignSource,
    /if \(!window\.confirm\([\s\S]*?\)\) \{\s*showToast\(`\$\{symbolOf\(coin\)\} \$\{actionText\}를 취소했습니다`, ['"]info['"]\);\s*return;\s*\}/
  );
});

test('모의투자 설정 경고는 내부 변경 필드 대신 사용자용 안내를 표시한다', () => {
  assert.match(redesignSource, /설정이 변경되어 관찰을 다시 확인해야 합니다/);
  assert.doesNotMatch(redesignSource, /pilot-momentum-shadow-config-drift/);
  assert.doesNotMatch(redesignSource, /최근 owner 재시작/);
});

test('same-window scalping variant evidence is visible without hiding invalid markets', () => {
  assert.match(redesignSource, /same_window_scalping_variant_comparison/);
  assert.match(redesignSource, /report.reportFreshness/);
  assert.match(redesignSource, /최신 raw window를 다시 생성/);
  assert.match(redesignSource, /requestedMarketCount/);
  assert.match(redesignSource, /invalidMarketCount/);
  assert.match(redesignSource, /유효 시장/);
  assert.match(redesignSource, /전환 불가/);
  assert.match(redesignSource, /invalid 시장이 하나라도 있거나 training gate가 실패/);
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

test('모의투자 시작 보류 사유는 사용자에게 필요한 조건만 표시한다', () => {
  assert.match(redesignSource, /기준 시장 데이터가 불완전합니다/);
  assert.match(redesignSource, /다른 모의투자 세션이 실행 중입니다/);
  assert.match(redesignSource, /보유 포지션이 있어 새 세션을 시작할 수 없습니다/);
});

test('smart order UI는 mixed fill 결과를 성공으로 오인하지 않는다', () => {
  assert.match(redesignSource, /result\.success === false \? 'warning' : 'success'/);
  assert.match(redesignSource, /result\.failures/);
  assert.match(tradingRouteSource, /orders\.length === 0 \? 409 : 207/);
});

test('validation UI는 오래된 report를 최신 raw window 근거와 구분한다', () => {
  assert.match(redesignSource, /validationReportFreshness/);
  assert.match(redesignSource, /report\.reportFreshness/);
  assert.match(redesignSource, /최신 raw window 재점검 필요/);
  assert.match(indexSource, /최신 raw window 재점검 필요/);
  assert.match(indexSource, /report\.reportFreshness/);
});

test('전략 준비 UI는 현재 서버 판정과 최신 결과가 모두 있어야 통과로 표시한다', () => {
  const validation = redesignSource.split('function renderValidationDetail() {')[1]?.split('function renderPaperDetail() {')[0];
  assert.ok(validation);
  assert.match(validation, /gate.checked === true && gate.passed === true && report\?\.freshness\?\.fresh === true/);
  assert.match(validation, /readiness\?\.currentEvidence === true/);
  assert.match(validation, /gate.checked === true && gate.passed === false/);
  assert.doesNotMatch(validation, /report\?\.filename|runtime gate|blockerDetails/);
});

test('research UI는 higher-timeframe 결과를 strict/live gate와 분리해 표시한다', () => {
  assert.match(redesignSource, /strategyResearch/);
  assert.match(redesignSource, /\/strategy-research/);
  assert.match(redesignSource, /(?:promoted=false|실제 주문으로 이어지지 않으며)/);
  assert.match(redesignSource, /(?:대체 전략 연구|전략 비교·참고용)/);
  assert.match(redesignSource, /(?:연구 전용|참고용)/);
  assert.match(indexSource, /pilot-redesign-root/);
});

test('모의투자 현황은 연구 원자료를 사용자 화면에 렌더하지 않는다', () => {
  const render = redesignSource.split('function renderMomentumShadow() {')[1]?.split('function renderAll() {')[0];
  assert.ok(render);
  assert.match(render, /pilot-momentum-shadow-card/);
  assert.match(render, /markedEquity/);
  assert.match(render, /markedReturnPercent/);
  assert.doesNotMatch(render, /SIGTERM|config drift|quoteQuality|paperForwardCohort|profitabilityEvidence|실거래 증거|증거 저장/);
});

test('AI 자문 화면은 저장 파일명과 CLI 구현 방식을 설명하지 않는다', () => {
  const shell = redesignSource.split('function aiDeskMarkup() {')[1]?.split('function mountAiDesk() {')[0];
  assert.ok(shell);
  assert.doesNotMatch(shell, /ai_monitoring_sessions\.json|Codex CLI|Claude CLI|API key 미사용|snapshot을 보냅니다|provider 상태/);
});

test('준비 현황은 세션 상태와 주문 잠금 사유만 간결하게 표시한다', () => {
  const history = redesignSource.split('data-pilot-page="history"')[1]?.split('function mountPageEnhancements()')[0];
  const paper = redesignSource.split('function renderPaperDetail() {')[1]?.split('function renderSettings() {')[0];
  assert.ok(history && paper);
  assert.match(history, /pilot-validation-detail/);
  assert.match(history, /pilot-paper-detail/);
  assert.doesNotMatch(history, /pilot-strategy-research-panel|pilot-momentum-shadow-panel|pilot-optimization-history|pilot-backtest-results/);
  assert.match(paper, /riskMonitor\?\.failClosed/);
  assert.match(paper, /analysisDataHealth\?\.failClosed/);
  assert.match(paper, /초기화하면 기존 모의 포트폴리오와 포지션이 지워집니다/);
  assert.doesNotMatch(paper, /MFE|MAE|funnel|counterfactual|signal evidence|wallet settlement/);
});

test('전략 점검은 사용자에게 준비 상태만 표시한다', () => {
  const validation = redesignSource.split('function renderValidationDetail() {')[1]?.split('function renderPaperDetail() {')[0];
  assert.ok(validation);
  assert.match(validation, /현재 전략은 실제투자 준비가 되지 않았습니다/);
  assert.match(validation, /실제투자 준비 여부를 확인할 때까지 주문은 잠겨 있습니다/);
  assert.doesNotMatch(validation, /파일명|API 종합 상태|승격 표시|runtime gate/);
});
