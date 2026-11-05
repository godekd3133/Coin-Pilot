// Listing-age entry block: refuse strict scalping entries in markets listed
// fewer than `minDays` days ago.
//
// Research (Upbit KRW, public daily candles): buying on day 2 after a listing
// and holding 30 days averaged about -24% with a 19% win rate (t≈-8). That is a
// defensive filter, not a profit source.
//
// Upbit has no listing-date field. The listing day is the oldest daily candle:
// request minDays+1 candles; if fewer come back, the oldest one is the first
// trading day. A listing time never changes, so a result is cached for the
// process (a mature market never needs another request). A failed lookup is not
// cached and blocks the entry (fail-closed). 0 disables the filter.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAY_CANDLES = 200;

function candleStartMs(candle) {
  const raw = candle?.candle_date_time_utc;
  if (typeof raw !== 'string' || !raw) return NaN;
  return Date.parse(raw.endsWith('Z') ? raw : `${raw}Z`);
}

/**
 * @returns {{ known: boolean, mature?: boolean, listedAtMs?: number }}
 */
export function inferListing(dayCandles, minDays) {
  if (!Array.isArray(dayCandles) || dayCandles.length === 0) return { known: false };
  const requested = Math.min(MAX_DAY_CANDLES, Math.ceil(minDays) + 1);
  if (dayCandles.length >= requested) return { known: true, mature: true };
  const starts = dayCandles.map(candleStartMs).filter(Number.isFinite);
  if (starts.length === 0) return { known: false };
  return { known: true, mature: false, listedAtMs: Math.min(...starts) };
}

export function listingAgeDays(listing, nowMs) {
  if (!listing?.known) return null;
  if (listing.mature) return Infinity;
  return Math.max(0, (nowMs - listing.listedAtMs) / DAY_MS);
}

export function createListingAgeStats() {
  return { checked: 0, blocked: 0, unknown: 0, lastBlocked: [] };
}

export class ListingAgeFilter {
  constructor({ minDays = 0, fetchDayCandles, now = () => Date.now() } = {}) {
    this.minDays = Number(minDays) > 0 ? Number(minDays) : 0;
    this.fetchDayCandles = fetchDayCandles;
    this.now = now;
    this.cache = new Map();
    this.stats = createListingAgeStats();
  }

  get enabled() {
    return this.minDays > 0 && typeof this.fetchDayCandles === 'function';
  }

  /**
   * @returns {Promise<null | { block: boolean, reason?: string, ageDays?: number }>}
   *   null when the filter is disabled.
   */
  async check(market) {
    if (!this.enabled) return null;
    this.stats.checked++;
    let listing = this.cache.get(market);
    if (!listing) {
      try {
        const count = Math.min(MAX_DAY_CANDLES, Math.ceil(this.minDays) + 1);
        listing = inferListing(await this.fetchDayCandles(market, count), this.minDays);
      } catch {
        listing = { known: false };
      }
      if (listing.known) this.cache.set(market, listing);
    }
    const ageDays = listingAgeDays(listing, this.now());
    if (ageDays === null) {
      this.stats.unknown++;
      return { block: true, reason: 'listing_age_unknown' };
    }
    if (ageDays < this.minDays) {
      this.stats.blocked++;
      const rounded = Number(ageDays.toFixed(1));
      this.stats.lastBlocked = [
        { market, ageDays: rounded, at: new Date(this.now()).toISOString() },
        ...this.stats.lastBlocked
      ].slice(0, 20);
      return { block: true, reason: 'listing_too_recent', ageDays: rounded };
    }
    return { block: false, ageDays };
  }

  snapshot() {
    return { minDays: this.minDays, ...this.stats };
  }
}
