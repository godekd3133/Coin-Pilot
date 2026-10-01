// backtest 공유 숫자 정규화 — NaN/undefined/null을 fallback으로 수렴.
export function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
