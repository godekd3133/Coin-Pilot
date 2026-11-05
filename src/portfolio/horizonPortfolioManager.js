// 기간별 포트폴리오 실시간 엔진 (코인·주식 공용, 모의·실전 공용).
//
// 흐름(사이클마다)
//  1) 실전이면 미확인 주문을 먼저 해결하고, 주기적으로 거래소 보유잔고와 장부를 대사한다.
//  2) 현재가로 모든 보유 포지션의 손절/트레일링 가격을 즉시 점검한다(봉 마감을 기다리지 않음).
//  3) 슬리브별로 새 봉이 완료됐으면: 봉 데이터 → 차트 분석 → 청산 판단 → 진입/리밸런싱.
//  4) 장부 저장, (코인 실전) 스캘퍼에 보유 수량 예약 등록.
//
// 안전 계약
//  - 이 엔진은 자신이 연 포지션만 매도한다(포지션 키 = 슬리브:종목).
//  - 실전 주문 체결을 확인하지 못하면 pendingOrders에 남기고 신규 진입을 잠근다.
//  - 거래소 대사 실패 시 신규 진입을 잠근다(청산은 계속 시도).
//  - 코인 최소 주문(5,000원)은 손절 거리까지 고려해 진입금액을 올려 잡아, 손절 후에도 매도 가능하게 한다.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeDurableJson } from '../runtime/durableJson.js';
import { analyzeAt, evaluateExit, signalCandidates, rankTargets, initialStop, regimeAllowsEntries, positionBudget, passesTickCost } from './horizonStrategy.js';
import { minimumBars } from './chartAnalysis.js';
import { HORIZON_KEYS, INTERVAL_MS, normalizeWeights } from './horizonProfiles.js';

const STATE_VERSION = 1;
const MAX_TRADES = 1000;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const PENDING_NOT_FOUND_GRACE_MS = 60 * 1000;
const PENDING_HOLDINGS_FALLBACK_MS = 10 * 60 * 1000;

function positionKey(sleeve, symbol) {
  return `${sleeve}:${symbol}`;
}

/** 해당 주기에서 마지막으로 "완료된" 봉의 시작 시각. 주봉은 월요일(UTC) 시작. */
export function latestCompletedBarStart(interval, nowMs, assetClass = 'coin') {
  if (interval === '1w') {
    const date = new Date(nowMs);
    const day = (date.getUTCDay() + 6) % 7;
    const weekStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
    return weekStart - INTERVAL_MS['1w'];
  }
  if (interval === '1d' && assetClass === 'stock') {
    // 국내 일봉은 KST 거래일 기준, 15:30 마감 후 완료로 본다.
    const kst = nowMs + 9 * 3600 * 1000;
    const dayStartKst = Math.floor(kst / INTERVAL_MS['1d']) * INTERVAL_MS['1d'];
    const closeKst = dayStartKst + (15 * 60 + 30) * 60 * 1000;
    const completedKst = kst >= closeKst ? dayStartKst : dayStartKst - INTERVAL_MS['1d'];
    return completedKst - 9 * 3600 * 1000;
  }
  const size = INTERVAL_MS[interval];
  return Math.floor(nowMs / size) * size - size;
}

function emptyState(assetClass, mode, seed) {
  return {
    version: STATE_VERSION,
    assetClass,
    mode,
    cash: mode === 'paper' ? seed : null,
    initialSeedMoney: mode === 'paper' ? seed : null,
    positions: {},
    sleeves: {},
    pendingOrders: {},
    trades: [],
    desiredRunning: true,
    updatedAt: new Date().toISOString()
  };
}

export class HorizonPortfolioManager {
  /**
   * @param {object} deps
   * @param {'coin'|'stock'} deps.assetClass
   * @param {'paper'|'live'} deps.mode
   * @param {{getBars(symbol, interval, count): Promise<Array>}} deps.loader
   * @param {object} deps.broker 시세/현금/주문 어댑터 (brokers.js)
   * @param {object} deps.profiles resolveHorizonProfiles 결과
   * @param {() => Promise<string[]>} deps.universeProvider 진입 후보 종목
   * @param {object} deps.config
   */
  constructor({
    assetClass,
    mode,
    loader,
    broker,
    profiles,
    universeProvider,
    marketGate = null,
    onReservationsChanged = null,
    config = {},
    stateFile = null,
    now = Date.now,
    log = console
  }) {
    this.assetClass = assetClass;
    this.mode = mode;
    this.loader = loader;
    this.broker = broker;
    this.profiles = profiles;
    this.universeProvider = universeProvider;
    this.marketGate = marketGate;
    this.onReservationsChanged = onReservationsChanged;
    this.stateFile = stateFile;
    this.now = now;
    this.log = log;
    this.config = {
      capitalRatio: 0.6,
      paperSeedMoney: 1_000_000,
      enabledSleeves: HORIZON_KEYS,
      benchmark: assetClass === 'coin' ? 'KRW-BTC' : '069500',
      minOrderAmount: assetClass === 'coin' ? 5000 : 0,
      ...config
    };
    this.weights = normalizeWeights(profiles, this.config.enabledSleeves);
    this.state = this._loadState();
    this.isRunning = false;
    this.entriesPaused = mode === 'live';
    this.pauseReason = mode === 'live' ? 'exchange_state_unverified' : null;
    this.lastReconcileAt = 0;
    this.lastCycleAt = null;
    this.lastError = null;
    this.lastAnalyses = {};
    this._barCache = new Map();
    this._cycleInFlight = null;
  }

  // ---------- 장부 ----------

  _loadState() {
    const seed = Math.max(0, Number(this.config.paperSeedMoney) || 0);
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return emptyState(this.assetClass, this.mode, seed);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (error) {
      throw new Error(`기간별 포트폴리오 장부를 읽을 수 없습니다 (${this.stateFile}): ${error.message}`, { cause: error });
    }
    if (parsed?.version !== STATE_VERSION || parsed.mode !== this.mode || parsed.assetClass !== this.assetClass) {
      throw new Error(`기간별 포트폴리오 장부의 버전/모드가 다릅니다 (${this.stateFile}).`);
    }
    return { ...emptyState(this.assetClass, this.mode, seed), ...parsed };
  }

  _save() {
    this.state.updatedAt = new Date(this.now()).toISOString();
    if (this.stateFile) writeDurableJson(this.stateFile, this.state);
    this._publishReservations();
  }

  _publishReservations() {
    if (typeof this.onReservationsChanged !== 'function') return;
    this.onReservationsChanged(this.reservedQuantities());
  }

  /** 종목별 이 엔진의 보유 수량 합(미확인 매수 주문 포함 안 함). */
  reservedQuantities() {
    const totals = {};
    for (const position of Object.values(this.state.positions)) {
      totals[position.symbol] = (totals[position.symbol] || 0) + position.quantity;
    }
    return totals;
  }

  _sleeveState(key) {
    this.state.sleeves[key] ||= { lastBarStart: null, rebalanceCounter: 0 };
    return this.state.sleeves[key];
  }

  _recordTrade(trade) {
    this.state.trades.push({ ...trade, at: new Date(this.now()).toISOString() });
    if (this.state.trades.length > MAX_TRADES) this.state.trades = this.state.trades.slice(-MAX_TRADES);
  }

  // ---------- 생명주기 ----------

  async start({ source = 'operator' } = {}) {
    if (this.isRunning) return this.getStatus();
    this.state.desiredRunning = true;
    this._save();
    this.isRunning = true;
    this.lastError = null;
    if (this.mode === 'live') await this.reconcile(true);
    this.log.log?.(`🧭 [기간별 ${this.assetClass === 'coin' ? '코인' : '주식'} ${this.mode === 'live' ? '실전' : '모의'}] 시작 (${source})`);
    return this.getStatus();
  }

  stop({ source = 'operator', persistIntent = true } = {}) {
    this.isRunning = false;
    if (persistIntent) {
      this.state.desiredRunning = false;
      this._save();
    }
    this.log.log?.(`⏹️  [기간별 ${this.assetClass} ${this.mode}] 중지 (${source})`);
    return this.getStatus();
  }

  // ---------- 실전 대사 ----------

  async reconcile(force = false) {
    if (this.mode !== 'live') return true;
    if (!force && this.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS && this.pauseReason !== 'exchange_state_unverified') return true;
    try {
      await this.resolvePendingOrders();
      const held = await this.broker.getHeldQuantities();
      const otherEngine = (await this.broker.getOtherEngineQuantities?.()) || {};
      let changed = false;
      const bySymbol = new Map();
      for (const [key, position] of Object.entries(this.state.positions)) {
        if (!bySymbol.has(position.symbol)) bySymbol.set(position.symbol, []);
        bySymbol.get(position.symbol).push([key, position]);
      }
      for (const [symbol, entries] of bySymbol) {
        const available = Math.max(0, (held[symbol] || 0) - (otherEngine[symbol] || 0));
        let tracked = entries.reduce((sum, [, position]) => sum + position.quantity, 0);
        if (tracked <= available * 1.001 + 1e-9) continue;
        // 외부에서 매도된 수량만큼 큰 포지션부터 줄인다.
        this.log.warn?.(`⚠️  [기간별 실전] ${symbol} 장부 ${tracked} > 계좌 ${available}: 장부를 계좌 기준으로 줄입니다.`);
        entries.sort((a, b) => b[1].quantity - a[1].quantity);
        for (const [key, position] of entries) {
          if (tracked <= available + 1e-9) break;
          const reduce = Math.min(position.quantity, tracked - available);
          position.quantity -= reduce;
          tracked -= reduce;
          if (position.quantity <= 1e-12) delete this.state.positions[key];
        }
        changed = true;
      }
      if (changed) this._save(); else this._publishReservations();
      this.lastReconcileAt = this.now();
      const pending = Object.keys(this.state.pendingOrders).length > 0;
      this.entriesPaused = pending;
      this.pauseReason = pending ? 'pending_order_unresolved' : null;
      return true;
    } catch (error) {
      this.entriesPaused = true;
      this.pauseReason = 'exchange_state_unverified';
      this.lastError = `거래소 대사 실패: ${error.message}`;
      return false;
    }
  }

  /**
   * 미확인 주문 해결.
   *  - 거래소 조회로 체결 결과를 찾으면 장부에 반영
   *  - 일정 시간 후에도 주문이 없으면(전송 전 중단) 폐기
   *  - 10분 넘게 확인이 안 되면 보유잔고 차이로 체결 수량을 확정(마지막 안전망)
   */
  async resolvePendingOrders() {
    const entries = Object.entries(this.state.pendingOrders);
    if (entries.length === 0) return;
    for (const [clientOrderId, record] of entries) {
      const age = this.now() - Date.parse(record.createdAt || 0);
      const fill = await this.broker.resolveOrder(record);
      if (fill?.notFound) {
        if (age >= PENDING_NOT_FOUND_GRACE_MS) delete this.state.pendingOrders[clientOrderId];
        continue;
      }
      if (!fill || fill.unresolved) {
        if (age >= PENDING_HOLDINGS_FALLBACK_MS) await this._resolveByHoldings(clientOrderId, record);
        continue;
      }
      delete this.state.pendingOrders[clientOrderId];
      if (fill.quantity > 0) {
        if (record.side === 'BUY') this._applyBuy(record, fill, { recovered: true });
        else this._applySell(record.key, fill, record.reason, { recovered: true });
      }
    }
    this._save();
  }

  async _resolveByHoldings(clientOrderId, record) {
    const held = await this.broker.getHeldQuantities();
    const other = (await this.broker.getOtherEngineQuantities?.()) || {};
    const tracked = Object.values(this.state.positions)
      .filter(position => position.symbol === record.symbol)
      .reduce((sum, position) => sum + position.quantity, 0);
    const available = Math.max(0, (held[record.symbol] || 0) - (other[record.symbol] || 0));
    const prices = await this.broker.getPrices([record.symbol]).catch(() => new Map());
    const price = prices.get(record.symbol);
    if (record.side === 'BUY') {
      const excess = available - tracked;
      if (excess > 1e-9 && Number.isFinite(price)) {
        this._applyBuy(record, { quantity: excess, price, cost: excess * price }, { recovered: 'holdings_delta' });
      }
    } else {
      const position = this.state.positions[record.key];
      if (position) {
        const keepForOthers = tracked - position.quantity;
        const remaining = Math.max(0, available - keepForOthers);
        const sold = position.quantity - remaining;
        if (sold > 1e-9 && Number.isFinite(price)) {
          this._applySell(record.key, { quantity: sold, price, proceeds: sold * price }, record.reason, { recovered: 'holdings_delta' });
        }
      }
    }
    delete this.state.pendingOrders[clientOrderId];
    this.log.warn?.(`⚠️  [기간별 실전] ${record.symbol} ${record.side} 주문을 보유잔고 차이로 확정했습니다.`);
  }

  // ---------- 자본 ----------

  async _capital(priceMap) {
    const cash = await this.broker.getAvailableCash(this.state);
    let positionsValue = 0;
    for (const position of Object.values(this.state.positions)) {
      positionsValue += position.quantity * (priceMap.get(position.symbol) ?? position.lastPrice ?? position.entryPrice);
    }
    if (this.mode === 'paper') {
      return { cash, horizonCapital: cash + positionsValue };
    }
    const accountEquity = await this.broker.getAccountEquity(priceMap);
    const horizonCapital = Math.max(0, accountEquity * this.config.capitalRatio);
    return { cash, horizonCapital };
  }

  _sleeveDeployed(sleeve) {
    return Object.values(this.state.positions)
      .filter(position => position.sleeve === sleeve)
      .reduce((sum, position) => sum + position.cost, 0);
  }

  /** 진입 금액. 0이면 진입 불가. */
  _entryAmount(sleeve, profile, { cash, horizonCapital }, price, stopPrice) {
    const sleeveBudget = horizonCapital * (this.weights[sleeve] || 0);
    const remaining = sleeveBudget - this._sleeveDeployed(sleeve);
    // Same risk-based size as the backtest: the loss at the stop is about
    // riskPerTradePercent of the sleeve, capped by the equal slot.
    const slot = positionBudget({
      sleeveEquity: sleeveBudget,
      maxPositions: profile.maxPositions,
      riskPerTradePercent: profile.riskPerTradePercent,
      entryPrice: price,
      stopPrice
    });
    let amount = Math.min(slot, remaining, cash * 0.98);
    if (this.assetClass === 'coin') {
      const stopDistance = Math.min(0.5, Math.max(0, (price - stopPrice) / price));
      const minEntry = Math.ceil((this.config.minOrderAmount / (1 - stopDistance - 0.01)) / 100) * 100;
      // 소액 시드: 슬리브 예산이 최소 진입액의 70% 이상 남아 있으면 최소 진입액으로 올린다.
      if (amount < minEntry && remaining >= minEntry * 0.7 && cash * 0.98 >= minEntry) amount = minEntry;
      return amount >= minEntry ? Math.floor(amount) : 0;
    }
    // 주식: 1주 단위. 예산이 1주보다 작아도 남은 슬리브 예산·현금으로 1주를 살 수 있으면 1주.
    const unit = price * 1.002;
    if (amount < unit && remaining >= unit * 0.7 && cash * 0.98 >= unit) amount = unit;
    return amount >= unit ? amount : 0;
  }

  // ---------- 매매 반영 ----------

  _applyBuy(record, fill, extra = {}) {
    const key = record.key;
    const existing = this.state.positions[key];
    const quantity = (existing?.quantity || 0) + fill.quantity;
    const cost = (existing?.cost || 0) + fill.cost;
    this.state.positions[key] = {
      sleeve: record.sleeve,
      symbol: record.symbol,
      quantity,
      entryPrice: existing ? (existing.entryPrice * existing.quantity + fill.price * fill.quantity) / quantity : fill.price,
      cost,
      entryTime: existing?.entryTime || new Date(this.now()).toISOString(),
      stopPrice: existing?.stopPrice ?? record.stopPrice,
      highestClose: existing?.highestClose ?? fill.price,
      barsHeld: existing?.barsHeld || 0,
      lastPrice: fill.price,
      score: record.score ?? null
    };
    this._recordTrade({ action: 'BUY', sleeve: record.sleeve, symbol: record.symbol, quantity: fill.quantity, price: fill.price, cost: fill.cost, reason: record.reason, ...extra });
  }

  _applySell(key, fill, reason, extra = {}) {
    const position = this.state.positions[key];
    if (!position) return null;
    const sold = Math.min(position.quantity, fill.quantity);
    const costShare = position.cost * (sold / position.quantity);
    const profit = fill.proceeds - costShare;
    position.quantity -= sold;
    position.cost -= costShare;
    if (position.quantity <= 1e-12 || (this.assetClass === 'stock' && position.quantity < 1)) delete this.state.positions[key];
    this._recordTrade({ action: 'SELL', sleeve: position.sleeve, symbol: position.symbol, quantity: sold, price: fill.price, proceeds: fill.proceeds, profit, returnPercent: (profit / costShare) * 100, reason, ...extra });
    return { sold, profit };
  }

  _newOrder(fields) {
    const clientOrderId = `hz-${randomUUID().replace(/-/g, '').slice(0, 30)}`;
    return { ...fields, clientOrderId, orderId: null, createdAt: new Date(this.now()).toISOString() };
  }

  /**
   * 실전 주문 공통 처리: 전송 전에 미확인 주문으로 먼저 기록(크래시 대비)하고,
   * 체결이 확정되면 기록을 지운다. 확정되지 않으면 기록을 남기고 신규 진입을 잠근다.
   */
  async _execute(order, dispatch) {
    if (this.mode === 'live') {
      this.state.pendingOrders[order.clientOrderId] = order;
      this._save();
    }
    let result;
    try {
      result = await dispatch(order);
    } catch (error) {
      result = this.mode === 'live' ? { pendingOrderId: order.clientOrderId } : { quantity: 0, error: error.message };
    }
    if (result?.pendingOrderId) {
      if (result.orderId) order.orderId = result.orderId;
      this.state.pendingOrders[order.clientOrderId] = order;
      this.entriesPaused = true;
      this.pauseReason = 'pending_order_unresolved';
      this._save();
      return null;
    }
    delete this.state.pendingOrders[order.clientOrderId];
    return result;
  }

  async _buy(sleeve, symbol, price, amount, analysis, profile, reason) {
    const stopPrice = initialStop(price, analysis, profile);
    const order = this._newOrder({ key: positionKey(sleeve, symbol), sleeve, symbol, side: 'BUY', stopPrice, score: analysis?.score ?? null, reason });
    const result = await this._execute(order, o => this.broker.buy(symbol, amount, price, o, this.state));
    if (!result || !(result.quantity > 0)) {
      if (result?.error) this.lastError = `${symbol} 매수 실패: ${result.error}`;
      this._save();
      return null;
    }
    this._applyBuy(order, result);
    this._save();
    this.log.log?.(`🟢 [기간별 ${sleeve} ${this.mode}] ${symbol} 매수 ${Math.round(result.cost).toLocaleString()}원 @ ${result.price} — ${reason}`);
    return result;
  }

  async _sell(key, price, reason) {
    const position = this.state.positions[key];
    if (!position) return null;
    const order = this._newOrder({ key, sleeve: position.sleeve, symbol: position.symbol, side: 'SELL', reason });
    if (this.assetClass === 'coin' && position.quantity * price < this.config.minOrderAmount) {
      position.stuckBelowMinimum = true;
      this.lastError = `${position.symbol} 평가금액이 최소 주문금액 미만이라 매도 대기 중`;
      return null;
    }
    const result = await this._execute(order, o => this.broker.sell(position.symbol, position.quantity, price, o, this.state));
    if (!result) return null;
    if (result.belowMinimum) {
      position.stuckBelowMinimum = true;
      this.lastError = `${position.symbol} 평가금액이 최소 주문금액 미만이라 매도 대기 중`;
      this._save();
      return null;
    }
    if (!(result.quantity > 0)) {
      if (result.error) this.lastError = `${position.symbol} 매도 실패: ${result.error}`;
      this._save();
      return null;
    }
    position.stuckBelowMinimum = false;
    const applied = this._applySell(key, result, reason);
    this._save();
    this.log.log?.(`🔴 [기간별 ${position.sleeve} ${this.mode}] ${position.symbol} 매도 (${applied.profit >= 0 ? '+' : ''}${Math.round(applied.profit).toLocaleString()}원) — ${reason}`);
    return applied;
  }

  // ---------- 데이터 ----------

  async _bars(symbol, profile, barStart) {
    const cacheKey = `${profile.interval}:${symbol}`;
    const cached = this._barCache.get(cacheKey);
    if (cached && cached.barStart === barStart) return cached.bars;
    const count = profile.interval === '1w' ? 160 : Math.max(320, minimumBars(profile.periods) * 3);
    const bars = await this.loader.getBars(symbol, profile.interval, count);
    this._barCache.set(cacheKey, { barStart, bars });
    return bars;
  }

  // ---------- 사이클 ----------

  async runCycle() {
    if (!this.isRunning) return null;
    if (this._cycleInFlight) return this._cycleInFlight;
    this._cycleInFlight = this._runCycle()
      .catch(error => {
        this.lastError = error.message;
        this.log.error?.(`❌ [기간별 ${this.assetClass} ${this.mode}] 사이클 오류: ${error.message}`);
      })
      .finally(() => { this._cycleInFlight = null; });
    return this._cycleInFlight;
  }

  async _runCycle() {
    const nowMs = this.now();
    this.lastCycleAt = new Date(nowMs).toISOString();
    const gate = this.marketGate ? await this.marketGate() : { canTrade: true, canEnter: true };
    if (!gate.canTrade) {
      this.lastGate = gate;
      return;
    }
    this.lastGate = gate;
    if (this.mode === 'live') await this.reconcile();

    const universe = (await this.universeProvider()) || [];
    const heldSymbols = [...new Set(Object.values(this.state.positions).map(position => position.symbol))];
    const priceMap = await this.broker.getPrices([...new Set([...heldSymbols, ...universe, this.config.benchmark])]);

    // 1) 실시간 손절 점검 (봉 마감 전이라도 손절가 이탈 시 즉시 청산)
    for (const [key, position] of Object.entries({ ...this.state.positions })) {
      const price = priceMap.get(position.symbol);
      if (!Number.isFinite(price)) continue;
      position.lastPrice = price;
      if (price <= position.stopPrice) await this._sell(key, price, 'ATR 손절/트레일링 (실시간)');
    }

    // 2) 슬리브별 봉 마감 처리
    const capital = await this._capital(priceMap);
    for (const sleeve of this.config.enabledSleeves) {
      const profile = this.profiles[sleeve];
      if (!profile) continue;
      const barStart = latestCompletedBarStart(profile.interval, nowMs, this.assetClass);
      const sleeveState = this._sleeveState(sleeve);
      if (sleeveState.lastBarStart === barStart) continue;
      await this._processSleeveBar(sleeve, profile, barStart, universe, priceMap, capital, gate);
      sleeveState.lastBarStart = barStart;
      this._save();
    }
  }

  async _processSleeveBar(sleeve, profile, barStart, universe, priceMap, capital, gate) {
    const sleeveState = this._sleeveState(sleeve);
    const analyses = [];
    const symbols = [...new Set([...universe, ...Object.values(this.state.positions).filter(p => p.sleeve === sleeve).map(p => p.symbol)])];
    for (const symbol of symbols) {
      try {
        const bars = await this._bars(symbol, profile, barStart);
        // 상장 직후 등 이력이 짧은 종목은 지표가 불안정하므로 제외(워밍업 + 30봉 필요).
        const held = Object.values(this.state.positions).some(p => p.sleeve === sleeve && p.symbol === symbol);
        if (bars.length < minimumBars(profile.periods) + (held ? 0 : 30)) continue;
        analyses.push({ symbol, bar: bars.at(-1), analysis: analyzeAt(bars, bars.length - 1, profile.periods) });
      } catch (error) {
        this.lastError = `${symbol} ${profile.interval} 봉 조회 실패: ${error.message}`;
      }
    }
    let benchmarkAnalysis = null;
    if (profile.regimeFilter) {
      try {
        const bars = await this._bars(this.config.benchmark, profile, barStart);
        if (bars.length >= minimumBars(profile.periods)) benchmarkAnalysis = analyzeAt(bars, bars.length - 1, profile.periods);
      } catch {
        benchmarkAnalysis = null;
      }
    }
    const benchmarkOk = regimeAllowsEntries(benchmarkAnalysis);
    // New entries fail closed when the regime filter is on but the benchmark is missing.
    const entryRegimeOk = regimeAllowsEntries(benchmarkAnalysis, { required: Boolean(profile.regimeFilter) });
    this.lastAnalyses[sleeve] = {
      barStart: new Date(barStart).toISOString(),
      benchmarkRegime: benchmarkAnalysis?.regime ?? null,
      top: analyses
        .filter(item => item.analysis?.available)
        .sort((a, b) => b.analysis.score - a.analysis.score)
        .slice(0, 8)
        .map(item => ({ symbol: item.symbol, score: item.analysis.score, regime: item.analysis.regime, rsi: Math.round(item.analysis.rsi), atrPercent: Math.round(item.analysis.atrPercent * 100) / 100 }))
    };

    // 청산 판단 (완료 봉 기준)
    for (const [key, position] of Object.entries({ ...this.state.positions })) {
      if (position.sleeve !== sleeve) continue;
      const item = analyses.find(a => a.symbol === position.symbol);
      if (!item) continue;
      const decision = evaluateExit(position, item.bar, item.analysis, profile, { benchmarkOk });
      position.stopPrice = decision.stopPrice;
      position.highestClose = decision.highestClose;
      position.barsHeld = (position.barsHeld || 0) + 1;
      position.score = item.analysis?.score ?? position.score;
      if (decision.exit && gate.canTrade) {
        await this._sell(key, priceMap.get(position.symbol) ?? item.bar.close, decision.reason);
      }
    }

    // 진입/리밸런싱
    const shouldRebalance = profile.mode === 'signal' || sleeveState.rebalanceCounter % profile.rebalanceBars === 0;
    sleeveState.rebalanceCounter += 1;
    if (!shouldRebalance || !gate.canEnter || this.entriesPaused || (profile.regimeFilter && !entryRegimeOk)) return;
    if ((this.weights[sleeve] || 0) <= 0) return;

    const sleevePositions = () => Object.values(this.state.positions).filter(p => p.sleeve === sleeve);
    let entries;
    if (profile.mode === 'signal') {
      entries = signalCandidates(analyses, profile).map(item => item.symbol);
    } else {
      const { targets } = rankTargets(analyses, profile, sleevePositions().map(p => p.symbol));
      const targetSet = new Set(targets);
      for (const position of sleevePositions()) {
        if (!targetSet.has(position.symbol)) {
          await this._sell(positionKey(sleeve, position.symbol), priceMap.get(position.symbol) ?? position.lastPrice, '리밸런싱 제외');
        }
      }
      entries = targets;
    }
    for (const symbol of entries) {
      if (sleevePositions().length >= profile.maxPositions || this.entriesPaused) break;
      if (this.state.positions[positionKey(sleeve, symbol)]) continue;
      // One symbol is held by at most one sleeve, so overlapping sleeves cannot
      // stack a single coin into a large share of the portfolio.
      if (Object.values(this.state.positions).some(position => position.symbol === symbol)) continue;
      const item = analyses.find(a => a.symbol === symbol);
      const price = priceMap.get(symbol);
      if (!item || !Number.isFinite(price)) continue;
      if (!passesTickCost(price, this.assetClass)) continue;
      const refreshedCash = await this.broker.getAvailableCash(this.state);
      const amount = this._entryAmount(sleeve, profile, { ...capital, cash: refreshedCash }, price, initialStop(price, item.analysis, profile));
      if (amount <= 0) continue;
      await this._buy(sleeve, symbol, price, amount, item.analysis, profile, `${profile.label} 차트 점수 ${item.analysis.score} (${item.analysis.regime})`);
    }
  }

  /** 연구 결과 반영. 비활성(비중 0)이 된 슬리브의 기존 포지션은 청산 규칙으로 계속 관리된다. */
  updateProfiles(profiles, { validated = true, source = null } = {}) {
    this.profiles = profiles;
    this.weights = validated ? normalizeWeights(profiles, this.config.enabledSleeves) : Object.fromEntries(HORIZON_KEYS.map(key => [key, 0]));
    this.paramsValidated = validated;
    this.paramsSource = source;
  }

  // ---------- 상태 ----------

  getStatus() {
    const positions = Object.values(this.state.positions).map(position => ({
      sleeve: position.sleeve,
      symbol: position.symbol,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      lastPrice: position.lastPrice ?? null,
      cost: Math.round(position.cost),
      stopPrice: position.stopPrice,
      score: position.score,
      barsHeld: position.barsHeld,
      entryTime: position.entryTime,
      unrealizedProfit: position.lastPrice ? Math.round(position.lastPrice * position.quantity - position.cost) : null,
      stuckBelowMinimum: position.stuckBelowMinimum === true
    }));
    const sells = this.state.trades.filter(trade => trade.action === 'SELL');
    const bySleeve = {};
    for (const key of HORIZON_KEYS) {
      const sleeveSells = sells.filter(trade => trade.sleeve === key);
      bySleeve[key] = {
        label: this.profiles[key]?.label,
        enabled: this.config.enabledSleeves.includes(key) && (this.weights[key] || 0) > 0,
        weight: Math.round((this.weights[key] || 0) * 1000) / 10,
        interval: this.profiles[key]?.interval,
        positions: positions.filter(p => p.sleeve === key).length,
        realizedProfit: Math.round(sleeveSells.reduce((s, t) => s + (t.profit || 0), 0)),
        trades: sleeveSells.length,
        winRate: sleeveSells.length ? Math.round((sleeveSells.filter(t => t.profit > 0).length / sleeveSells.length) * 1000) / 10 : 0,
        lastAnalysis: this.lastAnalyses[key] || null
      };
    }
    const positionsValue = positions.reduce((sum, p) => sum + (p.lastPrice ?? p.entryPrice) * p.quantity, 0);
    return {
      assetClass: this.assetClass,
      mode: this.mode,
      running: this.isRunning,
      desiredRunning: this.state.desiredRunning !== false,
      entriesPaused: this.entriesPaused,
      pauseReason: this.pauseReason,
      pendingOrders: Object.keys(this.state.pendingOrders).length,
      lastCycleAt: this.lastCycleAt,
      lastError: this.lastError,
      gate: this.lastGate || null,
      capitalRatio: this.config.capitalRatio,
      paramsValidated: this.paramsValidated !== false,
      paramsSource: this.paramsSource || null,
      cash: this.mode === 'paper' ? Math.round(this.state.cash) : null,
      initialSeedMoney: this.state.initialSeedMoney,
      totalAssets: this.mode === 'paper' ? Math.round(this.state.cash + positionsValue) : null,
      sleeves: bySleeve,
      positions,
      recentTrades: this.state.trades.slice(-30).reverse()
    };
  }

  resetPaper(seedMoney) {
    if (this.mode !== 'paper') throw new Error('실전 계좌는 초기화할 수 없습니다.');
    if (Object.keys(this.state.positions).length > 0) throw new Error('보유 포지션이 있어 초기화할 수 없습니다.');
    const desiredRunning = this.state.desiredRunning;
    this.state = { ...emptyState(this.assetClass, 'paper', Math.max(10000, Number(seedMoney) || this.config.paperSeedMoney)), desiredRunning };
    this._save();
    return this.getStatus();
  }
}

export default HorizonPortfolioManager;
