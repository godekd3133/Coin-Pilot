export const API_READ_QUERY_LIMITS = Object.freeze({
  allCoinScores: Object.freeze({ defaultValue: 100, max: 100 }),
  trades: Object.freeze({ defaultValue: 50, max: 100 }),
  news: Object.freeze({ defaultValue: 100, max: 100 }),
  coinNews: Object.freeze({ defaultValue: 50, max: 100 })
});

export function parseBoundedIntegerQuery(value, { defaultValue, max } = {}) {
  if (!Number.isSafeInteger(defaultValue) || defaultValue <= 0 ||
    !Number.isSafeInteger(max) || max < defaultValue) {
    throw new RangeError('defaultValue and max must be positive safe integers, with max >= defaultValue');
  }

  let parsedValue;
  if (typeof value === 'number') {
    parsedValue = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    parsedValue = Number(value);
  } else {
    return defaultValue;
  }

  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return Math.min(parsedValue, max);
}
