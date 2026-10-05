// 수동(UI-originated) 주문 서비스 어셈블러.
// 각 use-case는 자기 모듈에서 오고, 공유 의존은 manualOrderContext가 한 번 조립한다.
// 각 메서드는 {status, body}를 반환하며 예외는 호출자가 500으로 매핑한다.
import { createManualOrderContext } from './manualOrderContext.js';
import { createExecuteUseCase } from './manualOrderTrade.js';
import { createBuyUseCase } from './manualOrderBuy.js';
import { createSellUseCase } from './manualOrderSell.js';
import { createQuickUseCase } from './manualOrderQuick.js';
import { createSmartBuyUseCase } from './manualOrderSmartBuy.js';
import { createSmartSellUseCase } from './manualOrderSmartSell.js';
import { createExecuteBundleUseCase } from './manualOrderBundle.js';
import { quoteAmountMutationBlock } from './manualOrderLegs.js';

export function createManualOrderService({ tradingSystem, marketDataProvider }) {
  const ctx = createManualOrderContext({ tradingSystem, marketDataProvider });
  const supportedQuote = run => async (...args) => quoteAmountMutationBlock(tradingSystem) || run(...args);
  return {
    execute: supportedQuote(createExecuteUseCase(ctx)),
    buy: supportedQuote(createBuyUseCase(ctx)),
    sell: supportedQuote(createSellUseCase(ctx)),
    quick: supportedQuote(createQuickUseCase(ctx)),
    smartBuy: supportedQuote(createSmartBuyUseCase(ctx)),
    smartSell: supportedQuote(createSmartSellUseCase(ctx)),
    executeBundle: supportedQuote(createExecuteBundleUseCase(ctx))
  };
}
