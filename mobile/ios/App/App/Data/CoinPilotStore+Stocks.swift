import Foundation

// MARK: - Models (`GET /api/stocks/status`)

/// Mirrors `StockTradingService.getStatus()`; a disabled server answers
/// `{ enabled: false }`. Every field is optional so older/newer servers decode.
struct CoinPilotStocksStatus: Decodable, Equatable {
    var enabled: Bool?
    var credentialsConfigured: Bool?
    var universe: [String]
    var universeUpdatedAt: String?
    var universeError: String?
    var paper: CoinPilotStockTrader?
    var live: CoinPilotStockTrader?

    private enum CodingKeys: String, CodingKey {
        case enabled, credentialsConfigured, universe, universeUpdatedAt, universeError, paper, live
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.lenient(.enabled)
        credentialsConfigured = c.lenient(.credentialsConfigured)
        universe = c.lenientArray(.universe)
        universeUpdatedAt = c.lenient(.universeUpdatedAt)
        universeError = c.lenient(.universeError)
        paper = c.lenient(.paper)
        live = c.lenient(.live)
    }

    /// The trader that belongs to the app's current workspace.
    func trader(for workspace: CoinPilotWorkspaceMode) -> CoinPilotStockTrader? {
        workspace == .live ? live : paper
    }

    var isEnabled: Bool { enabled == true }
}

struct CoinPilotStockTrader: Decodable, Equatable {
    var mode: String?
    var running: Bool?
    var desiredRunning: Bool?
    var entriesPaused: Bool?
    var pauseReason: String?
    var pendingOrders: Int?
    var market: CoinPilotStockMarketState?
    var lastCycleAt: String?
    var lastError: String?
    var cash: Double?
    var initialSeedMoney: Double?
    var totalAssets: Double?
    var positions: [CoinPilotStockPosition]
    var maxPositions: Int?
    var statistics: CoinPilotStockStatistics?
    var recentTrades: [CoinPilotStockTrade]
    var recentSignals: [CoinPilotStockSignal]

    private enum CodingKeys: String, CodingKey {
        case mode, running, desiredRunning, entriesPaused, pauseReason, pendingOrders, market, lastCycleAt
        case lastError, cash, initialSeedMoney, totalAssets, positions, maxPositions, statistics
        case recentTrades, recentSignals
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = c.lenient(.mode)
        running = c.lenient(.running)
        desiredRunning = c.lenient(.desiredRunning)
        entriesPaused = c.lenient(.entriesPaused)
        pauseReason = c.lenient(.pauseReason)
        pendingOrders = c.lenientInt(.pendingOrders)
        market = c.lenient(.market)
        lastCycleAt = c.lenient(.lastCycleAt)
        lastError = c.lenient(.lastError)
        cash = c.lenientDouble(.cash)
        initialSeedMoney = c.lenientDouble(.initialSeedMoney)
        totalAssets = c.lenientDouble(.totalAssets)
        positions = c.lenientArray(.positions)
        maxPositions = c.lenientInt(.maxPositions)
        statistics = c.lenient(.statistics)
        recentTrades = c.lenientArray(.recentTrades)
        recentSignals = c.lenientArray(.recentSignals)
    }

    var isLive: Bool { mode == "live" }

    /// Market value of holdings at the last observed price (entry price fallback).
    var positionsValue: Double {
        positions.reduce(0) { $0 + ($1.lastPrice ?? $1.entryPrice ?? 0) * ($1.quantity ?? 0) }
    }

    var unrealizedProfit: Double? {
        let values = positions.compactMap(\.unrealizedProfit)
        return values.isEmpty ? nil : values.reduce(0, +)
    }

    /// Paper: cash + holdings vs seed. LIVE has no ledger cash, so nil.
    var profitVersusSeed: Double? {
        guard let totalAssets, let initialSeedMoney, initialSeedMoney > 0 else { return nil }
        return totalAssets - initialSeedMoney
    }

    var pauseLabel: String? {
        guard entriesPaused == true else { return nil }
        switch pauseReason {
        case "pending_order_unresolved": return "미확인 주문 확인 중"
        case "exchange_state_unverified": return "계좌 대사 대기"
        case .some(let reason) where !reason.isEmpty: return "진입 잠금"
        default: return "진입 잠금"
        }
    }
}

struct CoinPilotStockMarketState: Decodable, Equatable {
    var open: Bool?
    var canEnter: Bool?
    var mustFlatten: Bool?
    var reason: String?

    private enum CodingKeys: String, CodingKey { case open, canEnter, mustFlatten, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        open = c.lenient(.open)
        canEnter = c.lenient(.canEnter)
        mustFlatten = c.lenient(.mustFlatten)
        reason = c.lenient(.reason)
    }

    /// Korean label for `stockMarketSession` reasons.
    var title: String {
        switch reason {
        case "regular_session": return "정규장 운영 중"
        case "flatten_before_close": return "장 마감 전 정리 중"
        case "entry_cutoff": return "신규 진입 마감"
        case "before_open": return "개장 전"
        case "after_close": return "장 마감"
        case "market_holiday": return "휴장일"
        default: return open == true ? "장 운영 중" : "장 운영 확인 전"
        }
    }

    var detail: String? {
        switch reason {
        case "flatten_before_close": return "마감 동시호가 전 전량 정리. 오버나이트 보유 없음."
        case "entry_cutoff": return "장 마감이 가까워 새 종목은 사지 않고 보유 종목만 관리합니다."
        case "before_open", "after_close", "market_holiday": return "정규장 시간에만 주문합니다."
        default: return nil
        }
    }
}

struct CoinPilotStockPosition: Decodable, Equatable, Identifiable {
    var symbol: String
    var quantity: Double?
    var entryPrice: Double?
    var lastPrice: Double?
    var entryTime: String?
    var unrealizedProfit: Double?

    var id: String { symbol }

    private enum CodingKeys: String, CodingKey { case symbol, quantity, entryPrice, lastPrice, entryTime, unrealizedProfit }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        symbol = c.lenient(.symbol) ?? "?"
        quantity = c.lenientDouble(.quantity)
        entryPrice = c.lenientDouble(.entryPrice)
        lastPrice = c.lenientDouble(.lastPrice)
        entryTime = c.lenient(.entryTime)
        unrealizedProfit = c.lenientDouble(.unrealizedProfit)
    }

    var profitPercent: Double? {
        guard let entryPrice, entryPrice > 0, let lastPrice else { return nil }
        return (lastPrice - entryPrice) / entryPrice * 100
    }
}

struct CoinPilotStockStatistics: Decodable, Equatable {
    var totalTrades: Int?
    var winningTrades: Int?
    var winRate: Double?
    var totalProfit: Double?

    private enum CodingKeys: String, CodingKey { case totalTrades, winningTrades, winRate, totalProfit }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalTrades = c.lenientInt(.totalTrades)
        winningTrades = c.lenientInt(.winningTrades)
        winRate = c.lenientDouble(.winRate)
        totalProfit = c.lenientDouble(.totalProfit)
    }
}

struct CoinPilotStockTrade: Decodable, Equatable, Identifiable {
    var action: String?
    var symbol: String?
    var quantity: Double?
    var price: Double?
    var profit: Double?
    var profitPercent: Double?
    var reason: String?
    var orderId: String?
    var at: String?

    var id: String { [orderId, at, symbol, action].compactMap { $0 }.joined(separator: "|") }

    private enum CodingKeys: String, CodingKey { case action, symbol, quantity, price, profit, profitPercent, reason, orderId, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = c.lenient(.action)
        symbol = c.lenient(.symbol)
        quantity = c.lenientDouble(.quantity)
        price = c.lenientDouble(.price)
        profit = c.lenientDouble(.profit)
        profitPercent = c.lenientDouble(.profitPercent)
        reason = c.lenient(.reason)
        orderId = c.lenient(.orderId)
        at = c.lenient(.at)
    }

    var actionTitle: String { action == "SELL" ? "매도" : action == "BUY" ? "매수" : (action ?? "기록") }
}

struct CoinPilotStockSignal: Decodable, Equatable, Identifiable {
    var symbol: String?
    var reason: String?
    var valid: Bool?
    var rejection: String?
    var at: String?

    var id: String { "\(symbol ?? "")|\(at ?? "")|\(reason ?? "")" }

    private enum CodingKeys: String, CodingKey { case symbol, reason, valid, rejection, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        symbol = c.lenient(.symbol)
        reason = c.lenient(.reason)
        valid = c.lenient(.valid)
        rejection = c.lenient(.rejection)
        at = c.lenient(.at)
    }
}

// MARK: - Store actions

extension CoinPilotStore {
    static let stocksFeatureKey = "stocks"

    /// Loads `GET /api/stocks/status` through the authenticated mobile read path.
    @discardableResult
    func loadStocksStatus(force: Bool = true) async -> Bool {
        guard !isBundledPreview, !isBundledLocalMarketData else {
            stocksStatus = nil
            return false
        }
        return await refreshMobileFeatureGroup(Self.stocksFeatureKey, force: force) { context in
            guard let object = await self.loadMobileFeature("stocks-status", path: "/api/stocks/status", context: context),
                  self.isCurrentMobileFeatureContext(context) else {
                if let message = self.featureMessages["stocks-status"] {
                    self.setFeatureMessage(message, for: Self.stocksFeatureKey)
                }
                return false
            }
            guard let status = CoinPilotFeatureDecoding.decode(CoinPilotStocksStatus.self, from: object) else {
                self.setFeatureMessage("주식 상태 응답을 해석하지 못했습니다.", for: Self.stocksFeatureKey)
                return false
            }
            self.stocksStatus = status
            return true
        }
    }

    /// `POST /api/stocks/:mode/start|stop`. `mode` is `paper` or `live`.
    @discardableResult
    func setStockTraderRunning(mode: String, running: Bool) async -> Bool {
        guard ["paper", "live"].contains(mode) else { return false }
        let path = "/api/stocks/\(mode)/\(running ? "start" : "stop")"
        let result = await performFeatureMutation(Self.stocksFeatureKey, path: path, body: [:])
        let failure = featureMessages[Self.stocksFeatureKey]
        await loadStocksStatus(force: true)
        if result == nil {
            setFeatureMessage(failure ?? "요청을 처리하지 못했습니다.", for: Self.stocksFeatureKey)
            return false
        }
        setFeatureMessage(running
            ? (mode == "live" ? "실전 주식 자동매매 시작을 요청했습니다." : "모의 주식 자동매매를 시작했습니다.")
            : "주식 자동매매 중지를 요청했습니다. 보유 종목 위험 관리는 서버 상태에 따릅니다.", for: Self.stocksFeatureKey)
        return true
    }

    /// `POST /api/stocks/paper/reset` (paper only; the server refuses while holding positions).
    @discardableResult
    func resetStockPaper() async -> Bool {
        let result = await performFeatureMutation(Self.stocksFeatureKey, path: "/api/stocks/paper/reset", body: [:])
        let failure = featureMessages[Self.stocksFeatureKey]
        await loadStocksStatus(force: true)
        if result == nil {
            setFeatureMessage(failure ?? "초기화하지 못했습니다.", for: Self.stocksFeatureKey)
            return false
        }
        setFeatureMessage("모의 주식 계좌를 초기화했습니다.", for: Self.stocksFeatureKey)
        return true
    }
}
