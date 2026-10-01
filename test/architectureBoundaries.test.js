import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 아키텍처 경계 가드 — 추출된 구조가 다시 팽창/역전되지 않도록 고정한다.
 *
 * 1. 크기 예산: god-object가 된 파일은 line cap 아래에 머물러야 한다.
 *    새 책임을 추가하려면 적절한 모듈로 가거나 cap 근거를 업데이트한다.
 * 2. owner-표면 규칙: MultiCoinTrader에서 추출된 모듈은 동일 표면의
 *    cross-method 호출을 `this.owner.X()`로 해야 한다 — 인스턴스 수준
 *    stub(테스트·운영 훅)이 계속 작동하도록.
 * 3. 위임 존재: 추출된 모듈이 트레이더에서 위임/지연 팩토리를 받는다.
 */

const TRADER_FILE = 'src/trader/multiCoinTrader.js';
const JOURNAL_FILE = 'src/trader/paperValidationJournal.js';
const ORCHESTRATOR_BUDGETS = {
  'src/trader/multiCoinTrader.js': 1100,
  'src/api/dashboardServer.js': 850,
  'src/index.js': 400,
  'src/api/routes/trading.js': 300,
  // 추출이 끝난 orchestrator/facade — 다시 팽창하면 실패한다.
  'src/trader/paperValidationJournal.js': 500,
  'src/api/manualOrderService.js': 80,
  'src/api/upbit.js': 620,
  'src/api/upbitRateCoordinator.js': 700,
  'src/ai/monitoringSessionService.js': 750,
  'src/api/routes/research.js': 300,
  'src/backtest/scalpingBacktest.js': 1150
};

test('god-object로 분해된 파일은 크기 예산을 유지한다', () => {
  for (const [file, budget] of Object.entries(ORCHESTRATOR_BUDGETS)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;
    assert.ok(
      lines <= budget,
      `${file} is ${lines} lines, over budget ${budget} — extract a cohesive cluster or document why the cap moved`
    );
  }
});

// MultiCoinTrader에서 추출된 모듈 — cross-method 호출은 owner 경유여야 한다.
const OWNER_DELEGATED_MODULES = [
  'src/trader/paperValidationJournal.js',
  'src/trader/virtualPortfolioStore.js',
  'src/trader/positionRiskMonitor.js',
  'src/trader/liveOrderGateway.js',
  'src/trader/tradingLifecycle.js',
  'src/trader/orderExecutionEngine.js',
  'src/trader/tradingCycleRunner.js',
  'src/trader/positionRebalancer.js',
  'src/trader/portfolioValuation.js'
];

function declaredMethods(source) {
  return new Set(
    [...source.matchAll(/^ {2}(?:async )?([a-zA-Z_]\w*)\s*\(/gm)].map(m => m[1])
  );
}

test('추출된 트레이더 모듈은 cross-method 호출을 owner 표면으로 한다', () => {
  const traderSource = fs.readFileSync(TRADER_FILE, 'utf8');
  const traderMethods = declaredMethods(traderSource);
  for (const file of OWNER_DELEGATED_MODULES) {
    const source = fs.readFileSync(file, 'utf8');
    const ownMethods = declaredMethods(source);
    // `this.X(` 호출에서 X가 모듈에 선언되지 않았는데 트레이더 메서드명과
    // 충돌하면 — stub 우회 위험 — owner 경유로 명시돼야 한다.
    const bypasses = [
      ...source.matchAll(/\bthis\.([a-zA-Z_]\w*)\s*\(/g)
    ]
      .map(m => m[1])
      .filter(name => !ownMethods.has(name) && traderMethods.has(name));
    assert.deepEqual(
      [...new Set(bypasses)],
      [],
      `${file}: 호출 ${bypasses.join(', ')}은 this.owner.를 거쳐야 한다`
    );
  }
});

// 저널 서브모듈 — 저널 표면 메서드 호출은 this.journal을 거쳐야 한다.
const JOURNAL_DELEGATED_MODULES = [
  'src/trader/paperValidationStatus.js',
  'src/trader/paperValidationBlockedEntries.js',
  'src/trader/paperValidationTelemetry.js',
  'src/trader/paperValidationRiskGate.js',
  'src/trader/paperValidationShadowBook.js',
  'src/trader/paperValidationSession.js',
  'src/trader/paperValidationSnapshots.js'
];

test('저널 서브모듈은 저널 메서드 호출을 journal 표면으로 한다', () => {
  const journalSource = fs.readFileSync(JOURNAL_FILE, 'utf8');
  const journalMethods = declaredMethods(journalSource);
  for (const file of JOURNAL_DELEGATED_MODULES) {
    const source = fs.readFileSync(file, 'utf8');
    const ownMethods = declaredMethods(source);
    const bypasses = [...source.matchAll(/\bthis\.([a-zA-Z_]\w*)\s*\(/g)]
      .map(m => m[1])
      .filter(name => !ownMethods.has(name) && name !== 'journal' && journalMethods.has(name));
    assert.deepEqual(
      [...new Set(bypasses)],
      [],
      `${file}: 호출 ${bypasses.join(', ')}은 this.journal.를 거쳐야 한다`
    );
    assert.match(source, /constructor\(journal\)/, `${file} must take journal`);
  }
});

test('paperValidationJournal은 서브모듈의 지연 팩토리를 제공한다', () => {
  const source = fs.readFileSync(JOURNAL_FILE, 'utf8');
  const expectedFactories = [
    '_pvStatus', '_pvBlocked', '_pvTelemetry', '_pvRisk',
    '_pvShadow', '_pvSession', '_pvSnapshots'
  ];
  for (const factory of expectedFactories) {
    assert.match(
      source,
      new RegExp(`${factory}\\(\\)\\s*\\{`),
      `missing lazy factory ${factory}() on PaperValidationJournal`
    );
  }
});

// 수동 주문 서비스 — use-case 모듈은 팩토리 패턴을 유지하고 서비스가 얇게 남는다.
const MANUAL_ORDER_USE_CASES = [
  'src/api/manualOrderTrade.js',
  'src/api/manualOrderBuy.js',
  'src/api/manualOrderSell.js',
  'src/api/manualOrderQuick.js',
  'src/api/manualOrderSmartBuy.js',
  'src/api/manualOrderSmartSell.js',
  'src/api/manualOrderBundle.js'
];

test('수동 주문 use-case는 ctx 주입 팩토리와 LIVE evidence 경계를 유지한다', () => {
  for (const file of MANUAL_ORDER_USE_CASES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(
      source,
      /export function create[A-Z]\w*UseCase\(ctx\)/,
      `${file} must expose a create<Name>UseCase(ctx) factory`
    );
    // 라우트/헬퍼에서 거래소 클라이언트를 직접 호출하면 경계가 역전된 것.
    assert.doesNotMatch(
      source,
      /tradingSystem\.upbit\.order\s*\(/,
      `${file} must not call the exchange client directly — use runLiveLeg/executeLiveOrderWithEvidence`
    );
  }
  const serviceSource = fs.readFileSync('src/api/manualOrderService.js', 'utf8');
  assert.match(serviceSource, /createManualOrderContext/);
});

// LIVE leg 실행은 완전 관측 체결만 성공으로 인정한다 — 부분 체결이 포지션을 오염시키지 않도록.
test('수동 주문 LIVE leg은 완전 관측 체결만 성공으로 받는다', () => {
  const ctxSource = fs.readFileSync('src/api/manualOrderContext.js', 'utf8');
  assert.match(ctxSource, /executeLiveOrderWithEvidence/);
  assert.match(ctxSource, /hasCompleteObservedLiveFill/);
  assert.match(ctxSource, /liveFillFailureResult/);
});

test('MultiCoinTrader는 추출된 모듈의 위임과 지연 팩토리를 제공한다', () => {
  const source = fs.readFileSync(TRADER_FILE, 'utf8');
  const expectedFactories = [
    '_paperJournal', '_portfolioStore', '_riskMonitor', '_liveGateway',
    '_lifecycle', '_orderEngine', '_cycleRunner', '_rebalancer', '_valuation'
  ];
  for (const factory of expectedFactories) {
    assert.match(
      source,
      new RegExp(`${factory}\\(\\)\\s*\\{`),
      `missing lazy factory ${factory}() on MultiCoinTrader`
    );
  }
  // 지연 팩토리가 생성자 우회(Object.create) 테스트를 지원한다
  for (const module of OWNER_DELEGATED_MODULES) {
    const moduleSource = fs.readFileSync(module, 'utf8');
    assert.match(moduleSource, /constructor\(owner\)/, `${module} must take owner`);
  }
});
