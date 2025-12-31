# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Upbit cryptocurrency automated trading system with multi-coin support, backtesting, genetic algorithm optimization, real-time notifications, and web dashboard. Written in Node.js with ES modules. Supports analyzing all 230+ KRW market coins with `TARGET_COINS=ALL`.

## Commands

```bash
npm install          # Install dependencies
npm start            # Run integrated system (trading + optimization + dashboard)
npm run dev          # Development mode with auto-restart
npm run backtest     # Run backtesting only
npm run optimize     # Run parameter optimization only
npm run dashboard    # Run web dashboard only (http://localhost:3000)
```

## Architecture

```
src/
├── index.js                    # Main entry - integrates trading, optimization, backtesting loops
├── api/
│   ├── upbit.js               # Upbit API client (JWT auth, rate limiting, exponential backoff retry)
│   └── dashboardServer.js     # Express + Socket.io server for web dashboard API & real-time notifications
├── analysis/
│   ├── technicalIndicators.js # RSI, MACD, Bollinger Bands, MA crossover, volume analysis
│   └── newsMonitor.js         # Multi-source news + Twitter/X + coin-specific sentiment + urgent news detection
├── strategy/
│   └── tradingStrategy.js     # Trading decision + signal strength calculation
├── trader/
│   ├── autoTrader.js          # Single coin trader
│   └── multiCoinTrader.js     # Multi-coin portfolio trader with dynamic investment & rebalancing
├── backtest/
│   └── backtestEngine.js      # Backtesting with fee/slippage simulation, MDD, Sharpe ratio
├── optimization/
│   └── parameterOptimizer.js  # Genetic algorithm for parameter optimization
├── ml/
│   └── pricePredictor.js      # Linear regression price prediction
├── scripts/
│   ├── runBacktest.js
│   ├── runOptimization.js
│   └── runDashboard.js
└── utils/
    └── logger.js              # File-based logging with rotation
```

## Key Data Flow

1. **MultiCoinTrader** orchestrates the trading loop
2. **UpbitAPI** fetches candle data and handles orders (with rate limiting: 100ms min interval, exponential backoff on 429)
3. **comprehensiveAnalysis()** computes technical indicators
4. **NewsMonitor** provides sentiment scores and detects urgent news
5. **TradingStrategy.makeDecision()** combines scores (60% technical, 40% news) and calculates signal strength
6. **Signal Strength** (WEAK/MEDIUM/STRONG/VERY_STRONG) determines investment multiplier (0.8x to 2.5x)
7. **Dynamic Investment** calculates amount based on total assets × ratio × signal multiplier
8. **ParameterOptimizer** uses BacktestEngine to evaluate fitness and evolve parameters via genetic algorithm
9. **DashboardServer** emits real-time notifications via Socket.io for bundle suggestions and breaking news

## Signal Strength System

`TradingStrategy.calculateSignalStrength()` returns:

- `WEAK` (multiplier: 0.8x) - score 0-7 above threshold
- `MEDIUM` (multiplier: 1.2x) - score 8-14 above threshold
- `STRONG` (multiplier: 1.8x) - score 15-24 above threshold
- `VERY_STRONG` (multiplier: 2.5x) - score 25+ above threshold

## Real-time Notification System

`DashboardServer` uses Socket.io for real-time push notifications:

**Events emitted:**

- `new-signal` - Bundle rebalancing suggestions (sell A → buy B)
- `breaking-news` - Urgent news detection (급등, 급락, 규제, 금지, crash, surge, ban, etc.)

**Bundle Suggestions (`generateBundleSuggestions()`):**

1. Analyzes held positions for sell candidates (RSI overbought, profit taking, MACD bearish)
2. Scans top 20 volume coins for buy candidates (RSI oversold, price drop, MACD bullish)
3. Creates sell+buy pairs with combined score ≥ 80 points
4. Returns top 3 bundles sorted by total score

**Notification Flow:**

- Monitoring interval: 30 seconds
- Duplicate prevention: 5-minute cooldown per bundle key
- Frontend receives via Socket.io client and displays popup with sound

**API Endpoints:**

- `GET /api/bundle-suggestions` - Fetch current bundle suggestions
- `POST /api/trade/execute-bundle` - Execute sell+buy bundle trade

## Dynamic Investment

`MultiCoinTrader.calculateDynamicInvestmentAmount()`:

- Calculation: `totalAssets × investmentRatio × signalMultiplier`
- Default investmentRatio: 5%
- Minimum order: 5,000 KRW (Upbit minimum)
- Signal multiplier applied directly (0.8x to 2.5x based on strength)

## Rebalancing System

When max positions reached but a STRONG/VERY_STRONG buy signal detected:

1. `findWeakestPosition()` identifies the worst-performing position (lowest score - profit%)
2. `sellForRebalancing()` sells the weak position to free up funds
3. New position opened with the stronger signal coin

Rebalancing also triggers when balance insufficient but strong signal exists.

## UpbitAPI Error Handling

`UpbitAPI.order()` returns structured response:

- Success: `{ success: true, data: OrderData }`
- Failure: `{ success: false, error: { code, message, raw } }`

Error codes parsed via `parseApiError()`:

- `insufficient_funds_bid/ask` - Balance insufficient
- `under_min_total_bid` - Below 5,000 KRW minimum
- `market_does_not_exist` - Invalid market code

Helper methods:

- `waitForOrderFill(uuid, maxWaitMs)` - Poll order status until filled/timeout
- `isValidOrderAmount(amount)` - Check minimum order (5,000 KRW)
- `calculateMaxOrderVolume(krwBalance, price)` - Calculate max volume with fee consideration

## Coin-Specific Sentiment Analysis

`NewsMonitor` provides coin-specific sentiment analysis with multi-source support:

**News Sources:**

- CoinDesk, CoinTelegraph (English crypto news)
- Google News (English & Korean RSS feeds)
- Naver News (Korean)
- Twitter/X (via Nitter mirrors: nitter.net, nitter.privacydev.net, nitter.poast.org)
- CryptoPanic API (fallback for Twitter)

**Key Methods:**

- `getCoinSentiment(coin, maxAgeMs)` - Get cached sentiment for a coin (default 10min cache)
- `getMultiCoinSentiment(coins)` - Batch sentiment analysis with rate limiting (5 coins/batch)
- `fetchCoinSpecificNews(coin)` - Collect news from all sources for specific coin
- `fetchTwitterNews(query)` - Twitter/X search via Nitter mirrors
- `detectUrgentNews(news)` - Detect breaking news with urgent keywords (급등, 급락, 규제, crash, etc.)

**Coin Name Mapping:**

Pre-configured mappings for major coins (BTC, ETH, XRP, SOL, etc.) with:

- English name (e.g., "Bitcoin")
- Korean name (e.g., "비트코인")
- Symbol (e.g., "BTC")
- Twitter cashtag (e.g., "$BTC")

## Web Dashboard API Endpoints

**Core APIs:**

- `GET /api/status` - System status (running, mode, positions)
- `GET /api/account` - Account info (balance, positions, totalAssets)
- `GET /api/positions` - Current holding positions
- `GET /api/statistics` - Trading statistics per coin
- `GET /api/cumulative-pnl` - Cumulative profit/loss vs seed money

**Trading APIs:**

- `POST /api/trade/execute` - Execute single buy/sell order
- `POST /api/trade/execute-bundle` - Execute bundle trade (sell A + buy B)
- `POST /api/trade/smart-buy` - Smart buy with multi-coin allocation
- `POST /api/trade/smart-sell` - Smart sell with profit optimization
- `POST /api/trade/quick` - Quick market order
- `GET /api/bundle-suggestions` - Get rebalancing suggestions

**Analysis APIs:**

- `GET /api/coin-analysis` - Technical analysis for all target coins
- `GET /api/coin-detail/:coin` - Detailed coin info with indicators
- `GET /api/portfolio-analysis` - Portfolio composition and performance
- `GET /api/news/:coin` - Coin-specific news and sentiment

**Virtual Wallet (DRY_RUN mode):**

- `POST /api/virtual/deposit` - Add virtual funds
- `POST /api/virtual/withdraw` - Remove virtual funds
- `POST /api/virtual/reset` - Reset to initial seed money

**Control APIs:**

- `POST /api/control/start` - Start auto trading
- `POST /api/control/stop` - Stop auto trading
- `POST /api/config/update` - Update trading parameters

## Trading Fee System (CRITICAL)

모든 거래에 0.05% 수수료가 적용됨 - 새 거래 로직 추가 시 반드시 적용 필요

```javascript
const FEE_RATE = 0.0005; // 0.05%

// 매수 시
const fee = investmentAmount * FEE_RATE;
const actualInvestment = investmentAmount - fee;
const volume = actualInvestment / currentPrice;
// KRW 잔액에서 investmentAmount (수수료 포함) 차감

// 매도 시
const grossSellAmount = sellVolume * currentPrice;
const fee = grossSellAmount * FEE_RATE;
const netSellAmount = grossSellAmount - fee;
// KRW 잔액에 netSellAmount (수수료 차감) 입금
```

수수료가 적용되는 모든 위치:

| 파일                   | 기능                    | 비고                       |
| ---------------------- | ----------------------- | -------------------------- |
| `multiCoinTrader.js`   | 자동매매 (BUY/SELL)     | 라인 840-844, 977-980      |
| `multiCoinTrader.js`   | 리밸런싱 매도           | 라인 1178-1182             |
| `tradingStrategy.js`   | closePosition()         | 라인 366-369 (통계 계산용) |
| `trading.js`           | /trade/execute          | 라인 722, 799              |
| `trading.js`           | /trade/execute-bundle   | 라인 577                   |
| `trading.js`           | /trade/smart-buy        | 라인 998                   |
| `trading.js`           | /trade/smart-sell       | 라인 1221                  |
| `trading.js`           | /trade/quick            | 라인 1360, 1449            |
| `trading.js`           | /trade/buy, /trade/sell | 라인 1506, 1586            |

## Virtual Portfolio Data Structure (dry_portfolio.json)

```json
{
  "krwBalance": 10000000,          // KRW 잔액
  "holdings": {                     // 보유 코인
    "KRW-BTC": {
      "amount": 0.001,              // 보유 수량
      "avgPrice": 100000000,        // 평균 매수가 (시장가 기준)
      "entryTime": "2025-..."       // 최초 매수 시간 (ISO string)
    }
  },
  "positions": {                    // 전략 포지션 (통계 추적용)
    "KRW-BTC": {
      "type": "BUY",
      "entryPrice": 100000000,
      "amount": 0.001,
      "entryTime": "2025-...",      // Date로 변환 필요
      "id": 1234567890
    }
  },
  "tradeHistory": {                 // 거래 이력 (코인별 객체)
    "KRW-BTC": [
      { "action": "OPEN", ... },
      { "action": "CLOSE", "profit": 1000, ... }
    ]
  },
  "initialSeedMoney": 10000000,     // 초기 시드머니 (누적손익 계산)
  "updatedAt": "2025-..."           // 마지막 저장 시간
}
```

저장/로드 시 주의사항:

- `holdings`와 `positions`는 항상 동기화 필요
- `entryTime`은 저장 시 ISO string, 로드 시 Date 객체로 변환
- `tradeHistory`는 구버전(배열)과 신버전(객체) 모두 지원 (자동 마이그레이션)

## Holdings & Position Sync Rules

매수 시 필수 작업:

```javascript
// 1. holdings 업데이트
virtualPortfolio.holdings.set(coin, {
  amount: newAmount,
  avgPrice: newAvgPrice,
  entryTime: existing.entryTime || new Date().toISOString()  // 최초 매수 시간 유지!
});

// 2. 전략 포지션 업데이트
strategy.openPosition(currentPrice, volume, 'BUY');

// 3. 저장
saveVirtualPortfolio();
```

매도 시 필수 작업:

```javascript
// 1. holdings 업데이트
holding.amount -= sellVolume;
if (holding.amount <= 0.00000001) {
  virtualPortfolio.holdings.delete(coin);
}

// 2. 전략 포지션 종료 (통계 기록)
strategy.closePosition(currentPrice, reason);

// 3. 저장
saveVirtualPortfolio();
```

## Live Trading Specifics

실전 모드에서 체결 데이터 사용:

```javascript
// 주문 후 체결 대기
const fillResult = await this.upbit.waitForOrderFill(orderId, 30000);

if (fillResult.filled) {
  const filledOrder = fillResult.order;

  // 실제 체결 데이터 사용 (예상가 아님!)
  const actualPrice = parseFloat(filledOrder.avg_price);  // 평균 체결가
  const actualVolume = parseFloat(filledOrder.executed_volume);
  const paidFee = parseFloat(filledOrder.paid_fee);  // 실제 수수료

  // 슬리피지 계산
  const slippage = ((actualPrice - expectedPrice) / expectedPrice * 100);
}
```

거래소 동기화 (10분마다):

- `syncWithExchange()`: 내부 상태와 거래소 실잔고 비교
- 불일치 시 자동 수정 (포지션 복구 또는 제거)
- `cleanupPendingOrders()`: 5분 이상 미체결 주문 취소

## Statistics Calculation

`TradingStrategy.getStatistics()`는 `tradeHistory`의 CLOSE와 PARTIAL_CLOSE 기록 모두 사용:

```javascript
// 전체 매도 + 부분 매도 모두 포함
const allSellTrades = this.tradeHistory.filter(t =>
  t.action === 'CLOSE' || t.action === 'PARTIAL_CLOSE'
);
const winningTrades = allSellTrades.filter(t => t.profit > 0);
const totalProfit = allSellTrades.reduce((sum, t) => sum + t.profit, 0);
```

profit 계산 (closePosition 내부):

- grossProfit = (매도가 - 매수가) × 수량
- buyFee = 매수가 × 수량 × 0.0005
- sellFee = 매도가 × 수량 × 0.0005
- netProfit = grossProfit - buyFee - sellFee

## API Route Development Checklist (CRITICAL)

새 거래 API 엔드포인트 작성 시 반드시 확인:

### ⚠️ DRY_RUN과 LIVE 모드 모두 Strategy 업데이트 필수

**가장 흔한 버그**: DRY_RUN에서만 strategy 업데이트하고 LIVE에서 누락

```javascript
// ❌ 잘못된 패턴 - LIVE 모드에서 통계 누락
if (isDryRun) {
  virtualPortfolio.holdings.set(coin, ...);
  strategy.openPosition(price, volume, 'BUY');  // DRY_RUN만 업데이트
} else {
  await upbit.order(coin, 'bid', amount, null, 'price');
  // strategy 업데이트 누락!
}

// ✅ 올바른 패턴 - 두 모드 모두 업데이트
if (isDryRun) {
  virtualPortfolio.holdings.set(coin, ...);
  strategy.openPosition(price, volume, 'BUY');
  saveVirtualPortfolio();
} else {
  await upbit.order(coin, 'bid', amount, null, 'price');
  // LIVE도 strategy 업데이트!
  strategy.openPosition(price, volume, 'BUY');
}
```

### 1. Strategy 동적 생성 패턴

```javascript
// ❌ 잘못된 패턴 - strategy 없으면 통계 누락
const strategy = server.tradingSystem.strategies?.get(coin);

// ✅ 올바른 패턴 - 없으면 동적 생성
const strategy = server.tradingSystem.strategies?.get(coin) ||
                 server.tradingSystem.getStrategy?.(coin);
```

### 2. 부분 매도 vs 전체 매도 처리

```javascript
const isFullSell = holding.amount - sellVolume <= 0.00000001;

if (isFullSell) {
  // 전체 매도 - holdings 삭제 + closePosition
  virtualPortfolio.holdings.delete(coin);
  strategy.closePosition(currentPrice, reason);
} else {
  // 부분 매도 - recordPartialSell 사용 (수익 기록 포함)
  holding.amount -= sellVolume;
  strategy.recordPartialSell(currentPrice, sellVolume, reason);
  // recordPartialSell()이 내부에서:
  // - 부분 매도 수익 계산 (수수료 포함)
  // - tradeHistory에 PARTIAL_CLOSE 기록
  // - currentPosition.amount 감소
  // - 잔량 0이면 자동으로 closePosition 호출
}
```

**recordPartialSell() 메서드**: 부분 매도 시에도 수익이 통계에 반영되도록 함

- `action: 'PARTIAL_CLOSE'`로 tradeHistory에 기록
- 매수 시 수수료의 비율 + 매도 수수료를 계산하여 정확한 순수익 산출
- `getStatistics()`에서 CLOSE + PARTIAL_CLOSE 모두 집계

### 3. 추가 매수 시 평균단가 업데이트

```javascript
// holdings 평균단가
const existing = virtualPortfolio.holdings.get(coin) || { amount: 0, avgPrice: 0 };
const newAmount = existing.amount + buyVolume;
const newAvgPrice = ((existing.amount * existing.avgPrice) + (buyVolume * currentPrice)) / newAmount;

// strategy position 평균단가도 동일하게
if (strategy.currentPosition) {
  const totalAmount = strategy.currentPosition.amount + buyVolume;
  strategy.currentPosition.amount = totalAmount;
  strategy.currentPosition.entryPrice = newAvgPrice;  // 평균단가 업데이트
} else {
  strategy.openPosition(currentPrice, buyVolume, 'BUY');
}
```

### 4. 잔액 체크 (마이너스 방지)

```javascript
// 매수 전 잔액 확인
const currentBalance = virtualPortfolio.krwBalance || 0;
if (currentBalance < investmentAmount) {
  return res.status(400).json({
    error: `잔액 부족 (보유: ${currentBalance.toLocaleString()}원)`,
    success: false,
    availableBalance: currentBalance
  });
}

// 차감 시 Math.max로 마이너스 방지
virtualPortfolio.krwBalance = Math.max(0, currentBalance - investmentAmount);
```

### 5. 최소 금액 체크

```javascript
const MIN_ORDER_AMOUNT = 5000;  // Upbit 최소 주문금액

// 매수 전
if (investmentAmount < MIN_ORDER_AMOUNT) {
  return res.status(400).json({ error: '최소 투자금액은 5,000원입니다' });
}

// 매도 전
const estimatedSellAmount = sellVolume * currentPrice;
if (estimatedSellAmount < MIN_ORDER_AMOUNT) {
  return res.status(400).json({ error: '최소 매도금액은 5,000원입니다' });
}
```

### 6. 필수 저장 호출

```javascript
// 거래 완료 후 반드시 호출
server.tradingSystem.saveVirtualPortfolio();
```

## Important Files

- `.env` - API keys, trading mode (DRY_RUN), target coins, strategy parameters
- `optimal_config.json` - Persisted optimal parameters from genetic algorithm
- `dry_portfolio.json` - Virtual portfolio state (dry run mode, see structure above)
- `initial_seed_money.json` - Initial investment tracking (live mode, auto-created once)
- `backtest_results_*.json` - Per-coin backtesting results
- `optimization_history.json` - Parameter evolution history
- `portfolio_history.json` - Asset value snapshots for chart display

## Configuration

Key environment variables:
- `DRY_RUN=true/false` - Simulated vs real trading
- `TARGET_COINS` - Comma-separated coin list (e.g., KRW-BTC,KRW-ETH) or `ALL` to analyze all KRW markets
- `MAX_POSITIONS` - Maximum simultaneous positions
- `STOP_LOSS_PERCENT`, `TAKE_PROFIT_PERCENT` - Risk management
- `RSI_PERIOD`, `RSI_OVERSOLD`, `RSI_OVERBOUGHT` - Technical indicator params

## totalAssets 계산 규칙 (CRITICAL)

**모든 API에서 `calculateTotalAssets()` 사용 필수**

```javascript
// ✅ 올바른 패턴 - 통일된 계산
const totalAssets = await server.tradingSystem.calculateTotalAssets();

// ❌ 잘못된 패턴 - 직접 계산 (불일치 발생)
let totalAssets = krwBalance;
positions.forEach(pos => totalAssets += pos.amount * pos.currentPrice);
```

`calculateTotalAssets()`가 정확한 이유:

- `virtualPortfolio.holdings` 기반 (추가 매수 반영)
- ticker 조회 실패 시 평균단가로 fallback
- 모든 보유 코인 포함 (누락 없음)

## Known Architectural Limitations

### Race Condition (이론적)

동시 다발적인 API 요청 시 잔액 불일치 가능성 존재하나, Node.js 단일 스레드 특성상 실질적 위험 낮음:

- `await getTicker()` 이후 잔액 체크/업데이트는 동기 블록으로 실행
- 실제 문제 발생 시 mutex 패턴 적용 고려

## Codacy Integration

When editing files, run `codacy_cli_analyze` after modifications and after installing dependencies (with trivy for security scanning).
