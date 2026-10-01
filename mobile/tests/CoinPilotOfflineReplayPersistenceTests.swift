import Foundation

@main
struct CoinPilotOfflineReplayPersistenceTests {
    static func main() async throws {
        try await emptyArchiveLoadsAndSavedResultRoundTrips()
        try await duplicateIdentityReplacesTheEarlierResult()
        try await retentionKeepsOnlyTheFiveNewestResults()
        try await concurrentSavesKeepAnIntegrityCheckedArchive()
        try await unknownArchiveVersionFailsClosed()
        try await corruptArchiveFailsClosed()
        try await duplicateEntriesFailClosed()
        try await oversizedArchiveFailsClosed()
        try await semanticMutationsFailClosedOnLoadAndSave()
        try await fingerprintShapeIsCheckedWithoutClaimingAuthentication()
        try await generatedTradeOutcomesRoundTripWithinFiveResultLimit()
        try await sessionCheckpointRoundTripsAndChecksDatasetIdentity()
        try await tamperedSessionCheckpointFailsClosed()
        try await unsupportedSessionCheckpointVersionFailsClosed()
        try await impossibleSessionCursorCannotBeSaved()
        print("CoinPilotOfflineReplayPersistence: 15 scenarios passed")
    }

    private static func emptyArchiveLoadsAndSavedResultRoundTrips() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        let initiallyLoaded = try await store.load()
        precondition(initiallyLoaded.isEmpty, "A missing archive should start empty.")

        let expected = try makeResult(seed: 1)
        let saved = try await store.save(expected)
        let loaded = try await store.load()
        precondition(saved == [expected], "Save should return the persisted result history.")
        precondition(loaded == [expected], "Every replay result field should survive archive round-tripping.")
        precondition(FileManager.default.fileExists(atPath: fixture.fileURL.path), "Saving should create the injected archive.")
    }

    private static func duplicateIdentityReplacesTheEarlierResult() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        let original = try makeResult(seed: 2, source: "fixture-before", generatedAtOffsetSeconds: 120)
        let refreshed = try makeResult(seed: 2, source: "fixture-after", generatedAtOffsetSeconds: 180)
        precondition(original.metadata.datasetFingerprint == refreshed.metadata.datasetFingerprint,
                     "The same dataset must retain its deterministic fingerprint when only provenance time changes.")

        let afterOriginal = try await store.save(original)
        let afterReplacement = try await store.save(refreshed)
        let loaded = try await store.load()
        precondition(afterOriginal.count == 1, "The first result should create one history row.")
        precondition(afterReplacement == [refreshed], "A matching dedupe identity should replace the existing row.")
        precondition(loaded == [refreshed], "The replacement should survive a fresh archive read.")
    }

    private static func retentionKeepsOnlyTheFiveNewestResults() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        let expected = try (0..<7).map { try makeResult(seed: 10 + $0) }.reversed()
        for result in expected.reversed() {
            _ = try await store.save(result)
        }

        let loaded = try await store.load()
        precondition(loaded.count == 5, "The archive should retain no more than five results.")
        precondition(loaded.map(\.metadata.datasetFingerprint) == Array(expected.prefix(5)).map(\.metadata.datasetFingerprint),
                     "Retention should preserve newest-first order and discard only the oldest identities.")
    }

    private static func concurrentSavesKeepAnIntegrityCheckedArchive() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        let results = try (0..<12).map { try makeResult(seed: 100 + $0) }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for result in results {
                group.addTask {
                    _ = try await store.save(result)
                }
            }
            try await group.waitForAll()
        }

        let loaded = try await store.load()
        precondition(loaded.count == 5, "Serialized concurrent saves should still honor retention.")
        precondition(Set(loaded.map(\.metadata.datasetFingerprint)).count == loaded.count,
                     "Concurrent writes should leave a valid archive without duplicate identities.")
        precondition(loaded.allSatisfy { expected in results.contains(expected) },
                     "Concurrent history should contain only complete submitted results.")
    }

    private static func unknownArchiveVersionFailsClosed() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: true)
        try Data(#"{"schemaVersion":999,"results":[]}"#.utf8).write(to: fixture.fileURL)

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        do {
            _ = try await store.load()
            fatalError("An unknown archive version must not be treated as empty or current.")
        } catch let error as CoinPilotOfflineReplayPersistenceError {
            precondition(error == .unsupportedArchiveVersion, "Unknown schema should have a specific fail-closed error.")
        }
    }

    private static func corruptArchiveFailsClosed() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: true)
        try Data("{not-json".utf8).write(to: fixture.fileURL)

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        do {
            _ = try await store.load()
            fatalError("Corrupt archive bytes must not be silently discarded.")
        } catch let error as CoinPilotOfflineReplayPersistenceError {
            precondition(error == .invalidArchive, "Corruption should have a specific fail-closed error.")
        }
    }

    private static func duplicateEntriesFailClosed() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: true)
        let duplicate = try makeResult(seed: 3)
        let data = try JSONEncoder().encode(EncodableArchive(schemaVersion: 1, results: [duplicate, duplicate]))
        try data.write(to: fixture.fileURL)

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        do {
            _ = try await store.load()
            fatalError("Duplicate dedupe identities in an archive must not be accepted.")
        } catch let error as CoinPilotOfflineReplayPersistenceError {
            precondition(error == .invalidArchive, "Duplicate history entries should be rejected as invalid data.")
        }
    }

    private static func oversizedArchiveFailsClosed() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: true)
        let oversized = Data(repeating: 0x20, count: CoinPilotOfflineReplayFileStore.maximumArchiveBytes + 1)
        try oversized.write(to: fixture.fileURL)

        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        do {
            _ = try await store.load()
            fatalError("An oversized archive must not be decoded or truncated.")
        } catch let error as CoinPilotOfflineReplayPersistenceError {
            precondition(error == .archiveTooLarge, "Oversize should have a specific fail-closed error.")
        }
    }

    private static func semanticMutationsFailClosedOnLoadAndSave() async throws {
        let mutations = try makeSemanticMutations()
        for mutation in mutations {
            let saveFixture = try makeFixture()
            defer { try? FileManager.default.removeItem(at: saveFixture.directory) }
            let saveStore = CoinPilotOfflineReplayFileStore(fileURL: saveFixture.fileURL)
            do {
                _ = try await saveStore.save(mutation.result)
                fatalError("Save should reject the semantic mutation: \(mutation.name)")
            } catch let error as CoinPilotOfflineReplayPersistenceError {
                precondition(error == .invalidResult, "Save should reject \(mutation.name) as an invalid result.")
            }
            precondition(!FileManager.default.fileExists(atPath: saveFixture.fileURL.path),
                         "Rejected result must not create an archive: \(mutation.name)")

            let loadFixture = try makeFixture()
            defer { try? FileManager.default.removeItem(at: loadFixture.directory) }
            let archive = EncodableArchive(schemaVersion: 1, results: [mutation.result])
            let data = try JSONEncoder().encode(archive)
            try data.write(to: loadFixture.fileURL)

            let loadStore = CoinPilotOfflineReplayFileStore(fileURL: loadFixture.fileURL)
            do {
                _ = try await loadStore.load()
                fatalError("Load should reject the semantic mutation: \(mutation.name)")
            } catch let error as CoinPilotOfflineReplayPersistenceError {
                precondition(error == .invalidArchive, "Load should reject \(mutation.name) as an invalid archive.")
            }
        }
    }

    private static func fingerprintShapeIsCheckedWithoutClaimingAuthentication() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let valid = try makeResult(seed: 9)
        let alteredFingerprint = replacing(
            valid,
            metadata: replacing(valid.metadata, datasetFingerprint: String(repeating: "a", count: 64))
        )
        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        let saved = try await store.save(alteredFingerprint)
        let loaded = try await store.load()
        precondition(saved == [alteredFingerprint] && loaded == [alteredFingerprint],
                     "Without source candles, persistence checks fingerprint format but cannot authenticate its value.")
    }

    private static func generatedTradeOutcomesRoundTripWithinFiveResultLimit() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let expected = try [
            makeResult(seed: 49),
            makeResultWithTradeScenario(.stopLoss),
            makeResultWithTradeScenario(.takeProfit),
            makeResultWithTradeScenario(.maximumHold),
            makeResultWithTradeScenario(.backtestEnd)
        ]
        let store = CoinPilotOfflineReplayFileStore(fileURL: fixture.fileURL)
        for result in expected {
            _ = try await store.save(result)
        }

        let loaded = try await store.load()
        precondition(loaded.count == 5, "All five newest valid engine results should remain available.")
        precondition(loaded == Array(expected.reversed()), "Generated exit outcomes should round-trip in newest-first order.")
    }

    private static func sessionCheckpointRoundTripsAndChecksDatasetIdentity() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let result = try makeResult(seed: 77)
        let checkpoint = makeSessionCheckpoint(result: result, nextIndex: 3, status: .paused)
        let store = CoinPilotOfflineReplaySessionCheckpointStore(fileURL: fixture.fileURL)
        try await store.saveCheckpoint(checkpoint)

        let loaded = try await store.loadCheckpoint()
        precondition(loaded == checkpoint, "The local session checkpoint should survive an archive round trip.")
        precondition(loaded?.matches(result.metadata, candleCount: result.metadata.rowCount) == true,
                     "A checkpoint should bind to the matching dataset and pinned engine/config.")
        let differentDataMetadata = replacing(
            result.metadata,
            datasetFingerprint: String(repeating: "b", count: 64)
        )
        precondition(loaded?.matches(differentDataMetadata, candleCount: result.metadata.rowCount) == false,
                     "A well-formed checkpoint must not resume against a different dataset fingerprint.")
    }

    private static func tamperedSessionCheckpointFailsClosed() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let result = try makeResult(seed: 78)
        let checkpoint = makeSessionCheckpoint(result: result, nextIndex: 3, status: .paused)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(checkpoint)
        let tampered = replacing(#""nextCandleIndex":3"#, with: #""nextCandleIndex":4"#, in: data)
        try tampered.write(to: fixture.fileURL)

        let store = CoinPilotOfflineReplaySessionCheckpointStore(fileURL: fixture.fileURL)
        do {
            _ = try await store.loadCheckpoint()
            fatalError("A cursor changed without an updated checksum must be rejected.")
        } catch let error as CoinPilotOfflineReplaySessionCheckpointError {
            precondition(error == .invalidCheckpoint, "Tampered checkpoint data should fail closed.")
        }
    }

    private static func unsupportedSessionCheckpointVersionFailsClosed() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let result = try makeResult(seed: 79)
        let checkpoint = makeSessionCheckpoint(result: result, nextIndex: 3, status: .paused)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(checkpoint)
        let unsupported = replacing(#""schemaVersion":1"#, with: #""schemaVersion":2"#, in: data)
        try unsupported.write(to: fixture.fileURL)

        let store = CoinPilotOfflineReplaySessionCheckpointStore(fileURL: fixture.fileURL)
        do {
            _ = try await store.loadCheckpoint()
            fatalError("An unsupported checkpoint version must not be treated as resumable.")
        } catch let error as CoinPilotOfflineReplaySessionCheckpointError {
            precondition(error == .unsupportedVersion, "Unsupported session format should have a specific recovery error.")
        }
    }

    private static func impossibleSessionCursorCannotBeSaved() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let result = try makeResult(seed: 80)
        let impossible = makeSessionCheckpoint(result: result, nextIndex: 0, status: .completed)
        let store = CoinPilotOfflineReplaySessionCheckpointStore(fileURL: fixture.fileURL)
        do {
            try await store.saveCheckpoint(impossible)
            fatalError("A completed checkpoint must point just past the final candle.")
        } catch let error as CoinPilotOfflineReplaySessionCheckpointError {
            precondition(error == .invalidCheckpoint, "Impossible cursor/status pairs should fail closed.")
        }
    }

    private static func makeSemanticMutations() throws -> [SemanticMutation] {
        let flat = try makeResult(seed: 40)
        let traded = try makeResultWithTakeProfitTrade()
        guard let trade = traded.trades.first else {
            fatalError("The synthetic take-profit replay must produce a trade.")
        }
        let generatedBeforeEnd = iso8601String(
            Date(timeIntervalSince1970: Double(flat.metadata.endTimestampMilliseconds - 1_000) / 1_000)
        )

        return [
            SemanticMutation("unsupported engine", replacing(flat, metadata: replacing(flat.metadata, engineVersion: "offline-replay-v2"))),
            SemanticMutation("unsupported config", replacing(flat, metadata: replacing(flat.metadata, configVersion: "scalping-defaults-v2"))),
            SemanticMutation("unsupported simulation type", replacing(flat, metadata: replacing(flat.metadata, simulationType: "live-execution"))),
            SemanticMutation("unsupported execution model", replacing(flat, metadata: replacing(flat.metadata, executionModel: "market orders"))),
            SemanticMutation("invalid market", replacing(flat, metadata: replacing(flat.metadata, market: "BTC-KRW"))),
            SemanticMutation("unsupported result interval", replacing(flat, metadata: replacing(flat.metadata, intervalMinutes: 60))),
            SemanticMutation("invalid source", replacing(flat, metadata: replacing(flat.metadata, source: ""))),
            SemanticMutation("generation precedes data", replacing(flat, metadata: replacing(flat.metadata, generatedAt: generatedBeforeEnd))),
            SemanticMutation("invalid generation timestamp", replacing(flat, metadata: replacing(flat.metadata, generatedAt: "2026-01-01T00:18:00+09:00"))),
            SemanticMutation("invalid dataset start", replacing(flat, metadata: replacing(flat.metadata, startTimestampMilliseconds: 0))),
            SemanticMutation("invalid dataset end", replacing(flat, metadata: replacing(flat.metadata, endTimestampMilliseconds: flat.metadata.startTimestampMilliseconds))),
            SemanticMutation("row count below engine minimum", replacing(flat, metadata: replacing(flat.metadata, rowCount: 17))),
            SemanticMutation("malformed fingerprint", replacing(flat, metadata: replacing(flat.metadata, datasetFingerprint: "not-a-sha256"))),
            SemanticMutation("inconsistent final balance", replacing(flat, summary: replacing(flat.summary, finalBalance: flat.summary.finalBalance + 1))),
            SemanticMutation("inconsistent return", replacing(flat, summary: replacing(flat.summary, totalReturnPercent: 1))),
            SemanticMutation("unsupported initial balance", replacing(flat, summary: replacing(flat.summary, initialBalance: 5))),
            SemanticMutation("negative fee total", replacing(flat, summary: replacing(flat.summary, fees: -1))),
            SemanticMutation("invalid signal counts", replacing(flat, summary: replacing(flat.summary, cancelledSignalCount: 1))),
            SemanticMutation("completed trade count mismatch", replacing(flat, summary: replacing(flat.summary, completedTradeCount: 1))),
            SemanticMutation("equity point count mismatch", replacing(flat, equityCurve: Array(flat.equityCurve.dropLast()))),
            SemanticMutation("reverse equity chronology", replacing(flat, equityCurve: Array(flat.equityCurve.reversed()))),
            SemanticMutation("nonpositive equity price", replacing(flat, equityCurve: replacingFirst(flat.equityCurve, price: -1))),
            SemanticMutation("nonpositive equity", replacing(flat, equityCurve: replacingFirst(flat.equityCurve, equity: 0))),
            SemanticMutation("unsupported trade reason", replacing(traded, trades: [replacing(trade, reason: "MANUAL" )])),
            SemanticMutation("trade reason and price mismatch", replacing(traded, trades: [replacing(trade, reason: "STOP_LOSS" )])),
            SemanticMutation("backtest end time mismatch", replacing(traded, trades: [replacing(trade, reason: "BACKTEST_END" )])),
            SemanticMutation("signal and entry time mismatch", replacing(traded, trades: [replacing(trade, entryTimestampMilliseconds: trade.signalTimestampMilliseconds)])),
            SemanticMutation("exit precedes entry", replacing(traded, trades: [replacing(trade, exitTimestampMilliseconds: trade.entryTimestampMilliseconds - 60_000)])),
            SemanticMutation("inconsistent buy fee", replacing(traded, trades: [replacing(trade, buyFee: trade.buyFee + 1)])),
            SemanticMutation("positive adverse excursion", replacing(traded, trades: [replacing(trade, maxAdverseExcursionPercent: 0.5)])),
            SemanticMutation(
                "trade and summary profit mismatch",
                replacing(
                    traded,
                    summary: replacing(
                        traded.summary,
                        finalBalance: traded.summary.finalBalance + 1,
                        netProfit: traded.summary.netProfit + 1,
                        totalReturnPercent: (traded.summary.netProfit + 1) / traded.summary.initialBalance * 100
                    )
                )
            ),
            SemanticMutation("trade and summary fee mismatch", replacing(traded, summary: replacing(traded.summary, fees: traded.summary.fees + 1)))
        ]
    }

    private static func makeFixture() throws -> (directory: URL, fileURL: URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("coinpilot-offline-replay-persistence-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return (directory, directory.appendingPathComponent("offline-replay-v1.json"))
    }

    private static func makeResult(
        seed: Int,
        source: String = "offline-replay-test-fixture",
        generatedAtOffsetSeconds: Int = 120
    ) throws -> CoinPilotOfflineReplay.Result {
        let startMilliseconds: Int64 = 1_700_000_000_000 + Int64(seed * 120_000)
        let startDate = Date(timeIntervalSince1970: Double(startMilliseconds) / 1_000)
        let generatedAt = iso8601String(startDate.addingTimeInterval(17 * 60 + TimeInterval(generatedAtOffsetSeconds)))
        let price = 100.0 + Double(seed)
        let candles = (0..<18).map { index in
            CoinPilotOfflineReplay.Candle(
                timestampMilliseconds: startMilliseconds + Int64(index * 60_000),
                open: price,
                high: price + 1,
                low: price - 1,
                close: price,
                volume: 10
            )
        }
        return try CoinPilotOfflineReplay.run(
            CoinPilotOfflineReplay.Request(
                market: "KRW-BTC",
                intervalMinutes: 1,
                source: source,
                generatedAt: generatedAt,
                candles: candles
            )
        )
    }

    private static func makeResultWithTakeProfitTrade() throws -> CoinPilotOfflineReplay.Result {
        try makeResultWithTradeScenario(.takeProfit)
    }

    private static func makeResultWithTradeScenario(_ scenario: TradeScenario) throws -> CoinPilotOfflineReplay.Result {
        let startMilliseconds: Int64 = 1_767_225_600_000
        var candles: [CoinPilotOfflineReplay.Candle] = []
        for index in 0..<26 {
            let close = Double(120 - index)
            candles.append(candle(index, startMilliseconds: startMilliseconds, close: close, open: close + 0.5))
        }
        candles.append(candle(26, startMilliseconds: startMilliseconds, close: 96, open: 95.2, high: 96.4, low: 95))

        switch scenario {
        case .stopLoss:
            candles.append(candle(27, startMilliseconds: startMilliseconds, close: 96.2, open: 96, high: 97.2, low: 95.8))
            candles.append(candle(28, startMilliseconds: startMilliseconds, close: 97, open: 96.8, high: 97.2, low: 96.8))
            candles.append(candle(29, startMilliseconds: startMilliseconds, close: 96, open: 96.8, high: 97, low: 95.5))
            candles.append(candle(30, startMilliseconds: startMilliseconds, close: 90, open: 90, high: 99, low: 89.5))
        case .takeProfit:
            candles.append(candle(27, startMilliseconds: startMilliseconds, close: 97.8, open: 96, high: 98.2, low: 95.8))
            candles.append(candle(28, startMilliseconds: startMilliseconds, close: 97.5, open: 97.8, high: 98, low: 97.2))
        case .maximumHold:
            candles.append(candle(27, startMilliseconds: startMilliseconds, close: 96, open: 96, high: 96.4, low: 95.8))
            for index in 28...57 {
                candles.append(candle(index, startMilliseconds: startMilliseconds, close: 96, open: 96, high: 96.2, low: 95.8))
            }
        case .backtestEnd:
            candles.append(candle(27, startMilliseconds: startMilliseconds, close: 96, open: 96, high: 96.4, low: 95.8))
            candles.append(candle(28, startMilliseconds: startMilliseconds, close: 96.1, open: 96, high: 96.4, low: 95.8))
        }

        guard let endTimestamp = candles.last?.timestampMilliseconds else {
            fatalError("Each trade scenario must include at least one candle.")
        }

        return try CoinPilotOfflineReplay.run(CoinPilotOfflineReplay.Request(
            market: "KRW-BTC",
            intervalMinutes: 1,
            source: "offline-replay-test-fixture",
            generatedAt: iso8601String(Date(timeIntervalSince1970: Double(endTimestamp) / 1_000)),
            candles: candles
        ))
    }

    private static func candle(
        _ index: Int,
        startMilliseconds: Int64,
        close: Double,
        open: Double? = nil,
        high: Double? = nil,
        low: Double? = nil
    ) -> CoinPilotOfflineReplay.Candle {
        let actualOpen = open ?? close
        return CoinPilotOfflineReplay.Candle(
            timestampMilliseconds: startMilliseconds + Int64(index * 60_000),
            open: actualOpen,
            high: high ?? max(actualOpen, close),
            low: low ?? min(actualOpen, close),
            close: close,
            volume: 10
        )
    }

    private static func replacingFirst(
        _ values: [CoinPilotOfflineReplay.EquityPoint],
        price: Double? = nil,
        equity: Double? = nil
    ) -> [CoinPilotOfflineReplay.EquityPoint] {
        guard let first = values.first else { return values }
        var changed = values
        changed[0] = CoinPilotOfflineReplay.EquityPoint(
            timestampMilliseconds: first.timestampMilliseconds,
            price: price ?? first.price,
            equity: equity ?? first.equity
        )
        return changed
    }

    private static func replacing(
        _ result: CoinPilotOfflineReplay.Result,
        metadata: CoinPilotOfflineReplay.Metadata? = nil,
        summary: CoinPilotOfflineReplay.Summary? = nil,
        trades: [CoinPilotOfflineReplay.Trade]? = nil,
        equityCurve: [CoinPilotOfflineReplay.EquityPoint]? = nil
    ) -> CoinPilotOfflineReplay.Result {
        CoinPilotOfflineReplay.Result(
            metadata: metadata ?? result.metadata,
            summary: summary ?? result.summary,
            trades: trades ?? result.trades,
            equityCurve: equityCurve ?? result.equityCurve
        )
    }

    private static func replacing(
        _ metadata: CoinPilotOfflineReplay.Metadata,
        simulationType: String? = nil,
        executionModel: String? = nil,
        source: String? = nil,
        generatedAt: String? = nil,
        market: String? = nil,
        intervalMinutes: Int? = nil,
        startTimestampMilliseconds: Int64? = nil,
        endTimestampMilliseconds: Int64? = nil,
        rowCount: Int? = nil,
        configVersion: String? = nil,
        engineVersion: String? = nil,
        datasetFingerprint: String? = nil
    ) -> CoinPilotOfflineReplay.Metadata {
        CoinPilotOfflineReplay.Metadata(
            simulationType: simulationType ?? metadata.simulationType,
            executionModel: executionModel ?? metadata.executionModel,
            source: source ?? metadata.source,
            generatedAt: generatedAt ?? metadata.generatedAt,
            market: market ?? metadata.market,
            intervalMinutes: intervalMinutes ?? metadata.intervalMinutes,
            startTimestampMilliseconds: startTimestampMilliseconds ?? metadata.startTimestampMilliseconds,
            endTimestampMilliseconds: endTimestampMilliseconds ?? metadata.endTimestampMilliseconds,
            rowCount: rowCount ?? metadata.rowCount,
            configVersion: configVersion ?? metadata.configVersion,
            engineVersion: engineVersion ?? metadata.engineVersion,
            datasetFingerprint: datasetFingerprint ?? metadata.datasetFingerprint
        )
    }

    private static func replacing(
        _ summary: CoinPilotOfflineReplay.Summary,
        initialBalance: Double? = nil,
        finalBalance: Double? = nil,
        netProfit: Double? = nil,
        totalReturnPercent: Double? = nil,
        fees: Double? = nil,
        signalCount: Int? = nil,
        cancelledSignalCount: Int? = nil,
        completedTradeCount: Int? = nil
    ) -> CoinPilotOfflineReplay.Summary {
        CoinPilotOfflineReplay.Summary(
            initialBalance: initialBalance ?? summary.initialBalance,
            finalBalance: finalBalance ?? summary.finalBalance,
            netProfit: netProfit ?? summary.netProfit,
            totalReturnPercent: totalReturnPercent ?? summary.totalReturnPercent,
            fees: fees ?? summary.fees,
            signalCount: signalCount ?? summary.signalCount,
            cancelledSignalCount: cancelledSignalCount ?? summary.cancelledSignalCount,
            completedTradeCount: completedTradeCount ?? summary.completedTradeCount
        )
    }

    private static func replacing(
        _ trade: CoinPilotOfflineReplay.Trade,
        signalTimestampMilliseconds: Int64? = nil,
        entryTimestampMilliseconds: Int64? = nil,
        exitTimestampMilliseconds: Int64? = nil,
        entryPrice: Double? = nil,
        exitPrice: Double? = nil,
        quantity: Double? = nil,
        investmentAmount: Double? = nil,
        buyFee: Double? = nil,
        sellFee: Double? = nil,
        reason: String? = nil,
        netProfit: Double? = nil,
        profitPercent: Double? = nil,
        maxFavorableExcursionPercent: Double? = nil,
        maxAdverseExcursionPercent: Double? = nil
    ) -> CoinPilotOfflineReplay.Trade {
        CoinPilotOfflineReplay.Trade(
            signalTimestampMilliseconds: signalTimestampMilliseconds ?? trade.signalTimestampMilliseconds,
            entryTimestampMilliseconds: entryTimestampMilliseconds ?? trade.entryTimestampMilliseconds,
            exitTimestampMilliseconds: exitTimestampMilliseconds ?? trade.exitTimestampMilliseconds,
            entryPrice: entryPrice ?? trade.entryPrice,
            exitPrice: exitPrice ?? trade.exitPrice,
            quantity: quantity ?? trade.quantity,
            investmentAmount: investmentAmount ?? trade.investmentAmount,
            buyFee: buyFee ?? trade.buyFee,
            sellFee: sellFee ?? trade.sellFee,
            reason: reason ?? trade.reason,
            netProfit: netProfit ?? trade.netProfit,
            profitPercent: profitPercent ?? trade.profitPercent,
            maxFavorableExcursionPercent: maxFavorableExcursionPercent ?? trade.maxFavorableExcursionPercent,
            maxAdverseExcursionPercent: maxAdverseExcursionPercent ?? trade.maxAdverseExcursionPercent
        )
    }

    private static func iso8601String(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func makeSessionCheckpoint(
        result: CoinPilotOfflineReplay.Result,
        nextIndex: Int,
        status: CoinPilotOfflineReplaySessionStatus
    ) -> CoinPilotOfflineReplaySessionCheckpoint {
        CoinPilotOfflineReplaySessionCheckpoint(
            datasetFingerprint: result.metadata.datasetFingerprint,
            engineVersion: result.metadata.engineVersion,
            configVersion: result.metadata.configVersion,
            market: result.metadata.market,
            intervalMinutes: result.metadata.intervalMinutes,
            candleCount: result.metadata.rowCount,
            nextCandleIndex: nextIndex,
            status: status,
            speed: .tenCandlesPerSecond
        )
    }

    private static func replacing(_ target: String, with replacement: String, in data: Data) -> Data {
        let source = String(decoding: data, as: UTF8.self)
        return Data(source.replacingOccurrences(of: target, with: replacement).utf8)
    }

    private struct EncodableArchive: Encodable {
        let schemaVersion: Int
        let results: [CoinPilotOfflineReplay.Result]
    }

    private struct SemanticMutation {
        let name: String
        let result: CoinPilotOfflineReplay.Result

        init(_ name: String, _ result: CoinPilotOfflineReplay.Result) {
            self.name = name
            self.result = result
        }
    }

    private enum TradeScenario {
        case stopLoss
        case takeProfit
        case maximumHold
        case backtestEnd
    }
}
