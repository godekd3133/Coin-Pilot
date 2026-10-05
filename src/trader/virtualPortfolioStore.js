// VirtualPortfolioStore — DRY_RUN 가상 포트폴리오의 영속화·뮤테이션 경계.
//
// MultiCoinTrader에서 추출. 소유 범위:
// - virtualPortfolio 상태와 virtualPortfolioFile/seed 파일 IO
// - 수동 주문 mutation-and-persist seam(withManualPortfolioTransaction)
// - AsyncLocalStorage 기반 mutation 잠금(_portfolioMutationTail/Context)
// - 멱등성 레코드와 스냅샷/복원
//
// 트레이더 필드(strategies/config/upbit 등)는 owner를 통해 조회한다.
import fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { quoteOfSystem } from '../exchange/marketCodes.js';

function cloneManualPortfolioValue(value) {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export class VirtualPortfolioStore {
  constructor(owner) {
    this.owner = owner;
    this.virtualPortfolio = null;
    this.virtualPortfolioFile = null;
    this.initialSeedMoney = 0;
    this.smartTradeHistory = [];
    this.manualOrderIdempotencyRecords = [];
    this._portfolioMutationContext = new AsyncLocalStorage();
    this._portfolioMutationTail = Promise.resolve();
  }

  /**
   * 실전 모드용 초기 시드머니 로드/저장
   */
  loadInitialSeedMoney() {
    const seedFile = 'initial_seed_money.json';

    if (fs.existsSync(seedFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        if (data.initialSeedMoney > 0) {
          this.initialSeedMoney = data.initialSeedMoney;
          console.log(`📂 초기 시드머니 로드됨: ${this.initialSeedMoney.toLocaleString()}원`);
          console.log(`   기록일: ${data.recordedAt || '알 수 없음'}`);
        }
      } catch (error) {
        console.log('⚠️  초기 시드머니 로드 실패:', error.message);
      }
    }
  }

  /**
   * 실전 모드용 초기 시드머니 저장 (최초 1회만)
   */
  async saveInitialSeedMoney() {
    if (this.owner.dryRun) return;

    const seedFile = 'initial_seed_money.json';

    // 이미 저장된 파일이 있으면 스킵
    if (fs.existsSync(seedFile)) {
      return;
    }

    // 현재 총 자산을 초기 시드머니로 저장
    const totalAssets = await this.owner.calculateTotalAssets();

    const data = {
      initialSeedMoney: quoteOfSystem(this.owner) === 'KRW' ? Math.round(totalAssets) : totalAssets,
      recordedAt: new Date().toISOString(),
      note: '실전 모드 초기 투자금 (자동 기록)'
    };

    this.owner.writeJsonAtomically(seedFile, data);
    this.initialSeedMoney = data.initialSeedMoney;
    console.log(`💾 초기 시드머니 저장됨: ${this.initialSeedMoney.toLocaleString()}원`);
  }

  /**
   * 가상 포트폴리오 저장 (드라이 모드)
   */
  mutateAndPersistVirtualPortfolio(mutate) {
    if (!this.owner.dryRun) throw new Error('가상 포트폴리오는 모의투자 모드에서만 변경할 수 있습니다.');
    if (typeof mutate !== 'function') throw new TypeError('가상 포트폴리오 변경 함수가 필요합니다.');

    const portfolio = this.virtualPortfolio;
    const previousBalance = portfolio.krwBalance;
    const previousHoldingsReference = portfolio.holdings;
    const previousHoldingsEntries = previousHoldingsReference instanceof Map
      ? Array.from(previousHoldingsReference.entries(), ([market, holding]) => [
        market,
        holding && typeof holding === 'object' ? { ...holding } : holding
      ])
      : null;
    const previousSeedMoney = this.initialSeedMoney;
    const previousStrategyState = Array.from(this.owner.strategies?.values?.() || [], strategy => ({
      strategy,
      currentPosition: strategy.currentPosition,
      tradeHistory: strategy.tradeHistory
    }));

    try {
      mutate();
      this.owner.saveVirtualPortfolio();
      return true;
    } catch (error) {
      this.virtualPortfolio = portfolio;
      portfolio.krwBalance = previousBalance;
      portfolio.holdings = previousHoldingsReference;
      if (previousHoldingsReference instanceof Map && previousHoldingsEntries) {
        previousHoldingsReference.clear();
        for (const [market, holding] of previousHoldingsEntries) {
          previousHoldingsReference.set(market, holding);
        }
      }
      this.initialSeedMoney = previousSeedMoney;
      for (const state of previousStrategyState) {
        state.strategy.currentPosition = state.currentPosition;
        state.strategy.tradeHistory = state.tradeHistory;
      }
      throw error;
    }
  }

  adjustVirtualWalletBalance(delta) {
    const isKrw = quoteOfSystem(this.owner) === 'KRW';
    const validDelta = isKrw
      ? Number.isSafeInteger(delta)
      : Number.isFinite(delta) && Math.abs(delta) <= Number.MAX_SAFE_INTEGER;
    if (!validDelta || delta === 0) {
      throw new TypeError('모의 잔액 변경 금액이 올바르지 않습니다.');
    }

    const currentBalance = Number(this.virtualPortfolio?.krwBalance);
    const nextBalance = currentBalance + delta;
    if (!Number.isFinite(currentBalance) || !Number.isFinite(nextBalance) ||
      nextBalance < 0 || nextBalance > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('모의 잔액을 확인할 수 없습니다.');
    }
    // Reject arithmetic loss before saving, rather than silently accepting a
    // fractional adjustment that a large stored balance cannot represent.
    const deltaTolerance = Math.max(1e-8, Math.abs(delta) * Number.EPSILON * 4);
    const preservesDelta = (current, next) => next !== current &&
      Math.abs((next - current) - delta) <= deltaTolerance;
    if (!isKrw && !preservesDelta(currentBalance, nextBalance)) {
      throw new RangeError('현재 잔액에서는 입력한 소수 금액을 정확히 반영할 수 없습니다.');
    }

    const previousSeedMoney = this.initialSeedMoney;
    const nextSeedMoney = previousSeedMoney === undefined
      ? previousSeedMoney
      : Math.max(0, Number(previousSeedMoney) + delta);
    if (nextSeedMoney !== undefined && (!Number.isFinite(nextSeedMoney) || nextSeedMoney > Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('수익률 기준 금액을 확인할 수 없습니다.');
    }
    if (!isKrw && nextSeedMoney !== undefined && Number(previousSeedMoney) + delta >= 0 &&
      !preservesDelta(Number(previousSeedMoney), nextSeedMoney)) {
      throw new RangeError('현재 수익률 기준 금액에서는 입력한 소수 금액을 정확히 반영할 수 없습니다.');
    }

    this.owner.mutateAndPersistVirtualPortfolio(() => {
      this.virtualPortfolio.krwBalance = nextBalance;
      if (previousSeedMoney !== undefined) this.initialSeedMoney = nextSeedMoney;
    });
    return {
      krwBalance: this.virtualPortfolio.krwBalance,
      initialSeedMoney: this.initialSeedMoney
    };
  }

  async withPortfolioMutationLock(operation) {
    if (typeof operation !== 'function') throw new TypeError('포트폴리오 변경 함수가 필요합니다.');
    const currentContext = this._portfolioMutationContext.getStore();
    if (currentContext?.tradingSystem === this) return operation(currentContext);

    const previousTurn = this._portfolioMutationTail;
    const turn = previousTurn.then(() => {
      const context = { tradingSystem: this, manualPortfolioTransaction: null };
      return this._portfolioMutationContext.run(context, () => operation(context));
    });
    this._portfolioMutationTail = turn.then(() => undefined, () => undefined);
    return turn;
  }

  snapshotManualPortfolioState() {
    const portfolio = this.virtualPortfolio;
    const holdings = portfolio?.holdings;
    return {
      portfolio,
      krwBalance: portfolio?.krwBalance,
      holdingsReference: holdings,
      holdingsEntries: holdings instanceof Map
        ? Array.from(holdings.entries(), ([market, holding]) => [market, cloneManualPortfolioValue(holding)])
        : null,
      initialSeedMoney: this.initialSeedMoney,
      strategiesReference: this.owner.strategies,
      strategies: Array.from(this.owner.strategies?.entries?.() || [], ([coin, strategy]) => ({
        coin,
        strategy,
        currentPosition: cloneManualPortfolioValue(strategy.currentPosition),
        tradeHistory: cloneManualPortfolioValue(strategy.tradeHistory)
      })),
      smartTradeHistoryReference: this.smartTradeHistory,
      smartTradeHistory: cloneManualPortfolioValue(this.smartTradeHistory)
    };
  }

  restoreManualPortfolioState(snapshot) {
    this.virtualPortfolio = snapshot.portfolio;
    if (snapshot.portfolio) {
      snapshot.portfolio.krwBalance = snapshot.krwBalance;
      snapshot.portfolio.holdings = snapshot.holdingsReference;
      if (snapshot.holdingsReference instanceof Map && snapshot.holdingsEntries) {
        snapshot.holdingsReference.clear();
        for (const [market, holding] of snapshot.holdingsEntries) {
          snapshot.holdingsReference.set(market, cloneManualPortfolioValue(holding));
        }
      }
    }
    this.initialSeedMoney = snapshot.initialSeedMoney;

    this.owner.strategies = snapshot.strategiesReference;
    const retainedCoins = new Set(snapshot.strategies.map(state => state.coin));
    for (const coin of this.owner.strategies.keys()) {
      if (!retainedCoins.has(coin)) this.owner.strategies.delete(coin);
    }
    for (const state of snapshot.strategies) {
      this.owner.strategies.set(state.coin, state.strategy);
      state.strategy.currentPosition = cloneManualPortfolioValue(state.currentPosition);
      state.strategy.tradeHistory = cloneManualPortfolioValue(state.tradeHistory);
    }

    if (Array.isArray(snapshot.smartTradeHistoryReference)) {
      snapshot.smartTradeHistoryReference.splice(0, snapshot.smartTradeHistoryReference.length,
        ...(Array.isArray(snapshot.smartTradeHistory) ? cloneManualPortfolioValue(snapshot.smartTradeHistory) : []));
    }
    this.smartTradeHistory = snapshot.smartTradeHistoryReference;
  }

  async withManualPortfolioTransaction(operation) {
    if (typeof operation !== 'function') throw new TypeError('수동 포트폴리오 작업 함수가 필요합니다.');
    return this.owner.withPortfolioMutationLock(async context => {
      if (context.manualPortfolioTransaction) {
        return operation(context.manualPortfolioTransaction);
      }
      const snapshot = this.owner.snapshotManualPortfolioState();
      const transaction = {
        committed: false,
        rolledBack: false,
        rollback: () => {
          if (transaction.rolledBack) return;
          this.owner.restoreManualPortfolioState(snapshot);
          transaction.rolledBack = true;
        },
        commit: () => { transaction.committed = true; }
      };
      context.manualPortfolioTransaction = transaction;
      try {
        return await operation(transaction);
      } finally {
        if (!transaction.committed) transaction.rollback();
        context.manualPortfolioTransaction = null;
      }
    });
  }

  persistManualOrderIdempotencyRecords(records) {
    if (!this.owner.dryRun) throw new Error('모의 포트폴리오 기록을 LIVE에서 저장할 수 없습니다.');
    const previousRecords = this.manualOrderIdempotencyRecords;
    this.manualOrderIdempotencyRecords = cloneManualPortfolioValue(records);
    try {
      this.owner.saveVirtualPortfolio({ force: true, syncDirectory: true });
      const transaction = this._portfolioMutationContext.getStore()?.manualPortfolioTransaction;
      transaction?.commit?.();
    } catch (error) {
      this.manualOrderIdempotencyRecords = previousRecords;
      throw error;
    }
  }

  saveVirtualPortfolio({ force = false, syncDirectory = false } = {}) {
    if (!this.owner.dryRun) return;

    const transaction = this._portfolioMutationContext.getStore()?.manualPortfolioTransaction;
    if (transaction && !force) {
      transaction.dirty = true;
      return;
    }

    const portfolioFile = this.virtualPortfolioFile;
    const data = {
      krwBalance: this.virtualPortfolio.krwBalance,
      holdings: {},
      positions: {},
      tradeHistory: {},
      manualOrderIdempotencyRecords: this.manualOrderIdempotencyRecords,
      initialSeedMoney: this.initialSeedMoney,
      updatedAt: new Date().toISOString()
    };

    // holdings 저장 (entryTime 포함하여 저장) + 해당 코인의 포지션/이력도 함께 저장
    for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
      const strategy = this.owner.strategies.get(coin);
      data.holdings[coin] = {
        amount: holding.amount,
        avgPrice: holding.avgPrice,
        // strategy에서 entryTime 가져오거나 기존 값 유지
        entryTime: strategy?.currentPosition?.entryTime || holding.entryTime || new Date().toISOString()
      };

      // 해당 코인의 포지션도 함께 저장 (holdings와 positions 동기화)
      if (strategy?.currentPosition) {
        data.positions[coin] = strategy.currentPosition;
      }

      // 해당 코인의 거래 이력도 함께 저장
      if (strategy?.tradeHistory?.length > 0) {
        data.tradeHistory[coin] = strategy.tradeHistory;
      }
    }

    // 추가로 holdings에 없지만 전략에 거래 이력이 있는 코인들도 저장 (매도 완료된 코인 이력 보존)
    for (const [coin, strategy] of this.owner.strategies.entries()) {
      if (!data.tradeHistory[coin] && strategy.tradeHistory?.length > 0) {
        data.tradeHistory[coin] = strategy.tradeHistory;
      }
    }

    this.owner.writeJsonAtomically(portfolioFile, data, { mode: 0o600, fsync: true, syncDirectory });
    console.log('💾 가상 포트폴리오 저장됨');
  }

  writeJsonAtomically(file, data, { mode, fsync = false, syncDirectory = false } = {}) {
    const directory = path.dirname(file);
    if (directory && directory !== '.') fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let temporaryFileCreated = false;
    try {
      const descriptor = fs.openSync(temporaryFile, 'wx', mode ?? 0o666);
      temporaryFileCreated = true;
      try {
        if (mode !== undefined) fs.fchmodSync(descriptor, mode);
        fs.writeFileSync(descriptor, JSON.stringify(data, null, 2), 'utf8');
        if (fsync) fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryFile, file);
      temporaryFileCreated = false;
      if (syncDirectory) {
        const directoryDescriptor = fs.openSync(directory, 'r');
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      }
    } catch (error) {
      try {
        if (temporaryFileCreated && fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      } catch {
        // Preserve the original write/rename error. A later startup can use
        // the owner-process/heartbeat recovery path if cleanup also fails.
      }
      throw error;
    }
  }

  /**
   * 가상 포트폴리오 리셋 (드라이 모드)
   * @param {number} seedMoney - 새로운 시드머니 (기본: 1000만원)
   */
  resetVirtualPortfolio(seedMoney = 10000000) {
    if (!this.owner.dryRun) {
      console.log('⚠️  실전 모드에서는 포트폴리오 리셋이 불가능합니다');
      return false;
    }

    console.log('\n🔄 가상 포트폴리오 리셋 중...');

    this.owner.mutateAndPersistVirtualPortfolio(() => {
      this.virtualPortfolio = {
        krwBalance: seedMoney,
        holdings: new Map()
      };
      this.initialSeedMoney = seedMoney;
      for (const strategy of this.owner.strategies.values()) {
        strategy.currentPosition = null;
        strategy.tradeHistory = [];
      }
    });

    console.log(`✅ 포트폴리오 리셋 완료!`);
    console.log(`   시드머니: ${seedMoney.toLocaleString()}원`);
    console.log(`   보유 코인: 0개`);

    return true;
  }

  /**
   * 가상 포트폴리오 로드 (드라이 모드)
   */
  loadVirtualPortfolio() {
    const portfolioFile = this.virtualPortfolioFile;

    if (fs.existsSync(portfolioFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            !Number.isFinite(data.krwBalance) || data.krwBalance < 0 ||
            (data.holdings !== undefined &&
              (!data.holdings || typeof data.holdings !== 'object' || Array.isArray(data.holdings))) ||
            (data.positions !== undefined &&
              (!data.positions || typeof data.positions !== 'object' || Array.isArray(data.positions))) ||
            (data.tradeHistory !== undefined &&
              !Array.isArray(data.tradeHistory) &&
              (!data.tradeHistory || typeof data.tradeHistory !== 'object')) ||
            (data.manualOrderIdempotencyRecords !== undefined &&
              !Array.isArray(data.manualOrderIdempotencyRecords))) {
          throw new TypeError('Stored DRY_RUN portfolio has an invalid shape.');
        }
        for (const holding of Object.values(data.holdings || {})) {
          if (!holding || typeof holding !== 'object' || Array.isArray(holding) ||
              !Number.isFinite(holding.amount) || holding.amount < 0 ||
              !Number.isFinite(holding.avgPrice) || holding.avgPrice < 0) {
            throw new TypeError('Stored DRY_RUN portfolio has an invalid holding.');
          }
        }
        this.virtualPortfolio.krwBalance = data.krwBalance;
        this.virtualPortfolio.holdings = new Map(Object.entries(data.holdings || {}));
        this.manualOrderIdempotencyRecords = data.manualOrderIdempotencyRecords ?? [];

        // 저장된 초기 시드머니 로드 (없으면 현재 설정값 유지)
        if (data.initialSeedMoney) {
          this.initialSeedMoney = data.initialSeedMoney;
        }

        // 전략의 포지션과 거래 이력 복원
        if (data.positions) {
          for (const [coin, position] of Object.entries(data.positions)) {
            const strategy = this.owner.getStrategy(coin);
            if (strategy) {
              // JSON에서 로드된 날짜 문자열을 Date 객체로 변환
              if (position.entryTime && typeof position.entryTime === 'string') {
                position.entryTime = new Date(position.entryTime);
              }
              strategy.currentPosition = position;
            }
          }
        }

        // tradeHistory 하위 호환성 처리
        // 구버전: tradeHistory가 배열 [] 형태
        // 신버전: tradeHistory가 객체 { coin: [...] } 형태
        if (data.tradeHistory) {
          if (Array.isArray(data.tradeHistory)) {
            // 구버전 형태 (배열): 배열 내 각 거래에서 코인 정보를 추출하여 분류
            console.log('   🔄 구버전 tradeHistory 형식 감지 - 마이그레이션 중...');
            const migratedHistory = {};
            for (const trade of data.tradeHistory) {
              // 거래 기록에서 코인 정보 추출 시도
              const coin = trade.market || trade.coin || null;
              if (coin) {
                if (!migratedHistory[coin]) {
                  migratedHistory[coin] = [];
                }
                migratedHistory[coin].push({
                  ...trade,
                  entryTime: trade.entryTime ? new Date(trade.entryTime) : undefined,
                  exitTime: trade.exitTime ? new Date(trade.exitTime) : undefined
                });
              }
            }
            // 마이그레이션된 이력 적용
            for (const [coin, history] of Object.entries(migratedHistory)) {
              const strategy = this.owner.getStrategy(coin);
              if (strategy) {
                strategy.tradeHistory = history;
              }
            }
          } else {
            // 신버전 형태 (객체)
            for (const [coin, history] of Object.entries(data.tradeHistory)) {
              const strategy = this.owner.getStrategy(coin);
              if (strategy && Array.isArray(history)) {
                // 거래 이력의 날짜들도 Date 객체로 변환
                strategy.tradeHistory = history.map(trade => ({
                  ...trade,
                  entryTime: trade.entryTime ? new Date(trade.entryTime) : undefined,
                  exitTime: trade.exitTime ? new Date(trade.exitTime) : undefined
                }));
              }
            }
          }
        }

        // holdings와 positions 동기화 (holdings에 있는데 positions가 없는 경우)
        let syncedCount = 0;
        for (const [coin, holding] of this.virtualPortfolio.holdings.entries()) {
          if (holding.amount > 0) {
            const strategy = this.owner.getStrategy(coin);
            if (strategy && !strategy.currentPosition) {
              // holdings에서 position 생성
              strategy.currentPosition = {
                type: 'BUY',
                entryPrice: holding.avgPrice,
                amount: holding.amount,
                entryTime: holding.entryTime ? new Date(holding.entryTime) : new Date(),
                id: Date.now() + syncedCount
              };
              syncedCount++;
            }
          }
        }

        // 구버전 파일 형식 감지 시 신버전으로 자동 마이그레이션
        const needsMigration = Array.isArray(data.tradeHistory) ||
                              data.lastSaved !== undefined ||
                              data.initialSeedMoney === undefined;

        console.log(`📂 가상 포트폴리오 로드됨 (${portfolioFile})`);
        console.log(`   KRW 잔액: ${this.virtualPortfolio.krwBalance.toLocaleString()} 원`);
        console.log(`   보유 코인: ${this.virtualPortfolio.holdings.size}개`);
        if (syncedCount > 0) {
          console.log(`   🔄 포지션 동기화: ${syncedCount}개 복원됨`);
        }
        console.log(`   마지막 저장: ${data.updatedAt || data.lastSaved || '알 수 없음'}`);

        // 마이그레이션 필요 시 신버전 형식으로 즉시 저장
        if (needsMigration || syncedCount > 0) {
          console.log('   📝 신버전 형식으로 포트폴리오 마이그레이션 저장...');
          this.owner.saveVirtualPortfolio();
        }
      } catch (error) {
        const startupError = new Error(
          'Existing DRY_RUN portfolio could not be loaded; refusing to start with a replacement wallet.',
          { cause: error }
        );
        startupError.code = 'DRY_RUN_PORTFOLIO_LOAD_FAILED';
        throw startupError;
      }
    }
  }
}
