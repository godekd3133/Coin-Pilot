import { DEFAULT_QUOTE_EXECUTION_COST_MODEL } from './quoteExecutionCostCompatibility.js';

const COST_FLOOR_EPSILON_PERCENT = 1e-9;

export const DEFAULT_MOMENTUM_SHADOW_COST_PERCENT =
  DEFAULT_QUOTE_EXECUTION_COST_MODEL.assumedRoundTripCostPercent;

export function resolveMomentumShadowCostPercent(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return DEFAULT_MOMENTUM_SHADOW_COST_PERCENT;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MOMENTUM_SHADOW_COST_PERCENT;
}

export function assessMomentumShadowCostFloor(costPercent) {
  const configuredCostPercent = costPercent === null || costPercent === undefined || costPercent === ''
    ? null
    : Number(costPercent);
  const valid = configuredCostPercent !== null &&
    Number.isFinite(configuredCostPercent) && configuredCostPercent >= 0;
  const ready = valid && configuredCostPercent + COST_FLOOR_EPSILON_PERCENT >=
    DEFAULT_MOMENTUM_SHADOW_COST_PERCENT;
  return {
    ready,
    configuredCostPercent: valid ? configuredCostPercent : null,
    requiredCostPercent: DEFAULT_MOMENTUM_SHADOW_COST_PERCENT,
    reason: ready
      ? 'candidate_cost_meets_modeled_round_trip_cost'
      : 'candidate_cost_below_round_trip_cost_floor'
  };
}

export function gateMomentumShadowEntryCandidates(entryCandidates, costFloor) {
  const candidates = Array.isArray(entryCandidates) ? entryCandidates : [];
  const ready = costFloor?.ready === true;
  return {
    entryCandidates: ready ? candidates : [],
    blockedEntryCount: ready ? 0 : candidates.length
  };
}
