// 국내주식(KRX) 1분봉 과매도 반등 스캘핑 트레이더 (토스증권).
// mode='paper' : 토스 시세 + 로컬 가상 포트폴리오 체결(토스는 모의투자 서버가 없음)
// mode='live'  : 토스증권 실계좌 시장가 주문, 체결 결과(평균가/수수료/세금)로 장부 갱신
//
// 계약
// - 코인 스캘핑과 같은 반등 신호(calculateClosedCandleRebound)와 손절/익절/최대보유
//   (OversoldReactionStrategy.checkPosition)를 사용한다.
// - 주식은 1주 단위라서 소액 시드(1만~5만원)는 "살 수 있는 가격대" 종목만 대상이 된다.
//   비율 예산이 1주 가격보다 작아도 현금이 1주(+수수료)를 감당하면 1주를 산다.
// - 장 마감 전(단일가 이전) 신규 진입을 멈추고 보유 포지션을 전량 정리한다(오버나이트 없음).
// - LIVE는 이 트레이더가 연 포지션만 매도한다. 사용자가 직접 산 종목은 건드리지 않는다.
// - LIVE 시작 시 토스 보유잔고와 장부를 대사하고, 실패하면 신규 진입을 잠근다.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import OversoldReactionStrategy from '../strategy/oversoldReactionStrategy.js';
import { calculateClosedCandleRebound } from '../analysis/technicalIndicators.js';
import { writeDurableJson } from '../runtime/durableJson.js';
import { toNumber } from './tossInvestClient.js';

const STATE_VERSION = 1;
const MAX_TRADE_HISTORY = 500;

/**
 * 토스 1분봉(최신순, timestamp=봉 종료 시각)을 반등 분석기 입력 형식으로 변환한다.
 * 분석기는 index 0을 진행 중 캔들로 보고 제외하므로, 최신 봉이 이미 완료됐다면
 * 같은 값의 자리표시 봉을 앞에 붙여 완료 봉이 버려지지 않게 한다.
 */
export function toAnalyzerCandles(tossCandles, nowMs = Date.now()) {
  const parsed = (Array.isArray(tossCandles) ? tossCandles : [])
    .map(candle => {
      const endMs = Date.parse(candle?.timestamp);
      const open = toNumber(candle?.openPrice);
      const high = toNumber(candle?.highPrice);
      const low = toNumber(candle?.lowPrice);
      const close = toNumber(candle?.closePrice);
      const volume = toNumber(candle?.volume, 0);
      if (!Number.isFinite(endMs) || [open, high, low, close].some(value => value === null || value <= 0)) return null;
      return {
        endMs,
        candle_date_time_utc: new Date(endMs - 60000).toISOString().slice(0, 19),
        timestamp: endMs,
        opening_price: open,
        high_price: high,
        low_price: low,
        trade_price: close,
        candle_acc_trade_volume: volume
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.endMs - a.endMs);
  if (parsed.length === 0) return [];
  if (parsed[0].endMs <= nowMs) {
    return [{ ...parsed[0], placeholder: true }, ...parsed];
  }
  return parsed;
}

function emptyState(mode, seedMoney) {
  return {
    version: STATE_VERSION,
    mode,
    cash: mode === 'paper' ? seedMoney : null,
    initialSeedMoney: mode === 'paper' ? seedMoney : null,
    positions: {},
    pendingOrders: {},
    trades: [],
    desiredRunning: true,
    updatedAt: new Date().toISOString()
  };
}

export class StockTrader {
  constructor({
    mode,
    client,
    marketSession,
    config = {},
    stateFile = null,
    now = Date.now,
    log = console
  }) {
    if (mode !== 'paper' && mode !== 'live') throw new Error(`알 수 없는 주식 매매 모드: ${mode}`);
    this.mode = mode;
    this.client = client;
    this.marketSession = marketSession;
    this.stateFile = stateFile;
    this.now = now;
    this.log = log;
    this.config = {
      seedMoney: 50000,
      maxPositions: 3,
      investmentRatio: 0.3,
      commissionRate: 0.00015,
      sellTaxRate: 0.002,
      paperSlippageRate: 0.001,
      candleCount: 120,
      stopLossPercent: 1.5,
      takeProfitPercent: 2,
      maxHoldMinutes: 60,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      oversoldLookback: 1,
      minReboundPercent: 0.15,
      minRsiRecovery: 2,
      minVolumeRatio: 0.8,
      minCloseStrength: 0.55,
      maxEntryRetracePercent: 0.25,
      maxEntryChasePercent: 0.35,
      maxPriceDataGapSeconds: 60,
      ...config
    };
    this.strategies = new Map();
    this.state = this._loadState();
    this.isRunning = false;
    this.entriesPaused = mode === 'live';
    this.pauseReason = mode === 'live' ? 'exchange_state_unverified' : null;
    this.lastCycleAt = null;
    this.lastMarketState = null;
    this.lastError = null;
    this.lastSignals = [];
    this.lastPriceOkAt = null;
    this._cycleInFlight = null;
  }

  // ---------- 상태 저장 ----------

  _loadState() {
    const seed = Math.max(0, Number(this.config.seedMoney) || 0);
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return emptyState(this.mode, seed);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed?.version !== STATE_VERSION || parsed.mode !== this.mode) {
        throw new Error('state version/mode mismatch');
      }
      const state = { ...emptyState(this.mode, seed), ...parsed };
      for (const [symbol, position] of Object.entries(state.positions || {})) {
        this._strategyFor(symbol).openPosition(position.entryPrice, position.quantity, 'BUY');
        this._strategyFor(symbol).currentPosition.entryTime = new Date(position.entryTime);
      }
      return state;
    } catch (error) {
      // 손상된 장부를 덮어써 실포지션을 잃지 않도록 시작을 실패시킨다.
      throw new Error(`주식 ${this.mode} 장부를 읽을 수 없습니다 (${this.stateFile}): ${error.message}`, { cause: error });
    }
  }

  _save() {
    this.state.updatedAt = new Date(this.now()).toISOString();
    if (this.stateFile) writeDurableJson(this.stateFile, this.state);
  }

  _strategyFor(symbol) {
    let strategy = this.strategies.get(symbol);
    if (!strategy) {
      strategy = new OversoldReactionStrategy({
        stopLossPercent: this.config.stopLossPercent,
        takeProfitPercent: this.config.takeProfitPercent,
        maxHoldMinutes: this.config.maxHoldMinutes,
        maxEntryRetracePercent: this.config.maxEntryRetracePercent,
        maxEntryChasePercent: this.config.maxEntryChasePercent,
        tradingFee: this.config.commissionRate,
        slippage: this.config.paperSlippageRate
      });
      this.strategies.set(symbol, strategy);
    }
    return strategy;
  }

  // ---------- 생명주기 ----------

  async start({ source = 'operator' } = {}) {
    if (this.isRunning) return this.getStatus();
    this.state.desiredRunning = true;
    this._save();
    this.isRunning = true;
    this.lastError = null;
    if (this.mode === 'live') await this.reconcileLiveHoldings();
    this.log.log?.(`📈 [주식 ${this.mode === 'live' ? '실전' : '모의'}] 자동매매 시작 (${source})`);
    return this.getStatus();
  }

  stop({ source = 'operator', persistIntent = true } = {}) {
    this.isRunning = false;
    if (persistIntent) {
      this.state.desiredRunning = false;
      this._save();
    }
    this.log.log?.(`⏹️  [주식 ${this.mode === 'live' ? '실전' : '모의'}] 자동매매 중지 (${source})`);
    return this.getStatus();
  }

  /** LIVE 장부를 토스 보유잔고와 대사. 성공해야 신규 진입이 열린다. */
  async reconcileLiveHoldings() {
    if (this.mode !== 'live') return true;
    try {
      const holdings = await this.client.getHoldings();
      const heldQuantity = new Map(holdings.map(item => [item.symbol, Math.floor(toNumber(item.quantity, 0))]));
      let changed = false;
      for (const [symbol, position] of Object.entries(this.state.positions)) {
        const held = heldQuantity.get(symbol) || 0;
        if (held <= 0) {
          this.log.warn?.(`⚠️  [주식 실전] ${symbol} 장부 포지션이 계좌에 없어 제거합니다.`);
          delete this.state.positions[symbol];
          this._strategyFor(symbol).currentPosition = null;
          changed = true;
        } else if (held < position.quantity) {
          position.quantity = held;
          this._strategyFor(symbol).currentPosition.amount = held;
          changed = true;
        }
      }
      if (changed) this._save();
      if (Object.keys(this.state.pendingOrders || {}).length > 0) {
        this.entriesPaused = true;
        this.pauseReason = 'pending_order_unresolved';
      } else {
        this.entriesPaused = false;
        this.pauseReason = null;
      }
      return true;
    } catch (error) {
      this.entriesPaused = true;
      this.pauseReason = 'exchange_state_unverified';
      this.lastError = `보유잔고 대사 실패: ${error.message}`;
      return false;
    }
  }

  // ---------- 자산 ----------

  positionCount() {
    return Object.keys(this.state.positions).length;
  }

  async availableCash() {
    if (this.mode === 'paper') return Math.max(0, Number(this.state.cash) || 0);
    const cash = await this.client.getCashBuyingPower();
    if (cash === null) throw new Error('토스 매수 가능 금액을 확인할 수 없습니다.');
    return cash;
  }

  positionsValue(priceMap) {
    let total = 0;
    for (const [symbol, position] of Object.entries(this.state.positions)) {
      const price = priceMap?.get?.(symbol)?.price ?? position.lastPrice ?? position.entryPrice;
      total += price * position.quantity;
    }
    return total;
  }

  /** 종목당 예산. 비율 예산이 1주 가격보다 작아도 현금으로 1주를 살 수 있으면 1주. */
  sizeEntry({ price, cash, totalAssets }) {
    const feeFactor = 1 + this.config.commissionRate + (this.mode === 'paper' ? this.config.paperSlippageRate : 0.003);
    const unitCost = price * feeFactor;
    if (!(price > 0) || cash < unitCost) return 0;
    const slotsLeft = Math.max(1, this.config.maxPositions - this.positionCount());
    const ratioBudget = totalAssets * this.config.investmentRatio;
    const evenBudget = cash / slotsLeft;
    const budget = Math.min(cash, Math.max(ratioBudget, evenBudget));
    const quantity = Math.floor(budget / unitCost);
    return Math.max(1, Math.min(quantity, Math.floor(cash / unitCost)));
  }

  // ---------- 매매 사이클 ----------

  requiredSymbols(universe = []) {
    return [...new Set([...Object.keys(this.state.positions), ...universe])];
  }

  /**
   * @param {string[]} universe 진입 후보 종목
   * @param {{prices?: Map, candlesBySymbol?: Map}} shared 서비스가 공유하는 시세/캔들 스냅샷
   */
  async runCycle(universe, shared = {}) {
    if (!this.isRunning) return null;
    if (this._cycleInFlight) return this._cycleInFlight;
    this._cycleInFlight = this._runCycle(universe, shared)
      .catch(error => {
        this.lastError = error.message;
        this.log.error?.(`❌ [주식 ${this.mode}] 사이클 오류: ${error.message}`);
      })
      .finally(() => { this._cycleInFlight = null; });
    return this._cycleInFlight;
  }

  async _runCycle(universe, { prices = null, candlesBySymbol = null } = {}) {
    const nowMs = this.now();
    this.lastCycleAt = new Date(nowMs).toISOString();
    const market = await this.marketSession.getState();
    this.lastMarketState = { open: market.open, canEnter: market.canEnter, mustFlatten: market.mustFlatten, reason: market.reason };
    if (!market.open) return;

    if (this.mode === 'live') {
      await this.resolvePendingOrders();
      if (this.entriesPaused && this.pauseReason === 'exchange_state_unverified') {
        await this.reconcileLiveHoldings();
      }
    }

    const priceMap = prices || await this.client.getPrices(this.requiredSymbols(universe));
    if (priceMap.size > 0) this.lastPriceOkAt = nowMs;

    // 1) 보유 포지션 청산 점검 (장 마감 전 전량 정리 포함)
    for (const [symbol, position] of Object.entries({ ...this.state.positions })) {
      const quote = priceMap.get(symbol);
      if (!quote) continue;
      position.lastPrice = quote.price;
      const strategy = this._strategyFor(symbol);
      let exit = strategy.checkPosition(quote.price);
      if (!exit.shouldClose && market.mustFlatten) {
        exit = { shouldClose: true, reason: '장 마감 전 전량 정리', type: 'MARKET_CLOSE' };
      }
      if (exit.shouldClose) await this.sell(symbol, quote.price, exit.reason);
    }

    // 시세 공백이 길면 LIVE 신규 진입을 멈춘다(보유 포지션 보호가 우선).
    if (this.mode === 'live' && this.positionCount() > 0 && this.lastPriceOkAt &&
      nowMs - this.lastPriceOkAt > this.config.maxPriceDataGapSeconds * 1000) {
      this.entriesPaused = true;
      this.pauseReason = 'price_data_gap';
    } else if (this.pauseReason === 'price_data_gap') {
      this.entriesPaused = false;
      this.pauseReason = null;
    }

    // 2) 신규 진입
    if (!market.canEnter || this.entriesPaused) return;
    const signals = [];
    for (const symbol of universe) {
      if (this.positionCount() >= this.config.maxPositions) break;
      if (this.state.positions[symbol]) continue;
      const quote = priceMap.get(symbol);
      if (!quote) continue;
      const rawCandles = candlesBySymbol?.get?.(symbol) ?? await this.client.getMinuteCandles(symbol, this.config.candleCount);
      const candles = toAnalyzerCandles(rawCandles, nowMs);
      const rebound = calculateClosedCandleRebound(candles, this.config);
      const analysis = { indicators: { rebound } };
      const strategy = this._strategyFor(symbol);
      const decision = strategy.makeDecision(analysis, null, quote.price);
      if (decision.action !== 'BUY') continue;
      const validation = strategy.validateEntry(analysis, quote.price, decision);
      signals.push({ symbol, reason: decision.reason, valid: validation.valid, rejection: validation.reason || null, at: new Date(nowMs).toISOString() });
      if (!validation.valid) continue;
      await this.buy(symbol, quote.price, decision.reason, priceMap);
    }
    if (signals.length > 0) this.lastSignals = [...signals, ...this.lastSignals].slice(0, 20);
  }

  async buy(symbol, price, reason, priceMap = new Map()) {
    const cash = await this.availableCash();
    const totalAssets = cash + this.positionsValue(priceMap);
    const quantity = this.sizeEntry({ price, cash, totalAssets });
    if (quantity <= 0) {
      this.lastSignals.unshift({ symbol, reason, valid: false, rejection: `현금 부족 (${Math.floor(cash).toLocaleString()}원 < 1주 ${price.toLocaleString()}원)`, at: new Date(this.now()).toISOString() });
      return null;
    }

    let fillPrice;
    let filledQuantity;
    let commission;
    let orderId = null;
    if (this.mode === 'paper') {
      fillPrice = price * (1 + this.config.paperSlippageRate);
      filledQuantity = quantity;
      commission = fillPrice * quantity * this.config.commissionRate;
      const cost = fillPrice * quantity + commission;
      if (cost > this.state.cash) return null;
      this.state.cash = Math.max(0, this.state.cash - cost);
    } else {
      const clientOrderId = `cp-b-${randomUUID().slice(0, 28)}`;
      const created = await this.client.createMarketOrder({ symbol, side: 'BUY', quantity, clientOrderId });
      orderId = created?.orderId;
      const fill = await this._awaitLiveFill(orderId, { symbol, side: 'BUY', reason });
      if (!fill) return null;
      if (!(fill.filledQuantity > 0)) {
        this.log.warn?.(`⚠️  [주식 실전] ${symbol} 매수 미체결 (${fill.status})`);
        return null;
      }
      filledQuantity = Math.floor(fill.filledQuantity);
      fillPrice = fill.averageFilledPrice ?? price;
      commission = fill.commission || fillPrice * filledQuantity * this.config.commissionRate;
    }

    const entryTime = new Date(this.now()).toISOString();
    this.state.positions[symbol] = {
      quantity: filledQuantity,
      entryPrice: fillPrice,
      entryCommission: commission,
      entryTime,
      lastPrice: price,
      orderId,
      reason
    };
    const strategy = this._strategyFor(symbol);
    strategy.openPosition(fillPrice, filledQuantity, 'BUY');
    strategy.currentPosition.entryTime = new Date(entryTime);
    this._recordTrade({ action: 'BUY', symbol, quantity: filledQuantity, price: fillPrice, commission, reason, orderId });
    this._save();
    this.log.log?.(`🟢 [주식 ${this.mode === 'live' ? '실전' : '모의'}] ${symbol} ${filledQuantity}주 매수 @ ${Math.round(fillPrice).toLocaleString()}원 - ${reason}`);
    return this.state.positions[symbol];
  }

  async sell(symbol, price, reason) {
    const position = this.state.positions[symbol];
    if (!position) return null;
    let fillPrice;
    let soldQuantity;
    let commission;
    let tax;
    let orderId = null;
    if (this.mode === 'paper') {
      fillPrice = price * (1 - this.config.paperSlippageRate);
      soldQuantity = position.quantity;
      commission = fillPrice * soldQuantity * this.config.commissionRate;
      tax = fillPrice * soldQuantity * this.config.sellTaxRate;
      this.state.cash += fillPrice * soldQuantity - commission - tax;
    } else {
      const clientOrderId = `cp-s-${randomUUID().slice(0, 28)}`;
      const created = await this.client.createMarketOrder({ symbol, side: 'SELL', quantity: position.quantity, clientOrderId });
      orderId = created?.orderId;
      const fill = await this._awaitLiveFill(orderId, { symbol, side: 'SELL', reason });
      if (!fill) return null;
      if (!(fill.filledQuantity > 0)) {
        this.log.warn?.(`⚠️  [주식 실전] ${symbol} 매도 미체결 (${fill.status}) - 다음 사이클에 재시도`);
        return null;
      }
      soldQuantity = Math.min(position.quantity, Math.floor(fill.filledQuantity));
      fillPrice = fill.averageFilledPrice ?? price;
      commission = fill.commission || fillPrice * soldQuantity * this.config.commissionRate;
      tax = fill.tax || fillPrice * soldQuantity * this.config.sellTaxRate;
    }

    const entryCommissionShare = (position.entryCommission || 0) * (soldQuantity / position.quantity);
    const profit = (fillPrice - position.entryPrice) * soldQuantity - commission - tax - entryCommissionShare;
    const profitPercent = (profit / (position.entryPrice * soldQuantity)) * 100;
    const strategy = this._strategyFor(symbol);

    if (soldQuantity >= position.quantity) {
      strategy.closePosition(fillPrice, reason, { netProfit: profit });
      delete this.state.positions[symbol];
    } else {
      // LIVE 부분 체결: 남은 수량은 다음 사이클에 다시 매도한다.
      position.entryCommission = (position.entryCommission || 0) - entryCommissionShare;
      position.quantity -= soldQuantity;
      if (strategy.currentPosition) strategy.currentPosition.amount = position.quantity;
    }
    this._recordTrade({ action: 'SELL', symbol, quantity: soldQuantity, price: fillPrice, commission, tax, profit, profitPercent, reason, orderId });
    this._save();
    this.log.log?.(`🔴 [주식 ${this.mode === 'live' ? '실전' : '모의'}] ${symbol} ${soldQuantity}주 매도 @ ${Math.round(fillPrice).toLocaleString()}원 (${profit >= 0 ? '+' : ''}${Math.round(profit).toLocaleString()}원) - ${reason}`);
    return { symbol, soldQuantity, fillPrice, profit };
  }

  /**
   * LIVE 주문 체결 대기. 접수 후 조회가 실패하면 주문을 pendingOrders에 남기고
   * 신규 진입을 잠근 뒤, 다음 사이클의 resolvePendingOrders()가 결과를 장부에 반영한다.
   */
  async _awaitLiveFill(orderId, { symbol, side, reason }) {
    try {
      return await this.client.waitForOrderFill(orderId);
    } catch (error) {
      this.state.pendingOrders[orderId] = { symbol, side, reason, createdAt: new Date(this.now()).toISOString() };
      this.entriesPaused = true;
      this.pauseReason = 'pending_order_unresolved';
      this.lastError = `주문 체결 확인 실패 (${symbol} ${side}): ${error.message}`;
      this._save();
      return null;
    }
  }

  async resolvePendingOrders() {
    const pending = Object.entries(this.state.pendingOrders || {});
    if (pending.length === 0) return true;
    for (const [orderId, record] of pending) {
      let fill;
      try {
        fill = await this.client.waitForOrderFill(orderId, { timeoutMs: 3000 });
      } catch (error) {
        this.lastError = `미확인 주문 조회 실패 (${record.symbol}): ${error.message}`;
        return false;
      }
      delete this.state.pendingOrders[orderId];
      const quantity = Math.floor(fill.filledQuantity || 0);
      const price = fill.averageFilledPrice;
      if (quantity > 0 && price) {
        if (record.side === 'BUY') {
          const existing = this.state.positions[record.symbol];
          const total = (existing?.quantity || 0) + quantity;
          const avg = existing ? ((existing.entryPrice * existing.quantity) + price * quantity) / total : price;
          this.state.positions[record.symbol] = {
            ...(existing || {}),
            quantity: total,
            entryPrice: avg,
            entryCommission: (existing?.entryCommission || 0) + (fill.commission || 0),
            entryTime: existing?.entryTime || new Date(this.now()).toISOString(),
            lastPrice: price,
            orderId,
            reason: record.reason
          };
          const strategy = this._strategyFor(record.symbol);
          if (strategy.currentPosition) {
            strategy.currentPosition.amount = total;
            strategy.currentPosition.entryPrice = avg;
          } else {
            strategy.openPosition(avg, total, 'BUY');
          }
          this._recordTrade({ action: 'BUY', symbol: record.symbol, quantity, price, commission: fill.commission, reason: record.reason, orderId, recovered: true });
        } else {
          const position = this.state.positions[record.symbol];
          if (position) {
            const sold = Math.min(position.quantity, quantity);
            const share = (position.entryCommission || 0) * (sold / position.quantity);
            const profit = (price - position.entryPrice) * sold - (fill.commission || 0) - (fill.tax || 0) - share;
            position.quantity -= sold;
            position.entryCommission = (position.entryCommission || 0) - share;
            const strategy = this._strategyFor(record.symbol);
            if (position.quantity <= 0) {
              strategy.closePosition(price, record.reason, { netProfit: profit });
              delete this.state.positions[record.symbol];
            } else if (strategy.currentPosition) {
              strategy.currentPosition.amount = position.quantity;
            }
            this._recordTrade({ action: 'SELL', symbol: record.symbol, quantity: sold, price, profit, reason: record.reason, orderId, recovered: true });
          }
        }
      }
    }
    this._save();
    if (this.pauseReason === 'pending_order_unresolved') {
      this.entriesPaused = false;
      this.pauseReason = null;
    }
    return true;
  }

  _recordTrade(trade) {
    this.state.trades.push({ ...trade, at: new Date(this.now()).toISOString() });
    if (this.state.trades.length > MAX_TRADE_HISTORY) {
      this.state.trades = this.state.trades.slice(-MAX_TRADE_HISTORY);
    }
  }

  // ---------- 상태/통계 ----------

  getStatistics() {
    const sells = this.state.trades.filter(trade => trade.action === 'SELL');
    const wins = sells.filter(trade => trade.profit > 0).length;
    const totalProfit = sells.reduce((sum, trade) => sum + (Number(trade.profit) || 0), 0);
    return {
      totalTrades: sells.length,
      winningTrades: wins,
      winRate: sells.length > 0 ? (wins / sells.length) * 100 : 0,
      totalProfit: Math.round(totalProfit)
    };
  }

  getStatus() {
    const positions = Object.entries(this.state.positions).map(([symbol, position]) => ({
      symbol,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      lastPrice: position.lastPrice ?? null,
      entryTime: position.entryTime,
      unrealizedProfit: position.lastPrice
        ? Math.round((position.lastPrice - position.entryPrice) * position.quantity)
        : null
    }));
    const positionsValue = positions.reduce((sum, p) => sum + (p.lastPrice ?? p.entryPrice) * p.quantity, 0);
    const cash = this.mode === 'paper' ? Math.round(this.state.cash) : null;
    return {
      mode: this.mode,
      running: this.isRunning,
      desiredRunning: this.state.desiredRunning !== false,
      entriesPaused: this.entriesPaused,
      pauseReason: this.pauseReason,
      pendingOrders: Object.keys(this.state.pendingOrders || {}).length,
      market: this.lastMarketState,
      lastCycleAt: this.lastCycleAt,
      lastError: this.lastError,
      cash,
      initialSeedMoney: this.state.initialSeedMoney,
      totalAssets: cash !== null ? Math.round(cash + positionsValue) : null,
      positions,
      maxPositions: this.config.maxPositions,
      statistics: this.getStatistics(),
      recentTrades: this.state.trades.slice(-20).reverse(),
      recentSignals: this.lastSignals.slice(0, 10)
    };
  }

  /** 모의투자 시드 재설정 (보유 포지션이 없을 때만). */
  resetPaper(seedMoney) {
    if (this.mode !== 'paper') throw new Error('실전 계좌는 초기화할 수 없습니다.');
    if (this.positionCount() > 0) throw new Error('보유 포지션이 있어 초기화할 수 없습니다.');
    const seed = Math.max(0, Number(seedMoney) || this.config.seedMoney);
    const desiredRunning = this.state.desiredRunning;
    this.state = { ...emptyState('paper', seed), desiredRunning };
    this.strategies.clear();
    this._save();
    return this.getStatus();
  }
}

export default StockTrader;
