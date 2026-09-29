import UpbitAPI from './upbit.js';

/**
 * A public-only view of Upbit reads for the dashboard and other observers.
 * It deliberately owns a credential-free client, separate from trader setup.
 */
export class PublicMarketDataSource {
  #client;

  constructor() {
    this.#client = new UpbitAPI('', '');
    Object.freeze(this);
  }

  getMarkets(...args) {
    return this.#client.getMarkets(...args);
  }

  getTicker(...args) {
    return this.#client.getTicker(...args);
  }

  getMinuteCandles(...args) {
    return this.#client.getMinuteCandles(...args);
  }
}

export function createPublicMarketDataSource() {
  return new PublicMarketDataSource();
}
