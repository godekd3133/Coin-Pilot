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
  assert.equal(scriptAsset, '/pilot-redesign.js?v=observer-readonly-87');
  assert.match(indexSource, /<link\s+rel=["']stylesheet["']\s+href=["']\/pilot-redesign\.css\?v=20260918-06["']/);
  assert.match(serviceWorkerSource, /const CACHE_NAME = ['"]coinpilot-shell-v96['"]/);
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
    '/pilot-redesign.js?v=observer-readonly-87'
  ];
  for (const asset of shellAssets) {
    assert.match(
      serviceWorkerSource,
      new RegExp(`['"]${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
      `service worker app shell missing: ${asset}`
    );
  }
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

test('momentum shadow card displays benchmark-relative evidence without implying a fill', () => {
  assert.match(redesignSource, /benchmarkObservation/);
  assert.match(redesignSource, /benchmarkCheckpoints/);
  assert.match(redesignSource, /checkpoint/);
  assert.match(redesignSource, /전략 평가 차이/);
  assert.match(redesignSource, /실제 체결 아님/);
  assert.match(redesignSource, /realizedByMarket/);
  assert.match(redesignSource, /시장별 실현/);
  assert.match(redesignSource, /paperForwardCohort/);
  assert.match(redesignSource, /무결성 통과/);
  assert.match(redesignSource, /active\/ended/);
  assert.match(redesignSource, /과매도 관측 · 반등 조건 미충족/);
});

test('momentum shadow card separates integrity cohort from profitability evidence cohort', () => {
  assert.match(redesignSource, /profitabilityEvidenceProfitAggregation/);
  assert.match(redesignSource, /수익성 표본 미충족/);
  assert.match(redesignSource, /최소 관찰\/거래 조건/);
  assert.match(redesignSource, /혼합 config 합산 금지/);
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

test('paper UI는 server promotion blockers를 동일한 보류 사유로 표시한다', () => {
  assert.match(redesignSource, /promotionBlockers/);
  assert.match(redesignSource, /전환 보류 사유/);
  assert.match(redesignSource, /promotionBlockers\.join/);
});

test('overview paper gate는 최소 거래·관찰 기간 대비 진행률을 표시한다', () => {
  assert.match(redesignSource, /paperMinimumTrades/);
  assert.match(redesignSource, /paperMinimumDays/);
  assert.match(redesignSource, /청산 \$\{paperClosedTrades\}\/\$\{paperMinimumTrades\}회/);
  assert.match(redesignSource, /관찰 \$\{paperObservationDays\}\/\$\{paperMinimumDays\}일/);
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
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-nav-button\s*\{[\s\S]*min-height:\s*43px[\s\S]*font-size:\s*9px/
  );
  assert.match(
    redesignStyleSource,
    /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-nav-button\s+i\s*\{[\s\S]*font-size:\s*16px/
  );
});

test('paper 카드가 strict와 relaxed diagnostic 손익을 분리하고 모바일에서 접힌다', () => {
  assert.match(redesignSource, /shadowEvaluation/);
  assert.match(redesignSource, /looseShadowEvaluation/);
  assert.match(redesignSource, /maxFavorableExcursionPercent/);
  assert.match(redesignSource, /maxAdverseExcursionPercent/);
  assert.match(redesignSource, /pilot-paper-diagnostic-open/);
  assert.match(redesignSource, /미청산 · 실현손익 제외/);
  assert.match(redesignSource, /rejectionOutcomes/);
  assert.match(redesignSource, /pilot-paper-diagnostic-rejection/);
  assert.match(redesignSource, /거래량 확인 실패/);
  assert.match(redesignSource, /(?:진단용 relaxed 장부|참고용 비교 장부)/);
  assert.match(redesignSource, /(?:strict 승격 제외|실제 자산·전환과 무관)/);
  assert.match(redesignSource, /exitEvidence/);
  assert.match(redesignSource, /evidence\.validTradeCount/);
  assert.match(redesignSource, /실제 종료 경로 집계/);
  assert.match(redesignSource, /조기 청산·실제 fill·wallet settlement·수익성은 추정하지 않습니다/);
  assert.match(redesignStyleSource, /\.pilot-paper-diagnostics\s*\{/);
  assert.match(redesignStyleSource, /\.pilot-paper-diagnostic-grid\s*\{/);
  assert.match(redesignStyleSource, /\.pilot-paper-diagnostic-open\s*\{/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*760px\)[\s\S]*\.pilot-paper-diagnostic-grid\s*\{\s*grid-template-columns:\s*1fr/);
});

test('paper UI는 strict-only efficacy 관찰 모드를 명시한다', () => {
  assert.match(redesignSource, /paperExperiments\?\.diagnosticShadows\?\.enabled/);
  assert.match(redesignSource, /diagnosticModeHtml/);
  assert.match(redesignSource, /strict-only 관찰/);
  assert.match(redesignSource, /독립 efficacy cohort/);
});

test('paper UI는 RSI proximity 진단을 수익성 증거와 구분해 표시한다', () => {
  assert.match(redesignSource, /signalAvailability\.rsiProximity/);
  assert.match(redesignSource, /직전 RSI 최저/);
  assert.match(redesignSource, /과매도 기준/);
});

test('paper UI는 signal gate funnel을 고유 window 진단으로 표시한다', () => {
  assert.match(redesignSource, /signalAvailability\.signalFunnel/);
  assert.match(redesignSource, /funnel/);
  assert.match(indexSource, /signalAvailability\.signalFunnel/);
});

test('paper UI는 시장별 최신 signal evidence를 별도 read-only note로 표시한다', () => {
  assert.match(redesignSource, /lastSignalEvidenceByCoin/);
  assert.match(redesignSource, /최신 signal evidence/);
  assert.match(indexSource, /signalAvailability\?\.lastSignalEvidenceByCoin/);
});

test('momentum UI는 DOGE 제외 loss-cap 후보 readiness와 blocker를 표시한다', () => {
  assert.match(redesignSource, /fixed_2d_loss_cap_no_doge/);
  assert.match(redesignSource, /DOGE 제외 손실 상한 후보/);
  assert.match(redesignSource, /fixedHoldLossCapNoDogeReadiness/);
  assert.match(redesignSource, /historical/);
  assert.match(redesignSource, /promotion 아님/);
  assert.match(redesignSource, /rolling/);
  assert.match(redesignSource, /boundary unknown/);
  assert.match(redesignSource, /cost 경계/);
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

test('paper UI는 동일 signal 실행경계 비교와 부호 변경을 실제 체결과 구분해 표시한다', () => {
  assert.match(redesignSource, /executionOutcomeComparison/);
  assert.match(redesignSource, /strictVsShadow/);
  assert.match(redesignSource, /strictPositiveDiagnosticNegativeCount/);
  assert.match(redesignSource, /동일 signal 실행경계 비교/);
  assert.match(redesignSource, /executionRobustnessGate/);
  assert.match(redesignSource, /실행 강건성 gate/);
  assert.match(redesignSource, /실제 fill·partial fill·wallet settlement·전환 근거가 아닙니다/);
});

test('smart order UI는 mixed fill 결과를 성공으로 오인하지 않는다', () => {
  assert.match(redesignSource, /result\.success === false \? 'warning' : 'success'/);
  assert.match(redesignSource, /result\.failures/);
  assert.match(tradingRouteSource, /orders\.length === 0 \? 409 : 207/);
});

test('validation UI는 historical candle continuity 실패를 수익률과 분리해 표시한다', () => {
  assert.match(redesignSource, /(?:캔들 연속성 실패|캔들 공백)/);
  assert.match(redesignSource, /quality\.gapCount/);
  assert.match(indexSource, /(?:캔들 연속성 실패|캔들 공백)/);
  assert.match(indexSource, /quality\.largestGapSeconds/);
});

test('validation UI는 오래된 report를 최신 raw window 근거와 구분한다', () => {
  assert.match(redesignSource, /validationReportFreshness/);
  assert.match(redesignSource, /report\.reportFreshness/);
  assert.match(redesignSource, /최신 raw window 재점검 필요/);
  assert.match(indexSource, /최신 raw window 재점검 필요/);
  assert.match(indexSource, /report\.reportFreshness/);
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
  assert.match(redesignSource, /cycleDiagnostics/);
  assert.match(redesignSource, /cycle 진단/);
  assert.match(redesignSource, /benchmark.gateOpen/);
  assert.match(redesignSource, /heartbeatAgeSeconds/);
  assert.match(redesignSource, /benchmarkTrendMinPercent/);
  assert.match(redesignSource, /observationRestart/);
  assert.match(redesignSource, /안전 재시작/);
  assert.match(redesignSource, /dataQuality/);
  assert.match(redesignSource, /데이터 품질 차단/);
  assert.match(redesignSource, /promotionBlockers/);
  assert.match(redesignSource, /observationDays/);
  assert.match(redesignSource, /minimumResearchDays/);
  assert.match(redesignSource, /realizedReturnPercent/);
  assert.match(redesignSource, /realizedTradeConfidence/);
  assert.match(redesignSource, /거래수익 95% 하한/);
  assert.match(redesignSource, /blockedChecksAttribution/);
  assert.match(redesignSource, /과거 owner 원인 미분류/);
  assert.match(redesignSource, /minimumResearchTrades/);
  assert.match(redesignSource, /수익성 기준/);
  assert.match(redesignStyleSource, /\.pilot-momentum-shadow-profitability-gate\s*\{/);
  assert.match(redesignStyleSource, /@media\s*\(max-width:\s*760px\)/);
  assert.match(redesignSource, /관찰 기간/);
  assert.match(redesignSource, /riskControls/);
  assert.match(redesignSource, /보호중단 발동/);
  assert.match(redesignSource, /candidateReadiness/);
  assert.match(redesignSource, /candidateReadinessVariants/);
  assert.match(redesignSource, /candidate_slot_occupied/);
  assert.match(redesignSource, /candidate_slot_unverifiable/);
  assert.match(redesignSource, /readinessWarningsHtml/);
  assert.match(redesignSource, /exportMomentumShadowEvidence/);
  assert.match(redesignSource, /export-momentum-evidence/);
  assert.match(redesignSource, /sanitizeMomentumShadowEvidenceValue/);
  assert.match(redesignSource, /coinpilot\.momentum-shadow\.evidence\.v1/);
  assert.match(redesignSource, /실제 fill, wallet settlement, live profitability/);
  assert.match(redesignSource, /기준 시장의 시세 수집이 현재 실패 중입니다/);
  assert.match(redesignSource, /기준 시장 상대성과 anchor가 아직 기록되지 않았습니다/);
  assert.match(redesignSource, /기준 시장 owner가 새 상대성과 계측을 아직 로드하지 않았습니다/);
  assert.match(redesignSource, /상대성과 계측 대기 · owner 재시작 필요/);
  assert.match(redesignSource, /변동성 제한 후보/);
  assert.match(redesignSource, /next_open/);
  assert.match(redesignSource, /비용 대응·다음 시가 후보/);
  assert.match(redesignSource, /fixedHoldReadiness/);
  assert.match(redesignSource, /2일 고정 종료 후보/);
  assert.match(redesignSource, /fixedHoldRelativeReadiness/);
  assert.match(redesignSource, /2일·상대추세 후보/);
  assert.match(redesignSource, /relativeTrendMinPercent/);
  assert.match(redesignSource, /relativeTrendBlockedEntries/);
  assert.match(redesignSource, /fixed_2d_spread/);
  assert.match(redesignSource, /fixed_2d_quote_cross/);
  assert.match(redesignSource, /fixed_2d_loss_cap/);
  assert.match(redesignSource, /종가 손실 상한/);
  assert.match(redesignSource, /stopLossPercent/);
  assert.match(redesignSource, /lossCapCounterfactual/);
  assert.match(redesignSource, /종가 손실 상한 가상 비교/);
  assert.match(redesignSource, /호가/);
  assert.match(redesignSource, /호가 경계 모델/);
  assert.match(redesignSource, /best ask 매수 · best bid 매도\/평가/);
  assert.match(redesignSource, /quoteQuality/);
  assert.match(redesignSource, /quoteQualitySnapshot/);
  assert.match(redesignSource, /quoteQualitySnapshot\?\.fresh/);
  assert.match(redesignSource, /costCompatibility/);
  assert.match(redesignSource, /스캘핑 비용 호환성/);
  assert.match(redesignSource, /adverse-slippage 예산/);
  assert.match(redesignSource, /quoteHistory/);
  assert.match(redesignSource, /liveExecutionEvidence/);
  assert.match(redesignSource, /실거래 증거/);
  assert.match(redesignSource, /체결·settlement 비교 준비/);
  assert.match(redesignSource, /실제 fill과 wallet settlement가 별도로 관측될 때만 비교/);
  assert.match(redesignSource, /repeatedOverCeilingMarkets/);
  assert.match(redesignSource, /반복 호가/);
  assert.match(redesignSource, /반복 ceiling 초과/);
  assert.match(redesignSource, /오래됨/);
  assert.match(redesignSource, /blockedMarkets/);
  assert.match(redesignSource, /ceiling 초과/);
  assert.match(redesignSource, /network\.circuitOpen/);
  assert.match(redesignSource, /network\.failureStreak/);
  assert.match(redesignSource, /network\.fetchErrors/);
  assert.match(redesignSource, /lastErrorMarket/);
  assert.match(redesignSource, /missingMarkets/);
  assert.match(redesignSource, /확인 시장/);
  assert.match(redesignSource, /invalidCycles/);
  assert.match(redesignSource, /일봉 품질 이력/);
  assert.match(redesignSource, /시장 검토 차단/);
  assert.match(redesignSource, /quoteExecution/);
  assert.match(redesignSource, /호가 경계 evidence/);
  assert.match(redesignSource, /모델 crossing drag/);
  assert.match(redesignSource, /executionModel/);
  assert.match(redesignSource, /best ask 매수 · best bid 매도\/평가/);
  assert.match(redesignSource, /가격 모델/);
  assert.match(redesignSource, /state\.online/);
  assert.match(redesignSource, /networkGeneration/);
  assert.match(redesignSource, /clearDynamicStateForOffline/);
  assert.match(redesignSource, /window\.addEventListener\(['"]offline['"]/);
  assert.match(redesignSource, /window\.addEventListener\(['"]online['"]/);
  assert.match(redesignSource, /pilot-offline-banner/);
  assert.match(redesignSource, /오프라인 모드/);
  assert.match(redesignSource, /pendingEntryQuoteBlocked/);
  assert.match(redesignSource, /quote 차단/);
  assert.match(redesignSource, /누적 오류/);
  assert.match(redesignSource, /누적 오류 확인/);
  assert.match(redesignSource, /시세 수집/);
  assert.match(redesignSource, /benchmark_data_quality_invalid/);
  assert.match(redesignSource, /일봉 품질/);
  assert.match(redesignSource, /volatilityReadiness\.candidateConfig\?\.costPercent/);
  assert.match(redesignSource, /변동성 목표/);
  assert.match(redesignSource, /다음 일봉 시작가 체결/);
  assert.match(redesignSource, /추격 갭 상한/);
  assert.match(redesignSource, /일봉 신선도/);
  assert.match(redesignSource, /pendingEntryCount/);
  assert.match(redesignSource, /중복 신호 차단/);
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
