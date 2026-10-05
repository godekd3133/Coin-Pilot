import { quoteOfSystem } from '../exchange/marketCodes.js';

// 수동 주문 leg 프리미티브 — manualOrderService.js에서 추출.
// DRY 포트폴리오·전략 반영, LIVE 실패 결과, 잔고 조회. 상태 없음.
export const MANUAL_ORDER_FEE_RATE = 0.0005;
export const DUST_AMOUNT_THRESHOLD = 0.00000001;
const AMOUNT_QUOTE_ASSETS = new Set(['KRW', 'USDT', 'USDC', 'FDUSD', 'TUSD']);

export function quoteAmountMutationBlock(system) {
  const quoteCurrency = quoteOfSystem(system);
  if (AMOUNT_QUOTE_ASSETS.has(quoteCurrency)) return null;
  return {
    status: 400,
    body: {
      success: false,
      code: 'UNSUPPORTED_AMOUNT_CURRENCY',
      quoteCurrency,
      error: `${quoteCurrency} 기준 통화에서는 금액을 입력하는 주문과 모의 잔액 변경을 지원하지 않습니다. 조회 기능을 이용해 주세요.`
    }
  };
}

export function quoteAmountLimits(system) {
  return quoteOfSystem(system) === 'KRW'
    ? {
      minimumBuy: 5_000, minimumSmartSell: 1_000, minimumWallet: 1_000,
      minimumSeed: 100_000, maximumDeposit: 100_000_000,
      defaultBuy: 50_000, defaultSeed: 10_000_000
    }
    : {
      minimumBuy: 5, minimumSmartSell: 5, minimumWallet: 1,
      minimumSeed: 100, maximumDeposit: 100_000_000,
      defaultBuy: 50, defaultSeed: 10_000
    };
}

// Exchange filters remain authoritative for LIVE orders. These helpers keep
// dashboard amounts in the configured quote without truncating non-KRW funds.
export function floorQuoteAmount(system, amount) {
  return quoteOfSystem(system) === 'KRW' ? Math.floor(amount) : amount;
}

export function roundQuoteAmount(system, amount) {
  return quoteOfSystem(system) === 'KRW' ? Math.round(amount) : amount;
}

export function parseQuoteAmount(system, value) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  return floorQuoteAmount(system, Number(value));
}

export function formatQuoteAmount(system, amount) {
  const quote = quoteOfSystem(system);
  const value = Number(amount).toLocaleString('ko-KR', { maximumFractionDigits: quote === 'KRW' ? 0 : 8 });
  return quote === 'KRW' ? `${value}원` : `${value} ${quote}`;
}


export function getStrategyFor(tradingSystem, coin) {
  return tradingSystem.strategies?.get(coin) || tradingSystem.getStrategy?.(coin) || null;
}

// 추가 매수 시 평균단가 업데이트, 신규면 포지션 오픈 (통계 집계용)
export function reflectStrategyBuyFill(strategy, price, volume) {
  if (!strategy) return;
  if (!strategy.currentPosition) {
    strategy.openPosition(price, volume, 'BUY');
    return;
  }
  const existingPos = strategy.currentPosition;
  const totalAmount = existingPos.amount + volume;
  const newAvgPrice = ((existingPos.amount * existingPos.entryPrice) + (volume * price)) / totalAmount;
  strategy.currentPosition.amount = totalAmount;
  strategy.currentPosition.entryPrice = newAvgPrice;
}

// 실제 체결 수량만큼만 반영한다. isFullSell 판정 기준(보유량/전략 포지션)은
// 호출자의 기존 계약을 따르므로 플래그를 넘긴다.
export function reflectStrategySellFill(strategy, price, volume, reason, isFullSell) {
  if (!strategy?.currentPosition) return;
  if (isFullSell) strategy.closePosition(price, reason);
  else strategy.recordPartialSell(price, volume, reason);
}

// DRY_RUN 포트폴리오 + 전략 포지션에 매수 체결을 반영한다.
// 반드시 trader의 mutation-and-persist seam을 통과한다.
// reflectStrategy=false이면 전략 포지션은 호출자가 자체 계약으로 반영한다.
export function applyDryBuy(tradingSystem, { coin, amount, price, reflectStrategy = true }) {
  const fee = amount * MANUAL_ORDER_FEE_RATE;
  const actualInvestment = amount - fee;
  const volume = actualInvestment / price;
  const portfolio = tradingSystem.virtualPortfolio;
  if (!portfolio) return { applied: false, fee, actualInvestment, volume };
  const currentBalance = portfolio.krwBalance || 0;
  if (currentBalance < amount) {
    return {
      applied: false,
      insufficientBalance: true,
      availableBalance: currentBalance,
      fee,
      actualInvestment,
      volume
    };
  }
  tradingSystem.mutateAndPersistVirtualPortfolio(() => {
    portfolio.krwBalance = Math.max(0, currentBalance - amount);
    const existing = portfolio.holdings.get(coin) || { amount: 0, avgPrice: 0, entryTime: null };
    const newAmount = existing.amount + volume;
    const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * price)) / newAmount;
    portfolio.holdings.set(coin, {
      amount: newAmount,
      avgPrice: newAvgPrice,
      entryTime: existing.entryTime || new Date().toISOString()
    });
    if (reflectStrategy) {
      reflectStrategyBuyFill(getStrategyFor(tradingSystem, coin), price, volume);
    }
  });
  return { applied: true, fee, actualInvestment, volume };
}

// DRY_RUN 포트폴리오 + 전략 포지션에 매도 체결을 반영한다.
// 부분/전량 판정은 holding 잔량 기준이며, 전략 포지션 반영도 같은 기준을 따른다.
// reflectStrategy=false이면 전략 포지션은 호출자가 자체 계약으로 반영한다.
export function applyDrySell(tradingSystem, { coin, volume, price, reason, reflectStrategy = true }) {
  const portfolio = tradingSystem.virtualPortfolio;
  const grossSellAmount = volume * price;
  const fee = grossSellAmount * MANUAL_ORDER_FEE_RATE;
  const netSellAmount = grossSellAmount - fee;
  if (!portfolio) return { applied: false, fee, grossSellAmount, netSellAmount };
  let isFullSell = false;
  tradingSystem.mutateAndPersistVirtualPortfolio(() => {
    portfolio.krwBalance = (portfolio.krwBalance || 0) + netSellAmount;
    const currentHolding = portfolio.holdings.get(coin);
    const remaining = Number(currentHolding?.amount ?? 0) - volume;
    isFullSell = remaining <= DUST_AMOUNT_THRESHOLD;
    if (currentHolding) {
      if (isFullSell) {
        portfolio.holdings.delete(coin);
      } else {
        portfolio.holdings.set(coin, { ...currentHolding, amount: remaining });
      }
    }
    if (reflectStrategy) {
      reflectStrategySellFill(getStrategyFor(tradingSystem, coin), price, volume, reason, isFullSell);
    }
  });
  return { applied: true, fee, grossSellAmount, netSellAmount, isFullSell };
}

// LIVE 주문의 공통 실패 응답. blocked(evidence/게이트)는 503, 미체결은 409.
export function liveFillFailureResult(liveExecution, { message, extra = {} } = {}) {
  return {
    status: liveExecution.blocked ? 503 : 409,
    body: {
      success: false,
      mode: 'LIVE',
      message: liveExecution.blocked
        ? liveExecution.blockedMessage || '실제 주문을 차단했습니다. 체결 evidence 저장 상태를 확인하세요.'
        : message || '주문이 실제 체결되지 않아 전략 포지션을 반영하지 않았습니다.',
      order: liveExecution.orderResult,
      fill: liveExecution.fill,
      reason: liveExecution.reason || liveExecution.fill?.error || 'fill_not_observed',
      ...extra
    }
  };
}

export async function readLiveHolding(tradingSystem, coin) {
  const accounts = await tradingSystem.getAccountInfo();
  const coinSymbol = coin.split('-')[1];
  const coinAccount = accounts.find(account => account.currency === coinSymbol);
  return coinAccount
    ? { amount: Number(coinAccount.balance), avgPrice: Number(coinAccount.avg_buy_price) || 0 }
    : null;
}

export async function readKrwBalance(tradingSystem) {
  if (tradingSystem.dryRun) {
    return tradingSystem.virtualPortfolio?.krwBalance || 0;
  }
  const accounts = await tradingSystem.getAccountInfo();
  return tradingSystem.getKRWBalance(accounts) || 0;
}
