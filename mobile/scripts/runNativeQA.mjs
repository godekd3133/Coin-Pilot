// Native interaction QA only: synthetic data, temporary storage, no exchange or AI calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { ENV_SCHEMA } from '../../src/config/envSchema.js';

for (const name of Object.keys(ENV_SCHEMA)) delete process.env[name];
dotenv.config = () => ({ parsed: {} });
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-native-qa-'));
const logDir = process.env.COINPILOT_NATIVE_QA_LOG_DIR || stateDir;
fs.mkdirSync(logDir, { recursive: true });
const env = {
  DASHBOARD_HOST: '0.0.0.0',
  DASHBOARD_MOBILE_TOKEN: 'coinpilot-synthetic-native-qa',
  DASHBOARD_READ_ONLY_TOKEN: 'coinpilot-synthetic-reader',
  STAGING_OUTPUT_DIR: stateDir
};
Object.assign(process.env, env);
const { createMockTrader } = await import('../../src/scripts/runDashboard.js');
const { default: DashboardServer } = await import('../../src/api/dashboardServer.js');
const trader = createMockTrader();
trader.config.aiAdvisorEnabled = false;
trader.config.aiMonitoringFile = path.join(stateDir, 'ai.json');
trader.config.scalpingValidationOutputFile = path.join(stateDir, 'validation.json');
trader.config.strategyResearchOutputFile = path.join(stateDir, 'research.json');
trader.newsMonitor = null;
trader.newsData = [{
  title: 'QA 예시 뉴스: 시장 화면과 새로고침 확인',
  url: 'https://example.com/coinpilot-qa',
  source: 'QA 예시',
  publishedAt: new Date().toISOString()
}];
const server = new DashboardServer(trader, 39471, {
  env,
  optimizationStateDir: stateDir,
  paperForwardCohortRootDir: stateDir
});
server.aiAdvisor.enabled = false;
server.generateBundleSuggestions = async () => [{
  sell: { coin: 'KRW-BTC', amount: 0.0001 },
  buy: { coin: 'KRW-ETH', suggestedAmount: 9000 },
  rationale: 'QA 합성 종목 교체: 부분 매도와 매수 금액 확인'
}];
// Local scenario controls change only synthetic status; opinions never run a provider.
const scenarioFile = path.join(logDir, 'qa-scenarios.json');
const readScenario = () => {
  try { return JSON.parse(fs.readFileSync(scenarioFile, 'utf8')); }
  catch { return {}; }
};
server.aiAdvisor.getProviderStatus = async () => {
  const scenario = readScenario();
  if (scenario.providerError) throw new Error('synthetic provider status failure');
  const ready = scenario.readyProviders || [];
  return { enabled: scenario.aiEnabled === true, providers: ['gpt', 'claude'].map(id => ({
    id, label: id === 'gpt' ? 'OpenAI' : 'Claude', ready: ready.includes(id),
    status: ready.includes(id) ? 'READY' : 'NOT_AUTHENTICATED'
  })) };
};
server.aiAdvisor.ask = async () => ({ status: 'FAILED', error: '합성 검증 환경에서는 의견을 실행하지 않습니다.', results: [] });
const handleSyntheticRequest = server.app.handle.bind(server.app);
server.app.handle = (request, response, next) => {
  if (readScenario().liveCredentialSetup && request.url.startsWith('/live/api/')) {
    const pathname = request.url.split('?')[0];
    if (pathname !== '/live/api/auth/status' && pathname !== '/live/api/auth/login' &&
        request.headers.authorization !== 'Bearer coinpilot-synthetic-native-qa') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Synthetic QA authentication required' }));
      return;
    }
    if (request.method !== 'GET' && pathname !== '/live/api/auth/login') {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Synthetic LIVE view is read-only; no keys or orders accepted' }));
      return;
    }
    const fixtures = {
      '/live/api/status': { mode: 'LIVE', exchange: 'upbit', quoteCurrency: 'KRW', isRunning: false,
        upbitCredentialsConfigured: false, exchangeStateKnown: false, runtimeState: 'SETUP_REQUIRED' },
      '/live/api/account': { mode: 'LIVE', krwBalance: 0, totalAssets: 0, positions: [],
        readOnlyObserver: false, valuationAvailable: false }
    };
    if (fixtures[pathname]) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(fixtures[pathname]));
      return;
    }
    request.url = request.url.slice('/live'.length);
  }
  const delay = Number(readScenario().statusDelayMilliseconds);
  if (request.method === 'GET' && request.url.split('?')[0] === '/api/status' && Number.isFinite(delay) && delay > 0) {
    const timer = setTimeout(() => {
      if (!response.destroyed) handleSyntheticRequest(request, response, next);
    }, Math.min(delay, 30_000));
    response.once('close', () => clearTimeout(timer));
    return;
  }
  return handleSyntheticRequest(request, response, next);
};
// Comparisons in this harness never reach a public exchange or apply a candidate.
server.optimizationState.enabled = false;
server.collectCandleData = async () => Array.from({ length: 100 }, (_, index) => ({
  market: 'KRW-BTC', candle_date_time_utc: new Date(Date.now() - index * 60_000).toISOString(),
  opening_price: 100_000_000, high_price: 100_100_000, low_price: 99_900_000,
  trade_price: 100_000_000, candle_acc_trade_volume: 100
}));
if (process.env.COINPILOT_NATIVE_QA_NEWS_VARIANT === 'classified') {
  trader.newsData = ['positive', 'negative', 'neutral'].map((sentiment, index) => ({
    title: `QA 예시 기사 ${index + 1}`, url: 'https://example.com/coinpilot-qa',
    source: 'QA 예시', publishedAt: new Date().toISOString(), sentiment
  }));
}

// Synthetic stock and horizon engines for the native Stocks/Portfolios screens.
// They only flip in-memory flags; no broker, exchange or order path exists here.
const qaNow = () => new Date().toISOString();
const qaStockTrader = {
  mode: 'paper', running: true, desiredRunning: true, entriesPaused: false, pauseReason: null, pendingOrders: 0,
  market: { open: true, canEnter: true, mustFlatten: false, reason: 'regular_session' },
  lastCycleAt: qaNow(), lastError: null, cash: 612_400, initialSeedMoney: 1_000_000, totalAssets: 1_018_900,
  positions: [
    { symbol: 'QA0001', quantity: 12, entryPrice: 21_500, lastPrice: 22_350, entryTime: qaNow(), unrealizedProfit: 10_200 },
    { symbol: 'QA0002', quantity: 5, entryPrice: 30_100, lastPrice: 29_620, entryTime: qaNow(), unrealizedProfit: -2_400 }
  ],
  maxPositions: 3,
  statistics: { totalTrades: 7, winningTrades: 4, winRate: 57.1, totalProfit: 11_300 },
  recentTrades: [
    { action: 'SELL', symbol: 'QA0003', quantity: 8, price: 14_250, profit: 3_100, profitPercent: 2.8, reason: 'QA 익절', at: qaNow() },
    { action: 'BUY', symbol: 'QA0002', quantity: 5, price: 30_100, reason: 'QA 진입', at: qaNow() }
  ],
  recentSignals: [{ symbol: 'QA0004', reason: 'QA 과매도 반등', valid: false, rejection: '최대 보유 종목 도달', at: qaNow() }]
};
const qaSleeves = (label) => ({
  short: { label: '단기 (1~3일)', enabled: true, weight: 15, interval: '60m', positions: 1, realizedProfit: 4_200, trades: 5, winRate: 60, lastAnalysis: null },
  swing: { label: '스윙 (~1주)', enabled: true, weight: 25, interval: '240m', positions: 0, realizedProfit: -1_800, trades: 3, winRate: 33.3, lastAnalysis: null },
  mid: { label: '중기 (1~3개월)', enabled: true, weight: 30, interval: 'day', positions: 1, realizedProfit: 0, trades: 0, winRate: 0,
    lastAnalysis: { barStart: qaNow(), benchmarkRegime: 'bull', top: [{ symbol: `${label}-A`, score: 62, regime: 'trend', rsi: 58, atrPercent: 3.1 }] } },
  long: { label: '장기 (3개월+)', enabled: false, weight: 0, interval: 'week', positions: 0, realizedProfit: 0, trades: 0, winRate: 0, lastAnalysis: null }
});
const qaHorizon = (assetClass, symbols) => ({
  running: assetClass === 'coin',
  status() {
    return {
      assetClass, mode: 'paper', running: this.running, desiredRunning: this.running, entriesPaused: false, pauseReason: null,
      pendingOrders: 0, lastCycleAt: qaNow(), lastError: null, gate: { canTrade: true, canEnter: true }, capitalRatio: 0.3,
      paramsValidated: true, paramsSource: 'qa', cash: 2_140_000, initialSeedMoney: 3_000_000, totalAssets: 3_065_500,
      sleeves: qaSleeves(symbols[0]),
      positions: [
        { sleeve: 'short', symbol: symbols[0], quantity: 0.02, entryPrice: 30_000_000, lastPrice: 30_900_000, cost: 600_300, stopPrice: 29_100_000, score: 41, barsHeld: 3, entryTime: qaNow(), unrealizedProfit: 17_700, stuckBelowMinimum: false },
        { sleeve: 'mid', symbol: symbols[1], quantity: 40, entryPrice: 8_000, lastPrice: 7_800, cost: 320_160, stopPrice: 7_100, score: 55, barsHeld: 6, entryTime: qaNow(), unrealizedProfit: -8_160, stuckBelowMinimum: false }
      ],
      recentTrades: [{ action: 'SELL', sleeve: 'short', symbol: symbols[1], quantity: 10, price: 8_100, profit: 4_200, returnPercent: 2.1, reason: 'QA 추적 손절', at: qaNow() }],
      research: {
        generatedAt: qaNow(), method: 'expanding-walk-forward-3fold', markets: 30,
        sleeves: [
          { horizon: 'short', interval: '60m', passed: true, outOfSampleReturnPercent: 6.4, worstDrawdownPercent: 7.9, trades: 41 },
          { horizon: 'swing', interval: '240m', passed: true, outOfSampleReturnPercent: 3.2, worstDrawdownPercent: 11.5, trades: 18 },
          { horizon: 'mid', interval: 'day', passed: true, outOfSampleReturnPercent: 9.8, worstDrawdownPercent: 14.2, trades: 9 },
          { horizon: 'long', interval: 'week', passed: false, outOfSampleReturnPercent: -2.5, worstDrawdownPercent: 22.4, trades: 4 }
        ],
        scheduler: { running: false, lastRunAt: qaNow(), lastError: null }
      }
    };
  }
});
const qaCoinHorizon = qaHorizon('coin', ['KRW-BTC', 'KRW-XRP']);
const qaStockHorizon = qaHorizon('stock', ['QA0001', 'QA0005']);
const qaHorizonRuntime = horizon => ({
  getStatus: () => horizon.status(),
  manager: {
    start: async () => { horizon.running = true; },
    stop: () => { horizon.running = false; }
  }
});
server.coinHorizon = qaHorizonRuntime(qaCoinHorizon);
server.stockTradingService = {
  horizons: { paper: qaHorizonRuntime(qaStockHorizon) },
  getStatus: () => ({
    enabled: true, provider: 'synthetic', credentialsConfigured: true,
    universe: ['QA0001', 'QA0002', 'QA0003', 'QA0004', 'QA0005'], universeUpdatedAt: qaNow(), universeError: null,
    paper: { ...qaStockTrader, lastCycleAt: qaNow() }, live: null, horizons: {}
  }),
  startTrader: async mode => {
    if (mode !== 'paper') throw Object.assign(new Error('합성 검증 환경에는 실전 주식이 없습니다.'), { status: 404 });
    qaStockTrader.running = true;
    return qaStockTrader;
  },
  stopTrader: mode => {
    if (mode !== 'paper') throw Object.assign(new Error('합성 검증 환경에는 실전 주식이 없습니다.'), { status: 404 });
    qaStockTrader.running = false;
    return qaStockTrader;
  },
  getTrader: () => ({ resetPaper: () => { throw Object.assign(new Error('보유 포지션이 있어 초기화할 수 없습니다.'), { status: 409 }); } })
};

server.httpServer.on('request', (request, response) => {
  response.once('finish', () => {
    fs.appendFileSync(path.join(logDir, 'qa-http.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(),
      method: request.method,
      path: request.url.split('?')[0],
      status: response.statusCode,
      client: request.headers['user-agent'] || ''
    })}\n`, { mode: 0o600 });
  });
});
await server.start();
fs.writeFileSync(path.join(logDir, 'qa-server.json'), JSON.stringify({
  pid: process.pid, port: 39471, stateDir, synthetic: true
}, null, 2), { mode: 0o600 });
console.log(`SYNTHETIC NATIVE QA: port=39471 storage=${stateDir}; no real orders or credentials`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
