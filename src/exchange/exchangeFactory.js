import UpbitAPI from '../api/upbit.js';
import { BinanceExchange } from './binanceClient.js';

/**
 * Exchange selection seam. The process is pinned to a single exchange so the
 * book, market codes, and credential surface stay coherent; run a second
 * process with EXCHANGE=binance to operate both in parallel.
 *
 * Every client produced here presents the Upbit-compatible call surface used
 * by the trader (getMarkets/getTicker/getMinuteCandles/getAccounts/order/
 * cancelOrder/getOrder/getOrders/waitForOrderFill) — Binance responses are
 * normalized to Upbit field names by BinanceExchange.
 */

export const SUPPORTED_EXCHANGES = ['upbit', 'binance'];
export const DEFAULT_EXCHANGE = 'upbit';

export function resolveExchange(env = process.env) {
  const raw = String(env.EXCHANGE || DEFAULT_EXCHANGE).trim().toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(raw)) {
    throw new Error(`Unsupported EXCHANGE "${raw}". Use one of: ${SUPPORTED_EXCHANGES.join(', ')}.`);
  }
  return raw;
}

export function quoteAssetForExchange(exchange, env = process.env) {
  if (exchange === 'binance') {
    const quote = String(env.BINANCE_QUOTE_ASSET || 'USDT').trim().toUpperCase();
    return quote || 'USDT';
  }
  return 'KRW';
}

/**
 * Create the exchange client for the configured exchange.
 * `config` may carry pre-resolved keys (accessKey/secretKey) so credential
 * enrollment keeps working: for Binance those hold BINANCE_API_KEY/SECRET.
 */
export function createExchangeClient(config = {}, env = process.env) {
  const exchange = config.exchange || resolveExchange(env);
  if (exchange === 'binance') {
    return new BinanceExchange({
      accessKey: config.accessKey || env.BINANCE_API_KEY || '',
      secretKey: config.secretKey || env.BINANCE_API_SECRET || '',
      baseURL: env.BINANCE_BASE_URL || undefined,
      quoteAsset: config.quoteAsset || quoteAssetForExchange(exchange, env),
      requestTimeoutMs: config.upbitRequestTimeoutMs ?? config.requestTimeoutMs,
      stateDir: config.stateDir || env.COINPILOT_STATE_DIR || null
    });
  }
  return new UpbitAPI(config.accessKey, config.secretKey, {
    requestTimeoutMs: config.upbitRequestTimeoutMs
  });
}

/** The quote currency a market code belongs to ('KRW-BTC' → 'KRW'). */
export function quoteOfMarketCode(market) {
  if (typeof market !== 'string') return null;
  const [quote] = market.split('-');
  return /^[A-Z]{2,10}$/.test(quote) ? quote : null;
}
