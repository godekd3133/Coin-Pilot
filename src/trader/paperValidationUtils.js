// 페이퍼 검증 저널 공유 프리미티브 — paperValidationJournal.js에서 추출.

export function derivePositionExcursion(position = {}) {
  const entryPrice = Number(position.entryPrice);
  const validEntryPrice = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null;
  const highestPrice = validEntryPrice === null
    ? null
    : Number.isFinite(Number(position.highestPrice)) && Number(position.highestPrice) > 0
      ? Number(position.highestPrice)
      : validEntryPrice;
  const lowestPrice = validEntryPrice === null
    ? null
    : Number.isFinite(Number(position.lowestPrice)) && Number(position.lowestPrice) > 0
      ? Number(position.lowestPrice)
      : validEntryPrice;
  return {
    highestPrice,
    lowestPrice,
    maxFavorableExcursionPercent: validEntryPrice !== null && highestPrice !== null
      ? ((highestPrice - validEntryPrice) / validEntryPrice) * 100
      : null,
    maxAdverseExcursionPercent: validEntryPrice !== null && lowestPrice !== null
      ? ((lowestPrice - validEntryPrice) / validEntryPrice) * 100
      : null
  };
}

export function updatePositionExcursion(position, currentPrice) {
  if (!position || typeof position !== 'object') return derivePositionExcursion(position);
  const latestPrice = Number(currentPrice);
  const entryPrice = Number(position.entryPrice);
  if (Number.isFinite(latestPrice) && latestPrice > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    const current = derivePositionExcursion(position);
    position.highestPrice = Math.max(current.highestPrice ?? entryPrice, latestPrice);
    position.lowestPrice = Math.min(current.lowestPrice ?? entryPrice, latestPrice);
  }
  const excursion = derivePositionExcursion(position);
  position.highestPrice = excursion.highestPrice;
  position.lowestPrice = excursion.lowestPrice;
  position.maxFavorableExcursionPercent = excursion.maxFavorableExcursionPercent;
  position.maxAdverseExcursionPercent = excursion.maxAdverseExcursionPercent;
  return excursion;
}

export function validTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function serializePaperSignalEvidence(analysis, observedAt) {
  const rebound = analysis?.decision?.details?.rebound;
  if (!rebound || rebound.available !== true) return null;
  const numericOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    observedAt,
    signalKey: rebound.signalKey ? String(rebound.signalKey) : null,
    candleTime: rebound.candleTime || null,
    action: analysis?.decision?.action || 'HOLD',
    reason: String(analysis?.decision?.reason || 'unknown').slice(0, 120),
    currentPrice: numericOrNull(analysis?.currentPrice),
    previousRsi: numericOrNull(rebound.previousRsi),
    rsi: numericOrNull(rebound.rsi),
    previousWasOversold: rebound.previousWasOversold === true,
    currentWasOversold: rebound.currentWasOversold === true,
    bullishCandle: rebound.bullishCandle === true,
    reboundPriceChangePercent: numericOrNull(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent),
    rsiRecovery: numericOrNull(rebound.rsiRecovery),
    volumeRatio: numericOrNull(rebound.volumeRatio),
    closeStrength: numericOrNull(rebound.closeStrength),
    trendSlopePercent: numericOrNull(rebound.trendSlopePercent),
    previousHighBreak: rebound.previousHighBreak === true,
    volumeConfirmed: rebound.volumeConfirmed === true,
    volatilityConfirmed: rebound.volatilityConfirmed === true,
    signalRangeFloorConfirmed: rebound.signalRangeFloorConfirmed === true,
    closeStrengthConfirmed: rebound.closeStrengthConfirmed === true,
    trendConfirmed: rebound.trendConfirmed === true,
    previousHighBreakConfirmed: rebound.previousHighBreakConfirmed === true,
    reboundConfirmed: rebound.reboundConfirmed === true,
    signalProfile: rebound.signalProfile || null,
    rejectionReasons: [...new Set(Array.isArray(rebound.rejectionReasons) ? rebound.rejectionReasons : [])]
      .map(reason => String(reason).slice(0, 80))
      .slice(0, 12)
  };
}

export function inspectShadowEntryExecution(analysis, maxRetracePercent, maxChasePercent) {
  const rebound = analysis?.decision?.details?.rebound;
  const currentPrice = Number(analysis?.currentPrice);
  const referencePrice = Number(rebound?.referencePrice);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { valid: false, enforceable: true, reason: 'entry_price_invalid' };
  }
  // Some legacy diagnostic fixtures do not carry a rebound reference price.
  // Keep those rows observable rather than fabricating a drift value; the
  // strict BUY path always supplies a reference before execution.
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { valid: true, enforceable: false, reason: 'entry_reference_price_unavailable' };
  }

  const retracePercent = ((referencePrice - currentPrice) / referencePrice) * 100;
  if (retracePercent > maxRetracePercent) {
    return {
      valid: false,
      enforceable: true,
      reason: 'entry_retrace_exceeded',
      retracePercent,
      chasePercent: ((currentPrice - referencePrice) / referencePrice) * 100
    };
  }

  const chasePercent = ((currentPrice - referencePrice) / referencePrice) * 100;
  if (chasePercent > maxChasePercent) {
    return {
      valid: false,
      enforceable: true,
      reason: 'entry_chase_exceeded',
      retracePercent,
      chasePercent
    };
  }

  return { valid: true, enforceable: true, reason: null, retracePercent, chasePercent };
}
