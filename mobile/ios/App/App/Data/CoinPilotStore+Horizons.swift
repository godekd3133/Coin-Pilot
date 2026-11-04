import Foundation

// MARK: - Models (`GET /api/horizons/status`)

/// `{ coin: Runtime | null, stock: { paper?: Runtime, live?: Runtime } }`.
struct CoinPilotHorizonsStatus: Decodable, Equatable {
    var coin: CoinPilotHorizonRuntime?
    var stock: [String: CoinPilotHorizonRuntime]

    private enum CodingKeys: String, CodingKey { case coin, stock }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        coin = c.lenient(.coin)
        stock = c.lenientDictionary(.stock)
    }

    /// Stock runtime for the workspace, falling back to the only one present.
    func stockRuntime(for workspace: CoinPilotWorkspaceMode) -> CoinPilotHorizonRuntime? {
        stock[workspace == .live ? "live" : "paper"] ?? (stock.count == 1 ? stock.values.first : nil)
    }

    func runtime(asset: CoinPilotHorizonAsset, workspace: CoinPilotWorkspaceMode) -> CoinPilotHorizonRuntime? {
        asset == .coin ? coin : stockRuntime(for: workspace)
    }
}

enum CoinPilotHorizonAsset: String, CaseIterable, Identifiable {
    case coin
    case stock

    var id: String { rawValue }
    var title: String { self == .coin ? "코인" : "주식" }
}

/// `HorizonRuntime.getStatus()` = manager status + `research` summary.
struct CoinPilotHorizonRuntime: Decodable, Equatable {
    var assetClass: String?
    var mode: String?
    var running: Bool?
    var desiredRunning: Bool?
    var entriesPaused: Bool?
    var pauseReason: String?
    var pendingOrders: Int?
    var lastCycleAt: String?
    var lastError: String?
    var gate: CoinPilotHorizonGate?
    var capitalRatio: Double?
    var paramsValidated: Bool?
    var paramsSource: String?
    var cash: Double?
    var initialSeedMoney: Double?
    var totalAssets: Double?
    var sleeves: [String: CoinPilotHorizonSleeve]
    var positions: [CoinPilotHorizonPosition]
    var recentTrades: [CoinPilotHorizonTrade]
    var research: CoinPilotHorizonResearch?

    private enum CodingKeys: String, CodingKey {
        case assetClass, mode, running, desiredRunning, entriesPaused, pauseReason, pendingOrders, lastCycleAt
        case lastError, gate, capitalRatio, paramsValidated, paramsSource, cash, initialSeedMoney, totalAssets
        case sleeves, positions, recentTrades, research
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        assetClass = c.lenient(.assetClass)
        mode = c.lenient(.mode)
        running = c.lenient(.running)
        desiredRunning = c.lenient(.desiredRunning)
        entriesPaused = c.lenient(.entriesPaused)
        pauseReason = c.lenient(.pauseReason)
        pendingOrders = c.lenientInt(.pendingOrders)
        lastCycleAt = c.lenient(.lastCycleAt)
        lastError = c.lenient(.lastError)
        gate = c.lenient(.gate)
        capitalRatio = c.lenientDouble(.capitalRatio)
        paramsValidated = c.lenient(.paramsValidated)
        paramsSource = c.lenient(.paramsSource)
        cash = c.lenientDouble(.cash)
        initialSeedMoney = c.lenientDouble(.initialSeedMoney)
        totalAssets = c.lenientDouble(.totalAssets)
        sleeves = c.lenientDictionary(.sleeves)
        positions = c.lenientArray(.positions)
        recentTrades = c.lenientArray(.recentTrades)
        research = c.lenient(.research)
    }

    var isLive: Bool { mode == "live" }

    /// Sleeves exactly as the server sent them. The server's own order is
    /// short → swing → mid → long; unknown sleeves sort after, by key, so a
    /// newly added profile appears without an app change.
    var orderedSleeves: [(key: String, sleeve: CoinPilotHorizonSleeve)] {
        let preferred = ["short", "swing", "mid", "long"]
        return sleeves.map { (key: $0.key, sleeve: $0.value) }.sorted { lhs, rhs in
            let left = preferred.firstIndex(of: lhs.key) ?? Int.max
            let right = preferred.firstIndex(of: rhs.key) ?? Int.max
            return left == right ? lhs.key < rhs.key : left < right
        }
    }

    func research(for sleeveKey: String) -> CoinPilotHorizonResearchSleeve? {
        research?.sleeves.first { $0.horizon == sleeveKey }
    }

    func positions(for sleeveKey: String) -> [CoinPilotHorizonPosition] {
        positions.filter { $0.sleeve == sleeveKey }
    }

    var positionsValue: Double {
        positions.reduce(0) { $0 + ($1.lastPrice ?? $1.entryPrice ?? 0) * ($1.quantity ?? 0) }
    }

    var realizedProfit: Double {
        sleeves.values.reduce(0) { $0 + ($1.realizedProfit ?? 0) }
    }

    var profitVersusSeed: Double? {
        guard let totalAssets, let initialSeedMoney, initialSeedMoney > 0 else { return nil }
        return totalAssets - initialSeedMoney
    }

    var pauseLabel: String? {
        guard entriesPaused == true else { return nil }
        switch pauseReason {
        case "pending_order_unresolved": return "미확인 주문 확인 중"
        case "exchange_state_unverified": return "계좌 대사 대기"
        default: return "진입 잠금"
        }
    }
}

struct CoinPilotHorizonGate: Decodable, Equatable {
    var canTrade: Bool?
    var canEnter: Bool?
    var reason: String?

    private enum CodingKeys: String, CodingKey { case canTrade, canEnter, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canTrade = c.lenient(.canTrade)
        canEnter = c.lenient(.canEnter)
        reason = c.lenient(.reason)
    }
}

struct CoinPilotHorizonSleeve: Decodable, Equatable {
    var label: String?
    var enabled: Bool?
    /// Percent of the engine capital (0–100).
    var weight: Double?
    var interval: String?
    var positions: Int?
    var realizedProfit: Double?
    var trades: Int?
    var winRate: Double?
    var lastAnalysis: CoinPilotHorizonAnalysis?

    private enum CodingKeys: String, CodingKey {
        case label, enabled, weight, interval, positions, realizedProfit, trades, winRate, lastAnalysis
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = c.lenient(.label)
        enabled = c.lenient(.enabled)
        weight = c.lenientDouble(.weight)
        // interval is a string ("60m", "1d") on most profiles but may be numeric.
        interval = c.lenient(.interval) ?? c.lenientInt(.interval).map { "\($0)" }
        positions = c.lenientInt(.positions)
        realizedProfit = c.lenientDouble(.realizedProfit)
        trades = c.lenientInt(.trades)
        winRate = c.lenientDouble(.winRate)
        lastAnalysis = c.lenient(.lastAnalysis)
    }
}

struct CoinPilotHorizonAnalysis: Decodable, Equatable {
    var barStart: String?
    var benchmarkRegime: String?
    var top: [CoinPilotHorizonCandidate]

    private enum CodingKeys: String, CodingKey { case barStart, benchmarkRegime, top }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        barStart = c.lenient(.barStart)
        benchmarkRegime = c.lenient(.benchmarkRegime)
        top = c.lenientArray(.top)
    }
}

struct CoinPilotHorizonCandidate: Decodable, Equatable, Identifiable {
    var symbol: String
    var score: Double?
    var regime: String?
    var rsi: Double?
    var atrPercent: Double?

    var id: String { symbol }

    private enum CodingKeys: String, CodingKey { case symbol, score, regime, rsi, atrPercent }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        symbol = c.lenient(.symbol) ?? "?"
        score = c.lenientDouble(.score)
        regime = c.lenient(.regime)
        rsi = c.lenientDouble(.rsi)
        atrPercent = c.lenientDouble(.atrPercent)
    }
}

struct CoinPilotHorizonPosition: Decodable, Equatable, Identifiable {
    var sleeve: String?
    var symbol: String
    var quantity: Double?
    var entryPrice: Double?
    var lastPrice: Double?
    var cost: Double?
    var stopPrice: Double?
    var score: Double?
    var barsHeld: Int?
    var entryTime: String?
    var unrealizedProfit: Double?
    var stuckBelowMinimum: Bool?

    var id: String { "\(sleeve ?? "")|\(symbol)" }

    private enum CodingKeys: String, CodingKey {
        case sleeve, symbol, quantity, entryPrice, lastPrice, cost, stopPrice, score, barsHeld, entryTime
        case unrealizedProfit, stuckBelowMinimum
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sleeve = c.lenient(.sleeve)
        symbol = c.lenient(.symbol) ?? "?"
        quantity = c.lenientDouble(.quantity)
        entryPrice = c.lenientDouble(.entryPrice)
        lastPrice = c.lenientDouble(.lastPrice)
        cost = c.lenientDouble(.cost)
        stopPrice = c.lenientDouble(.stopPrice)
        score = c.lenientDouble(.score)
        barsHeld = c.lenientInt(.barsHeld)
        entryTime = c.lenient(.entryTime)
        unrealizedProfit = c.lenientDouble(.unrealizedProfit)
        stuckBelowMinimum = c.lenient(.stuckBelowMinimum)
    }

    var profitPercent: Double? {
        guard let cost, cost > 0, let unrealizedProfit else { return nil }
        return unrealizedProfit / cost * 100
    }
}

struct CoinPilotHorizonTrade: Decodable, Equatable, Identifiable {
    var action: String?
    var sleeve: String?
    var symbol: String?
    var quantity: Double?
    var price: Double?
    var profit: Double?
    var returnPercent: Double?
    var reason: String?
    var at: String?

    var id: String { "\(at ?? "")|\(sleeve ?? "")|\(symbol ?? "")|\(action ?? "")" }

    private enum CodingKeys: String, CodingKey { case action, sleeve, symbol, quantity, price, profit, returnPercent, reason, at }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = c.lenient(.action)
        sleeve = c.lenient(.sleeve)
        symbol = c.lenient(.symbol)
        quantity = c.lenientDouble(.quantity)
        price = c.lenientDouble(.price)
        profit = c.lenientDouble(.profit)
        returnPercent = c.lenientDouble(.returnPercent)
        reason = c.lenient(.reason)
        at = c.lenient(.at)
    }
}

/// `summarizeStudy(report)` + scheduler status. Missing report → only scheduler.
struct CoinPilotHorizonResearch: Decodable, Equatable {
    var generatedAt: String?
    var method: String?
    var markets: Int?
    var sleeves: [CoinPilotHorizonResearchSleeve]
    var schedulerRunning: Bool?
    var schedulerLastRunAt: String?
    var schedulerLastError: String?

    private enum CodingKeys: String, CodingKey { case generatedAt, method, markets, sleeves, scheduler }
    private enum SchedulerKeys: String, CodingKey { case running, lastRunAt, lastError }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = c.lenient(.generatedAt)
        method = c.lenient(.method)
        markets = c.lenientInt(.markets)
        sleeves = c.lenientArray(.sleeves)
        if let scheduler = try? c.nestedContainer(keyedBy: SchedulerKeys.self, forKey: .scheduler) {
            schedulerRunning = scheduler.lenient(.running)
            schedulerLastRunAt = scheduler.lenient(.lastRunAt)
            schedulerLastError = scheduler.lenient(.lastError)
        }
    }

    var hasReport: Bool { generatedAt != nil }
}

struct CoinPilotHorizonResearchSleeve: Decodable, Equatable, Identifiable {
    var horizon: String?
    var interval: String?
    var passed: Bool?
    var outOfSampleReturnPercent: Double?
    var worstDrawdownPercent: Double?
    var trades: Int?

    var id: String { horizon ?? UUID().uuidString }

    private enum CodingKeys: String, CodingKey {
        case horizon, interval, passed, outOfSampleReturnPercent, worstDrawdownPercent, trades
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        horizon = c.lenient(.horizon)
        interval = c.lenient(.interval) ?? c.lenientInt(.interval).map { "\($0)" }
        passed = c.lenient(.passed)
        outOfSampleReturnPercent = c.lenientDouble(.outOfSampleReturnPercent)
        worstDrawdownPercent = c.lenientDouble(.worstDrawdownPercent)
        trades = c.lenientInt(.trades)
    }
}

// MARK: - Store actions

extension CoinPilotStore {
    static let horizonsFeatureKey = "horizons"

    @discardableResult
    func loadHorizonsStatus(force: Bool = true) async -> Bool {
        guard !isBundledPreview, !isBundledLocalMarketData else {
            horizonsStatus = nil
            return false
        }
        return await refreshMobileFeatureGroup(Self.horizonsFeatureKey, force: force) { context in
            guard let object = await self.loadMobileFeature("horizons-status", path: "/api/horizons/status", context: context),
                  self.isCurrentMobileFeatureContext(context) else {
                if let message = self.featureMessages["horizons-status"] {
                    self.setFeatureMessage(message, for: Self.horizonsFeatureKey)
                }
                return false
            }
            guard let status = CoinPilotFeatureDecoding.decode(CoinPilotHorizonsStatus.self, from: object) else {
                self.setFeatureMessage("포트폴리오 상태 응답을 해석하지 못했습니다.", for: Self.horizonsFeatureKey)
                return false
            }
            self.horizonsStatus = status
            return true
        }
    }

    /// `POST /api/horizons/:asset/start|stop`.
    @discardableResult
    func setHorizonRunning(asset: CoinPilotHorizonAsset, running: Bool) async -> Bool {
        let path = "/api/horizons/\(asset.rawValue)/\(running ? "start" : "stop")"
        let result = await performFeatureMutation(Self.horizonsFeatureKey, path: path, body: [:])
        let failure = featureMessages[Self.horizonsFeatureKey]
        await loadHorizonsStatus(force: true)
        if result == nil {
            setFeatureMessage(failure ?? "요청을 처리하지 못했습니다.", for: Self.horizonsFeatureKey)
            return false
        }
        setFeatureMessage(running
            ? "\(asset.title) 기간별 포트폴리오 시작을 요청했습니다."
            : "\(asset.title) 기간별 포트폴리오 중지를 요청했습니다.", for: Self.horizonsFeatureKey)
        return true
    }
}
