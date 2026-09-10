import test from 'node:test';
import assert from 'node:assert/strict';
import OversoldReactionStrategy from '../src/strategy/oversoldReactionStrategy.js';

function analysis(overrides = {}) {
  return {
    indicators: {
      rebound: {
        available: true,
        oversold: false,
        previousWasOversold: true,
        currentWasOversold: false,
        reboundConfirmed: true,
        bullishCandle: true,
        priceChangePercent: 0.25,
        rsi: 32,
        previousRsi: 27,
        rsiRecovery: 5,
        currentClose: 100.25,
        previousClose: 100,
        referencePrice: 100.25,
        signalKey: '2026-09-09T00:01:00'
      }
    },
    ...overrides
  };
}

test('과매도 반등 조건을 충족한 첫 신호만 BUY가 된다', () => {
  const strategy = new OversoldReactionStrategy({
    entryDelayMinMs: 1000,
    entryDelayMaxMs: 5000,
    random: () => 0.5
  });

  const decision = strategy.makeDecision(analysis(), { score: 0 }, 100.25);
  assert.equal(decision.action, 'BUY');
  assert.equal(decision.entryDelayMs, 3000);
  assert.equal(decision.entrySignalKey, '2026-09-09T00:01:00');

  const duplicate = strategy.makeDecision(analysis(), { score: 0 }, 100.25);
  assert.equal(duplicate.action, 'HOLD');
  assert.match(duplicate.reason, /이미 처리됨/);
});

test('momentum_breakout 프로파일은 과매도 없이 추세·고가 돌파 BUY를 만들 수 있다', () => {
  const strategy = new OversoldReactionStrategy({ random: () => 0 });
  const breakout = analysis({
    indicators: {
      rebound: {
        available: true,
        signalProfile: 'momentum_breakout',
        oversold: false,
        previousWasOversold: false,
        currentWasOversold: false,
        reboundConfirmed: true,
        bullishCandle: true,
        priceChangePercent: 0.4,
        reboundPriceChangePercent: 0.4,
        rsi: 55,
        previousRsi: 54,
        rsiRecovery: 1,
        currentClose: 100.4,
        previousClose: 100,
        previousHigh: 100.2,
        previousHighBreak: true,
        referencePrice: 100.4,
        signalKey: '2026-09-09T00:03:00'
      }
    }
  });

  const decision = strategy.makeDecision(breakout, { score: 0 }, 100.4);
  assert.equal(decision.action, 'BUY');
  assert.match(decision.reason, /추세 돌파/);
});

test('반등이 확인되지 않으면 BUY하지 않는다', () => {
  const strategy = new OversoldReactionStrategy();
  const pending = analysis();
  pending.indicators.rebound.reboundConfirmed = false;
  pending.indicators.rebound.oversold = true;

  const decision = strategy.makeDecision(pending, { score: 0 }, 99.8);
  assert.equal(decision.action, 'HOLD');
  assert.match(decision.reason, /반등/);
});

test('지연 후 되밀림이 허용 범위를 넘으면 진입을 취소한다', () => {
  const strategy = new OversoldReactionStrategy({ maxEntryRetracePercent: 0.25 });
  const decision = strategy.makeDecision(analysis(), { score: 0 }, 100.25);

  const validation = strategy.validateEntry(
    analysis(),
    99.9,
    decision
  );

  assert.equal(validation.valid, false);
  assert.match(validation.reason, /되밀림/);
});

test('지연 중 가격을 추격하게 되면 진입을 취소한다', () => {
  const strategy = new OversoldReactionStrategy({ maxEntryChasePercent: 0.35 });
  const decision = strategy.makeDecision(analysis(), { score: 0 }, 100.25);

  const validation = strategy.validateEntry(
    analysis(),
    100.7,
    decision
  );

  assert.equal(validation.valid, false);
  assert.match(validation.reason, /추격/);
});

test('신호가 새 완료 캔들로 바뀌면 이전 지연 주문을 취소한다', () => {
  const strategy = new OversoldReactionStrategy();
  const decision = strategy.makeDecision(analysis(), { score: 0 }, 100.25);
  const nextCandle = analysis();
  nextCandle.indicators.rebound.signalKey = '2026-09-09T00:02:00';

  const validation = strategy.validateEntry(nextCandle, 100.3, decision);
  assert.equal(validation.valid, false);
  assert.match(validation.reason, /신호가 변경/);
});

test('손실 청산 뒤에는 즉시 같은 시장에 재진입하지 않는다', () => {
  const strategy = new OversoldReactionStrategy({ cooldownAfterLossMinutes: 15 });
  strategy.openPosition(100, 1, 'BUY');
  strategy.closePosition(98, '손절 테스트');

  const decision = strategy.makeDecision(analysis(), { score: 0 }, 98);
  assert.equal(decision.action, 'HOLD');
  assert.match(decision.reason, /쿨다운/);
});

test('손실 중인 포지션만 loss-only hold timeout으로 먼저 청산한다', () => {
  const strategy = new OversoldReactionStrategy({
    maxLosingHoldMinutes: 5,
    maxHoldMinutes: 30,
    stopLossPercent: 5,
    takeProfitPercent: 10
  });
  strategy.openPosition(100, 1, 'BUY');
  strategy.currentPosition.entryTime = new Date(Date.now() - 6 * 60 * 1000);

  const check = strategy.checkPosition(99.5);
  assert.equal(check.shouldClose, true);
  assert.equal(check.type, 'MAX_LOSING_HOLD_TIME');

  strategy.currentPosition.entryTime = new Date(Date.now() - 6 * 60 * 1000);
  assert.equal(strategy.checkPosition(100.5).shouldClose, false);
});

test('break-even 보호 출구는 이익 도달 뒤 고정 손절보다 높은 출구를 사용한다', () => {
  const strategy = new OversoldReactionStrategy({
    breakEvenTriggerPercent: 0.5,
    breakEvenOffsetPercent: 0.05,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8
  });
  strategy.openPosition(100, 1, 'BUY');

  const armed = strategy.checkPosition(100.6);
  assert.equal(armed.shouldClose, false);
  assert.equal(strategy.currentPosition.breakEvenArmed, true);

  const protectedExit = strategy.checkPosition(100.24);
  assert.equal(protectedExit.shouldClose, true);
  assert.equal(protectedExit.type, 'BREAK_EVEN_STOP');
});

test('trailing 보호 출구는 관찰된 최고가에서 되밀림을 제한한다', () => {
  const strategy = new OversoldReactionStrategy({
    trailingActivationPercent: 0.5,
    trailingStopPercent: 0.4,
    stopLossPercent: 1.2,
    takeProfitPercent: 3
  });
  strategy.openPosition(100, 1, 'BUY');

  assert.equal(strategy.checkPosition(101).shouldClose, false);
  assert.equal(strategy.currentPosition.trailingArmed, true);
  const protectedExit = strategy.checkPosition(100.5);
  assert.equal(protectedExit.shouldClose, true);
  assert.equal(protectedExit.type, 'TRAILING_STOP');
});
