// 다중 지표 차트 분석 엔진 (자산·주기 무관).
// 입력: 시간순(오래된→최신) 완료 봉 배열 { time, open, high, low, close, volume }
// 출력: -100~100 점수와 구성 요소, ATR%, 추세 국면.
//
// 점수 구성(가중 합):
//  - trend      : EMA(fast/slow/long) 정렬 + slow EMA 기울기
//  - momentum   : 단기·중기 수익률(ROC), 변동성 대비 정규화
//  - macd       : MACD 히스토그램 방향과 크기(가격 대비)
//  - rsi        : 추세 국면에서의 RSI 위치(과열/과매도 패널티·보너스)
//  - breakout   : 최근 N봉 고가 돌파 / 저가 이탈, 볼린저 %B
//  - volume     : 상승봉 거래량 우위(OBV 기울기)와 거래량 증가
// 모든 지표는 i번째 완료 봉까지만 사용하므로 백테스트와 실시간이 같은 결과를 낸다.

export const DEFAULT_ANALYSIS_PERIODS = Object.freeze({
  emaFast: 10,
  emaSlow: 30,
  emaLong: 100,
  rocShort: 5,
  rocLong: 20,
  rsiPeriod: 14,
  atrPeriod: 14,
  breakoutLookback: 20,
  bbPeriod: 20,
  volumeLookback: 20
});

export const COMPONENT_WEIGHTS = Object.freeze({
  trend: 0.3,
  momentum: 0.22,
  macd: 0.14,
  rsi: 0.1,
  breakout: 0.14,
  volume: 0.1
});

function clamp(value, min = -1, max = 1) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

export function emaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length === 0 || period <= 0) return out;
  const k = 2 / (period + 1);
  let ema = values[0];
  out[0] = ema;
  for (let i = 1; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function rsiAt(closes, period, end = closes.length - 1) {
  if (end < period) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change; else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i <= end; i += 1) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function atrAt(bars, period, end = bars.length - 1) {
  if (end < period) return NaN;
  let atr = 0;
  for (let i = end - period + 1; i <= end; i += 1) {
    const prevClose = bars[i - 1].close;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
    atr += tr;
  }
  return atr / period;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
}

/** 분석에 필요한 최소 봉 수. */
export function minimumBars(periods = DEFAULT_ANALYSIS_PERIODS) {
  const p = { ...DEFAULT_ANALYSIS_PERIODS, ...periods };
  return Math.max(p.emaLong, p.rocLong + 1, p.breakoutLookback + 1, p.bbPeriod, p.volumeLookback + 1, p.rsiPeriod + 1, p.atrPeriod + 1) + 5;
}

/**
 * @param {Array<{time:number, open:number, high:number, low:number, close:number, volume:number}>} bars
 * @param {object} periods
 */
export function analyzeChart(bars, periods = DEFAULT_ANALYSIS_PERIODS) {
  const p = { ...DEFAULT_ANALYSIS_PERIODS, ...periods };
  if (!Array.isArray(bars) || bars.length < minimumBars(p)) {
    return { available: false, score: 0, reason: 'insufficient_bars', bars: bars?.length || 0 };
  }
  const closes = bars.map(bar => bar.close);
  const end = bars.length - 1;
  const close = closes[end];

  // 변동성 기준(봉 수익률 표준편차)으로 지표를 정규화해 자산 간 비교 가능하게 한다.
  const returns = [];
  for (let i = Math.max(1, end - 59); i <= end; i += 1) returns.push(closes[i] / closes[i - 1] - 1);
  const barVol = Math.max(stdev(returns), 1e-6);

  // --- trend ---
  const emaFast = emaSeries(closes, p.emaFast);
  const emaSlow = emaSeries(closes, p.emaSlow);
  const emaLong = emaSeries(closes, p.emaLong);
  const alignment = (close > emaFast[end] ? 1 : -1) * 0.25 +
    (emaFast[end] > emaSlow[end] ? 1 : -1) * 0.35 +
    (emaSlow[end] > emaLong[end] ? 1 : -1) * 0.4;
  const slopeLookback = Math.min(5, end);
  const slowSlope = (emaSlow[end] / emaSlow[end - slopeLookback] - 1) / (barVol * Math.sqrt(slopeLookback));
  const trend = clamp(alignment * 0.7 + clamp(slowSlope / 2) * 0.3);

  // --- momentum ---
  const rocShort = close / closes[end - p.rocShort] - 1;
  const rocLong = close / closes[end - p.rocLong] - 1;
  const momentum = clamp(
    clamp(rocShort / (barVol * Math.sqrt(p.rocShort) * 2)) * 0.4 +
    clamp(rocLong / (barVol * Math.sqrt(p.rocLong) * 2)) * 0.6
  );

  // --- MACD (fast/slow EMA 차이와 시그널) ---
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signal = emaSeries(macdLine, 9);
  const hist = macdLine[end] - signal[end];
  const histPrev = macdLine[end - 1] - signal[end - 1];
  const macd = clamp((hist / close) / (barVol * 0.5)) * 0.7 + (hist > histPrev ? 0.3 : -0.3);

  // --- RSI ---
  const rsi = rsiAt(closes, p.rsiPeriod, end);
  let rsiScore;
  if (rsi >= 80) rsiScore = -0.6; // 과열: 추격 매수 억제
  else if (rsi >= 55) rsiScore = 0.6;
  else if (rsi >= 45) rsiScore = 0;
  else if (rsi >= 30) rsiScore = -0.5;
  else rsiScore = trend > 0 ? 0.3 : -0.8; // 상승 추세 속 과매도는 눌림목, 하락 추세면 회피

  // --- breakout / Bollinger ---
  const lookback = bars.slice(end - p.breakoutLookback, end);
  const priorHigh = Math.max(...lookback.map(bar => bar.high));
  const priorLow = Math.min(...lookback.map(bar => bar.low));
  const bbWindow = closes.slice(end - p.bbPeriod + 1, end + 1);
  const bbMean = bbWindow.reduce((a, b) => a + b, 0) / bbWindow.length;
  const bbStd = stdev(bbWindow);
  const percentB = bbStd > 0 ? (close - (bbMean - 2 * bbStd)) / (4 * bbStd) : 0.5;
  let breakout = (percentB - 0.5) * 0.8;
  if (close > priorHigh) breakout += 0.6;
  if (close < priorLow) breakout -= 0.8;
  breakout = clamp(breakout);

  // --- volume ---
  let upVolume = 0;
  let downVolume = 0;
  for (let i = end - p.volumeLookback + 1; i <= end; i += 1) {
    if (closes[i] >= closes[i - 1]) upVolume += bars[i].volume; else downVolume += bars[i].volume;
  }
  const volumeBalance = upVolume + downVolume > 0 ? (upVolume - downVolume) / (upVolume + downVolume) : 0;
  const recentVol = bars.slice(end - 4, end + 1).reduce((s, b) => s + b.volume, 0) / 5;
  const baseVol = bars.slice(end - p.volumeLookback, end).reduce((s, b) => s + b.volume, 0) / p.volumeLookback;
  const volumeSurge = baseVol > 0 ? clamp((recentVol / baseVol - 1) / 2) : 0;
  const volume = clamp(volumeBalance * 0.7 + volumeSurge * Math.sign(rocShort || 0) * 0.3);

  const components = { trend, momentum, macd: clamp(macd), rsi: rsiScore, breakout, volume };
  const raw = Object.entries(COMPONENT_WEIGHTS).reduce((sum, [key, weight]) => sum + components[key] * weight, 0);
  const atr = atrAt(bars, p.atrPeriod, end);
  const regime = trend > 0.35 ? 'uptrend' : trend < -0.35 ? 'downtrend' : 'range';

  return {
    available: true,
    score: Math.round(clamp(raw) * 1000) / 10,
    components,
    close,
    rsi,
    atr,
    atrPercent: (atr / close) * 100,
    rocShortPercent: rocShort * 100,
    rocLongPercent: rocLong * 100,
    regime,
    time: bars[end].time
  };
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 국내 주식 주봉 완료 시점: 주 시작(월 00:00 KST) + 4일 15:30 (금요일 정규장 마감). */
export const STOCK_WEEK_CLOSE_OFFSET_MS = 4 * DAY_MS + (15 * 60 + 30) * 60 * 1000;

/**
 * 해당 시각이 속한 주의 시작(월요일 00:00).
 * coin: UTC 기준(업비트 일봉 00:00 UTC). stock: KST 달력 주(토스 일봉 00:00 KST = 전날 15:00 UTC)
 * — UTC 요일로 묶으면 국내 주가 화~월로 어긋난다.
 */
export function weekStartOf(timeMs, assetClass = 'coin') {
  const offset = assetClass === 'stock' ? KST_OFFSET_MS : 0;
  const date = new Date(timeMs + offset);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day) - offset;
}

/** 일봉 → 주봉 집계 (월요일 시작 주; coin=UTC, stock=KST 달력 주). */
export function aggregateWeekly(dailyBars, { assetClass = 'coin' } = {}) {
  const weeks = new Map();
  for (const bar of dailyBars) {
    const weekStart = weekStartOf(bar.time, assetClass);
    const week = weeks.get(weekStart);
    if (!week) {
      weeks.set(weekStart, { time: weekStart, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    } else {
      week.high = Math.max(week.high, bar.high);
      week.low = Math.min(week.low, bar.low);
      week.close = bar.close;
      week.volume += bar.volume;
    }
  }
  return [...weeks.values()].sort((a, b) => a.time - b.time);
}
