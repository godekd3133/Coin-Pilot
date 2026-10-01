import Foundation

/// Golden values below were produced by Node's `simulateScalping` in
/// `src/backtest/scalpingBacktest.js` with its pinned DEFAULT_CONFIG and the
/// same synthetic candles. They are intentionally literal fixture values.
@main
struct CoinPilotOfflineReplayTests {
    private static let baseTimestamp: Int64 = 1_767_225_600_000

    static func main() throws {
        try testTakeProfitMatchesNodeGolden()
        try testStopWinsWhenBothBarriersTouch()
        try testStopGapThroughMatchesNodeGolden()
        try testTimestampBasedMaximumHoldMatchesNodeGolden()
        try testBacktestEndAndFeesMatchNodeGolden()
        try testMetadataAndFingerprintAreStable()
        try testMinimumHistoryBoundary()
        try testIntervalTooCoarseForMaximumHoldRule()
        try testNodeContinuityThresholdAndNoGapFill()
        try testDuplicateAndReverseTimestampsFailClosed()
        try testMalformedCandleAndGeneratedAtFailClosed()
        try testPlaybackFramesAreIndexedFromTheHistoricalCandles()
        print("CoinPilotOfflineReplayTests: 12/12 passed")
    }

    private static func testTakeProfitMatchesNodeGolden() throws {
        let result = try CoinPilotOfflineReplay.run(request(for: .takeProfit))
        try expect(result.trades.count == 1, "take-profit trade count")
        let trade = result.trades[0]
        try expect(trade.reason == "TAKE_PROFIT", "take-profit reason")
        try expect(trade.signalTimestampMilliseconds == baseTimestamp + 26 * 60_000, "signal timestamp")
        try expect(trade.entryTimestampMilliseconds == baseTimestamp + 27 * 60_000, "delayed entry timestamp")
        try expect(trade.exitTimestampMilliseconds == baseTimestamp + 27 * 60_000, "exit timestamp")
        try expectNear(trade.entryPrice, 96.09599999999999, "entry price")
        try expectNear(trade.exitPrice, 97.72790227199998, "take-profit exit price")
        try expectNear(trade.quantity, 208.02114552114554, "quantity")
        try expectNear(trade.investmentAmount, 20_000, "investment amount")
        try expectNear(trade.buyFee, 10, "buy fee")
        try expectNear(trade.sellFee, 10.164735089999999, "sell fee")
        try expectNear(trade.netProfit, 319.3054449099982, "net profit")
        try expectNear(trade.profitPercent, 1.5965272245499909, "profit percent")
        try expectNear(trade.maxFavorableExcursionPercent, 2.189477189477204, "maximum favorable excursion")
        try expectNear(trade.maxAdverseExcursionPercent, -0.30802530802530004, "maximum adverse excursion")
        try expectNear(result.summary.finalBalance, 1_000_319.30544491, "final balance")
        try expectNear(result.summary.fees, 20.16473509, "total fees")
        try expect(result.summary.signalCount == 1, "signal count")
        try expect(result.summary.cancelledSignalCount == 0, "cancelled signal count")
    }

    private static func testStopWinsWhenBothBarriersTouch() throws {
        let result = try CoinPilotOfflineReplay.run(request(for: .bothBarriers))
        try expect(result.trades.count == 1, "both-barriers trade count")
        let trade = result.trades[0]
        try expect(trade.reason == "STOP_LOSS", "stop must win when stop and take-profit are both touched")
        try expectNear(trade.entryPrice, 96.09599999999999, "both-barriers entry price")
        try expectNear(trade.exitPrice, 94.84790515199998, "stop exit price with adverse slippage")
        try expectNear(trade.netProfit, -279.4953049400028, "stop net profit")
        try expectNear(result.summary.finalBalance, 999_720.50469506, "stop final balance")
    }

    private static func testStopGapThroughMatchesNodeGolden() throws {
        let result = try CoinPilotOfflineReplay.run(request(for: .stopGapDown))
        try expect(result.trades.count == 1, "stop gap-through trade count")
        let trade = result.trades[0]
        try expect(trade.reason == "STOP_LOSS", "stop must win over a take-profit touch after a gap-down open")
        try expect(trade.exitTimestampMilliseconds == baseTimestamp + 30 * 60_000, "gap-through exit timestamp")
        try expectNear(trade.entryPrice, 96.09599999999999, "gap-through entry price")
        try expectNear(trade.exitPrice, 89.91, "gap-through uses open before adverse slippage")
        try expectNear(trade.sellFee, 9.351590596903097, "gap-through sell fee")
        try expectNear(trade.netProfit, -1_306.1703967907088, "gap-through net loss")
        try expectNear(result.summary.finalBalance, 998_693.8296032093, "gap-through final balance")
        try expectNear(result.summary.fees, 19.351590596903097, "gap-through total fees")
    }

    private static func testTimestampBasedMaximumHoldMatchesNodeGolden() throws {
        let result = try CoinPilotOfflineReplay.run(request(for: .maximumHold))
        try expect(result.trades.count == 1, "maximum-hold trade count")
        let trade = result.trades[0]
        try expect(trade.reason == "MAX_HOLD_TIME", "maximum-hold reason")
        try expect(trade.exitTimestampMilliseconds == baseTimestamp + 57 * 60_000, "30-minute exit uses UTC candle timestamps")
        try expectNear(trade.entryPrice, 96.09599999999999, "maximum-hold entry price")
        try expectNear(trade.exitPrice, 95.904, "maximum-hold open exit with adverse slippage")
        try expectNear(trade.netProfit, -59.91508991008959, "maximum-hold net profit")
        try expectNear(result.summary.finalBalance, 999_940.08491009, "maximum-hold final balance")
    }

    private static func testBacktestEndAndFeesMatchNodeGolden() throws {
        let result = try CoinPilotOfflineReplay.run(request(for: .backtestEnd))
        try expect(result.trades.count == 1, "backtest-end trade count")
        let trade = result.trades[0]
        try expect(trade.reason == "BACKTEST_END", "unfinished position closes at historical window end")
        try expect(trade.exitTimestampMilliseconds == baseTimestamp + 28 * 60_000, "backtest-end timestamp")
        try expectNear(trade.exitPrice, 96.00389999999999, "backtest-end exit with adverse slippage")
        try expectNear(trade.netProfit, -39.14416812874697, "backtest-end net profit")
        try expectNear(result.summary.fees, 19.985420626248754, "both-side fees at window end")
        try expectNear(result.summary.finalBalance, 999_960.8558318713, "backtest-end final balance")
    }

    private static func testMetadataAndFingerprintAreStable() throws {
        let input = request(for: .takeProfit)
        let first = try CoinPilotOfflineReplay.run(input)
        let second = try CoinPilotOfflineReplay.run(input)
        try expect(first.metadata.simulationType == "historical-simulation", "simulation type")
        try expect(first.metadata.executionModel.contains("next-candle-open"), "execution model describes historical entry proxy")
        try expect(first.metadata.source == "upbit-public-market-api", "source provenance")
        try expect(first.metadata.generatedAt == "2026-01-01T00:28:00.000Z", "pack generation timestamp")
        try expect(first.metadata.market == "KRW-BTC", "single-market identity")
        try expect(first.metadata.intervalMinutes == 1, "candle interval")
        try expect(first.metadata.startTimestampMilliseconds == baseTimestamp, "dataset start")
        try expect(first.metadata.endTimestampMilliseconds == baseTimestamp + 28 * 60_000, "dataset end")
        try expect(first.metadata.rowCount == 29, "dataset row count")
        try expect(first.metadata.configVersion == CoinPilotOfflineReplay.configurationVersion, "pinned config version")
        try expect(first.metadata.engineVersion == CoinPilotOfflineReplay.engineVersion, "pinned engine version")
        try expect(first.metadata.datasetFingerprint.count == 64, "SHA-256 fingerprint shape")
        try expect(first.metadata.datasetFingerprint == second.metadata.datasetFingerprint, "fingerprint repeatability")

        let provenanceOnlyChange = CoinPilotOfflineReplay.Request(
            market: input.market,
            intervalMinutes: input.intervalMinutes,
            source: "same-dataset-different-label",
            generatedAt: "2026-01-01T00:29:00.000Z",
            candles: input.candles
        )
        let sameData = try CoinPilotOfflineReplay.run(provenanceOnlyChange)
        try expect(first.metadata.datasetFingerprint == sameData.metadata.datasetFingerprint, "fingerprint represents market candles, not pack labels")

        var changedCandles = input.candles
        let last = changedCandles.removeLast()
        changedCandles.append(CoinPilotOfflineReplay.Candle(
            timestampMilliseconds: last.timestampMilliseconds,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close + 0.01,
            volume: last.volume
        ))
        let changedData = CoinPilotOfflineReplay.Request(
            market: input.market,
            intervalMinutes: input.intervalMinutes,
            source: input.source,
            generatedAt: input.generatedAt,
            candles: changedCandles
        )
        let changed = try CoinPilotOfflineReplay.run(changedData)
        try expect(first.metadata.datasetFingerprint != changed.metadata.datasetFingerprint, "fingerprint changes with OHLCV")
    }

    private static func testNodeContinuityThresholdAndNoGapFill() throws {
        var atThreshold = (0..<17).map { candle(Int64($0) * 60_000, close: 100) }
        atThreshold.append(candle(16 * 60_000 + 90_000, close: 100))
        let withinNodeThreshold = try CoinPilotOfflineReplay.run(request(candles: atThreshold, generatedAt: "2026-01-01T00:17:30.000Z"))
        try expect(withinNodeThreshold.metadata.rowCount == 18, "Node 1.5x continuity threshold is accepted without synthetic rows")

        var overThreshold = (0..<17).map { candle(Int64($0) * 60_000, close: 100) }
        overThreshold.append(candle(16 * 60_000 + 91_000, close: 100))
        try expectReplayError(.candleGap(index: 17, deltaMilliseconds: 91_000)) {
            try CoinPilotOfflineReplay.run(request(candles: overThreshold, generatedAt: "2026-01-01T00:17:31.000Z"))
        }
    }

    private static func testMinimumHistoryBoundary() throws {
        let tooShort = (0..<17).map { candle(Int64($0) * 60_000, close: 100) }
        try expectReplayError(.insufficientCandles(minimum: 18)) {
            try CoinPilotOfflineReplay.run(request(candles: tooShort, generatedAt: "2026-01-01T00:17:00.000Z"))
        }

        let sufficient = (0..<18).map { candle(Int64($0) * 60_000, close: 100) }
        let result = try CoinPilotOfflineReplay.run(request(candles: sufficient, generatedAt: "2026-01-01T00:18:00.000Z"))
        try expect(result.equityCurve.count == 2, "The minimum supported history should produce evaluated equity points.")
    }

    private static func testIntervalTooCoarseForMaximumHoldRule() throws {
        let hourly = (0..<18).map { candle(Int64($0) * 60 * 60_000, close: 100) }
        try expectReplayError(.intervalTooCoarse(intervalMinutes: 60, maximumHoldMinutes: 30)) {
            try CoinPilotOfflineReplay.run(request(
                candles: hourly,
                generatedAt: "2026-01-01T18:00:00.000Z",
                intervalMinutes: 60
            ))
        }
    }

    private static func testDuplicateAndReverseTimestampsFailClosed() throws {
        var duplicate = (0..<17).map { candle(Int64($0) * 60_000, close: 100) }
        duplicate.append(candle(16 * 60_000, close: 101))
        try expectReplayError(.timestampsNotIncreasing(index: 17)) {
            try CoinPilotOfflineReplay.run(request(candles: duplicate, generatedAt: "2026-01-01T00:17:00.000Z"))
        }

        var reverse = (0..<16).map { candle(Int64($0) * 60_000, close: 100) }
        reverse.append(candle(16 * 60_000, close: 101))
        reverse.append(candle(15 * 60_000 + 30_000, close: 100))
        try expectReplayError(.timestampsNotIncreasing(index: 17)) {
            try CoinPilotOfflineReplay.run(request(candles: reverse, generatedAt: "2026-01-01T00:16:30.000Z"))
        }
    }

    private static func testMalformedCandleAndGeneratedAtFailClosed() throws {
        var invalidOHLC = (0..<17).map { candle(Int64($0) * 60_000, close: 100) }
        invalidOHLC.append(candle(17 * 60_000, close: 100, open: 102, high: 101, low: 99))
        try expectReplayError(.invalidCandle(index: 17, reason: "고가·저가 범위가 시가·종가와 맞지 않습니다")) {
            try CoinPilotOfflineReplay.run(request(candles: invalidOHLC, generatedAt: "2026-01-01T00:17:00.000Z"))
        }

        let valid = (0..<18).map { candle(Int64($0) * 60_000, close: 100 + Double($0)) }
        try expectReplayError(.generatedAtBeforeLastCandle) {
            try CoinPilotOfflineReplay.run(request(candles: valid, generatedAt: "2026-01-01T00:16:30.000Z"))
        }
        try expectReplayError(.invalidGeneratedAt) {
            try CoinPilotOfflineReplay.run(request(candles: valid, generatedAt: "2026-01-01T00:17:00+09:00"))
        }
    }

    private static func testPlaybackFramesAreIndexedFromTheHistoricalCandles() throws {
        let input = request(for: .takeProfit)
        let result = try CoinPilotOfflineReplay.run(input)
        guard let warmupFrame = CoinPilotOfflineReplay.playbackFrame(atCandleIndex: 0, request: input, result: result),
              let firstValuedFrame = CoinPilotOfflineReplay.playbackFrame(
                  atCandleIndex: CoinPilotOfflineReplay.minimumCandleCount - 2,
                  request: input,
                  result: result
              ),
              let lastFrame = CoinPilotOfflineReplay.playbackFrame(
                  atCandleIndex: input.candles.count - 1,
                  request: input,
                  result: result
              ) else {
            throw TestFailure(description: "valid candle indices should produce playback frames")
        }

        try expect(warmupFrame.candleIndex == 0 && warmupFrame.totalCandleCount == input.candles.count,
                   "playback progress starts at the source candle index")
        try expect(warmupFrame.timestampMilliseconds == input.candles[0].timestampMilliseconds,
                   "frame time comes from the selected source candle")
        try expect(warmupFrame.historicalClose == input.candles[0].close,
                   "frame price is the source candle close")
        try expect(warmupFrame.historicalSimulationEquity == nil,
                   "warmup candles do not invent a simulation equity value")
        try expect(firstValuedFrame.historicalSimulationEquity == result.equityCurve.first?.equity,
                   "the first calculated balance maps to the strategy warmup boundary")
        try expect(lastFrame.historicalSimulationEquity == result.equityCurve.last?.equity,
                   "the final candle maps to the final historical curve point")
        try expect(CoinPilotOfflineReplay.playbackFrame(
            atCandleIndex: input.candles.count,
            request: input,
            result: result
        ) == nil, "out-of-range cursors fail closed")

        let mismatchedRequest = CoinPilotOfflineReplay.Request(
            market: "KRW-ETH",
            intervalMinutes: input.intervalMinutes,
            source: input.source,
            generatedAt: input.generatedAt,
            candles: input.candles
        )
        try expect(CoinPilotOfflineReplay.playbackFrame(
            atCandleIndex: 0,
            request: mismatchedRequest,
            result: result
        ) == nil, "frames cannot pair a result with a different market")
    }

    private enum Scenario {
        case takeProfit
        case bothBarriers
        case stopGapDown
        case maximumHold
        case backtestEnd
    }

    private static func request(for scenario: Scenario) -> CoinPilotOfflineReplay.Request {
        var candles: [CoinPilotOfflineReplay.Candle] = []
        for index in 0..<26 {
            let close = Double(120 - index)
            candles.append(candle(
                Int64(index) * 60_000,
                close: close,
                open: close + 0.5,
                high: close + 0.5,
                low: close - 0.5
            ))
        }
        candles.append(candle(26 * 60_000, close: 96, open: 95.2, high: 96.4, low: 95))

        switch scenario {
        case .takeProfit:
            candles.append(candle(27 * 60_000, close: 97.8, open: 96, high: 98.2, low: 95.8))
            candles.append(candle(28 * 60_000, close: 97.5, open: 97.8, high: 98, low: 97.2))
        case .bothBarriers:
            candles.append(candle(27 * 60_000, close: 97.8, open: 96, high: 99, low: 94))
            candles.append(candle(28 * 60_000, close: 97.5, open: 97.8, high: 98, low: 97.2))
        case .stopGapDown:
            candles.append(candle(27 * 60_000, close: 96.2, open: 96, high: 97.2, low: 95.8))
            candles.append(candle(28 * 60_000, close: 97.0, open: 96.8, high: 97.2, low: 96.8))
            candles.append(candle(29 * 60_000, close: 96.0, open: 96.8, high: 97.0, low: 95.5))
            candles.append(candle(30 * 60_000, close: 90, open: 90, high: 99, low: 89.5))
        case .maximumHold:
            candles.append(candle(27 * 60_000, close: 96, open: 96, high: 96.4, low: 95.8))
            for index in 28...57 {
                candles.append(candle(Int64(index) * 60_000, close: 96, open: 96, high: 96.2, low: 95.8))
            }
        case .backtestEnd:
            candles.append(candle(27 * 60_000, close: 96, open: 96, high: 96.4, low: 95.8))
            candles.append(candle(28 * 60_000, close: 96.1, open: 96, high: 96.4, low: 95.8))
        }

        let lastMinute = Int((candles.last!.timestampMilliseconds - baseTimestamp) / 60_000)
        let generatedAt = String(format: "2026-01-01T00:%02d:00.000Z", lastMinute)
        return request(candles: candles, generatedAt: generatedAt)
    }

    private static func request(
        candles: [CoinPilotOfflineReplay.Candle],
        generatedAt: String,
        intervalMinutes: Int = 1
    ) -> CoinPilotOfflineReplay.Request {
        CoinPilotOfflineReplay.Request(
            market: "KRW-BTC",
            intervalMinutes: intervalMinutes,
            source: "upbit-public-market-api",
            generatedAt: generatedAt,
            candles: candles
        )
    }

    private static func candle(
        _ offsetMilliseconds: Int64,
        close: Double,
        open: Double? = nil,
        high: Double? = nil,
        low: Double? = nil,
        volume: Double = 100
    ) -> CoinPilotOfflineReplay.Candle {
        let candleOpen = open ?? close
        return CoinPilotOfflineReplay.Candle(
            timestampMilliseconds: baseTimestamp + offsetMilliseconds,
            open: candleOpen,
            high: high ?? max(candleOpen, close),
            low: low ?? min(candleOpen, close),
            close: close,
            volume: volume
        )
    }

    private static func expectReplayError(
        _ expected: CoinPilotOfflineReplay.ReplayError,
        _ operation: () throws -> Any
    ) throws {
        do {
            let _ = try operation()
            throw TestFailure(description: "expected replay error \(expected)")
        } catch let error as CoinPilotOfflineReplay.ReplayError {
            try expect(error == expected, "error mismatch: got \(error), expected \(expected)")
        }
    }

    private static func expectNear(_ actual: Double, _ expected: Double, _ label: String, tolerance: Double = 1e-8) throws {
        try expect(actual.isFinite && abs(actual - expected) <= tolerance, "\(label): got \(actual), expected \(expected)")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw TestFailure(description: message) }
    }

    private struct TestFailure: Error, CustomStringConvertible {
        let description: String

        init(description: String) {
            self.description = description
        }
    }
}
