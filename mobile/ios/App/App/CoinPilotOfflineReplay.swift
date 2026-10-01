import CryptoKit
import Foundation

/// Deterministic, local-only OHLCV replay for the bundled-market-data mode.
///
/// This is a historical simulation model. It does not model live execution,
/// order-book depth, exchange latency, or exchange-side order handling.
enum CoinPilotOfflineReplay {
    static let engineVersion = "coinpilot-offline-replay-v1"
    static let configurationVersion = "scalping-defaults-v1"
    static let simulationType = "historical-simulation"
    static let executionModel = "OHLC candles; next-candle-open entry proxy; gap-through stop uses bar open; adverse slippage and fees on both sides"
    static let tradingFee = 0.0005
    static let adverseSlippage = 0.001
    static let maximumHoldMinutes = 30

    private static let supportedIntervals = Set([1, 5, 15, 60])
    private static let maximumCandles = 20_000
    private static let initialBalance = 1_000_000.0
    private static let investmentRatio = 0.02
    private static let minimumOrderAmount = 5_000.0
    private static let rsiPeriod = 14
    private static let rsiOversold = 30.0
    private static let oversoldLookback = 1
    private static let minimumHistory = rsiPeriod + max(2, oversoldLookback)
    static let minimumCandleCount = minimumHistory + 2
    private static let minimumCandles = minimumCandleCount
    private static let minimumReboundPercent = 0.15
    private static let minimumRSIRecovery = 2.0
    private static let minimumVolumeRatio = 1.0
    private static let volumeLookback = 20
    private static let minimumCloseStrength = 0.65
    private static let trendPeriod = 30
    private static let trendSlopeLookback = 3
    private static let minimumTrendSlopePercent = -0.2
    private static let requirePreviousHighBreak = true
    private static let maximumEntryRetracePercent = 0.25
    private static let maximumEntryChasePercent = 0.35
    private static let stopLossPercent = 1.2
    private static let takeProfitPercent = 1.8
    private static let cooldownAfterLossMinutes = 15
    private static let maximumConsecutiveLosses = 3

    struct Candle: Codable, Equatable, Sendable {
        let timestampMilliseconds: Int64
        let open: Double
        let high: Double
        let low: Double
        let close: Double
        let volume: Double

        init(
            timestampMilliseconds: Int64,
            open: Double,
            high: Double,
            low: Double,
            close: Double,
            volume: Double
        ) {
            self.timestampMilliseconds = timestampMilliseconds
            self.open = open
            self.high = high
            self.low = low
            self.close = close
            self.volume = volume
        }
    }

    struct Request: Codable, Equatable, Sendable {
        let market: String
        let intervalMinutes: Int
        let source: String
        let generatedAt: String
        let candles: [Candle]

        init(
            market: String,
            intervalMinutes: Int,
            source: String,
            generatedAt: String,
            candles: [Candle]
        ) {
            self.market = market
            self.intervalMinutes = intervalMinutes
            self.source = source
            self.generatedAt = generatedAt
            self.candles = candles
        }
    }

    struct Metadata: Codable, Equatable, Sendable {
        let simulationType: String
        let executionModel: String
        let source: String
        let generatedAt: String
        let market: String
        let intervalMinutes: Int
        let startTimestampMilliseconds: Int64
        let endTimestampMilliseconds: Int64
        let rowCount: Int
        let configVersion: String
        let engineVersion: String
        let datasetFingerprint: String
    }

    struct Summary: Codable, Equatable, Sendable {
        let initialBalance: Double
        let finalBalance: Double
        let netProfit: Double
        let totalReturnPercent: Double
        let fees: Double
        let signalCount: Int
        let cancelledSignalCount: Int
        let completedTradeCount: Int
    }

    struct Trade: Codable, Equatable, Sendable {
        let signalTimestampMilliseconds: Int64
        let entryTimestampMilliseconds: Int64
        let exitTimestampMilliseconds: Int64
        let entryPrice: Double
        let exitPrice: Double
        let quantity: Double
        let investmentAmount: Double
        let buyFee: Double
        let sellFee: Double
        let reason: String
        let netProfit: Double
        let profitPercent: Double
        let maxFavorableExcursionPercent: Double
        let maxAdverseExcursionPercent: Double
    }

    struct EquityPoint: Codable, Equatable, Sendable {
        let timestampMilliseconds: Int64
        let price: Double
        let equity: Double
    }

    struct PlaybackFrame: Equatable, Sendable {
        let candleIndex: Int
        let totalCandleCount: Int
        let timestampMilliseconds: Int64
        let historicalClose: Double
        let historicalSimulationEquity: Double?
    }

    struct Result: Codable, Equatable, Sendable {
        let metadata: Metadata
        let summary: Summary
        let trades: [Trade]
        let equityCurve: [EquityPoint]
    }

    enum ReplayError: Error, Equatable, LocalizedError, Sendable {
        case invalidMarket
        case unsupportedInterval(Int)
        case invalidSource
        case invalidGeneratedAt
        case generatedAtBeforeLastCandle
        case insufficientCandles(minimum: Int)
        case intervalTooCoarse(intervalMinutes: Int, maximumHoldMinutes: Int)
        case tooManyCandles
        case invalidCandle(index: Int, reason: String)
        case timestampsNotIncreasing(index: Int)
        case candleGap(index: Int, deltaMilliseconds: Int64)

        var errorDescription: String? {
            switch self {
            case .invalidMarket:
                return "리플레이 시장 코드가 올바르지 않습니다."
            case let .unsupportedInterval(interval):
                return "지원하지 않는 캔들 간격입니다: \(interval)분"
            case .invalidSource:
                return "리플레이 데이터 출처가 비어 있거나 너무 깁니다."
            case .invalidGeneratedAt:
                return "데이터 생성 시각이 UTC ISO 8601 형식이 아닙니다."
            case .generatedAtBeforeLastCandle:
                return "데이터 생성 시각이 마지막 캔들보다 빠릅니다."
            case let .insufficientCandles(minimum):
                return "이 설정의 신호 탐색과 다음 캔들 진입을 위해 캔들 \(minimum)개 이상이 필요합니다."
            case let .intervalTooCoarse(intervalMinutes, maximumHoldMinutes):
                let intervalLabel = intervalMinutes == 60 ? "1시간" : "\(intervalMinutes)분"
                return "\(intervalLabel) 자료로는 \(maximumHoldMinutes)분 보유 한도를 확인할 수 없습니다. 1분·5분·15분 자료를 선택하세요."
            case .tooManyCandles:
                return "리플레이 캔들 수가 지원 한도를 넘었습니다."
            case .invalidCandle:
                return "캔들 값이 올바르지 않아 과거 재생을 시작할 수 없습니다."
            case .timestampsNotIncreasing:
                return "캔들 시간이 중복되거나 순서가 맞지 않습니다."
            case .candleGap:
                return "캔들 사이에 긴 시간 공백이 있어 이 구간은 재생할 수 없습니다."
            }
        }
    }

    private struct OpenPosition {
        let signalTimestampMilliseconds: Int64
        let entryTimestampMilliseconds: Int64
        let entryPrice: Double
        let quantity: Double
        let investmentAmount: Double
        let buyFee: Double
        var highestPrice: Double
        var lowestPrice: Double
    }

    private struct ExitDecision {
        let reason: String
        let price: Double
    }

    /// Runs the pinned historical strategy over a complete, single-market series.
    /// No networking, account, order, wallet, token, or automation dependency is
    /// available to the kernel.
    static func run(_ request: Request) throws -> Result {
        try validate(request)
        let replay = simulate(request.candles)
        let first = request.candles[0]
        let last = request.candles[request.candles.count - 1]
        let metadata = Metadata(
            simulationType: simulationType,
            executionModel: executionModel,
            source: request.source,
            generatedAt: request.generatedAt,
            market: request.market,
            intervalMinutes: request.intervalMinutes,
            startTimestampMilliseconds: first.timestampMilliseconds,
            endTimestampMilliseconds: last.timestampMilliseconds,
            rowCount: request.candles.count,
            configVersion: configurationVersion,
            engineVersion: engineVersion,
            datasetFingerprint: datasetFingerprint(for: request)
        )
        return Result(metadata: metadata, summary: replay.summary, trades: replay.trades, equityCurve: replay.equityCurve)
    }

    /// Projects one already-validated candle into the local playback timeline.
    /// Values remain historical; this method has no live-price or order path.
    static func playbackFrame(
        atCandleIndex index: Int,
        request: Request,
        result: Result
    ) -> PlaybackFrame? {
        guard request.candles.indices.contains(index),
              let first = request.candles.first,
              let last = request.candles.last,
              result.metadata.engineVersion == engineVersion,
              result.metadata.configVersion == configurationVersion,
              result.metadata.market == request.market,
              result.metadata.intervalMinutes == request.intervalMinutes,
              result.metadata.source == request.source,
              result.metadata.generatedAt == request.generatedAt,
              result.metadata.rowCount == request.candles.count,
              result.metadata.startTimestampMilliseconds == first.timestampMilliseconds,
              result.metadata.endTimestampMilliseconds == last.timestampMilliseconds else {
            return nil
        }

        let candle = request.candles[index]
        let curveIndex = index - minimumHistory
        let simulatedEquity = result.equityCurve.indices.contains(curveIndex)
            ? result.equityCurve[curveIndex].equity
            : nil
        return PlaybackFrame(
            candleIndex: index,
            totalCandleCount: request.candles.count,
            timestampMilliseconds: candle.timestampMilliseconds,
            historicalClose: candle.close,
            historicalSimulationEquity: simulatedEquity
        )
    }

    private static func validate(_ request: Request) throws {
        guard isValidMarket(request.market) else { throw ReplayError.invalidMarket }
        guard supportedIntervals.contains(request.intervalMinutes) else {
            throw ReplayError.unsupportedInterval(request.intervalMinutes)
        }
        let sourceBytes = Array(request.source.utf8)
        guard !sourceBytes.isEmpty, sourceBytes.count <= 128 else { throw ReplayError.invalidSource }
        guard let generatedAtMilliseconds = utcMilliseconds(from: request.generatedAt) else {
            throw ReplayError.invalidGeneratedAt
        }
        guard request.candles.count >= minimumCandles else {
            throw ReplayError.insufficientCandles(minimum: minimumCandles)
        }
        guard request.candles.count <= maximumCandles else { throw ReplayError.tooManyCandles }
        guard request.intervalMinutes <= maximumHoldMinutes else {
            throw ReplayError.intervalTooCoarse(
                intervalMinutes: request.intervalMinutes,
                maximumHoldMinutes: maximumHoldMinutes
            )
        }

        let expectedIntervalSeconds = Double(request.intervalMinutes) * 60.0
        let maximumGapSeconds = expectedIntervalSeconds * 1.5
        for (index, candle) in request.candles.enumerated() {
            guard candle.timestampMilliseconds > 0 else {
                throw ReplayError.invalidCandle(index: index, reason: "시각은 UTC epoch 이후여야 합니다")
            }
            guard [candle.open, candle.high, candle.low, candle.close, candle.volume].allSatisfy(\.isFinite) else {
                throw ReplayError.invalidCandle(index: index, reason: "OHLCV에는 유한한 숫자만 허용됩니다")
            }
            guard candle.open > 0, candle.high > 0, candle.low > 0, candle.close > 0, candle.volume >= 0 else {
                throw ReplayError.invalidCandle(index: index, reason: "가격은 양수이고 거래량은 음수일 수 없습니다")
            }
            guard candle.high >= max(candle.open, candle.close),
                  candle.low <= min(candle.open, candle.close),
                  candle.low <= candle.high else {
                throw ReplayError.invalidCandle(index: index, reason: "고가·저가 범위가 시가·종가와 맞지 않습니다")
            }
            guard Double(candle.timestampMilliseconds) <= Double(generatedAtMilliseconds) else {
                throw ReplayError.generatedAtBeforeLastCandle
            }
            if index == 0 { continue }

            let previousTimestamp = request.candles[index - 1].timestampMilliseconds
            guard candle.timestampMilliseconds > previousTimestamp else {
                throw ReplayError.timestampsNotIncreasing(index: index)
            }
            let deltaMilliseconds = candle.timestampMilliseconds - previousTimestamp
            // Match Node's analyzeHistoricalCandleContinuity default exactly:
            // deltaSeconds > expectedIntervalSeconds * 1.5 is a gap. The
            // threshold is not rounded, and a gap is never filled.
            let deltaSeconds = Double(deltaMilliseconds) / 1_000.0
            guard deltaSeconds <= maximumGapSeconds else {
                throw ReplayError.candleGap(index: index, deltaMilliseconds: deltaMilliseconds)
            }
        }
    }

    private static func simulate(_ candles: [Candle]) -> (
        summary: Summary,
        trades: [Trade],
        equityCurve: [EquityPoint]
    ) {
        let closes = candles.map(\.close)
        var closePrefix = [0.0]
        closePrefix.reserveCapacity(closes.count + 1)
        for close in closes {
            closePrefix.append(closePrefix[closePrefix.count - 1] + close)
        }
        let rsiSeries = calculateRSI(closes, period: rsiPeriod)
        var balance = initialBalance
        var fees = 0.0
        var signalCount = 0
        var cancelledSignalCount = 0
        var trades: [Trade] = []
        var equityCurve: [EquityPoint] = []
        var position: OpenPosition?
        var cooldownUntil: Int64 = 0
        var consecutiveLosses = 0

        for index in minimumHistory..<max(minimumHistory, candles.count) {
            let candle = candles[index]
            var closedThisCandle = false

            if var active = position {
                if let exit = exitDecision(position: active, candle: candle) {
                    let trade = close(active, on: candle, exit: exit)
                    balance += tradeGrossReceived(trade)
                    fees += trade.sellFee
                    trades.append(trade)
                    position = nil
                    closedThisCandle = true
                    if trade.netProfit < 0 {
                        consecutiveLosses += 1
                        let cooldownMinutes = consecutiveLosses >= maximumConsecutiveLosses
                            ? max(cooldownAfterLossMinutes, 60)
                            : cooldownAfterLossMinutes
                        cooldownUntil = candle.timestampMilliseconds + Int64(cooldownMinutes) * 60_000
                    } else {
                        consecutiveLosses = 0
                        cooldownUntil = 0
                    }
                } else {
                    updateExcursion(&active, with: candle)
                    position = active
                }
            }

            if position == nil,
               !closedThisCandle,
               candle.timestampMilliseconds >= cooldownUntil,
               index + 1 < candles.count {
                if consecutiveLosses >= maximumConsecutiveLosses {
                    consecutiveLosses = 0
                    cooldownUntil = 0
                }

                if reboundConfirmed(
                    candles: candles,
                    closePrefix: closePrefix,
                    rsi: rsiSeries,
                    index: index
                ) {
                    signalCount += 1
                    let nextCandle = candles[index + 1]
                    let referencePrice = candle.close
                    let retracePercent = ((referencePrice - nextCandle.open) / referencePrice) * 100.0
                    let chasePercent = ((nextCandle.open - referencePrice) / referencePrice) * 100.0
                    if retracePercent > maximumEntryRetracePercent || chasePercent > maximumEntryChasePercent {
                        cancelledSignalCount += 1
                    } else {
                        let investmentAmount = min(balance * investmentRatio, balance * 0.95)
                        let buyFee = investmentAmount * tradingFee
                        let entryPrice = nextCandle.open * (1.0 + adverseSlippage)
                        if investmentAmount >= minimumOrderAmount, entryPrice > 0 {
                            let quantity = (investmentAmount - buyFee) / entryPrice
                            balance -= investmentAmount
                            fees += buyFee
                            position = OpenPosition(
                                signalTimestampMilliseconds: candle.timestampMilliseconds,
                                entryTimestampMilliseconds: nextCandle.timestampMilliseconds,
                                entryPrice: entryPrice,
                                quantity: quantity,
                                investmentAmount: investmentAmount,
                                buyFee: buyFee,
                                highestPrice: entryPrice,
                                lowestPrice: entryPrice
                            )
                        }
                    }
                }
            }

            let markEquity = balance + (position.map { $0.quantity * candle.close } ?? 0.0)
            equityCurve.append(EquityPoint(
                timestampMilliseconds: candle.timestampMilliseconds,
                price: candle.close,
                equity: markEquity
            ))
        }

        if let active = position, let lastCandle = candles.last {
            let endExit = ExitDecision(reason: "BACKTEST_END", price: lastCandle.close * (1.0 - adverseSlippage))
            let trade = close(active, on: lastCandle, exit: endExit)
            balance += tradeGrossReceived(trade)
            fees += trade.sellFee
            trades.append(trade)
        }

        let netProfit = balance - initialBalance
        let summary = Summary(
            initialBalance: initialBalance,
            finalBalance: balance,
            netProfit: netProfit,
            totalReturnPercent: (netProfit / initialBalance) * 100.0,
            fees: fees,
            signalCount: signalCount,
            cancelledSignalCount: cancelledSignalCount,
            completedTradeCount: trades.count
        )
        return (summary, trades, equityCurve)
    }

    private static func calculateRSI(_ prices: [Double], period: Int) -> [Double?] {
        var values = Array<Double?>(repeating: nil, count: prices.count)
        guard prices.count >= period + 1 else { return values }

        var gains = 0.0
        var losses = 0.0
        for index in 1...period {
            let difference = prices[index] - prices[index - 1]
            if difference >= 0 { gains += difference } else { losses -= difference }
        }
        var averageGain = gains / Double(period)
        var averageLoss = losses / Double(period)
        values[period] = averageLoss == 0 ? 100.0 : 100.0 - (100.0 / (1.0 + averageGain / averageLoss))

        if period + 1 < prices.count {
            for index in (period + 1)..<prices.count {
                let difference = prices[index] - prices[index - 1]
                let currentGain = difference >= 0 ? difference : 0.0
                let currentLoss = difference < 0 ? -difference : 0.0
                averageGain = (averageGain * Double(period - 1) + currentGain) / Double(period)
                averageLoss = (averageLoss * Double(period - 1) + currentLoss) / Double(period)
                values[index] = averageLoss == 0 ? 100.0 : 100.0 - (100.0 / (1.0 + averageGain / averageLoss))
            }
        }
        return values
    }

    private static func reboundConfirmed(
        candles: [Candle],
        closePrefix: [Double],
        rsi: [Double?],
        index: Int
    ) -> Bool {
        guard index > 0,
              let currentRSI = rsi[index],
              let previousRSI = rsi[index - 1] else { return false }

        let candle = candles[index]
        let previous = candles[index - 1]
        guard candle.close > candle.open, candle.close > previous.close else { return false }
        guard previous.high < candle.close else { return false }

        let currentRange = candle.high - candle.low
        let closeStrength = currentRange > 0 ? (candle.close - candle.low) / currentRange : 1.0
        guard closeStrength >= minimumCloseStrength else { return false }

        let volumeStart = max(0, index - volumeLookback)
        let volumeHistory = candles[volumeStart..<index].map(\.volume)
        let averageVolume = volumeHistory.isEmpty ? 0.0 : volumeHistory.reduce(0.0, +) / Double(volumeHistory.count)
        if averageVolume > 0, candle.volume / averageVolume < minimumVolumeRatio { return false }

        if index >= trendPeriod + trendSlopeLookback {
            let currentStart = index - trendPeriod + 1
            let previousEnd = index - trendSlopeLookback
            let previousStart = previousEnd - trendPeriod + 1
            let currentAverage = (closePrefix[index + 1] - closePrefix[currentStart]) / Double(trendPeriod)
            let previousAverage = (closePrefix[previousEnd + 1] - closePrefix[previousStart]) / Double(trendPeriod)
            if previousAverage > 0 {
                let slopePercent = ((currentAverage - previousAverage) / previousAverage) * 100.0
                if slopePercent < minimumTrendSlopePercent { return false }
            }
        }

        guard previousRSI <= rsiOversold else { return false }
        let reboundPercent = ((candle.close - previous.close) / previous.close) * 100.0
        let rsiRecovery = currentRSI - previousRSI
        return reboundPercent >= minimumReboundPercent && rsiRecovery >= minimumRSIRecovery
    }

    private static func exitDecision(position: OpenPosition, candle: Candle) -> ExitDecision? {
        let protectiveStop = position.entryPrice * (1.0 - stopLossPercent / 100.0)
        let takeProfit = position.entryPrice * (1.0 + takeProfitPercent / 100.0)

        // OHLC does not reveal intrabar order. Match the Node simulator's
        // conservative rule: if both barriers trade in one candle, stop wins.
        if candle.low <= protectiveStop {
            // A stop-market order cannot fill at its trigger after a bar has
            // already opened below that level. Use the worse opening price
            // for a gap-through, then apply adverse slippage.
            let stopFillPrice = min(candle.open, protectiveStop)
            return ExitDecision(reason: "STOP_LOSS", price: stopFillPrice * (1.0 - adverseSlippage))
        }
        if candle.high >= takeProfit {
            return ExitDecision(reason: "TAKE_PROFIT", price: takeProfit * (1.0 - adverseSlippage))
        }

        let holdMilliseconds = candle.timestampMilliseconds - position.entryTimestampMilliseconds
        if holdMilliseconds >= Int64(maximumHoldMinutes) * 60_000 {
            return ExitDecision(reason: "MAX_HOLD_TIME", price: candle.open * (1.0 - adverseSlippage))
        }
        return nil
    }

    private static func close(_ position: OpenPosition, on candle: Candle, exit: ExitDecision) -> Trade {
        var finalPosition = position
        updateExcursion(&finalPosition, with: candle)
        let grossAmount = finalPosition.quantity * exit.price
        let sellFee = grossAmount * tradingFee
        let netProfit = grossAmount - sellFee - finalPosition.investmentAmount
        return Trade(
            signalTimestampMilliseconds: finalPosition.signalTimestampMilliseconds,
            entryTimestampMilliseconds: finalPosition.entryTimestampMilliseconds,
            exitTimestampMilliseconds: candle.timestampMilliseconds,
            entryPrice: finalPosition.entryPrice,
            exitPrice: exit.price,
            quantity: finalPosition.quantity,
            investmentAmount: finalPosition.investmentAmount,
            buyFee: finalPosition.buyFee,
            sellFee: sellFee,
            reason: exit.reason,
            netProfit: netProfit,
            profitPercent: (netProfit / finalPosition.investmentAmount) * 100.0,
            maxFavorableExcursionPercent: ((finalPosition.highestPrice - finalPosition.entryPrice) / finalPosition.entryPrice) * 100.0,
            maxAdverseExcursionPercent: ((finalPosition.lowestPrice - finalPosition.entryPrice) / finalPosition.entryPrice) * 100.0
        )
    }

    private static func updateExcursion(_ position: inout OpenPosition, with candle: Candle) {
        position.highestPrice = max(position.highestPrice, candle.high)
        position.lowestPrice = min(position.lowestPrice, candle.low)
    }

    private static func tradeGrossReceived(_ trade: Trade) -> Double {
        trade.quantity * trade.exitPrice - trade.sellFee
    }

    private static func datasetFingerprint(for request: Request) -> String {
        var bytes = Data("coinpilot-offline-replay-dataset-v1\0".utf8)
        appendLengthPrefixed(Array(request.market.utf8), to: &bytes)
        appendInt32(Int32(request.intervalMinutes), to: &bytes)
        appendUInt32(UInt32(request.candles.count), to: &bytes)
        for candle in request.candles {
            appendInt64(candle.timestampMilliseconds, to: &bytes)
            appendDouble(candle.open, to: &bytes)
            appendDouble(candle.high, to: &bytes)
            appendDouble(candle.low, to: &bytes)
            appendDouble(candle.close, to: &bytes)
            appendDouble(candle.volume, to: &bytes)
        }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private static func appendLengthPrefixed(_ value: [UInt8], to data: inout Data) {
        appendUInt32(UInt32(value.count), to: &data)
        data.append(contentsOf: value)
    }

    private static func appendInt32(_ value: Int32, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }

    private static func appendUInt32(_ value: UInt32, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }

    private static func appendInt64(_ value: Int64, to data: inout Data) {
        var bigEndian = UInt64(bitPattern: value).bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }

    private static func appendDouble(_ value: Double, to data: inout Data) {
        let canonicalValue = value == 0.0 ? 0.0 : value
        var bigEndian = canonicalValue.bitPattern.bigEndian
        withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }

    private static func isValidMarket(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count >= 6, bytes.count <= 19,
              bytes[0...3].elementsEqual(Array("KRW-".utf8)) else { return false }
        return bytes[4...].allSatisfy { byte in
            (65...90).contains(byte) || (48...57).contains(byte)
        }
    }

    private static func utcMilliseconds(from value: String) -> Int64? {
        guard value.hasSuffix("Z"), (20...30).contains(value.utf8.count) else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: value)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: value)
        }
        guard let date else { return nil }
        let milliseconds = date.timeIntervalSince1970 * 1_000.0
        guard milliseconds.isFinite,
              milliseconds >= Double(Int64.min), milliseconds <= Double(Int64.max) else { return nil }
        return Int64(milliseconds.rounded(.towardZero))
    }
}
