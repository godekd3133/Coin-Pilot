import { inspectMarketQuoteFreshness } from './marketQuoteFreshness.js';
import { MARKET_DATA_FRESHNESS } from './marketDataProvider.js';
import { appendSmartTradeHistory } from './smartTradeHistory.js';
import { baseOfMarket, marketsForQuote, quoteOfSystem } from '../exchange/marketCodes.js';
import {
  executeLiveOrderWithEvidence,
  hasCompleteObservedLiveFill
} from './manualOrderExecution.js';

const MANUAL_ORDER_FEE_RATE = 0.0005;
const DUST_AMOUNT_THRESHOLD = 0.00000001;
const MIN_BUY_KRW = 5000;

function getStrategyFor(tradingSystem, coin) {
  return tradingSystem.strategies?.get(coin) || tradingSystem.getStrategy?.(coin) || null;
}

// 추가 매수 시 평균단가 업데이트, 신규면 포지션 오픈 (통계 집계용)
function reflectStrategyBuyFill(strategy, price, volume) {
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
function reflectStrategySellFill(strategy, price, volume, reason, isFullSell) {
  if (!strategy?.currentPosition) return;
  if (isFullSell) strategy.closePosition(price, reason);
  else strategy.recordPartialSell(price, volume, reason);
}

// DRY_RUN 포트폴리오 + 전략 포지션에 매수 체결을 반영한다.
// 반드시 trader의 mutation-and-persist seam을 통과한다.
// reflectStrategy=false이면 전략 포지션은 호출자가 자체 계약으로 반영한다.
function applyDryBuy(tradingSystem, { coin, amount, price, reflectStrategy = true }) {
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
function applyDrySell(tradingSystem, { coin, volume, price, reason, reflectStrategy = true }) {
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
function liveFillFailureResult(liveExecution, { message, extra = {} } = {}) {
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

async function readLiveHolding(tradingSystem, coin) {
  const accounts = await tradingSystem.getAccountInfo();
  const coinSymbol = coin.split('-')[1];
  const coinAccount = accounts.find(account => account.currency === coinSymbol);
  return coinAccount
    ? { amount: Number(coinAccount.balance), avgPrice: Number(coinAccount.avg_buy_price) || 0 }
    : null;
}

async function readKrwBalance(tradingSystem) {
  if (tradingSystem.dryRun) {
    return tradingSystem.virtualPortfolio?.krwBalance || 0;
  }
  const accounts = await tradingSystem.getAccountInfo();
  return tradingSystem.getKRWBalance(accounts) || 0;
}

/**
 * 수동(UI-originated) 주문 use-case 모음. 라우트는 요청 검증과 HTTP 매핑만 담당하고,
 * 시세 신선도 게이트·DRY/LIVE 체결·전략 포지션 반영·응답 shaping은 여기서 처리한다.
 * 각 메서드는 {status, body}를 반환하며 예외는 호출자가 500으로 매핑한다.
 */
export function createManualOrderService({ tradingSystem, marketDataProvider }) {
  const readFreshTickers = markets => marketDataProvider.getTickers(markets, {
    freshness: MARKET_DATA_FRESHNESS.FRESH
  });
  const readFreshMarketTicker = async market => {
    const tickers = await readFreshTickers([market]);
    return tickers.find(ticker => ticker?.market === market) || null;
  };
  const readMinuteCandles = (...args) => marketDataProvider.getMinuteCandles(...args);

  const inspectMarketQuote = (ticker, market, now = Date.now()) => {
    if (ticker?.market !== market) {
      return {
        fresh: false,
        market,
        sourceAsOf: null,
        ageMs: null,
        maximumAgeMs: null,
        reason: 'market_quote_unavailable'
      };
    }
    return inspectMarketQuoteFreshness(ticker, {
      now,
      maximumAgeSeconds: tradingSystem.maxCandleAgeSeconds
    });
  };

  const marketQuoteBlockResult = (marketQuotes, additionalBody = {}) => {
    const issues = marketQuotes.filter(entry => !entry.fresh);
    if (issues.length === 0) return null;
    const stale = issues.some(entry => entry.reason === 'market_source_stale' ||
      entry.reason === 'market_source_timestamp_in_future');
    return {
      status: 409,
      body: {
        success: false,
        code: stale ? 'MARKET_QUOTE_STALE' : 'MARKET_QUOTE_UNAVAILABLE',
        message: stale
          ? '선택한 종목의 최근 체결 시각이 오래되어 주문을 보내지 않았습니다.'
          : '선택한 종목의 시세와 원본 시각을 확인할 수 없어 주문을 보내지 않았습니다.',
        ...additionalBody,
        markets: issues.map(({ market, reason, sourceAsOf, ageMs, maximumAgeMs }) => ({
          market, reason, sourceAsOf, ageMs, maximumAgeMs
        }))
      }
    };
  };

  const requireFreshQuote = async (coin) => {
    const ticker = await readFreshMarketTicker(coin);
    const block = marketQuoteBlockResult([inspectMarketQuote(ticker, coin)]);
    return { ticker, block };
  };

  // LIVE 단일 레그 실행. 완전 체결 관측 시 execution을, 아니면 failure result를 반환.
  const runLiveLeg = async (params, { failureMessage, failureExtra } = {}) => {
    const execution = await executeLiveOrderWithEvidence(tradingSystem, params);
    if (hasCompleteObservedLiveFill(execution)) return { execution, failure: null };
    return {
      execution,
      failure: liveFillFailureResult(execution, { message: failureMessage, extra: failureExtra })
    };
  };

  async function execute({ coin, action, amount, clientIntentId = null }) {
    if (!coin || !action) {
      return { status: 400, body: { error: 'coin과 action은 필수입니다', success: false } };
    }
    if (!['BUY', 'SELL'].includes(action.toUpperCase())) {
      return { status: 400, body: { error: 'action은 BUY 또는 SELL이어야 합니다', success: false } };
    }
    if (!tradingSystem.upbit) {
      return { status: 400, body: { error: '거래 시스템이 초기화되지 않았습니다', success: false } };
    }

    // 전략 가져오기 (없으면 동적 생성하여 통계 추적 보장)
    const strategy = getStrategyFor(tradingSystem, coin);
    const isDryRun = tradingSystem.dryRun;
    const side = action.toUpperCase();

    if (side === 'BUY') {
      const investmentAmount = amount || 50000;
      if (investmentAmount < MIN_BUY_KRW) {
        return { status: 400, body: { error: '최소 투자금액은 5000원입니다', success: false } };
      }
      const { ticker, block } = await requireFreshQuote(coin);
      if (block) return block;
      const currentPrice = ticker.trade_price;

      if (isDryRun) {
        // 모의투자 - 가상 포트폴리오 업데이트 (수수료 0.05%)
        const applied = applyDryBuy(tradingSystem, {
          coin,
          amount: investmentAmount,
          price: currentPrice,
          reflectStrategy: false
        });
        if (applied.insufficientBalance) {
          return {
            status: 400,
            body: {
              error: `잔액 부족 (보유: ${applied.availableBalance.toLocaleString()}원, 요청: ${investmentAmount.toLocaleString()}원)`,
              success: false,
              availableBalance: applied.availableBalance
            }
          };
        }
        // 이 라우트의 기존 계약: 포트폴리오 유무와 무관하게 포지션을 새로 연다.
        if (strategy) strategy.openPosition(currentPrice, applied.volume, 'BUY');
        return {
          status: 200,
          body: {
            success: true,
            message: `[모의투자] ${coin} ${investmentAmount.toLocaleString()}원 매수 완료 (수수료 ${applied.fee.toFixed(0)}원)`,
            order: {
              coin,
              action: 'BUY',
              price: currentPrice,
              volume: applied.volume,
              amount: investmentAmount,
              fee: applied.fee,
              mode: 'DRY_RUN'
            }
          }
        };
      }

      // 실전투자: 접수만으로 포지션을 열지 않고 실제 fill을 확인한다.
      const { execution, failure } = await runLiveLeg({
        market: coin,
        side: 'bid',
        volume: investmentAmount,
        orderType: 'price',
        requested: { amount: investmentAmount },
        referencePrice: currentPrice,
        clientIntentId
      });
      if (failure) return failure;
      const actualPrice = Number(execution.fill.averagePrice);
      const actualVolume = Number(execution.fill.executedVolume);
      if (strategy) strategy.openPosition(actualPrice, actualVolume, 'BUY');
      return {
        status: 200,
        body: {
          success: true,
          mode: 'LIVE',
          message: `${coin} 매수 체결 완료`,
          order: { ...(execution.orderResult || {}), mode: 'LIVE' },
          fill: execution.fill,
          price: actualPrice,
          volume: actualVolume,
          fee: execution.fill.paidFee
        }
      };
    }

    // SELL
    const accounts = await tradingSystem.getAccountInfo();
    const coinSymbol = coin.split('-')[1];
    const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
    const coinBalance = coinAccount ? parseFloat(coinAccount.balance) : 0;
    const sellVolume = strategy?.currentPosition?.amount || coinBalance;
    if (sellVolume <= 0) {
      return { status: 400, body: { error: '매도할 수량이 없습니다', success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;

    if (isDryRun) {
      // 모의투자 - 가상 포트폴리오 업데이트 (수수료 0.05%)
      const applied = applyDrySell(tradingSystem, {
        coin,
        volume: sellVolume,
        price: currentPrice,
        reason: '수동 매도',
        reflectStrategy: false
      });
      // 이 라우트의 기존 계약: 전략 포지션은 항상 전량 종료한다.
      if (strategy) strategy.closePosition(currentPrice, '수동 매도');
      return {
        status: 200,
        body: {
          success: true,
          message: `[모의투자] ${coin} ${sellVolume.toFixed(8)} 매도 완료 (+${applied.netSellAmount.toLocaleString()}원, 수수료 ${applied.fee.toFixed(0)}원)`,
          order: {
            coin,
            action: 'SELL',
            price: currentPrice,
            volume: sellVolume,
            grossAmount: applied.grossSellAmount,
            fee: applied.fee,
            amount: applied.netSellAmount,
            mode: 'DRY_RUN'
          }
        }
      };
    }

    // 실전투자: 실제 체결 수량만 전략 포지션에 반영한다.
    const { execution, failure } = await runLiveLeg({
      market: coin,
      side: 'ask',
      volume: sellVolume,
      orderType: 'market',
      requested: { volume: sellVolume },
      referencePrice: currentPrice,
      clientIntentId
    });
    if (failure) return failure;
    const actualPrice = Number(execution.fill.averagePrice);
    const actualVolume = Number(execution.fill.executedVolume);
    if (strategy?.currentPosition) {
      const isFullSell = strategy.currentPosition.amount - actualVolume <= DUST_AMOUNT_THRESHOLD;
      reflectStrategySellFill(strategy, actualPrice, actualVolume, '수동 매도', isFullSell);
    }
    return {
      status: 200,
      body: {
        success: true,
        mode: 'LIVE',
        message: `${coin} 매도 체결 완료`,
        order: { ...(execution.orderResult || {}), mode: 'LIVE' },
        fill: execution.fill,
        price: actualPrice,
        volume: actualVolume,
        fee: execution.fill.paidFee,
        grossAmount: actualPrice * actualVolume,
        amount: actualPrice * actualVolume - (Number.isFinite(execution.fill.paidFee) ? execution.fill.paidFee : 0)
      }
    };
  }

  async function buy({ coin, amount, clientIntentId = null }) {
    if (!coin || !amount) {
      return { status: 400, body: { error: 'coin과 amount는 필수입니다', success: false } };
    }
    if (amount < MIN_BUY_KRW) {
      return { status: 400, body: { error: '최소 매수 금액은 5,000원입니다', success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;
    const isDryRun = tradingSystem.dryRun;
    let responsePrice = currentPrice;
    let responseVolume;
    let responseFee;
    let liveFill = null;

    if (isDryRun) {
      const applied = applyDryBuy(tradingSystem, { coin, amount, price: currentPrice });
      if (applied.insufficientBalance) {
        return {
          status: 400,
          body: {
            error: `잔액 부족 (보유: ${applied.availableBalance.toLocaleString()}원)`,
            success: false
          }
        };
      }
      const fee = amount * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = amount - fee;
      responseVolume = actualInvestment / currentPrice;
      responseFee = fee;
    } else {
      const { execution, failure } = await runLiveLeg({
        market: coin,
        side: 'bid',
        volume: amount,
        orderType: 'price',
        requested: { amount },
        referencePrice: currentPrice,
        clientIntentId
      });
      liveFill = execution.fill;
      if (failure) {
        return { status: failure.status, body: { ...failure.body, coin } };
      }
      responsePrice = liveFill.averagePrice;
      responseVolume = liveFill.executedVolume;
      responseFee = liveFill.paidFee;
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      reflectStrategyBuyFill(getStrategyFor(tradingSystem, coin), responsePrice, responseVolume);
    }

    return {
      status: 200,
      body: {
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        coin,
        amount,
        fee: responseFee,
        price: responsePrice,
        volume: responseVolume,
        fill: liveFill
      }
    };
  }

  async function sell({ coin, quantity, clientIntentId = null }) {
    if (!coin || !quantity) {
      return { status: 400, body: { error: 'coin과 quantity는 필수입니다', success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;
    const isDryRun = tradingSystem.dryRun;

    // 보유량 확인
    const holding = isDryRun
      ? tradingSystem.virtualPortfolio?.holdings?.get(coin)
      : await readLiveHolding(tradingSystem, coin);

    if (!holding || holding.amount <= 0) {
      return { status: 400, body: { error: '보유 수량이 없습니다', success: false } };
    }

    const sellVolume = Math.min(quantity, holding.amount);
    let responsePrice = currentPrice;
    let responseVolume = sellVolume;
    let responseGrossAmount = sellVolume * currentPrice;
    let responseFee = responseGrossAmount * MANUAL_ORDER_FEE_RATE;
    let responseReceivedAmount = responseGrossAmount - responseFee;
    let liveFill = null;

    if (isDryRun) {
      applyDrySell(tradingSystem, {
        coin,
        volume: sellVolume,
        price: currentPrice,
        reason: '수동 매도'
      });
    } else {
      const { execution, failure } = await runLiveLeg({
        market: coin,
        side: 'ask',
        volume: sellVolume,
        orderType: 'market',
        requested: { volume: sellVolume },
        referencePrice: currentPrice,
        clientIntentId
      });
      liveFill = execution.fill;
      if (failure) {
        return { status: failure.status, body: { ...failure.body, coin } };
      }
      responsePrice = liveFill.averagePrice;
      responseVolume = liveFill.executedVolume;
      responseFee = liveFill.paidFee;
      responseGrossAmount = responsePrice * responseVolume;
      responseReceivedAmount = responseGrossAmount - responseFee;
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      const strategy = getStrategyFor(tradingSystem, coin);
      const isFullSell = holding.amount - responseVolume <= DUST_AMOUNT_THRESHOLD;
      if (strategy?.currentPosition) {
        if (isFullSell) strategy.closePosition(responsePrice, '수동 매도');
        else strategy.recordPartialSell(responsePrice, responseVolume, '수동 매도');
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        coin,
        quantity: responseVolume,
        price: responsePrice,
        grossAmount: Math.round(responseGrossAmount),
        fee: Math.round(responseFee),
        receivedAmount: Math.round(responseReceivedAmount),
        fill: liveFill
      }
    };
  }

  async function quick({ coin, action, amount, clientIntentId = null }) {
    if (!coin || !action || !amount) {
      return { status: 400, body: { error: 'coin, action, amount 필수', success: false } };
    }
    if (action === 'BUY' && amount < MIN_BUY_KRW) {
      return { status: 400, body: { error: '최소 매수 금액은 5,000원입니다', success: false } };
    }

    const { ticker, block } = await requireFreshQuote(coin);
    if (block) return block;
    const currentPrice = ticker.trade_price;
    const isDryRun = tradingSystem.dryRun;

    if (action === 'BUY') {
      // 보유 현금 확인 및 자동 조절
      let buyAmount = amount;
      let buyWasAdjusted = false;
      const availableBalance = await readKrwBalance(tradingSystem);

      // 금액이 보유 현금을 초과하면 최대 가용 금액으로 자동 조절
      if (buyAmount > availableBalance * 0.98) {
        buyAmount = Math.floor(availableBalance * 0.95);
        buyWasAdjusted = true;
        console.log(`⚠️ 빠른 매수 금액 자동 조절: ${amount.toLocaleString()}원 → ${buyAmount.toLocaleString()}원`);
      }
      if (buyAmount < MIN_BUY_KRW) {
        return {
          status: 400,
          body: {
            error: `보유 현금 부족 (${availableBalance.toLocaleString()}원). 최소 5,000원 이상 필요합니다.`,
            success: false,
            availableBalance
          }
        };
      }

      const fee = buyAmount * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = buyAmount - fee;
      const volume = actualInvestment / currentPrice;
      let responsePrice = currentPrice;
      let responseVolume = volume;
      let responseFee = fee;
      let liveFill = null;

      if (isDryRun) {
        const applied = applyDryBuy(tradingSystem, { coin, amount: buyAmount, price: currentPrice });
        if (applied.insufficientBalance) {
          return {
            status: 400,
            body: {
              error: `잔액 부족 (보유: ${applied.availableBalance.toLocaleString()}원, 요청: ${buyAmount.toLocaleString()}원)`,
              success: false,
              availableBalance: applied.availableBalance
            }
          };
        }
      } else {
        const { execution, failure } = await runLiveLeg({
          market: coin,
          side: 'bid',
          volume: buyAmount,
          orderType: 'price',
          requested: { amount: buyAmount },
          referencePrice: currentPrice,
          clientIntentId
        });
        if (failure) return failure;
        const actualPrice = Number(execution.fill.averagePrice);
        const actualVolume = Number(execution.fill.executedVolume);
        liveFill = execution.fill;
        reflectStrategyBuyFill(getStrategyFor(tradingSystem, coin), actualPrice, actualVolume);
        responsePrice = actualPrice;
        responseVolume = actualVolume;
        responseFee = execution.fill.paidFee;
      }

      return {
        status: 200,
        body: {
          success: true,
          mode: isDryRun ? 'DRY_RUN' : 'LIVE',
          action: 'BUY',
          coin,
          amount: buyAmount,
          originalAmount: amount,
          amountWasAdjusted: buyWasAdjusted,
          price: responsePrice,
          volume: responseVolume,
          fee: responseFee,
          fill: liveFill,
          message: buyWasAdjusted
            ? `매수 완료 (금액 자동 조절: ${amount.toLocaleString()}원 → ${buyAmount.toLocaleString()}원, 수수료 ${(isDryRun ? fee : responseFee || 0).toFixed(0)}원)`
            : `매수 완료 (수수료 ${(isDryRun ? fee : responseFee || 0).toFixed(0)}원)`
        }
      };
    }

    // SELL
    let holding = isDryRun
      ? tradingSystem.virtualPortfolio?.holdings?.get(coin)
      : await readLiveHolding(tradingSystem, coin);
    if (!holding || holding.amount <= 0) {
      return { status: 400, body: { error: '보유 수량이 없습니다', success: false } };
    }

    const maxHoldingValue = holding.amount * currentPrice;
    let sellWasAdjusted = false;

    // amount가 퍼센트인 경우 (100 이하)
    let sellVolume;
    if (amount <= 100) {
      sellVolume = holding.amount * (amount / 100);
    } else {
      sellVolume = amount / currentPrice;
      if (sellVolume > holding.amount) {
        sellVolume = holding.amount;
        sellWasAdjusted = true;
        console.log(`⚠️ 빠른 매도 수량 자동 조절: 요청 ${(amount / currentPrice).toFixed(8)} → 최대 ${holding.amount.toFixed(8)}`);
      }
    }

    let responsePrice = currentPrice;
    let responseVolume = sellVolume;
    let responseFee = sellVolume * currentPrice * MANUAL_ORDER_FEE_RATE;
    let liveFill = null;

    if (isDryRun) {
      applyDrySell(tradingSystem, {
        coin,
        volume: sellVolume,
        price: currentPrice,
        reason: '빠른 매도'
      });
    } else {
      const { execution, failure } = await runLiveLeg({
        market: coin,
        side: 'ask',
        volume: sellVolume,
        orderType: 'market',
        requested: { volume: sellVolume },
        referencePrice: currentPrice,
        clientIntentId
      });
      if (failure) return failure;
      const actualPrice = Number(execution.fill.averagePrice);
      const actualVolume = Number(execution.fill.executedVolume);
      const actualFee = execution.fill.paidFee;
      const strategy = getStrategyFor(tradingSystem, coin);
      reflectStrategySellFill(
        strategy,
        actualPrice,
        actualVolume,
        '빠른 매도',
        (strategy?.currentPosition?.amount ?? 0) - actualVolume <= DUST_AMOUNT_THRESHOLD
      );
      responsePrice = actualPrice;
      responseVolume = actualVolume;
      responseFee = actualFee;
      liveFill = execution.fill;
    }

    return {
      status: 200,
      body: {
        success: true,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        action: 'SELL',
        coin,
        volume: responseVolume,
        price: responsePrice,
        grossAmount: responsePrice * responseVolume,
        fee: responseFee,
        amount: responsePrice * responseVolume - (Number.isFinite(responseFee) ? responseFee : 0),
        originalAmount: amount,
        amountWasAdjusted: sellWasAdjusted,
        fill: liveFill,
        maxHoldingValue: Math.round(maxHoldingValue),
        message: sellWasAdjusted
          ? `매도 완료 (최대 보유액 ${Math.round(maxHoldingValue).toLocaleString()}원으로 조절, 수수료 ${(isDryRun ? responseFee : responseFee || 0).toFixed(0)}원)`
          : `매도 완료 (수수료 ${(isDryRun ? responseFee : responseFee || 0).toFixed(0)}원)`
      }
    };
  }

  async function smartBuy({ totalAmount, minScore = 60, maxCoins = 10 }, { attachLegIntent = null } = {}) {
    if (!totalAmount || totalAmount < MIN_BUY_KRW) {
      return { status: 400, body: { error: '최소 금액은 5,000원입니다', success: false } };
    }
    if (!tradingSystem.upbit) {
      return { status: 400, body: { error: '거래 시스템 미초기화', success: false } };
    }

    // 보유 현금 확인 및 자동 조절
    const availableBalance = await readKrwBalance(tradingSystem);

    // 요청 금액이 보유 현금을 초과하면 최대 가용 금액으로 자동 조절
    const originalAmount = totalAmount;
    let amountWasAdjusted = false;
    if (totalAmount > availableBalance * 0.98) { // 2% 여유분 확보
      totalAmount = Math.floor(availableBalance * 0.95); // 95%까지만 사용
      amountWasAdjusted = true;
      console.log(`⚠️ 스마트 매수 금액 자동 조절: ${originalAmount.toLocaleString()}원 → ${totalAmount.toLocaleString()}원 (보유: ${availableBalance.toLocaleString()}원)`);
    }
    if (totalAmount < MIN_BUY_KRW) {
      return {
        status: 400,
        body: {
          error: `보유 현금 부족 (${availableBalance.toLocaleString()}원). 최소 5,000원 이상 필요합니다.`,
          success: false,
          availableBalance
        }
      };
    }

    const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');

    // 상위 거래량 코인 분석 (상위 30개)
    const markets = await marketDataProvider.getMarkets();
    const krwMarkets = marketsForQuote(markets, quoteOfSystem(tradingSystem));
    const requestedTickers = await readFreshTickers(krwMarkets);
    const tickers = requestedTickers.filter(ticker =>
      inspectMarketQuote(ticker, ticker?.market).fresh
    );
    if (tickers.length === 0) {
      const quoteBlock = marketQuoteBlockResult(requestedTickers.map(ticker =>
        inspectMarketQuote(ticker, ticker?.market)
      ));
      return quoteBlock || {
        status: 409,
        body: {
          success: false,
          code: 'MARKET_QUOTE_UNAVAILABLE',
          message: '최근 시세를 확인할 수 있는 종목이 없어 주문을 보내지 않았습니다.'
        }
      };
    }
    const tickerByMarket = new Map(tickers.map(ticker => [ticker.market, ticker]));

    // 상위 30개 거래량 코인 분석
    const analyzeCount = Math.min(30, krwMarkets.length);
    const topCoins = tickers
      .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, analyzeCount)
      .map(t => t.market);

    // 각 코인 분석 및 점수 계산
    const coinScores = [];
    for (const coin of topCoins) {
      try {
        const ticker = tickers.find(t => t.market === coin);
        const candles = await readMinuteCandles(coin, 5, 100);
        if (!candles || candles.length < 50) continue;

        const analysis = comprehensiveAnalysis(candles, {
          rsiPeriod: tradingSystem.config.rsiPeriod || 14,
          rsiOversold: tradingSystem.config.rsiOversold || 30,
          rsiOverbought: tradingSystem.config.rsiOverbought || 70
        });
        if (!analysis?.indicators) continue;

        const rsi = typeof analysis.indicators.rsi === 'number' ? analysis.indicators.rsi : null;
        const macd = analysis.indicators.macd;
        const bb = analysis.indicators.bollingerBands;

        // 매수 적합도 점수
        let score = 50;
        if (rsi !== null) {
          if (rsi < 30) score += 25;
          else if (rsi < 40) score += 15;
          else if (rsi > 70) score -= 20;
        }
        if (macd?.histogram > 0 && macd?.macdLine > macd?.signalLine) score += 20;
        if (bb?.percentB < 0.2) score += 15;

        const change24h = ticker.signed_change_rate * 100;
        if (change24h < -3) score += 10;

        coinScores.push({
          coin,
          score,
          price: ticker.trade_price,
          change24h,
          rsi,
          volume: ticker.acc_trade_price_24h
        });
        await new Promise(r => setTimeout(r, 50));
      } catch {
        // 개별 코인 오류 무시
      }
    }

    // 점수 순 정렬
    coinScores.sort((a, b) => b.score - a.score);

    // 최소 점수 이상인 코인 선택 (maxCoins 제한 적용)
    let selectedCoins = coinScores.filter(c => c.score >= minScore);
    // 조건 충족 코인이 없으면 상위 3개 선택 (폴백)
    if (selectedCoins.length === 0) {
      selectedCoins = coinScores.slice(0, 3);
    }
    if (maxCoins > 0 && selectedCoins.length > maxCoins) {
      selectedCoins = selectedCoins.slice(0, maxCoins);
    }
    // 코인당 최소 5000원 이상 투자할 수 있는 개수로 제한
    const maxAffordable = Math.floor(totalAmount / MIN_BUY_KRW);
    if (selectedCoins.length > maxAffordable) {
      selectedCoins = selectedCoins.slice(0, maxAffordable);
    }

    const selectedQuoteBlock = marketQuoteBlockResult(selectedCoins.map(coinData =>
      inspectMarketQuote(tickerByMarket.get(coinData.coin), coinData.coin)
    ));
    if (selectedQuoteBlock) return selectedQuoteBlock;
    if (selectedCoins.length === 0) {
      return {
        status: 409,
        body: {
          success: false,
          code: 'NO_SMART_BUY_CANDIDATES',
          message: '주문 조건을 충족하는 종목이 없어 주문을 보내지 않았습니다.'
        }
      };
    }

    const amountPerCoin = Math.floor(totalAmount / selectedCoins.length);
    const orders = [];
    const liveFailures = [];
    const isDryRun = tradingSystem.dryRun;
    let runningBalance = availableBalance; // 실행 중 잔액 추적

    for (const coinData of selectedCoins) {
      if (amountPerCoin < MIN_BUY_KRW) continue;

      const dispatchQuoteCheck = inspectMarketQuote(tickerByMarket.get(coinData.coin), coinData.coin);
      if (!dispatchQuoteCheck.fresh) {
        liveFailures.push({ coin: coinData.coin, reason: dispatchQuoteCheck.reason, orderDispatched: false });
        continue;
      }

      // 실시간 잔액 체크 (마이너스 방지)
      if (isDryRun && runningBalance < amountPerCoin) {
        console.log(`⚠️ 잔액 부족으로 ${coinData.coin} 스킵 (필요: ${amountPerCoin}, 잔액: ${runningBalance})`);
        continue;
      }

      const fee = amountPerCoin * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = amountPerCoin - fee;
      const volume = actualInvestment / coinData.price;
      let executedPrice = coinData.price;
      let executedVolume = volume;
      let executedFee = fee;
      let executionFill = null;

      if (isDryRun) {
        const portfolio = tradingSystem.virtualPortfolio;
        if (portfolio) {
          // 이중 안전장치: 실제 잔액 다시 확인
          const actualBalance = portfolio.krwBalance || 0;
          if (actualBalance < amountPerCoin) {
            console.log(`⚠️ 실제 잔액 부족으로 ${coinData.coin} 스킵`);
            continue;
          }
          portfolio.krwBalance = Math.max(0, actualBalance - amountPerCoin);
          runningBalance = portfolio.krwBalance; // 업데이트
          const existing = portfolio.holdings.get(coinData.coin) || { amount: 0, avgPrice: 0, entryTime: null };
          const newAmount = existing.amount + volume;
          const newAvgPrice = ((existing.amount * existing.avgPrice) + (volume * coinData.price)) / newAmount;
          portfolio.holdings.set(coinData.coin, {
            amount: newAmount,
            avgPrice: newAvgPrice,
            entryTime: existing.entryTime || new Date().toISOString()
          });
          reflectStrategyBuyFill(getStrategyFor(tradingSystem, coinData.coin), coinData.price, volume);
        }
      } else {
        const legIntentId = attachLegIntent ? await attachLegIntent(`buy:${coinData.coin}`) : null;
        if (!legIntentId) {
          liveFailures.push({
            coin: coinData.coin,
            reason: 'leg_intent_unavailable',
            orderDispatched: false
          });
          continue;
        }
        const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
          market: coinData.coin,
          side: 'bid',
          volume: amountPerCoin,
          orderType: 'price',
          requested: { amount: amountPerCoin },
          referencePrice: coinData.price,
          clientIntentId: legIntentId
        });
        executionFill = liveExecution.fill;
        if (!hasCompleteObservedLiveFill(liveExecution)) {
          liveFailures.push({
            coin: coinData.coin,
            fill: executionFill,
            reason: liveExecution.reason || executionFill?.error || 'fill_not_observed'
          });
          continue;
        }
        executedPrice = executionFill.averagePrice;
        executedVolume = executionFill.executedVolume;
        executedFee = executionFill.paidFee;
        // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
        reflectStrategyBuyFill(getStrategyFor(tradingSystem, coinData.coin), executedPrice, executedVolume);
      }

      const tradeRecord = {
        coin: coinData.coin,
        amount: isDryRun ? amountPerCoin : executedPrice * executedVolume + executedFee,
        price: executedPrice,
        volume: executedVolume,
        fee: executedFee,
        score: coinData.score,
        rsi: typeof coinData.rsi === 'number' ? coinData.rsi.toFixed(1) : '-',
        change24h: typeof coinData.change24h === 'number' ? coinData.change24h.toFixed(2) : '-',
        type: 'BUY',
        source: 'smart-buy',
        timestamp: new Date().toISOString(),
        fill: executionFill
      };
      orders.push(tradeRecord);
      // 스마트 거래 이력 저장
      appendSmartTradeHistory(tradingSystem, tradeRecord);
    }

    if (isDryRun && tradingSystem.saveVirtualPortfolio) {
      tradingSystem.saveVirtualPortfolio();
    }

    // 실제 투자된 총액 계산
    const totalInvested = orders.reduce((sum, o) => sum + o.amount, 0);
    const responseStatus = liveFailures.length > 0
      ? orders.length === 0 ? 409 : 207
      : 200;
    return {
      status: responseStatus,
      body: {
        success: liveFailures.length === 0,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        totalAmount,
        totalInvested,
        originalAmount,
        amountWasAdjusted,
        availableBalance,
        analyzedCoins: coinScores.length,
        qualifiedCoins: coinScores.filter(c => c.score >= minScore).length,
        trades: orders,
        failures: liveFailures,
        message: liveFailures.length > 0
          ? `${orders.length}개 체결 · ${liveFailures.length}개 미체결/실패. 체결되지 않은 주문은 전략 포지션에 반영하지 않았습니다.`
          : amountWasAdjusted
          ? `${orders.length}개 코인에 자동 매수 완료 (금액 자동 조절: ${originalAmount.toLocaleString()}원 → ${totalAmount.toLocaleString()}원)`
          : `${orders.length}개 코인에 자동 매수 완료 (점수 ${minScore}점 이상)`
      }
    };
  }

  async function smartSell({ targetAmount, strategy = 'worst' }, { attachLegIntent = null } = {}) {
    if (!targetAmount || targetAmount < 1000) {
      return { status: 400, body: { error: '목표 매도 금액은 최소 1,000원 이상이어야 합니다', success: false } };
    }
    if (!tradingSystem.upbit) {
      return { status: 400, body: { error: '거래 시스템 미초기화', success: false } };
    }

    // 실전/드라이 모드에 따라 보유 코인 조회
    let holdings = new Map();
    const isDryRunMode = tradingSystem.dryRun;
    if (isDryRunMode) {
      // Analysis awaits ticker/candle reads. Keep a value snapshot for the
      // ranking pass and re-read the shared holding immediately before each
      // mutation so a concurrent portfolio update cannot over-credit KRW.
      const portfolioHoldings = tradingSystem.virtualPortfolio?.holdings;
      holdings = portfolioHoldings instanceof Map
        ? new Map(Array.from(portfolioHoldings.entries(), ([coin, holding]) => [coin, { ...holding }]))
        : new Map();
    } else {
      const accounts = await tradingSystem.getAccountInfo();
      for (const acc of accounts) {
        const quote = quoteOfSystem(tradingSystem);
        if (acc.currency !== quote && parseFloat(acc.balance) > 0) {
          holdings.set(`${quote}-${acc.currency}`, {
            amount: parseFloat(acc.balance),
            avgPrice: parseFloat(acc.avg_buy_price) || 0
          });
        }
      }
    }
    if (holdings.size === 0) {
      return { status: 400, body: { error: '보유 중인 코인이 없습니다', success: false } };
    }

    const { comprehensiveAnalysis } = await import('../analysis/technicalIndicators.js');

    // 보유 코인 분석
    const holdingCoins = Array.from(holdings.keys());
    const tickers = await readFreshTickers(holdingCoins);
    const tickerByMarket = new Map(tickers
      .filter(ticker => typeof ticker?.market === 'string')
      .map(ticker => [ticker.market, ticker]));
    const holdingQuoteBlock = marketQuoteBlockResult(holdingCoins.map(coin =>
      inspectMarketQuote(tickerByMarket.get(coin), coin)
    ));
    if (holdingQuoteBlock) return holdingQuoteBlock;

    const coinAnalysis = [];
    let totalHoldingValue = 0;
    for (const coin of holdingCoins) {
      const holding = holdings.get(coin);
      const ticker = tickers.find(t => t.market === coin);
      if (!ticker) continue;

      const currentValue = ticker.trade_price * holding.amount;
      const costBasis = holding.avgPrice * holding.amount;
      const profit = currentValue - costBasis;
      const profitPercent = costBasis > 0 ? ((currentValue / costBasis) - 1) * 100 : 0;
      totalHoldingValue += currentValue;

      // RSI 분석
      let rsi = 50;
      try {
        const candles = await readMinuteCandles(coin, 5, 50);
        if (candles && candles.length >= 30) {
          const analysis = comprehensiveAnalysis(candles, {});
          rsi = analysis?.indicators?.rsi || 50;
        }
      } catch {
        // RSI 조회 실패 시 기본값 유지
      }

      coinAnalysis.push({
        coin,
        holding,
        currentPrice: ticker.trade_price,
        currentValue,
        costBasis,
        profit,
        profitPercent,
        rsi,
        change24h: ticker.signed_change_rate * 100
      });
      await new Promise(r => setTimeout(r, 50));
    }

    // 목표 금액이 총 보유 금액보다 크면 전량 매도
    const actualTargetAmount = Math.min(targetAmount, totalHoldingValue);

    // 전략에 따라 정렬
    if (strategy === 'worst') {
      // 손실 큰 순 (손절)
      coinAnalysis.sort((a, b) => a.profitPercent - b.profitPercent);
    } else if (strategy === 'best') {
      // 수익 큰 순 (익절)
      coinAnalysis.sort((a, b) => b.profitPercent - a.profitPercent);
    } else if (strategy === 'overbought') {
      // RSI 높은 순
      coinAnalysis.sort((a, b) => b.rsi - a.rsi);
    }

    const plannedQuoteBlock = marketQuoteBlockResult(coinAnalysis.map(data =>
      inspectMarketQuote(tickerByMarket.get(data.coin), data.coin)
    ));
    if (plannedQuoteBlock) return plannedQuoteBlock;

    const orders = [];
    const liveFailures = [];
    const isDryRun = tradingSystem.dryRun;
    let totalSellAmount = 0;
    let remainingTarget = actualTargetAmount;

    for (const data of coinAnalysis) {
      if (remainingTarget <= 0) break;

      const dispatchQuoteCheck = inspectMarketQuote(tickerByMarket.get(data.coin), data.coin);
      if (!dispatchQuoteCheck.fresh) {
        liveFailures.push({ coin: data.coin, reason: dispatchQuoteCheck.reason, orderDispatched: false });
        continue;
      }

      const currentHolding = isDryRun
        ? tradingSystem.virtualPortfolio?.holdings?.get(data.coin)
        : data.holding;
      const currentHoldingAmount = Number(currentHolding?.amount);
      const currentPrice = Number(data.currentPrice);
      if (!Number.isFinite(currentHoldingAmount) || currentHoldingAmount <= 0 ||
        !Number.isFinite(currentPrice) || currentPrice <= 0) continue;

      // The analysis snapshot may predate an automatic or manual holding
      // change. Clamp its planned value to the holding that exists now.
      const analyzedSellAmount = Math.min(data.currentValue, remainingTarget);
      const currentHoldingValue = currentHoldingAmount * currentPrice;
      const sellAmount = Math.min(analyzedSellAmount, currentHoldingValue);
      if (sellAmount < 1000) continue; // 최소 금액

      const sellVolume = Math.min(currentHoldingAmount, sellAmount / currentPrice);
      const actualGrossSellAmount = sellVolume * currentPrice;
      const sellRatio = sellVolume / currentHoldingAmount;
      const fee = actualGrossSellAmount * MANUAL_ORDER_FEE_RATE;
      const netSellAmount = actualGrossSellAmount - fee;
      let executedPrice = currentPrice;
      let executedVolume = sellVolume;
      let executedFee = fee;
      let executedSellAmount = actualGrossSellAmount;
      let executedNetSellAmount = netSellAmount;
      let executedSellRatio = sellRatio;
      const averageEntryPrice = Number(currentHolding.avgPrice);
      let executedProfit = Number.isFinite(averageEntryPrice) && averageEntryPrice > 0
        ? (currentPrice - averageEntryPrice) * sellVolume - executedFee
        : (data.profit * executedSellRatio) - executedFee;
      let executedProfitPercent = Number.isFinite(averageEntryPrice) && averageEntryPrice > 0
        ? ((currentPrice / averageEntryPrice) - 1) * 100
        : data.profitPercent;
      let executionFill = null;

      if (isDryRun) {
        const portfolio = tradingSystem.virtualPortfolio;
        if (portfolio) {
          portfolio.krwBalance += netSellAmount;
          const holding = portfolio.holdings.get(data.coin);
          const isFullSell = holding && (Number(holding.amount) - sellVolume) <= DUST_AMOUNT_THRESHOLD;
          if (holding) {
            holding.amount = Math.max(0, Number(holding.amount) - sellVolume);
            if (holding.amount <= DUST_AMOUNT_THRESHOLD) {
              portfolio.holdings.delete(data.coin);
            }
          }
          // 전략 포지션도 업데이트 (통계 집계용)
          const strategyObj = getStrategyFor(tradingSystem, data.coin);
          if (strategyObj?.currentPosition) {
            if (isFullSell) {
              // 전량 매도 시 포지션 종료 (수익 계산 포함)
              strategyObj.closePosition(currentPrice, '스마트 매도');
            } else {
              // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
              strategyObj.recordPartialSell(currentPrice, sellVolume, '스마트 매도');
            }
          }
        }
      } else {
        const legIntentId = attachLegIntent ? await attachLegIntent(`sell:${data.coin}`) : null;
        if (!legIntentId) {
          liveFailures.push({
            coin: data.coin,
            reason: 'leg_intent_unavailable',
            orderDispatched: false
          });
          continue;
        }
        const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
          market: data.coin,
          side: 'ask',
          volume: sellVolume,
          orderType: 'market',
          requested: { volume: sellVolume },
          referencePrice: currentPrice,
          clientIntentId: legIntentId
        });
        executionFill = liveExecution.fill;
        if (!hasCompleteObservedLiveFill(liveExecution)) {
          liveFailures.push({
            coin: data.coin,
            fill: executionFill,
            reason: liveExecution.reason || executionFill?.error || 'fill_not_observed'
          });
          continue;
        }
        executedPrice = executionFill.averagePrice;
        executedVolume = executionFill.executedVolume;
        executedFee = executionFill.paidFee;
        executedSellAmount = executedPrice * executedVolume;
        executedNetSellAmount = executedSellAmount - executedFee;
        executedSellRatio = data.holding.amount > 0
          ? executedVolume / data.holding.amount
          : sellRatio;
        const liveAverageEntryPrice = Number(currentHolding.avgPrice);
        executedProfit = Number.isFinite(liveAverageEntryPrice) && liveAverageEntryPrice > 0
          ? (executedPrice - liveAverageEntryPrice) * executedVolume - executedFee
          : (data.profit * executedSellRatio) - executedFee;
        executedProfitPercent = Number.isFinite(liveAverageEntryPrice) && liveAverageEntryPrice > 0
          ? ((executedPrice / liveAverageEntryPrice) - 1) * 100
          : data.profitPercent;
        // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
        const isFullSell = (currentHolding.amount - executedVolume) <= DUST_AMOUNT_THRESHOLD;
        const strategyObj = getStrategyFor(tradingSystem, data.coin);
        if (strategyObj?.currentPosition) {
          if (isFullSell) {
            strategyObj.closePosition(executedPrice, '스마트 매도');
          } else {
            // 부분 매도 시 실제 체결 수량만 기록한다.
            strategyObj.recordPartialSell(executedPrice, executedVolume, '스마트 매도');
          }
        }
      }

      totalSellAmount += isDryRun ? netSellAmount : executedNetSellAmount;
      remainingTarget -= executedSellAmount; // 실제 gross 체결액 기준으로 차감

      const tradeRecord = {
        coin: data.coin,
        volume: executedVolume,
        price: executedPrice,
        grossAmount: Math.round(executedSellAmount),
        fee: Math.round(executedFee),
        amount: Math.round(executedNetSellAmount),
        profit: Math.round(executedProfit),
        profitPercent: Number(executedProfitPercent).toFixed(2),
        type: 'SELL',
        source: 'smart-sell',
        timestamp: new Date().toISOString(),
        fill: executionFill
      };
      orders.push(tradeRecord);
      // 스마트 거래 이력 저장
      appendSmartTradeHistory(tradingSystem, tradeRecord);
    }

    if (isDryRun && tradingSystem.saveVirtualPortfolio) {
      tradingSystem.saveVirtualPortfolio();
    }

    const sellWasAdjusted = targetAmount > totalHoldingValue;
    const responseStatus = liveFailures.length > 0
      ? orders.length === 0 ? 409 : 207
      : 200;
    return {
      status: responseStatus,
      body: {
        success: liveFailures.length === 0,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE',
        targetAmount,
        actualTargetAmount: Math.round(actualTargetAmount),
        totalHoldingValue: Math.round(totalHoldingValue),
        amountWasAdjusted: sellWasAdjusted,
        strategy,
        totalReceived: Math.round(totalSellAmount),
        trades: orders,
        failures: liveFailures,
        message: liveFailures.length > 0
          ? `${orders.length}건 체결 · ${liveFailures.length}건 미체결/실패. 미체결 주문은 전략 포지션과 손익에 반영하지 않았습니다.`
          : sellWasAdjusted
          ? `${orders.length}개 코인에서 ${Math.round(totalSellAmount).toLocaleString()}원 매도 완료 (목표 ${targetAmount.toLocaleString()}원 → 최대 보유액 ${Math.round(totalHoldingValue).toLocaleString()}원으로 조절)`
          : `${orders.length}개 코인에서 ${Math.round(totalSellAmount).toLocaleString()}원 매도 완료`
      }
    };
  }

  // 번들 제안 실행 (매도 후 매수)
  async function executeBundle({ sellCoin, sellAmount, buyCoin, buyAmount }, { attachLegIntent = null } = {}) {
    if (!sellCoin || !buyCoin) {
      return { status: 400, body: { error: 'sellCoin과 buyCoin은 필수입니다', success: false } };
    }

    const results = { sell: null, buy: null };
    const isDryRun = tradingSystem.dryRun;

    // Read and validate both legs before the first portfolio/order mutation.
    const [sellTicker, buyTicker] = await Promise.all([
      readFreshMarketTicker(sellCoin),
      readFreshMarketTicker(buyCoin)
    ]);
    const initialQuoteBlock = marketQuoteBlockResult([
      inspectMarketQuote(sellTicker, sellCoin),
      inspectMarketQuote(buyTicker, buyCoin)
    ]);
    if (initialQuoteBlock) return initialQuoteBlock;

    // 1. 매도 실행
    const sellPrice = sellTicker.trade_price;
    let holding = tradingSystem.virtualPortfolio?.holdings.get(sellCoin);
    if (!isDryRun) {
      holding = await readLiveHolding(tradingSystem, sellCoin);
    }
    const requestedSellAmount = Number(sellAmount);
    const actualSellAmount = Number.isFinite(requestedSellAmount) && requestedSellAmount > 0
      ? Math.min(requestedSellAmount, Number(holding?.amount) || 0)
      : Number(holding?.amount) || 0;
    if (actualSellAmount <= 0) {
      return { status: 400, body: { error: '매도할 수량이 없습니다', success: false } };
    }

    const sellValue = actualSellAmount * sellPrice;
    if (isDryRun) {
      // 모의투자 매도 (수수료 적용)
      const sellFee = sellValue * MANUAL_ORDER_FEE_RATE;
      const netSellValue = sellValue - sellFee;
      const portfolio = tradingSystem.virtualPortfolio;
      if (portfolio) {
        portfolio.krwBalance += netSellValue;
        const existingHolding = portfolio.holdings.get(sellCoin);
        const isFullSell = existingHolding && (existingHolding.amount - actualSellAmount) <= DUST_AMOUNT_THRESHOLD;
        if (existingHolding) {
          existingHolding.amount -= actualSellAmount;
          if (existingHolding.amount <= DUST_AMOUNT_THRESHOLD) {
            portfolio.holdings.delete(sellCoin);
          }
        }
        // 전략 포지션도 업데이트 (통계 집계용)
        const sellStrategy = getStrategyFor(tradingSystem, sellCoin);
        if (sellStrategy?.currentPosition) {
          if (isFullSell) {
            sellStrategy.closePosition(sellPrice, '번들 매도');
          } else {
            // 부분 매도 시 recordPartialSell 사용 (수익 기록 포함)
            sellStrategy.recordPartialSell(sellPrice, actualSellAmount, '번들 매도');
          }
        }
      }
      results.sell = { coin: sellCoin, amount: actualSellAmount, price: sellPrice, grossValue: sellValue, fee: sellFee, value: netSellValue };
    } else {
      const sellIntentId = attachLegIntent ? await attachLegIntent('sell') : null;
      if (!sellIntentId) {
        return {
          status: 503,
          body: {
            success: false,
            mode: 'LIVE',
            reason: 'leg_intent_unavailable',
            message: '요청 저널에 매도 주문 식별자를 기록하지 못해 주문을 보내지 않았습니다.'
          }
        };
      }
      const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
        market: sellCoin,
        side: 'ask',
        volume: actualSellAmount,
        orderType: 'market',
        requested: { volume: actualSellAmount },
        referencePrice: sellPrice,
        clientIntentId: sellIntentId
      });
      results.sell = {
        ...(liveExecution.orderResult || {}),
        coin: sellCoin,
        fill: liveExecution.fill
      };
      if (!hasCompleteObservedLiveFill(liveExecution)) {
        return liveFillFailureResult(liveExecution, {
          message: '번들 매도가 실제 체결되지 않아 매수로 진행하지 않았습니다.',
          extra: { results }
        });
      }

      const filledSellAmount = Number(liveExecution.fill.executedVolume);
      const filledSellPrice = Number(liveExecution.fill.averagePrice);
      const filledSellFee = liveExecution.fill.paidFee;
      const filledSellValue = filledSellAmount * filledSellPrice;
      const netSellValue = filledSellValue - (Number.isFinite(filledSellFee) ? filledSellFee : 0);
      results.sell = {
        ...results.sell,
        amount: filledSellAmount,
        price: filledSellPrice,
        grossValue: filledSellValue,
        fee: filledSellFee,
        value: netSellValue
      };
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      const isFullSell = holding && (Number(holding.amount) - filledSellAmount) <= DUST_AMOUNT_THRESHOLD;
      const sellStrategy = getStrategyFor(tradingSystem, sellCoin);
      if (sellStrategy?.currentPosition) {
        if (isFullSell) {
          sellStrategy.closePosition(filledSellPrice, '번들 매도');
        } else {
          // 부분 매도 시 실제 체결 수량만 기록한다.
          sellStrategy.recordPartialSell(filledSellPrice, filledSellAmount, '번들 매도');
        }
      }
    }

    // 2. 매수 실행
    const buyQuoteCheck = inspectMarketQuote(buyTicker, buyCoin);
    const buyQuoteBlock = marketQuoteBlockResult([buyQuoteCheck], {
      results,
      message: buyQuoteCheck.reason === 'market_source_stale' ||
        buyQuoteCheck.reason === 'market_source_timestamp_in_future'
        ? '매도는 완료됐지만 매수 종목의 최근 체결 시각이 오래되어 매수는 보내지 않았습니다.'
        : '매도는 완료됐지만 매수 종목의 시세를 확인할 수 없어 매수는 보내지 않았습니다.'
    });
    if (buyQuoteBlock) return buyQuoteBlock;
    const buyPrice = buyTicker.trade_price;
    // 매도 후 실제 잔액 기반으로 매수 (드라이런에서는 수수료 차감된 금액 사용)
    const availableForBuy = results.sell.value;
    const requestedBuyAmount = Number(buyAmount);
    const investAmount = Number.isFinite(requestedBuyAmount) && requestedBuyAmount > 0
      ? requestedBuyAmount
      : Math.floor(availableForBuy * 0.95);
    if (!Number.isFinite(investAmount) || investAmount < MIN_BUY_KRW) {
      return {
        status: 400,
        body: {
          success: false,
          mode: isDryRun ? 'DRY_RUN' : 'LIVE',
          message: '매수 금액이 최소 주문 금액(5,000원)보다 작습니다.',
          results
        }
      };
    }

    if (isDryRun) {
      // 모의투자 매수 (수수료 적용)
      const buyFee = investAmount * MANUAL_ORDER_FEE_RATE;
      const actualInvestment = investAmount - buyFee;
      const buyVolume = actualInvestment / buyPrice;
      const portfolio = tradingSystem.virtualPortfolio;
      if (portfolio) {
        portfolio.krwBalance -= investAmount;
        const existing = portfolio.holdings.get(buyCoin) || { amount: 0, avgPrice: 0, entryTime: null };
        const newAmount = existing.amount + buyVolume;
        const newAvgPrice = ((existing.amount * existing.avgPrice) + (buyVolume * buyPrice)) / newAmount;
        portfolio.holdings.set(buyCoin, {
          amount: newAmount,
          avgPrice: newAvgPrice,
          entryTime: existing.entryTime || new Date().toISOString()
        });
        reflectStrategyBuyFill(getStrategyFor(tradingSystem, buyCoin), buyPrice, buyVolume);
        tradingSystem.saveVirtualPortfolio();
      }
      results.buy = { coin: buyCoin, amount: buyVolume, price: buyPrice, grossValue: investAmount, fee: buyFee, value: actualInvestment };
    } else {
      const buyIntentId = attachLegIntent ? await attachLegIntent('buy') : null;
      if (!buyIntentId) {
        return {
          status: 503,
          body: {
            success: false,
            mode: 'LIVE',
            reason: 'leg_intent_unavailable',
            message: '요청 저널에 매수 주문 식별자를 기록하지 못해 매수를 보내지 않았습니다. 매도 체결은 results.sell에서 확인하세요.',
            results
          }
        };
      }
      const liveExecution = await executeLiveOrderWithEvidence(tradingSystem, {
        market: buyCoin,
        side: 'bid',
        volume: investAmount,
        orderType: 'price',
        requested: { amount: investAmount },
        referencePrice: buyPrice,
        clientIntentId: buyIntentId
      });
      results.buy = {
        ...(liveExecution.orderResult || {}),
        coin: buyCoin,
        fill: liveExecution.fill
      };
      if (!hasCompleteObservedLiveFill(liveExecution)) {
        return liveFillFailureResult(liveExecution, {
          message: '번들 매수가 실제 체결되지 않았습니다. 매도 체결은 results.sell에서 확인하세요.',
          extra: { results }
        });
      }

      const filledBuyVolume = Number(liveExecution.fill.executedVolume);
      const filledBuyPrice = Number(liveExecution.fill.averagePrice);
      const filledBuyFee = liveExecution.fill.paidFee;
      const filledBuyValue = filledBuyVolume * filledBuyPrice;
      const netBuyValue = filledBuyValue - (Number.isFinite(filledBuyFee) ? filledBuyFee : 0);
      results.buy = {
        ...results.buy,
        amount: filledBuyVolume,
        price: filledBuyPrice,
        grossValue: filledBuyValue,
        fee: filledBuyFee,
        value: netBuyValue
      };
      // 실제 체결된 수량/가격만 전략 포지션에 반영한다.
      reflectStrategyBuyFill(getStrategyFor(tradingSystem, buyCoin), filledBuyPrice, filledBuyVolume);
    }

    appendSmartTradeHistory(tradingSystem, {
      type: 'BUNDLE_TRADE',
      sell: results.sell,
      buy: results.buy,
      timestamp: new Date().toISOString(),
      mode: isDryRun ? 'DRY_RUN' : 'LIVE'
    });

    return {
      status: 200,
      body: {
        success: true,
        message: `[${isDryRun ? '모의투자' : '실전'}] ${baseOfMarket(sellCoin)} 매도 → ${baseOfMarket(buyCoin)} 매수 완료`,
        results,
        mode: isDryRun ? 'DRY_RUN' : 'LIVE'
      }
    };
  }

  return {
    execute,
    buy,
    sell,
    quick,
    smartBuy,
    smartSell,
    executeBundle
  };
}
