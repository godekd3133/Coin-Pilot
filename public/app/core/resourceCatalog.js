// Every server read the shell knows about. A feature lists the names it needs
// in its `resources` array; adding a read means adding one entry here.
// interval: polling period while active and visible. manual: fetched only on
// demand (expensive analyses).

import { fetchMarketSnapshot } from '../domain/trading.js';

const unwrapList = (data, key) => (Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : []);

export const RESOURCE_CATALOG = {
  status: { interval: 15_000, fetch: api => api.get('/status') },
  account: { interval: 15_000, fetch: api => api.get('/account') },
  pnl: { interval: 30_000, fetch: api => api.get('/cumulative-pnl') },
  today: { interval: 30_000, fetch: api => api.get('/today-summary') },
  history: { interval: 60_000, defaultParams: '24h', fetch: (api, period = '24h') => api.get(`/portfolio/history?period=${encodeURIComponent(period)}`) },
  trades: { interval: 30_000, fetch: api => api.get('/trades?limit=50') },
  prices: { interval: 15_000, fetch: api => fetchMarketSnapshot(api) },
  targetCoins: { interval: 300_000, fetch: api => api.get('/target-coins') },
  statistics: { interval: 60_000, fetch: api => api.get('/statistics') },
  readiness: { interval: 60_000, fetch: api => api.get('/strategy-readiness') },
  validation: { interval: 120_000, fetch: api => api.get('/scalping-validation') },
  paper: { interval: 30_000, fetch: api => api.get('/paper-validation') },
  stocks: { interval: 15_000, fetch: api => api.get('/stocks/status') },
  horizons: { interval: 30_000, fetch: api => api.get('/horizons/status') },
  candles: { manual: true, defaultParams: { coin: 'KRW-BTC', unit: 5 }, fetch: (api, { coin, unit } = {}) => api.get(`/market/candles/${encodeURIComponent(coin)}?unit=${encodeURIComponent(unit)}&count=100`).then(rows => ({ coin, unit, rows: Array.isArray(rows) ? rows : [] })) },
  coinDetail: { manual: true, fetch: (api, coin) => api.get(`/coin-detail/${encodeURIComponent(coin)}`) },
  analysis: { manual: true, fetch: api => api.get('/all-coin-scores?limit=60') },
  recommendations: { manual: true, fetch: api => api.get('/trading-recommendations') },
  bundles: { manual: true, fetch: api => api.get('/bundle-suggestions') },
  news: { manual: true, fetch: api => api.get('/news?limit=80') },
  aiProviders: { interval: 120_000, fetch: api => api.get('/ai/providers') },
  aiMonitoring: { interval: 30_000, fetch: api => api.get('/ai/monitoring?limit=40') },
  parameterRanges: { interval: 0, fetch: api => api.get('/parameter-ranges') },
  optimalConfig: { interval: 120_000, fetch: api => api.get('/optimal-config') },
  investmentConfig: { interval: 60_000, fetch: api => api.get('/investment-config') },
  presets: { interval: 0, fetch: api => api.get('/investment-presets').then(data => unwrapList(data, 'presets')) },
  optimization: { interval: 60_000, fetch: api => api.get('/optimization/settings') },
  optimizationHistory: { interval: 120_000, fetch: api => api.get('/optimization-history').then(data => unwrapList(data, 'history')) },
  backtestResults: { interval: 300_000, fetch: api => api.get('/backtest/results').then(data => unwrapList(data, 'results')) },
  strategyResearch: { interval: 300_000, fetch: api => api.get('/strategy-research') },
  momentumShadow: { interval: 300_000, fetch: api => api.get('/momentum-shadow') },
  notifications: { interval: 60_000, fetch: api => api.get('/notifications/status') },
  automationHistory: { interval: 60_000, fetch: api => api.get('/automation/history') },
  systemStatus: { interval: 30_000, fetch: api => api.get('/system-status') }
};
