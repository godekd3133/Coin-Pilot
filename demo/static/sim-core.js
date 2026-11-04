/*
 * Coin Pilot static demo simulator.
 *
 * Pure in-browser model behind the demo's fake /api/* responses. It never
 * touches the trading engine, a network or real market data. Every price is
 * produced by a seeded PRNG, so identical seed + identical actions replay the
 * same path. The entry/exit rule is a deliberately simplified teaching rule,
 * not the production strategy.
 */
(function (root) {
  'use strict';

  const DEFAULT_SEED = 20260929;
  const SEED_MONEY = 10_000_000;
  const FEE_RATE = 0.0005;
  const SLIPPAGE_RATE = 0.001;
  const TAKE_PROFIT = 0.012;
  const STOP_LOSS = 0.01;
  const MAX_HOLD_TICKS = 30;
  const MAX_POSITIONS = 3;
  const INVESTMENT_RATIO = 0.15;
  const MAX_CONSECUTIVE_LOSSES = 3;
  const COOLDOWN_TICKS = 240;
  const MIN_ORDER = 5000;
  const HISTORY_LIMIT = 240;
  const WARMUP_TICKS = 180;

  const MARKETS = [
    ['KRW-DEMOA', '예시코인 A', 48_200_000, 0.0028],
    ['KRW-DEMOB', '예시코인 B', 3_140_000, 0.0034],
    ['KRW-DEMOC', '예시코인 C', 218_500, 0.0042],
    ['KRW-DEMOD', '예시코인 D', 12_350, 0.0048],
    ['KRW-DEMOE', '예시코인 E', 1_482, 0.0052],
    ['KRW-DEMOF', '예시코인 F', 86.4, 0.0058]
  ];

  // mulberry32: small, portable, and its whole state is one integer.
  function nextRandom(state) {
    state.rng = (state.rng + 0x6D2B79F5) | 0;
    let t = state.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function gaussian(state) {
    const u = Math.max(nextRandom(state), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * nextRandom(state));
  }

  function roundPrice(price) {
    if (price >= 1_000_000) return Math.round(price / 500) * 500;
    if (price >= 100_000) return Math.round(price / 50) * 50;
    if (price >= 1_000) return Math.round(price);
    if (price >= 100) return Math.round(price * 10) / 10;
    return Math.round(price * 100) / 100;
  }

  function rsi(closes, period = 14) {
    if (closes.length <= period) return 50;
    let gain = 0;
    let loss = 0;
    for (let i = closes.length - period; i < closes.length; i += 1) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gain += diff; else loss -= diff;
    }
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  }

  // Oversold + bullish candle + rebound from the recent low. Pure so the live
  // loop and the backtest evaluate exactly the same teaching rule.
  function evaluateSignal(closes, candle) {
    const value = rsi(closes);
    const oversold = value < 42;
    const bullish = candle.close > candle.open;
    const recentLow = Math.min(...closes.slice(-8));
    const rebound = candle.close > recentLow * 1.0015;
    return { rsi: value, oversold, bullish, rebound, confirmed: oversold && bullish && rebound };
  }

  function stepPrice(rand, market, regime) {
    const logDeviation = Math.log(market.price / market.base);
    let drift = -0.012 * logDeviation;
    let noise = rand.gaussian() * market.vol;
    if (market.dip > 0) { drift -= market.vol * 0.9; market.dip -= 1; }
    else if (rand.next() < 0.035) market.dip = 4;
    if (regime === 'crash') {
      market.crashStep = (market.crashStep || 0) + 1;
      noise *= 0.2;
      drift = market.crashStep % 6 === 0 ? 0.0065 : -0.0042;
    }
    return market.price * Math.exp(drift + noise);
  }

  function randomSource(state) {
    return { next: () => nextRandom(state), gaussian: () => gaussian(state) };
  }

  function tickMarket(state, market) {
    const open = market.price;
    const raw = stepPrice(randomSource(state), market, state.regime);
    const close = roundPrice(raw);
    market.rawPrice = raw;
    market.price = raw;
    market.last = close;
    const wick = Math.abs(raw - open) * 0.4 + open * market.vol * 0.25;
    const candle = {
      open: roundPrice(open),
      high: roundPrice(Math.max(open, raw) + wick * nextRandom(state)),
      low: roundPrice(Math.min(open, raw) - wick * nextRandom(state)),
      close,
      volume: Math.round((800 + nextRandom(state) * 2400) * 100) / 100
    };
    candle.high = Math.max(candle.high, candle.open, candle.close);
    candle.low = Math.min(candle.low, candle.open, candle.close);
    market.candles.push(candle);
    if (market.candles.length > HISTORY_LIMIT) market.candles.shift();
    return candle;
  }

  function initialState(seed) {
    const state = {
      version: 1,
      seed,
      rng: seed | 0,
      tick: 0,
      regime: 'normal',
      crashLeft: 0,
      krw: SEED_MONEY,
      markets: {},
      positions: {},
      trades: [],
      log: [],
      history: [],
      todayBuy: 0,
      todaySell: 0,
      realized: 0,
      session: { active: false, started: false, startedAt: null, stoppedAt: null, baseline: SEED_MONEY, closed: 0, wins: 0, grossLoss: 0 },
      funnel: { availableWindows: 0, oversoldWindows: 0, bullishWindows: 0, priceReboundWindows: 0, confirmedWindows: 0 },
      circuit: { enabled: true, lossCount: 0, maxLosses: MAX_CONSECUTIVE_LOSSES, coolingDown: false, untilTick: null, trippedAt: null, trips: 0 },
      blockedEntries: 0,
      lastEvents: [],
      optimization: { enabled: false, interval: 3600000 }
    };
    MARKETS.forEach(([coin, name, base, vol]) => {
      state.markets[coin] = { coin, name, base, vol, price: base, last: roundPrice(base), dip: 0, candles: [] };
    });
    for (let i = 0; i < WARMUP_TICKS; i += 1) {
      Object.values(state.markets).forEach(market => tickMarket(state, market));
    }
    return state;
  }

  function createDemoSim({ seed = DEFAULT_SEED, savedState = null, now = () => Date.now() } = {}) {
    let state = savedState && savedState.version === 1 && savedState.seed === seed ? savedState : initialState(seed);
    const emitQueue = [];

    const iso = (ms = now()) => new Date(ms).toISOString();
    const emit = (event, payload) => emitQueue.push([event, payload]);
    const pushLog = (kind, text) => {
      state.log.unshift({ at: iso(), kind, text });
      if (state.log.length > 60) state.log.length = 60;
    };
    const symbol = coin => coin.replace('KRW-', '');
    const lastPrice = coin => state.markets[coin].last;

    function holdingsValue() {
      return Object.entries(state.positions).reduce((sum, [coin, p]) => sum + p.amount * lastPrice(coin), 0);
    }
    const totalAssets = () => state.krw + holdingsValue();

    function positionRows() {
      return Object.entries(state.positions).map(([coin, p]) => {
        const currentPrice = lastPrice(coin);
        const currentValue = p.amount * currentPrice;
        const cost = p.amount * p.avgPrice;
        const profit = currentValue - cost;
        return {
          coin, market: coin, koreanName: state.markets[coin].name, amount: p.amount, avgPrice: p.avgPrice, entryPrice: p.avgPrice,
          currentPrice, currentValue, profit, profitPercent: cost > 0 ? (profit / cost) * 100 : 0,
          entryTime: p.entryTime, source: p.source
        };
      });
    }

    function recordTrade(trade) {
      state.trades.unshift({ ...trade, timestamp: iso() });
      if (state.trades.length > 80) state.trades.length = 80;
    }

    function openPosition(coin, amountKrw, source) {
      const fill = lastPrice(coin) * (1 + SLIPPAGE_RATE);
      const fee = amountKrw * FEE_RATE;
      const quantity = (amountKrw - fee) / fill;
      const existing = state.positions[coin];
      if (existing) {
        const total = existing.amount + quantity;
        existing.avgPrice = (existing.avgPrice * existing.amount + fill * quantity) / total;
        existing.amount = total;
      } else {
        state.positions[coin] = { amount: quantity, avgPrice: fill, entryTick: state.tick, entryTime: iso(), source };
      }
      state.krw -= amountKrw;
      state.todayBuy += 1;
      recordTrade({
        action: source === 'strategy' ? 'OPEN' : 'BUY', type: 'BUY', source, coin, amount: quantity, volume: quantity,
        price: fill, entryPrice: fill, grossAmount: amountKrw, fee, entryTime: iso()
      });
      return { fill, quantity, fee };
    }

    function closePosition(coin, quantity, reason, source) {
      const p = state.positions[coin];
      const fill = lastPrice(coin) * (1 - SLIPPAGE_RATE);
      const gross = fill * quantity;
      const fee = gross * FEE_RATE;
      const proceeds = gross - fee;
      const profit = proceeds - p.avgPrice * quantity;
      state.krw += proceeds;
      p.amount -= quantity;
      if (p.amount <= 1e-9) delete state.positions[coin];
      state.todaySell += 1;
      state.realized += profit;
      recordTrade({
        action: source === 'strategy' ? 'CLOSE' : 'SELL', type: 'SELL', source, coin, amount: quantity, volume: quantity,
        price: fill, exitPrice: fill, entryPrice: p.avgPrice, grossAmount: gross, fee, profit, reason, exitTime: iso()
      });
      return { fill, proceeds, profit, fee };
    }

    function tripCircuit() {
      const circuit = state.circuit;
      circuit.coolingDown = true;
      circuit.untilTick = state.tick + COOLDOWN_TICKS;
      circuit.trippedAt = iso();
      circuit.trips += 1;
      state.regime = 'normal';
      state.crashLeft = 0;
      pushLog('risk', `연속 손실 ${circuit.lossCount}회: 손실 한도에 닿아 신규 진입을 멈췄습니다. 보유분 청산 감시는 계속합니다.`);
    }

    function managePositions() {
      Object.entries({ ...state.positions }).forEach(([coin, p]) => {
        if (p.source !== 'strategy') return;
        const change = lastPrice(coin) / p.avgPrice - 1;
        const held = state.tick - p.entryTick;
        const reason = change >= TAKE_PROFIT ? 'TAKE_PROFIT'
          : change <= -STOP_LOSS ? 'STOP_LOSS'
            : held >= MAX_HOLD_TICKS ? 'MAX_HOLD' : null;
        if (!reason) return;
        const result = closePosition(coin, p.amount, reason, 'strategy');
        const session = state.session;
        session.closed += 1;
        if (result.profit > 0) { session.wins += 1; state.circuit.lossCount = 0; } else {
          session.grossLoss += -result.profit;
          state.circuit.lossCount = Math.min(state.circuit.lossCount + 1, state.circuit.maxLosses);
        }
        const label = { TAKE_PROFIT: '목표 도달', STOP_LOSS: '손절 기준 도달', MAX_HOLD: '보유 시간 종료' }[reason];
        pushLog('exit', `${symbol(coin)} 모의 청산 (${label}), 비용 반영 손익 ${Math.round(result.profit).toLocaleString('ko-KR')}원`);
        emit('auto-trade', { trade: { coin, type: 'SELL', reason, profit: result.profit } });
        if (!state.circuit.coolingDown && state.circuit.lossCount >= state.circuit.maxLosses) tripCircuit();
      });
    }

    function scanEntries(candles) {
      const funnel = state.funnel;
      Object.values(state.markets).forEach(market => {
        const closes = market.candles.map(item => item.close);
        const signal = evaluateSignal(closes, candles[market.coin]);
        funnel.availableWindows += 1;
        if (signal.oversold) funnel.oversoldWindows += 1;
        if (signal.oversold && signal.bullish) funnel.bullishWindows += 1;
        if (signal.oversold && signal.bullish && signal.rebound) funnel.priceReboundWindows += 1;
        if (!signal.confirmed) return;
        funnel.confirmedWindows += 1;
        if (state.positions[market.coin]) return;
        if (state.circuit.coolingDown) {
          state.blockedEntries += 1;
          // The counter keeps every blocked signal; the visible log stays readable.
          if (state.log[0]?.kind !== 'blocked') pushLog('blocked', `${symbol(market.coin)} 등 신호가 나왔지만 손실 한도로 진입하지 않았습니다.`);
          return;
        }
        if (Object.keys(state.positions).length >= MAX_POSITIONS) return;
        const amount = Math.floor(Math.min(SEED_MONEY * INVESTMENT_RATIO, state.krw));
        if (amount < MIN_ORDER) return;
        pushLog('signal', `${symbol(market.coin)} 신호: RSI ${signal.rsi.toFixed(1)} 과매도, 양봉, 저점 반등 확인`);
        emit('new-signal', { coin: market.coin });
        openPosition(market.coin, amount, 'strategy');
        pushLog('entry', `${symbol(market.coin)} 모의 진입 ${amount.toLocaleString('ko-KR')}원`);
        emit('auto-trade', { trade: { coin: market.coin, type: 'BUY' } });
      });
    }

    function tick() {
      state.tick += 1;
      const candles = {};
      Object.values(state.markets).forEach(market => { candles[market.coin] = tickMarket(state, market); });
      if (state.crashLeft > 0) {
        state.crashLeft -= 1;
        if (state.crashLeft === 0) state.regime = 'normal';
      }
      if (state.circuit.coolingDown && state.tick >= state.circuit.untilTick) {
        state.circuit.coolingDown = false;
        state.circuit.lossCount = 0;
        state.circuit.untilTick = null;
        pushLog('risk', '손실 한도 대기 시간이 끝나 신규 진입 판단을 다시 시작합니다.');
      }
      if (state.session.active) {
        managePositions();
        scanEntries(candles);
      }
      if (state.tick % 5 === 0) snapshot();
      return drainEvents();
    }

    function snapshot() {
      state.history.push({ timestamp: iso(), totalAssets: totalAssets() });
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
    }

    function drainEvents() { return emitQueue.splice(0); }

    function triggerCrash() {
      if (!state.session.active) return { ok: false, message: '먼저 모의 자동매매를 시작해 주세요.' };
      if (state.circuit.coolingDown) return { ok: false, message: '이미 손실 한도로 신규 진입이 멈춰 있습니다.' };
      state.regime = 'crash';
      state.crashLeft = 90;
      Object.values(state.markets).forEach(market => { market.crashStep = 0; });
      pushLog('risk', '합성 급락 시나리오 시작: 모든 예시 코인의 합성 시세를 끌어내립니다.');
      return { ok: true };
    }

    // ---------------------------------------------------------- API payloads
    function runtimeState() { return state.session.active ? 'RUNNING' : 'STOPPED'; }

    function statusPayload() {
      return {
        mode: 'DRY_RUN', isRunning: state.session.active, runtimeState: runtimeState(), exchangeStateKnown: true,
        entriesPaused: state.circuit.coolingDown, stopReason: state.session.active ? null : 'operator_stop',
        maxCandleAgeSeconds: 90, readOnlyObserver: false, demo: true, lossCircuitBreaker: circuitPayload(),
        targetCoins: Object.keys(state.markets), timestamp: iso()
      };
    }

    function circuitPayload() {
      const c = state.circuit;
      return { enabled: c.enabled, lossCount: c.lossCount, maxLosses: c.maxLosses, coolingDown: c.coolingDown, trippedAt: c.trippedAt, cooldownTicksRemaining: c.coolingDown ? Math.max(0, c.untilTick - state.tick) : 0, blockedEntries: state.blockedEntries };
    }

    function accountPayload() {
      const total = totalAssets();
      const profit = total - SEED_MONEY;
      return {
        mode: 'DRY_RUN', krwBalance: state.krw, totalAssets: total, profit, profitPercent: (profit / SEED_MONEY) * 100,
        initialSeedMoney: SEED_MONEY, realizedProfit: state.realized, positions: positionRows(), sourceAsOf: iso(), fetchedAt: iso()
      };
    }

    function paperPayload() {
      const session = state.session;
      if (!session.started) return { available: false, reason: 'paper_validation_session_not_started', active: false };
      const updatedAt = iso();
      return {
        available: true, active: session.active, state: session.active ? 'RUNNING' : 'STOPPED', updatedAt, heartbeatAt: updatedAt,
        startedAt: session.startedAt, stoppedAt: session.stoppedAt, closedTradeCount: session.closed, interruptionCount: 0, interruptions: [],
        currentAssets: totalAssets(), baselineAssets: session.baseline, configConsistent: true, continuityEligible: true, orphaned: false, readOnlyObserver: false,
        strictEvaluation: { activePositions: Object.keys(state.positions).length, closedTradeCount: session.closed, winningTrades: session.wins, positions: positionRows() },
        lossCircuitBreaker: circuitPayload(), candleFreshness: { blockedSnapshots: 0, blockedAnalyses: 0, blockedEntries: state.blockedEntries },
        analysisDataHealth: { failClosed: false, analysisActive: false, continuityEligible: true, currentGapDurationSeconds: 0 },
        riskMonitor: { failClosed: false, watchdogTelemetryVersion: 1, maxWatchdogTickGapMs: 1000 },
        telemetry: { analysisIncompleteCycles: 0 }, signalTelemetry: { available: true },
        signalAvailability: { signalFunnel: { version: 1, ...state.funnel } }
      };
    }

    function marketRow(market) {
      const candles = market.candles;
      const dayAgo = candles[Math.max(0, candles.length - 180)];
      const highs = candles.slice(-180).map(item => item.high);
      const lows = candles.slice(-180).map(item => item.low);
      const stamp = iso();
      return {
        coin: market.coin, market: market.coin, koreanName: market.name, englishName: `${market.coin.replace('KRW-', '')} (synthetic)`,
        price: market.last, change: ((market.last - dayAgo.open) / dayAgo.open) * 100, high: Math.max(...highs), low: Math.min(...lows),
        volumeKrw: candles.slice(-180).reduce((sum, item) => sum + item.volume * item.close, 0), sourceAsOf: stamp, fetchedAt: stamp, quoteFresh: true
      };
    }

    function snapshotPayload() {
      const stamp = iso();
      return {
        prices: Object.values(state.markets).map(marketRow), complete: true, missingMarkets: [], unavailableMarkets: [], sourceAsOf: stamp, fetchedAt: stamp,
        snapshotSource: 'synthetic_demo', marketListStale: false, marketListFetchedAt: stamp
      };
    }

    function candlesPayload(coin, unit, count) {
      const market = state.markets[coin];
      if (!market) return null;
      const interval = Math.max(1, Number(unit) || 1);
      const rows = [];
      const source = market.candles;
      for (let end = source.length; end > 0 && rows.length < count; end -= interval) {
        const slice = source.slice(Math.max(0, end - interval), end);
        rows.unshift({
          open: slice[0].open, close: slice[slice.length - 1].close, volume: slice.reduce((sum, item) => sum + item.volume, 0),
          high: Math.max(...slice.map(item => item.high)), low: Math.min(...slice.map(item => item.low)),
          timestamp: iso(now() - (source.length - end) * 60_000)
        });
      }
      return rows;
    }

    function scoresPayload() {
      const coins = Object.values(state.markets).map(market => {
        const closes = market.candles.map(item => item.close);
        const signal = evaluateSignal(closes, market.candles[market.candles.length - 1]);
        const recommendation = signal.confirmed ? 'BUY' : signal.rsi > 68 ? 'SELL' : 'HOLD';
        const row = marketRow(market);
        const signals = [
          `RSI ${signal.rsi.toFixed(1)} (합성 시세 기준)`,
          signal.oversold ? '과매도 구간' : '과매도 아님',
          signal.bullish ? '최근 캔들 양봉' : '최근 캔들 음봉',
          signal.rebound ? '최근 저점에서 반등 확인' : '반등 미확인'
        ];
        const buyScore = Math.round(Math.max(0, 70 - signal.rsi) * 2);
        const sellScore = Math.round(Math.max(0, signal.rsi - 50) * 2);
        return { coin: market.coin, symbol: symbol(market.coin), koreanName: market.name, currentPrice: market.last, change24h: row.change, volume24h: row.volumeKrw, recommendation, totalScore: buyScore - sellScore, buyScore, sellScore, indicators: { rsi: signal.rsi, macdSignal: signal.bullish ? 'BULLISH' : 'BEARISH' }, signals };
      });
      return { success: true, timestamp: iso(), totalAnalyzed: coins.length, coins };
    }

    function statisticsPayload() {
      return [{ strategy: 'demo_rule', totalTrades: state.session.closed, winningTrades: state.session.wins }];
    }

    function configPayload() {
      return {
        investmentRatio: INVESTMENT_RATIO, maxPositions: MAX_POSITIONS,
        scalping: { stopLossPercent: STOP_LOSS * 100, takeProfitPercent: TAKE_PROFIT * 100, marketRegimeEnabled: false, requireReboundBelowOverbought: false }
      };
    }

    // ---------------------------------------------------------------- orders
    const fail = (status, message, code) => ({ status, body: { success: false, error: message, message, code } });

    function manualBuy(body) {
      const coin = body.coin;
      const amount = Number(body.amount);
      if (!state.markets[coin]) return fail(400, '체험판에 없는 종목입니다.', 'DEMO_UNKNOWN_MARKET');
      if (!Number.isFinite(amount) || amount < MIN_ORDER) return fail(400, `최소 주문 금액은 ${MIN_ORDER.toLocaleString('ko-KR')}원입니다.`, 'DEMO_MIN_ORDER');
      if (amount > state.krw) return fail(400, '모의 잔액이 부족합니다.', 'DEMO_INSUFFICIENT');
      const result = openPosition(coin, Math.floor(amount), 'manual');
      pushLog('entry', `${symbol(coin)} 수동 모의 매수 ${Math.floor(amount).toLocaleString('ko-KR')}원`);
      return { status: 200, body: { success: true, message: `${symbol(coin)} 모의 매수 완료 (합성 시세)`, fill: result } };
    }

    function manualSell(body) {
      const coin = body.coin;
      const position = state.positions[coin];
      const quantity = Number(body.quantity);
      if (!position) return fail(400, '보유하지 않은 종목입니다.', 'DEMO_NO_POSITION');
      if (!Number.isFinite(quantity) || quantity <= 0) return fail(400, '매도 수량을 확인해 주세요.', 'DEMO_BAD_QUANTITY');
      const result = closePosition(coin, Math.min(quantity, position.amount), 'MANUAL', 'manual');
      pushLog('exit', `${symbol(coin)} 수동 모의 매도, 비용 반영 손익 ${Math.round(result.profit).toLocaleString('ko-KR')}원`);
      return { status: 200, body: { success: true, message: `${symbol(coin)} 모의 매도 완료 (합성 시세)`, fill: result } };
    }

    function walletChange(kind, body) {
      const amount = Number(body.amount);
      if (kind === 'reset') {
        const seedMoney = state.seed;
        const fresh = initialState(seedMoney);
        const markets = state.markets;
        state = { ...fresh, markets, tick: state.tick, rng: state.rng };
        return { status: 200, body: { success: true, message: '모의 지갑을 처음 금액으로 되돌렸습니다.' } };
      }
      if (!Number.isFinite(amount) || amount <= 0) return fail(400, '금액을 확인해 주세요.', 'DEMO_BAD_AMOUNT');
      if (kind === 'withdraw' && amount > state.krw) return fail(400, '모의 잔액이 부족합니다.', 'DEMO_INSUFFICIENT');
      state.krw += kind === 'deposit' ? amount : -amount;
      return { status: 200, body: { success: true, message: kind === 'deposit' ? '모의 잔액을 늘렸습니다.' : '모의 잔액을 줄였습니다.' } };
    }

    function startSession(body) {
      if (body && body.reset === true) {
        Object.keys(state.positions).forEach(coin => delete state.positions[coin]);
        state.krw = SEED_MONEY;
        state.trades = [];
        state.history = [];
        state.realized = 0;
        state.todayBuy = 0;
        state.todaySell = 0;
        state.circuit = { ...state.circuit, lossCount: 0, coolingDown: false, untilTick: null, trippedAt: null };
        state.session = { ...state.session, closed: 0, wins: 0, grossLoss: 0 };
      }
      state.session.active = true;
      state.session.started = true;
      state.session.startedAt = iso();
      state.session.stoppedAt = null;
      state.session.baseline = totalAssets();
      pushLog('info', '모의 자동매매 시작: 합성 시세에서 조건을 확인합니다.');
      snapshot();
      return { status: 200, body: { success: true, status: paperPayload() } };
    }

    function stopSession() {
      state.session.active = false;
      state.session.stoppedAt = iso();
      state.regime = 'normal';
      state.crashLeft = 0;
      pushLog('info', '모의 자동매매 중지: 신규 진입과 자동 청산을 멈췄습니다. 수동 모의 주문이 열립니다.');
      return { status: 200, body: { success: true, status: paperPayload() } };
    }

    // ------------------------------------------------------------------ route
    function handle(method, rawPath, body = {}) {
      const url = new URL(rawPath, 'https://coinpilot.invalid');
      const path = url.pathname.replace(/^\/api/, '');
      const query = url.searchParams;
      const ok = data => ({ status: 200, body: data });
      if (method === 'GET') {
        const candleMatch = path.match(/^\/market\/candles\/(.+)$/);
        if (candleMatch) {
          const rows = candlesPayload(decodeURIComponent(candleMatch[1]), query.get('unit'), Math.min(Number(query.get('count')) || 100, 200));
          return rows ? ok(rows) : fail(404, '체험판에 없는 종목입니다.', 'DEMO_UNKNOWN_MARKET');
        }
        if (/^\/coin-detail\//.test(path)) {
          const market = state.markets[decodeURIComponent(path.split('/')[2])];
          return market ? ok({ ...marketRow(market), analysis: scoresPayload().coins.find(item => item.coin === market.coin) }) : fail(404, '체험판에 없는 종목입니다.', 'DEMO_UNKNOWN_MARKET');
        }
        if (/^\/news\//.test(path) || path === '/news') return ok({ success: true, news: [], sentiment: { overall: 'neutral', score: 0 }, demoNotice: '체험판은 외부 뉴스를 불러오지 않습니다.' });
        if (/^\/backtest\/results/.test(path)) return ok({ results: [] });
        if (/^\/ai\/sessions\//.test(path)) return ok({ session: null, evaluations: [] });
        switch (path) {
          case '/auth/status': return ok({ authRequired: false });
          case '/status': case '/system-status': return ok(statusPayload());
          case '/account': return ok(accountPayload());
          case '/positions': return ok(positionRows());
          case '/cumulative-pnl': { const a = accountPayload(); return ok({ totalAssets: a.totalAssets, profit: a.profit, profitPercent: a.profitPercent, initialSeedMoney: SEED_MONEY }); }
          case '/today-summary': return ok({ realizedProfit: state.realized, buyCount: state.todayBuy, sellCount: state.todaySell });
          case '/statistics': return ok(statisticsPayload());
          case '/scalping-validation': return ok({ available: true, promoted: false, researchOnly: true, demo: true, reason: '합성 데이터이므로 전략 검증 근거가 아닙니다.' });
          case '/strategy-readiness': return ok({ status: 'NOT_REQUIRED', decisionMeaning: 'performance_validation_optional', currentEvidence: false, liveGate: { enforced: false, checked: false, passed: false, code: 'demo_live_disabled' } });
          case '/paper-validation': return ok(paperPayload());
          case '/momentum-shadow': return ok({ available: false, reason: 'demo_not_available' });
          case '/portfolio-analysis': { const a = accountPayload(); const holdings = positionRows(); return ok({ summary: { totalAssets: a.totalAssets, totalProfit: a.profit, krwBalance: a.krwBalance, totalHoldings: holdings.length }, holdings, generatedAt: iso() }); }
          case '/portfolio/history': return ok({ data: state.history, mode: 'DRY_RUN' });
          case '/trades': return ok(state.trades.slice(0, Math.min(Number(query.get('limit')) || 50, 80)));
          case '/market/prices/snapshot': return ok(snapshotPayload());
          case '/market/prices': return ok(snapshotPayload().prices);
          case '/target-coins': return ok({ coins: Object.keys(state.markets), count: Object.keys(state.markets).length, stale: false, fetchedAt: iso() });
          case '/all-coin-scores': case '/coin-analysis': return ok(scoresPayload());
          case '/trading-recommendations': { const coins = scoresPayload().coins; return ok({ buyRecommendations: coins.filter(item => item.recommendation === 'BUY').map(item => ({ ...item, symbol: symbol(item.coin), reason: item.signals[0] })), sellRecommendations: [] }); }
          case '/parameter-ranges': return ok({});
          case '/optimal-config': return ok({ parameters: { stopLossPercent: STOP_LOSS * 100, takeProfitPercent: TAKE_PROFIT * 100, investmentRatio: INVESTMENT_RATIO } });
          case '/investment-config': return ok(configPayload());
          case '/investment-presets': return ok({ presets: [] });
          case '/optimization/settings': return ok({ enabled: state.optimization.enabled, interval: state.optimization.interval, nextRun: null });
          case '/optimization-history': return ok({ history: [] });
          case '/strategy-research': return ok({ available: false, reason: 'demo_not_available', generatedAt: iso() });
          case '/ai/monitoring': return ok({ events: [], consultations: [], sessions: [], effectiveness: null });
          case '/ai/sessions': return ok({ sessions: [] });
          case '/ai/providers': case '/ai/status': return ok({ providers: [] });
          case '/quote-execution-evidence': case '/quote-quality': return ok({ available: false, reason: 'demo_not_available' });
          default: return fail(404, '체험판에서는 제공하지 않는 정보입니다.', 'DEMO_NOT_AVAILABLE');
        }
      }
      if (/^\/auth\//.test(path)) return ok({ authRequired: false });
      switch (path) {
        case '/trade/buy': return manualBuy(body);
        case '/trade/sell': return manualSell(body);
        case '/virtual/deposit': return walletChange('deposit', body);
        case '/virtual/withdraw': return walletChange('withdraw', body);
        case '/virtual/reset': return walletChange('reset', body);
        case '/paper-validation/start': return startSession(body);
        case '/paper-validation/stop': return stopSession();
        case '/portfolio/snapshot': snapshot(); return ok({ success: true, snapshot: state.history[state.history.length - 1] });
        default: return fail(403, '체험판에서는 지원하지 않는 작업입니다. 실제 서버나 거래소로 전송되지 않았습니다.', 'DEMO_ACTION_DISABLED');
      }
    }

    return {
      tick, handle, triggerCrash, drainEvents,
      get state() { return state; },
      summary: () => ({
        started: state.session.started, active: state.session.active, closed: state.session.closed, entries: state.trades.filter(item => item.source === 'strategy' && item.action === 'OPEN').length,
        coolingDown: state.circuit.coolingDown, lossCount: state.circuit.lossCount, maxLosses: state.circuit.maxLosses, trips: state.circuit.trips,
        blockedEntries: state.blockedEntries, regime: state.regime, cooldownTicksRemaining: circuitPayload().cooldownTicksRemaining, log: state.log.slice(0, 8)
      })
    };
  }

  // Replays the teaching rule over a seeded synthetic series. Both columns use
  // the same trades, so the only difference is the cost assumption.
  function runCostBacktest({ seed = DEFAULT_SEED, feePercent = FEE_RATE * 100, slippagePercent = SLIPPAGE_RATE * 100, ticks = 2880 } = {}) {
    const fee = Math.max(0, Number(feePercent) || 0) / 100;
    const slip = Math.max(0, Number(slippagePercent) || 0) / 100;
    const state = { rng: (seed ^ 0x5bd1e995) | 0, regime: 'normal' };
    const markets = MARKETS.map(([coin, , base, vol]) => ({ coin, base, vol, price: base, last: roundPrice(base), dip: 0, candles: [] }));
    const open = new Map();
    const trades = [];
    const stake = SEED_MONEY * INVESTMENT_RATIO;
    let grossEquity = SEED_MONEY;
    let netEquity = SEED_MONEY;
    const curve = [{ gross: grossEquity, net: netEquity }];
    for (let t = 0; t < ticks; t += 1) {
      markets.forEach(market => {
        const candle = tickMarket(state, market);
        if (market.candles.length < 30) return;
        const position = open.get(market.coin);
        if (position) {
          const change = market.last / position.entry - 1;
          if (change >= TAKE_PROFIT || change <= -STOP_LOSS || t - position.at >= MAX_HOLD_TICKS) {
            const grossPnl = stake * change;
            const netEntry = position.entry * (1 + slip);
            const netExit = market.last * (1 - slip);
            const netPnl = stake * (1 - fee) * (netExit / netEntry) * (1 - fee) - stake;
            grossEquity += grossPnl;
            netEquity += netPnl;
            trades.push({ gross: grossPnl, net: netPnl });
            open.delete(market.coin);
          }
          return;
        }
        if (open.size < MAX_POSITIONS && evaluateSignal(market.candles.map(item => item.close), candle).confirmed) {
          open.set(market.coin, { entry: market.last, at: t });
        }
      });
      if (t % 24 === 0) curve.push({ gross: grossEquity, net: netEquity });
    }
    curve.push({ gross: grossEquity, net: netEquity });
    const summarize = key => {
      const values = trades.map(item => item[key]);
      const wins = values.filter(value => value > 0);
      const losses = values.filter(value => value <= 0);
      const lossSum = -losses.reduce((sum, value) => sum + value, 0);
      const winSum = wins.reduce((sum, value) => sum + value, 0);
      const total = values.reduce((sum, value) => sum + value, 0);
      return { totalPnl: total, returnPercent: (total / SEED_MONEY) * 100, winRatePercent: values.length ? (wins.length / values.length) * 100 : 0, profitFactor: lossSum > 0 ? winSum / lossSum : null };
    };
    const gross = summarize('gross');
    const net = summarize('net');
    return { seed, ticks, feePercent: fee * 100, slippagePercent: slip * 100, tradeCount: trades.length, gross, net, costTotal: gross.totalPnl - net.totalPnl, curve, synthetic: true };
  }

  const api = { createDemoSim, runCostBacktest, evaluateSignal, DEFAULT_SEED, SEED_MONEY, FEE_RATE, SLIPPAGE_RATE, MARKETS };
  root.CoinPilotDemoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
