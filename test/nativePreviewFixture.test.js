import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const fixture = JSON.parse(fs.readFileSync(
  new URL('../mobile/ios/App/App/CoinPilotBundledPreview.json', import.meta.url),
  'utf8'
));

test('native preview holdings agree with their average cost, value, and unrealized profit', () => {
  const { account } = fixture;
  assert.equal(fixture.status.strategyMode, 'preview');
  assert.equal(account.valuationAvailable, true);
  let holdingsValue = 0;
  let unrealizedProfit = 0;

  for (const position of account.positions) {
    const averagePrice = position.avgPrice ?? position.entryPrice;
    const costBasis = Math.round(position.amount * averagePrice);
    const currentValue = Math.round(position.amount * position.currentPrice);
    const profit = currentValue - costBasis;
    assert.equal(position.costBasis, costBasis, `${position.coin}: average cost × quantity must equal cost basis`);
    assert.equal(position.currentValue, currentValue, `${position.coin}: current price × quantity must equal valuation`);
    assert.equal(position.profit, profit, `${position.coin}: valuation − cost basis must equal profit`);
    assert.equal(Number(position.profitPercent), Number(((profit / costBasis) * 100).toFixed(2)),
      `${position.coin}: percentage must use the same average cost as the visible holding`);
    holdingsValue += currentValue;
    unrealizedProfit += profit;
  }

  assert.equal(account.totalAssets, account.krwBalance + holdingsValue);
  assert.equal(account.profit, account.totalAssets - account.initialSeedMoney);
  assert.equal(account.profit, account.realizedProfit + unrealizedProfit);
});

test('native preview open trades use the matching holding entry price', () => {
  for (const trade of fixture.trades.filter(row => row.type === 'OPEN')) {
    const position = fixture.account.positions.find(row => row.coin === trade.coin);
    assert.ok(position, `${trade.coin}: the example open trade must have a holding`);
    assert.equal(trade.entryPrice, position.entryPrice,
      `${trade.coin}: this single-entry example must show the same purchase price in history and assets`);
  }
});
