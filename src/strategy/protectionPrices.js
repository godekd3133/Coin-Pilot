/**
 * 보호 출구가 실제 순손익 기준으로 작동하도록 비용을 반영한 가격을
 * 계산한다. paper/backtest의 entry amount는 매수 수수료 차감 후 수량이고,
 * exit price는 adverse slippage를 거친다고 가정하므로 두 비용을 모두
 * 포함해야 진짜 break-even이 된다.
 */
export function calculateCostAdjustedBreakEvenPrice(
  entryPrice,
  {
    tradingFee = 0.0005,
    slippage = 0.001,
    offsetPercent = 0
  } = {}
) {
  const entry = Number(entryPrice);
  const fee = Number(tradingFee);
  const adverseSlippage = Number(slippage);
  const offset = Number(offsetPercent);
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const safeFee = Number.isFinite(fee) ? Math.max(0, Math.min(0.99, fee)) : 0.0005;
  const safeSlippage = Number.isFinite(adverseSlippage)
    ? Math.max(0, Math.min(0.99, adverseSlippage))
    : 0.001;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  const executionFactor = (1 - safeFee) ** 2 * (1 - safeSlippage);
  if (executionFactor <= 0) return null;
  return (entry / executionFactor) * (1 + safeOffset / 100);
}
