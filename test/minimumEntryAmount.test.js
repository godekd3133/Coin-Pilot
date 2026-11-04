import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioValuation } from '../src/trader/portfolioValuation.js';

test('코인 최소 진입 금액은 손절 후에도 최소 매도금액을 지킬 수 있게 여유를 둔다', () => {
  const valuation = new PortfolioValuation({ MIN_ORDER_AMOUNT: 5000, config: { stopLossPercent: 1.2 } });
  const minimum = valuation.getMinimumEntryAmount();
  assert.equal(minimum, 5200);
  assert.ok(minimum * (1 - 0.012) * (1 - 0.0005) > 5000);
});
