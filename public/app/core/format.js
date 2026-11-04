// Korean number/time formatting. Missing values render as an em dash so a
// null is never shown as 0.

export const DASH = '—';

export function hasFiniteValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

export function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function won(value, suffix = '원') {
  if (!hasFiniteValue(value)) return DASH;
  return `${Math.round(Number(value)).toLocaleString('ko-KR')}${suffix}`;
}

export function signedWon(value) {
  if (!hasFiniteValue(value)) return DASH;
  const parsed = Number(value);
  return `${parsed > 0 ? '+' : parsed < 0 ? '-' : ''}${won(Math.abs(parsed))}`;
}

/** Compact KRW: 1.2억, 3,400만 */
export function compactWon(value) {
  if (!hasFiniteValue(value)) return DASH;
  const parsed = Number(value);
  const abs = Math.abs(parsed);
  const sign = parsed < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}조`;
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString('ko-KR')}만`;
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}`;
}

export function price(value) {
  if (!hasFiniteValue(value)) return DASH;
  const parsed = Number(value);
  if (parsed === 0) return '0';
  const digits = Math.abs(parsed) < 1 ? 8 : Math.abs(parsed) < 100 ? 4 : 0;
  return parsed.toLocaleString('ko-KR', { maximumFractionDigits: digits });
}

export function quantity(value) {
  if (!hasFiniteValue(value)) return DASH;
  return Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

export function percent(value, decimals = 2) {
  if (!hasFiniteValue(value)) return DASH;
  const parsed = Number(value);
  return `${parsed > 0 ? '+' : ''}${parsed.toFixed(decimals)}%`;
}

/** Unsigned percent, e.g. a weight. */
export function ratio(value, decimals = 1) {
  if (!hasFiniteValue(value)) return DASH;
  return `${Number(value).toFixed(decimals)}%`;
}

/** 'up' | 'down' | '' for Korean P&L colouring (up = red, down = blue). */
export function tone(value) {
  if (!hasFiniteValue(value)) return '';
  const parsed = Number(value);
  return parsed > 0 ? 'up' : parsed < 0 ? 'down' : '';
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function time(value, withSeconds = false) {
  const date = toDate(value);
  if (!date) return DASH;
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
}

export function dateTime(value) {
  const date = toDate(value);
  if (!date) return DASH;
  return date.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fullDateTime(value) {
  const date = toDate(value);
  if (!date) return DASH;
  return date.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Exchange timestamps: distinguishes absent from malformed values. */
export function marketTimestamp(value) {
  if (value === null || value === undefined || value === '' || (typeof value === 'string' && value.trim() === '')) {
    return '시각 정보 미제공';
  }
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return '시각 형식 오류';
  const date = toDate(value);
  if (!date) return '시각 형식 오류';
  return date.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function relativeTime(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return DASH;
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < -5) return dateTime(date);
  if (seconds < 10) return '방금';
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}일 전` : dateTime(date);
}

export function durationSeconds(seconds) {
  if (!hasFiniteValue(seconds) || Number(seconds) < 0) return '확인 불가';
  const whole = Math.floor(Number(seconds));
  if (whole < 60) return `${whole}초`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

export function symbolOf(coin) {
  return String(coin || '').replace(/^[A-Z]+-/, '');
}

export const format = {
  DASH, hasFiniteValue, number, won, signedWon, compactWon, price, quantity, percent, ratio, tone,
  time, dateTime, fullDateTime, marketTimestamp, relativeTime, durationSeconds, symbolOf
};

export default format;
