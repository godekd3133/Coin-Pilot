// PortfolioValuation — 계좌/평가 읽기 모델.
//
// MultiCoinTrader에서 추출 — 상태 없음, owner를 통해 포트폴리오·시세·계좌를 읽는다.
export class PortfolioValuation {
  constructor(owner) {
    this.owner = owner;
  }

  /**
   * 총 자산 계산 (KRW + 코인 평가액) - 드라이/실전 모드 모두 지원
   */
  async calculateTotalAssets(priceMapOverride = null, {
    allowAveragePriceFallback = true,
    accountsOverride = null
  } = {}) {
    if (this.owner.dryRun) {
      // 드라이 모드: 가상 포트폴리오 사용
      let totalAssets = this.owner.virtualPortfolio.krwBalance;

      const holdingCoins = Array.from(this.owner.virtualPortfolio.holdings.keys());
      if (!allowAveragePriceFallback && holdingCoins.length > 0) {
        const priceMap = priceMapOverride instanceof Map ? new Map(priceMapOverride) : new Map();
        if (!(priceMapOverride instanceof Map)) {
          try {
            const tickers = await this.owner.marketDataAdapter.getTickers(holdingCoins);
            if (Array.isArray(tickers)) {
              for (const ticker of tickers) {
                const price = Number(ticker?.trade_price);
                if (ticker?.market && Number.isFinite(price) && price > 0) {
                  priceMap.set(ticker.market, price);
                }
              }
            }
          } catch {
            return null;
          }
        }

        for (const [coin, holding] of this.owner.virtualPortfolio.holdings.entries()) {
          const currentPrice = Number(priceMap.get(coin));
          if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
          totalAssets += currentPrice * holding.amount;
        }
        return totalAssets;
      }

      if (holdingCoins.length > 0) {
        // A shared research snapshot may provide one common mark for every
        // variant. In normal runtime paths this remains null and the method
        // keeps its existing exchange read behavior.
        const priceMap = priceMapOverride instanceof Map
          ? priceMapOverride
          : new Map();

        if (!(priceMapOverride instanceof Map)) {
          try {
            const tickers = await this.owner.marketDataAdapter.getTickers(holdingCoins);
            // ticker 응답을 맵으로 변환
            if (tickers && Array.isArray(tickers)) {
              for (const ticker of tickers) {
                if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                  priceMap.set(ticker.market, ticker.trade_price);
                }
              }
            }
          } catch {
            // ticker 조회 실패 시 priceMap은 비어있음 → 평균단가로 계산됨
          }
        }

        // 모든 보유 코인에 대해 계산 (현재가 또는 평균단가)
        for (const [coin, holding] of this.owner.virtualPortfolio.holdings.entries()) {
          const currentPrice = priceMap.get(coin);
          if (currentPrice !== undefined) {
            // 현재가로 계산
            totalAssets += currentPrice * holding.amount;
          } else {
            // 현재가 조회 실패 시 평균단가로 계산
            totalAssets += holding.avgPrice * holding.amount;
          }
        }
      }
      return totalAssets;
    } else {
      // 실전 모드: 실제 업비트 계좌 잔액 사용
      const accounts = !allowAveragePriceFallback && Array.isArray(accountsOverride)
        ? accountsOverride
        : await this.owner.upbit.getAccounts({ priority: 'risk' });
      if (!accounts || !Array.isArray(accounts)) {
        console.error('계좌 조회 실패');
        return allowAveragePriceFallback ? 0 : null;
      }

      if (!allowAveragePriceFallback) {
        let totalAssets = 0;
        const krwAccount = accounts.find(acc => acc.currency === this.owner.quoteAsset);
        if (krwAccount) {
          totalAssets += parseFloat(krwAccount.balance || 0) + parseFloat(krwAccount.locked || 0);
        }

        const coinAccounts = accounts.filter(acc => {
          if (acc.currency === this.owner.quoteAsset) return false;
          const balance = parseFloat(acc.balance || 0) + parseFloat(acc.locked || 0);
          return Number.isFinite(balance) && balance > 0;
        });
        if (coinAccounts.length === 0) return totalAssets;

        const coinMarkets = coinAccounts.map(acc => `${this.owner.quoteAsset}-${acc.currency}`);
        const priceMap = priceMapOverride instanceof Map ? new Map(priceMapOverride) : new Map();
        if (!(priceMapOverride instanceof Map)) {
          try {
            const tickers = await this.owner.marketDataAdapter.getTickers(coinMarkets);
            if (Array.isArray(tickers)) {
              for (const ticker of tickers) {
                const price = Number(ticker?.trade_price);
                if (ticker?.market && Number.isFinite(price) && price > 0) {
                  priceMap.set(ticker.market, price);
                }
              }
            }
          } catch {
            return null;
          }
        }

        for (const account of coinAccounts) {
          const market = `${this.owner.quoteAsset}-${account.currency}`;
          const price = Number(priceMap.get(market));
          if (!Number.isFinite(price) || price <= 0) return null;
          const balance = parseFloat(account.balance || 0) + parseFloat(account.locked || 0);
          totalAssets += price * balance;
        }
        return totalAssets;
      }

      let totalAssets = 0;

      // KRW 잔액
      const krwAccount = accounts.find(acc => acc.currency === this.owner.quoteAsset);
      if (krwAccount) {
        totalAssets += parseFloat(krwAccount.balance) + parseFloat(krwAccount.locked || 0);
      }

      // 보유 코인 평가액
      const coinAccounts = accounts.filter(acc => acc.currency !== this.owner.quoteAsset && parseFloat(acc.balance) > 0);
      if (coinAccounts.length > 0) {
        const coinMarkets = coinAccounts.map(acc => `${this.owner.quoteAsset}-${acc.currency}`);
        try {
          const tickers = await this.owner.marketDataAdapter.getTickers(coinMarkets);
          // ticker 응답 유효성 검사
          if (tickers && Array.isArray(tickers) && tickers.length > 0) {
            for (const ticker of tickers) {
              if (ticker && ticker.market && typeof ticker.trade_price === 'number') {
                const coinSymbol = ticker.market.split('-')[1];
                const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
                if (coinAccount) {
                  const balance = parseFloat(coinAccount.balance) + parseFloat(coinAccount.locked || 0);
                  totalAssets += ticker.trade_price * balance;
                }
              }
            }
          } else {
            // ticker 조회 실패 시 평균매입가로 계산
            for (const acc of coinAccounts) {
              const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
              totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
            }
          }
        } catch {
          // 현재가 조회 실패 시 평균매입가로 계산
          for (const acc of coinAccounts) {
            const balance = parseFloat(acc.balance) + parseFloat(acc.locked || 0);
            totalAssets += parseFloat(acc.avg_buy_price || 0) * balance;
          }
        }
      }
      return totalAssets;
    }
  }

  /**
   * 현재 보유 중인 코인 목록 반환 (백테스팅용)
   */
  async getHeldCoins() {
    if (this.owner.dryRun) {
      // 드라이 모드: 가상 포트폴리오에서 보유 코인 목록 반환
      return Array.from(this.owner.virtualPortfolio.holdings.keys());
    } else {
      // 실전 모드: 실제 업비트 계좌에서 보유 코인 목록 반환
      try {
        const accounts = await this.owner.upbit.getAccounts({ priority: 'risk' });
        if (!accounts || !Array.isArray(accounts)) {
          return [];
        }
        return accounts
          .filter(acc => acc.currency !== this.owner.quoteAsset && parseFloat(acc.balance) > 0)
          .map(acc => `${this.owner.quoteAsset}-${acc.currency}`);
      } catch (error) {
        console.error('보유 코인 조회 실패:', error.message);
        return [];
      }
    }
  }

  /**
   * 동적 투자금액 계산 (비율 기반으로 단순화)
   * @param {number} totalAssets - 총 자산
   * @param {Object} signalStrength - 신호 강도 { level, multiplier, score }
   */
  async calculateDynamicInvestmentAmount(totalAssets = null, signalStrength = null) {
    const investmentRatio = Number(this.owner.investmentRatio);
    if (!Number.isFinite(investmentRatio) || investmentRatio <= 0) return 0;

    // 총 자산이 전달되지 않으면 계산
    if (totalAssets === null) {
      totalAssets = await this.owner.calculateTotalAssets();
    }

    // 투자금액: 총 자산의 investmentRatio
    let dynamicAmount = totalAssets * investmentRatio;

    // 신호 강도에 따른 배수 적용
    if (signalStrength && signalStrength.multiplier > 0) {
      dynamicAmount *= signalStrength.multiplier;
      console.log(`  📊 신호 강도: ${signalStrength.level} (x${signalStrength.multiplier})`);
    }

    // 최소 주문 금액 체크 (업비트 최소 5,000원)
    dynamicAmount = Math.max(this.owner.MIN_ORDER_AMOUNT, dynamicAmount);

    return Math.floor(dynamicAmount);
  }

  /**
   * 누적손익 계산
   */
  async calculateCumulativePnL(options = {}) {
    const totalAssets = await this.owner.calculateTotalAssets(options.priceMapOverride ?? null, options);
    const valuationAvailable = Number.isFinite(totalAssets);
    const result = {
      initialSeedMoney: this.owner.initialSeedMoney,
      totalAssets: valuationAvailable ? Math.round(totalAssets) : null,
      profit: valuationAvailable ? Math.round(totalAssets - this.owner.initialSeedMoney) : null,
      profitPercent: valuationAvailable && this.owner.initialSeedMoney > 0
        ? ((totalAssets / this.owner.initialSeedMoney) - 1) * 100
        : valuationAvailable ? 0 : null,
      mode: this.owner.dryRun ? 'DRY_RUN' : 'LIVE'
    };

    if (options.allowAveragePriceFallback === false) {
      result.valuationAvailable = valuationAvailable;
      result.valuationStatus = valuationAvailable ? 'available' : 'unavailable';
    }
    return result;
  }

  /**
   * 계좌 정보 조회
   */
  async getAccountInfo() {
    if (this.owner.dryRun) {
      // 가상 포트폴리오에서 잔액 반환
      const accounts = [
        { currency: this.owner.quoteAsset, balance: String(this.owner.virtualPortfolio.krwBalance), locked: '0', avg_buy_price: '0' }
      ];

      // 보유 코인 추가
      for (const [coin, holding] of this.owner.virtualPortfolio.holdings.entries()) {
        const coinSymbol = coin.split('-')[1];
        accounts.push({
          currency: coinSymbol,
          balance: String(holding.amount),
          locked: '0',
          avg_buy_price: String(holding.avgPrice)
        });
      }

      return accounts;
    }
    return await this.owner.upbit.getAccounts({ priority: 'risk' });
  }

  /**
   * KRW 잔액 조회 (사용 가능 금액만)
   */
  getKRWBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === this.owner.quoteAsset);
    if (!krwAccount) return 0;
    // balance는 사용 가능한 금액, locked는 주문 중인 금액 (별도 관리됨)
    return parseFloat(krwAccount.balance) || 0;
  }

  /**
   * KRW 총 잔액 조회 (locked 포함)
   */
  getKRWTotalBalance(accounts) {
    const krwAccount = accounts.find(acc => acc.currency === this.owner.quoteAsset);
    if (!krwAccount) return 0;

    const balance = parseFloat(krwAccount.balance) || 0;
    const locked = parseFloat(krwAccount.locked) || 0;
    return balance + locked;
  }

  /**
   * 코인 잔액 조회
   */
  getCoinBalance(accounts, market) {
    const coinSymbol = market.split('-')[1];
    const coinAccount = accounts.find(acc => acc.currency === coinSymbol);
    return coinAccount ? parseFloat(coinAccount.balance) : 0;
  }
}
