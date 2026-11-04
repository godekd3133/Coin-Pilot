// 국내 정규장(KRX) 운영 시간 판단.
// 토스증권 market-calendar/KR 응답을 하루 단위로 캐시하고, 조회 실패 시
// 평일 09:00~15:30 KST 기본값으로 대체한다(공휴일은 캘린더로만 판단 가능).

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstDateString(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function defaultSession(ms) {
  const kst = new Date(ms + KST_OFFSET_MS);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return null;
  const date = kstDateString(ms);
  return {
    date,
    start: Date.parse(`${date}T09:00:00+09:00`),
    closingAuction: Date.parse(`${date}T15:20:00+09:00`),
    end: Date.parse(`${date}T15:30:00+09:00`),
    source: 'default'
  };
}

export function parseCalendarDay(day) {
  const regular = day?.integrated?.regularMarket;
  if (!day?.date) return undefined;
  if (!regular) return null; // 휴장일
  const start = Date.parse(regular.startTime);
  const end = Date.parse(regular.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const closingAuction = Date.parse(regular.singlePriceAuctionStartTime);
  return {
    date: day.date,
    start,
    closingAuction: Number.isFinite(closingAuction) ? closingAuction : end - 10 * 60 * 1000,
    end,
    source: 'calendar'
  };
}

export class StockMarketSession {
  constructor({ client = null, now = Date.now, entryCutoffMinutes = 15, flattenMinutes = 12 } = {}) {
    this.client = client;
    this.now = now;
    // 장 마감 전 신규 진입 중단/전량 청산 시점(분). 단일가 매매(15:20) 전에 정리한다.
    this.entryCutoffMs = Math.max(0, Number(entryCutoffMinutes) || 0) * 60 * 1000;
    this.flattenMs = Math.max(0, Number(flattenMinutes) || 0) * 60 * 1000;
    this._cache = null;
  }

  async getTodaySession() {
    const nowMs = this.now();
    const today = kstDateString(nowMs);
    if (this._cache?.date === today) return this._cache.session;
    let session;
    if (this.client) {
      try {
        const calendar = await this.client.getMarketCalendarKR();
        const parsed = parseCalendarDay(calendar?.today);
        if (parsed !== undefined && (parsed === null || parsed.date === today)) session = parsed;
      } catch {
        session = undefined;
      }
    }
    if (session === undefined) session = defaultSession(nowMs);
    // 캘린더 조회 실패로 기본값을 쓴 경우 다음 사이클에 다시 시도한다.
    if (session?.source !== 'default') this._cache = { date: today, session };
    return session;
  }

  /**
   * @returns {Promise<{open:boolean, canEnter:boolean, mustFlatten:boolean, reason:string, session:object|null}>}
   */
  async getState() {
    const session = await this.getTodaySession();
    const nowMs = this.now();
    if (!session) return { open: false, canEnter: false, mustFlatten: false, reason: 'market_holiday', session: null };
    if (nowMs < session.start) return { open: false, canEnter: false, mustFlatten: false, reason: 'before_open', session };
    if (nowMs >= session.end) return { open: false, canEnter: false, mustFlatten: false, reason: 'after_close', session };
    const auction = session.closingAuction;
    const mustFlatten = nowMs >= auction - this.flattenMs;
    const canEnter = nowMs < auction - this.entryCutoffMs;
    return {
      open: nowMs < auction, // 종가 단일가 구간에는 시장가 즉시 체결이 안 되므로 거래하지 않는다.
      canEnter,
      mustFlatten,
      reason: canEnter ? 'regular_session' : mustFlatten ? 'flatten_before_close' : 'entry_cutoff',
      session
    };
  }
}

export default StockMarketSession;
