/** Resolve the effective position and allocation limits without losing valid zero values. */
export function resolveTradingLimits({ env = {}, isScalpingMode, optimalParams = null }) {
  return {
    maxPositions: (isScalpingMode ? env.SCALP_MAX_POSITIONS : env.MAX_POSITIONS) ??
      (isScalpingMode ? 3 : 99999),
    portfolioAllocation: (isScalpingMode ? env.SCALP_PORTFOLIO_ALLOCATION : env.PORTFOLIO_ALLOCATION) ??
      (isScalpingMode ? 0.1 : 0.5),
    investmentRatio: isScalpingMode
      ? (env.SCALP_INVESTMENT_RATIO ?? 0.02)
      : (optimalParams?.investmentRatio ?? env.INVESTMENT_RATIO ?? 0.05)
  };
}
