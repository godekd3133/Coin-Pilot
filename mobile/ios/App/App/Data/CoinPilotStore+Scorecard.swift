import Foundation

// MARK: - `GET /api/status` sub-objects used by Home

/// `engineActivity` from `GET /api/status` (src/api/engineActivity.js).
struct CoinPilotEngineActivity: Equatable {
    let lastCycleAt: String?
    let lastCycleMarkets: Int?
    let lastCycleInactive: Int?
    let signalsLastHour: Int?
    let entriesLastHour: Int?
    let lastExchangeSyncAt: String?

    init(_ object: [String: Any]) {
        lastCycleAt = object["lastCycleAt"] as? String
        lastCycleMarkets = Self.int(object["lastCycleMarkets"])
        lastCycleInactive = Self.int(object["lastCycleInactive"])
        signalsLastHour = Self.int(object["signalsLastHour"])
        entriesLastHour = Self.int(object["entriesLastHour"])
        lastExchangeSyncAt = object["lastExchangeSyncAt"] as? String
    }

    var lastCycleDate: Date? { CoinPilotMarketSnapshotMetadata.parseDate(lastCycleAt) }

    static func int(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber else { return nil }
        let double = number.doubleValue
        return double.isFinite ? Int(double) : nil
    }
}

/// `accountLossGuard` from `GET /api/status` (src/risk/accountLossGuard.js).
struct CoinPilotAccountLossGuard: Equatable {
    let enabled: Bool?
    let equityFloor: Double?
    let dailyLossLimit: Double?
    let realizedToday: Double?
    let equity: Double?
    let blocked: Bool?
    let blockedReason: String?

    init(_ object: [String: Any]) {
        enabled = object["enabled"] as? Bool
        equityFloor = Self.number(object["equityFloorKrw"])
        dailyLossLimit = Self.number(object["dailyLossLimitKrw"])
        realizedToday = Self.number(object["realizedToday"])
        equity = Self.number(object["equity"])
        blocked = object["blocked"] as? Bool
        blockedReason = object["blockedReason"] as? String
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }
}

// MARK: - Models (`GET /api/scorecard`)

/// Mirrors `src/api/routes/scorecard.js`. Every field is optional so an older
/// server (no route) or a newer one (extra fields) still decodes.
struct CoinPilotScorecard: Decodable, Equatable {
    var available: Bool?
    var reason: String?
    var mode: String?
    var generatedAt: String?
    var periodStartAt: String?
    var periodEndAt: String?
    var costs: Costs?
    var tradeCount: Int?
    var winCount: Int?
    var winRatePercent: Double?
    var realizedNetProfit: Double?
    var avgNetReturnPercent: Double?
    var avgGrossReturnPercent: Double?
    var avgCostPercent: Double?
    var ci95: Interval?
    var ciIncludesZero: Bool?
    var minTradesForVerdict: Int?
    var verdict: String?
    var today: Today?
    var benchmark: Benchmark?
    var comparison: Comparison?
    var openPositions: [Position]
    var engine: Engine?

    private enum CodingKeys: String, CodingKey {
        case available, reason, mode, generatedAt, periodStartAt, periodEndAt, costs, tradeCount, winCount
        case winRatePercent, realizedNetProfit, avgNetReturnPercent, avgGrossReturnPercent, avgCostPercent
        case ci95, ciIncludesZero, minTradesForVerdict, verdict, today, benchmark, comparison, openPositions, engine
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = c.lenient(.available)
        reason = c.lenient(.reason)
        mode = c.lenient(.mode)
        generatedAt = c.lenient(.generatedAt)
        periodStartAt = c.lenient(.periodStartAt)
        periodEndAt = c.lenient(.periodEndAt)
        costs = c.lenient(.costs)
        tradeCount = c.lenientInt(.tradeCount)
        winCount = c.lenientInt(.winCount)
        winRatePercent = c.lenientDouble(.winRatePercent)
        realizedNetProfit = c.lenientDouble(.realizedNetProfit)
        avgNetReturnPercent = c.lenientDouble(.avgNetReturnPercent)
        avgGrossReturnPercent = c.lenientDouble(.avgGrossReturnPercent)
        avgCostPercent = c.lenientDouble(.avgCostPercent)
        ci95 = c.lenient(.ci95)
        ciIncludesZero = c.lenient(.ciIncludesZero)
        minTradesForVerdict = c.lenientInt(.minTradesForVerdict)
        verdict = c.lenient(.verdict)
        today = c.lenient(.today)
        benchmark = c.lenient(.benchmark)
        comparison = c.lenient(.comparison)
        openPositions = c.lenientArray(.openPositions)
        engine = c.lenient(.engine)
    }

    struct Costs: Decodable, Equatable {
        var source: String?
        var feeRate: Double?
        var slippageRate: Double?
        var slippageBooked: Bool?
        var unmodeledTradeCount: Int?

        private enum CodingKeys: String, CodingKey { case source, feeRate, slippageRate, slippageBooked, unmodeledTradeCount }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            source = c.lenient(.source)
            feeRate = c.lenientDouble(.feeRate)
            slippageRate = c.lenientDouble(.slippageRate)
            slippageBooked = c.lenient(.slippageBooked)
            unmodeledTradeCount = c.lenientInt(.unmodeledTradeCount)
        }
    }

    struct Interval: Decodable, Equatable {
        var low: Double?
        var high: Double?

        private enum CodingKeys: String, CodingKey { case low, high }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            low = c.lenientDouble(.low)
            high = c.lenientDouble(.high)
        }
    }

    struct Today: Decodable, Equatable {
        var date: String?
        var tradeCount: Int?
        var realizedNetProfit: Double?

        private enum CodingKeys: String, CodingKey { case date, tradeCount, realizedNetProfit }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = c.lenient(.date)
            tradeCount = c.lenientInt(.tradeCount)
            realizedNetProfit = c.lenientDouble(.realizedNetProfit)
        }
    }

    struct Benchmark: Decodable, Equatable {
        var available: Bool?
        var reason: String?
        var market: String?
        var startAt: String?
        var startPrice: Double?
        var endAt: String?
        var endPrice: Double?
        var returnPercent: Double?
        var coversFullPeriod: Bool?

        private enum CodingKeys: String, CodingKey {
            case available, reason, market, startAt, startPrice, endAt, endPrice, returnPercent, coversFullPeriod
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            available = c.lenient(.available)
            reason = c.lenient(.reason)
            market = c.lenient(.market)
            startAt = c.lenient(.startAt)
            startPrice = c.lenientDouble(.startPrice)
            endAt = c.lenient(.endAt)
            endPrice = c.lenientDouble(.endPrice)
            returnPercent = c.lenientDouble(.returnPercent)
            coversFullPeriod = c.lenient(.coversFullPeriod)
        }
    }

    struct Comparison: Decodable, Equatable {
        var seed: Double?
        var strategyReturnOnSeedPercent: Double?
        var holdReturnPercent: Double?
        var holdProfit: Double?
        var excessReturnPercent: Double?

        private enum CodingKeys: String, CodingKey {
            case seed, strategyReturnOnSeedPercent, holdReturnPercent, holdProfit, excessReturnPercent
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            seed = c.lenientDouble(.seed)
            strategyReturnOnSeedPercent = c.lenientDouble(.strategyReturnOnSeedPercent)
            holdReturnPercent = c.lenientDouble(.holdReturnPercent)
            holdProfit = c.lenientDouble(.holdProfit)
            excessReturnPercent = c.lenientDouble(.excessReturnPercent)
        }
    }

    struct Position: Decodable, Equatable, Identifiable {
        var coin: String?
        var entryPrice: Double?
        var amount: Double?
        var entryTime: String?
        var stopLossPrice: Double?
        var stopLossPercent: Double?
        var takeProfitPrice: Double?
        var protectiveStopArmed: Bool?
        var maxHoldExitAt: String?
        var losingHoldExitAt: String?
        var lastPrice: Double?
        var lastPriceAt: String?
        var unrealizedReturnPercent: Double?

        var id: String { "\(coin ?? "")|\(entryTime ?? "")" }

        private enum CodingKeys: String, CodingKey {
            case coin, entryPrice, amount, entryTime, stopLossPrice, stopLossPercent, takeProfitPrice
            case protectiveStopArmed, maxHoldExitAt, losingHoldExitAt, lastPrice, lastPriceAt, unrealizedReturnPercent
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            coin = c.lenient(.coin)
            entryPrice = c.lenientDouble(.entryPrice)
            amount = c.lenientDouble(.amount)
            entryTime = c.lenient(.entryTime)
            stopLossPrice = c.lenientDouble(.stopLossPrice)
            stopLossPercent = c.lenientDouble(.stopLossPercent)
            takeProfitPrice = c.lenientDouble(.takeProfitPrice)
            protectiveStopArmed = c.lenient(.protectiveStopArmed)
            maxHoldExitAt = c.lenient(.maxHoldExitAt)
            losingHoldExitAt = c.lenient(.losingHoldExitAt)
            lastPrice = c.lenientDouble(.lastPrice)
            lastPriceAt = c.lenient(.lastPriceAt)
            unrealizedReturnPercent = c.lenientDouble(.unrealizedReturnPercent)
        }
    }

    struct Engine: Decodable, Equatable {
        var checkIntervalMs: Double?
        var stallAfterSeconds: Double?

        private enum CodingKeys: String, CodingKey { case checkIntervalMs, stallAfterSeconds }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            checkIntervalMs = c.lenientDouble(.checkIntervalMs)
            stallAfterSeconds = c.lenientDouble(.stallAfterSeconds)
        }
    }
}

// MARK: - Store actions

extension CoinPilotStore {
    static let scorecardFeatureKey = "scorecard"

    /// Loads `GET /api/scorecard` through the authenticated mobile read path.
    /// An older server without the route leaves `scorecard` nil and sets a
    /// feature message; Home then says the figure is unavailable.
    @discardableResult
    func loadScorecard(force: Bool = true) async -> Bool {
        guard !isBundledPreview, !isBundledLocalMarketData else {
            scorecard = nil
            return false
        }
        return await refreshMobileFeatureGroup(Self.scorecardFeatureKey, force: force) { context in
            guard let object = await self.loadMobileFeature("scorecard-read", path: "/api/scorecard", context: context),
                  self.isCurrentMobileFeatureContext(context) else {
                if let message = self.featureMessages["scorecard-read"] {
                    self.setFeatureMessage(message, for: Self.scorecardFeatureKey)
                }
                return false
            }
            guard let scorecard = CoinPilotFeatureDecoding.decode(CoinPilotScorecard.self, from: object) else {
                self.setFeatureMessage("성과 응답을 해석하지 못했습니다.", for: Self.scorecardFeatureKey)
                return false
            }
            self.scorecard = scorecard
            return true
        }
    }
}
