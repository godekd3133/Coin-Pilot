import CryptoKit
import Foundation

enum CoinPilotOfflineReplayPersistenceError: Error, Equatable, LocalizedError, Sendable {
    case storageUnavailable
    case unsupportedArchiveVersion
    case invalidArchive
    case invalidResult
    case archiveTooLarge

    var errorDescription: String? {
        switch self {
        case .storageUnavailable:
            return "이 기기에서 재생 기록을 저장할 위치를 찾지 못했습니다."
        case .unsupportedArchiveVersion:
            return "이전 재생 기록 형식을 지원하지 않습니다."
        case .invalidArchive:
            return "저장된 재생 기록을 읽을 수 없습니다."
        case .invalidResult:
            return "과거 재생 결과의 값이 올바르지 않습니다."
        case .archiveTooLarge:
            return "재생 기록이 허용된 저장 크기를 넘었습니다."
        }
    }
}

protocol CoinPilotOfflineReplayResultPersisting: Sendable {
    func load() async throws -> [CoinPilotOfflineReplay.Result]
    func save(_ result: CoinPilotOfflineReplay.Result) async throws -> [CoinPilotOfflineReplay.Result]
}

enum CoinPilotOfflineReplaySessionStatus: String, Codable, CaseIterable, Equatable, Sendable {
    case stopped
    case playing
    case paused
    case completed
}

enum CoinPilotOfflineReplayPlaybackSpeed: Int, Codable, CaseIterable, Identifiable, Equatable, Hashable, Sendable {
    case fourCandlesPerSecond = 250
    case tenCandlesPerSecond = 100
    case twentyCandlesPerSecond = 50

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .fourCandlesPerSecond: return "4개/초"
        case .tenCandlesPerSecond: return "10개/초"
        case .twentyCandlesPerSecond: return "20개/초"
        }
    }

    var sleepNanoseconds: UInt64 { UInt64(rawValue) * 1_000_000 }
}

struct CoinPilotOfflineReplaySessionCheckpoint: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let datasetFingerprint: String
    let engineVersion: String
    let configVersion: String
    let market: String
    let intervalMinutes: Int
    let candleCount: Int
    let nextCandleIndex: Int
    let status: CoinPilotOfflineReplaySessionStatus
    let speedDelayMilliseconds: Int
    let integritySHA256: String

    init(
        datasetFingerprint: String,
        engineVersion: String,
        configVersion: String,
        market: String,
        intervalMinutes: Int,
        candleCount: Int,
        nextCandleIndex: Int,
        status: CoinPilotOfflineReplaySessionStatus,
        speed: CoinPilotOfflineReplayPlaybackSpeed
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.datasetFingerprint = datasetFingerprint
        self.engineVersion = engineVersion
        self.configVersion = configVersion
        self.market = market
        self.intervalMinutes = intervalMinutes
        self.candleCount = candleCount
        self.nextCandleIndex = nextCandleIndex
        self.status = status
        speedDelayMilliseconds = speed.rawValue
        integritySHA256 = Self.checksum(for: ChecksumPayload(
            schemaVersion: schemaVersion,
            datasetFingerprint: datasetFingerprint,
            engineVersion: engineVersion,
            configVersion: configVersion,
            market: market,
            intervalMinutes: intervalMinutes,
            candleCount: candleCount,
            nextCandleIndex: nextCandleIndex,
            status: status,
            speedDelayMilliseconds: speed.rawValue
        ))
    }

    var playbackSpeed: CoinPilotOfflineReplayPlaybackSpeed? {
        CoinPilotOfflineReplayPlaybackSpeed(rawValue: speedDelayMilliseconds)
    }

    var isWellFormed: Bool {
        guard schemaVersion == Self.currentSchemaVersion,
              datasetFingerprint.utf8.count == 64,
              datasetFingerprint.utf8.allSatisfy({
                  (48...57).contains($0) || (97...102).contains($0)
              }),
              engineVersion == CoinPilotOfflineReplay.engineVersion,
              configVersion == CoinPilotOfflineReplay.configurationVersion,
              Self.isValidMarket(market),
              [1, 5, 15].contains(intervalMinutes),
              candleCount >= CoinPilotOfflineReplay.minimumCandleCount,
              candleCount <= 20_000,
              (0...candleCount).contains(nextCandleIndex),
              playbackSpeed != nil else {
            return false
        }

        switch status {
        case .stopped:
            guard nextCandleIndex == 0 else { return false }
        case .playing, .paused:
            guard nextCandleIndex < candleCount else { return false }
        case .completed:
            guard nextCandleIndex == candleCount else { return false }
        }

        return integritySHA256 == Self.checksum(for: checksumPayload)
    }

    func matches(_ metadata: CoinPilotOfflineReplay.Metadata, candleCount: Int) -> Bool {
        isWellFormed &&
            datasetFingerprint == metadata.datasetFingerprint &&
            engineVersion == metadata.engineVersion &&
            configVersion == metadata.configVersion &&
            market == metadata.market &&
            intervalMinutes == metadata.intervalMinutes &&
            self.candleCount == candleCount &&
            metadata.rowCount == candleCount
    }

    private var checksumPayload: ChecksumPayload {
        ChecksumPayload(
            schemaVersion: schemaVersion,
            datasetFingerprint: datasetFingerprint,
            engineVersion: engineVersion,
            configVersion: configVersion,
            market: market,
            intervalMinutes: intervalMinutes,
            candleCount: candleCount,
            nextCandleIndex: nextCandleIndex,
            status: status,
            speedDelayMilliseconds: speedDelayMilliseconds
        )
    }

    private static func checksum(for payload: ChecksumPayload) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(payload) else { return "" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func isValidMarket(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (6...19).contains(bytes.count), bytes[0..<4].elementsEqual(Array("KRW-".utf8)) else {
            return false
        }
        return bytes[4...].allSatisfy { (65...90).contains($0) || (48...57).contains($0) }
    }

    private struct ChecksumPayload: Codable, Sendable {
        let schemaVersion: Int
        let datasetFingerprint: String
        let engineVersion: String
        let configVersion: String
        let market: String
        let intervalMinutes: Int
        let candleCount: Int
        let nextCandleIndex: Int
        let status: CoinPilotOfflineReplaySessionStatus
        let speedDelayMilliseconds: Int
    }
}

enum CoinPilotOfflineReplaySessionCheckpointError: Error, Equatable, LocalizedError, Sendable {
    case storageUnavailable
    case unsupportedVersion
    case invalidCheckpoint
    case checkpointTooLarge

    var errorDescription: String? {
        switch self {
        case .storageUnavailable:
            return "이 기기에서 재생 상태를 저장할 위치를 찾지 못했습니다."
        case .unsupportedVersion:
            return "저장된 재생 상태 형식이 현재 앱과 호환되지 않습니다."
        case .invalidCheckpoint:
            return "저장된 재생 상태가 손상되었거나 올바르지 않습니다."
        case .checkpointTooLarge:
            return "저장된 재생 상태가 허용 크기를 넘었습니다."
        }
    }
}

protocol CoinPilotOfflineReplaySessionPersisting: Sendable {
    func loadCheckpoint() async throws -> CoinPilotOfflineReplaySessionCheckpoint?
    func saveCheckpoint(_ checkpoint: CoinPilotOfflineReplaySessionCheckpoint) async throws
    func clearCheckpoint() async throws
}

actor CoinPilotOfflineReplaySessionCheckpointStore: CoinPilotOfflineReplaySessionPersisting {
    static let maximumCheckpointBytes = 16 * 1_024
    static let shared = CoinPilotOfflineReplaySessionCheckpointStore()

    private let fileURL: URL?
    private let fileManager: FileManager

    init(fileURL: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.fileURL = fileURL ?? Self.defaultFileURL(fileManager: fileManager)
    }

    func loadCheckpoint() async throws -> CoinPilotOfflineReplaySessionCheckpoint? {
        guard let fileURL else { throw CoinPilotOfflineReplaySessionCheckpointError.storageUnavailable }
        guard fileManager.fileExists(atPath: fileURL.path) else { return nil }

        let attributes = try fileManager.attributesOfItem(atPath: fileURL.path)
        guard let size = attributes[.size] as? NSNumber,
              size.intValue <= Self.maximumCheckpointBytes else {
            throw CoinPilotOfflineReplaySessionCheckpointError.checkpointTooLarge
        }
        let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        guard data.count <= Self.maximumCheckpointBytes else {
            throw CoinPilotOfflineReplaySessionCheckpointError.checkpointTooLarge
        }

        let checkpoint: CoinPilotOfflineReplaySessionCheckpoint
        do {
            checkpoint = try JSONDecoder().decode(CoinPilotOfflineReplaySessionCheckpoint.self, from: data)
        } catch {
            throw CoinPilotOfflineReplaySessionCheckpointError.invalidCheckpoint
        }
        guard checkpoint.schemaVersion == CoinPilotOfflineReplaySessionCheckpoint.currentSchemaVersion else {
            throw CoinPilotOfflineReplaySessionCheckpointError.unsupportedVersion
        }
        guard checkpoint.isWellFormed else {
            throw CoinPilotOfflineReplaySessionCheckpointError.invalidCheckpoint
        }
        return checkpoint
    }

    func saveCheckpoint(_ checkpoint: CoinPilotOfflineReplaySessionCheckpoint) async throws {
        guard checkpoint.isWellFormed else {
            throw CoinPilotOfflineReplaySessionCheckpointError.invalidCheckpoint
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(checkpoint)
        guard data.count <= Self.maximumCheckpointBytes else {
            throw CoinPilotOfflineReplaySessionCheckpointError.checkpointTooLarge
        }
        guard let fileURL else { throw CoinPilotOfflineReplaySessionCheckpointError.storageUnavailable }
        try fileManager.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: .atomic)
    }

    func clearCheckpoint() async throws {
        guard let fileURL else { throw CoinPilotOfflineReplaySessionCheckpointError.storageUnavailable }
        if fileManager.fileExists(atPath: fileURL.path) {
            try fileManager.removeItem(at: fileURL)
        }
    }

    private static func defaultFileURL(fileManager: FileManager) -> URL? {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("CoinPilot", isDirectory: true)
            .appendingPathComponent("offline-replay-session-v1.json", isDirectory: false)
    }
}

actor CoinPilotOfflineReplayFileStore: CoinPilotOfflineReplayResultPersisting {
    private struct Identity: Hashable {
        let datasetFingerprint: String
        let configVersion: String
        let engineVersion: String
        let market: String
        let intervalMinutes: Int

        init(_ result: CoinPilotOfflineReplay.Result) {
            let metadata = result.metadata
            datasetFingerprint = metadata.datasetFingerprint
            configVersion = metadata.configVersion
            engineVersion = metadata.engineVersion
            market = metadata.market
            intervalMinutes = metadata.intervalMinutes
        }
    }

    private struct Archive: Codable, Sendable {
        let schemaVersion: Int
        let results: [CoinPilotOfflineReplay.Result]
    }

    static let archiveSchemaVersion = 1
    static let maximumStoredResults = 5
    static let maximumArchiveBytes = 20 * 1_024 * 1_024
    static let shared = CoinPilotOfflineReplayFileStore()

    private let fileURL: URL?
    private let fileManager: FileManager

    init(fileURL: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.fileURL = fileURL ?? Self.defaultFileURL(fileManager: fileManager)
    }

    func load() async throws -> [CoinPilotOfflineReplay.Result] {
        try readArchive().results
    }

    func save(_ result: CoinPilotOfflineReplay.Result) async throws -> [CoinPilotOfflineReplay.Result] {
        guard Self.isValidResult(result) else {
            throw CoinPilotOfflineReplayPersistenceError.invalidResult
        }
        var archive = try readArchive()
        let identity = Identity(result)
        var results = archive.results.filter { Identity($0) != identity }
        results.insert(result, at: 0)
        results = Array(results.prefix(Self.maximumStoredResults))
        archive = Archive(schemaVersion: Self.archiveSchemaVersion, results: results)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(archive)
        guard data.count <= Self.maximumArchiveBytes else {
            throw CoinPilotOfflineReplayPersistenceError.archiveTooLarge
        }

        guard let fileURL else { throw CoinPilotOfflineReplayPersistenceError.storageUnavailable }
        try fileManager.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: .atomic)
        return results
    }

    private func readArchive() throws -> Archive {
        guard let fileURL else { throw CoinPilotOfflineReplayPersistenceError.storageUnavailable }
        guard fileManager.fileExists(atPath: fileURL.path) else {
            return Archive(schemaVersion: Self.archiveSchemaVersion, results: [])
        }

        let attributes = try fileManager.attributesOfItem(atPath: fileURL.path)
        guard let size = attributes[.size] as? NSNumber,
              size.intValue <= Self.maximumArchiveBytes else {
            throw CoinPilotOfflineReplayPersistenceError.archiveTooLarge
        }
        let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        guard data.count <= Self.maximumArchiveBytes else {
            throw CoinPilotOfflineReplayPersistenceError.archiveTooLarge
        }

        let archive: Archive
        do {
            archive = try JSONDecoder().decode(Archive.self, from: data)
        } catch {
            throw CoinPilotOfflineReplayPersistenceError.invalidArchive
        }
        guard archive.schemaVersion == Self.archiveSchemaVersion else {
            throw CoinPilotOfflineReplayPersistenceError.unsupportedArchiveVersion
        }
        guard archive.results.count <= Self.maximumStoredResults,
              Set(archive.results.map { Identity($0) }).count == archive.results.count else {
            throw CoinPilotOfflineReplayPersistenceError.invalidArchive
        }
        guard archive.results.allSatisfy(Self.isValidResult) else {
            throw CoinPilotOfflineReplayPersistenceError.invalidArchive
        }
        return archive
    }

    private static func isValidResult(_ result: CoinPilotOfflineReplay.Result) -> Bool {
        let metadata = result.metadata
        let summary = result.summary
        let minimumHistory = CoinPilotOfflineReplay.minimumCandleCount - 2

        guard metadata.simulationType == CoinPilotOfflineReplay.simulationType,
              metadata.executionModel == CoinPilotOfflineReplay.executionModel,
              metadata.configVersion == CoinPilotOfflineReplay.configurationVersion,
              metadata.engineVersion == CoinPilotOfflineReplay.engineVersion,
              isValidSource(metadata.source),
              isValidMarket(metadata.market),
              [1, 5, 15].contains(metadata.intervalMinutes),
              metadata.intervalMinutes <= CoinPilotOfflineReplay.maximumHoldMinutes,
              metadata.startTimestampMilliseconds > 0,
              metadata.endTimestampMilliseconds > metadata.startTimestampMilliseconds,
              (CoinPilotOfflineReplay.minimumCandleCount...20_000).contains(metadata.rowCount),
              isValidFingerprintShape(metadata.datasetFingerprint),
              let generatedAtMilliseconds = utcMilliseconds(from: metadata.generatedAt),
              generatedAtMilliseconds >= metadata.endTimestampMilliseconds else {
            return false
        }

        let intervalMilliseconds = Double(metadata.intervalMinutes) * 60_000.0
        let maximumDatasetSpan = Double(metadata.rowCount - 1) * intervalMilliseconds * 1.5
        guard Double(metadata.endTimestampMilliseconds - metadata.startTimestampMilliseconds) <= maximumDatasetSpan + 1 else {
            return false
        }

        let expectedEquityPointCount = metadata.rowCount - minimumHistory
        guard result.equityCurve.count == expectedEquityPointCount,
              result.equityCurve.count >= 2 else {
            return false
        }

        var equityIndexByTimestamp: [Int64: Int] = [:]
        var previousEquityPoint: CoinPilotOfflineReplay.EquityPoint?
        for (index, point) in result.equityCurve.enumerated() {
            guard point.timestampMilliseconds > metadata.startTimestampMilliseconds,
                  point.timestampMilliseconds <= metadata.endTimestampMilliseconds,
                  point.price.isFinite, point.price > 0,
                  point.equity.isFinite, point.equity > 0,
                  equityIndexByTimestamp.updateValue(index, forKey: point.timestampMilliseconds) == nil else {
                return false
            }
            if let previousEquityPoint {
                let deltaMilliseconds = Double(point.timestampMilliseconds - previousEquityPoint.timestampMilliseconds)
                guard deltaMilliseconds > 0,
                      deltaMilliseconds <= intervalMilliseconds * 1.5 + 1 else {
                    return false
                }
            }
            previousEquityPoint = point
        }
        guard result.equityCurve.last?.timestampMilliseconds == metadata.endTimestampMilliseconds else {
            return false
        }

        let tradeCount = result.trades.count
        guard summary.initialBalance == 1_000_000.0,
              summary.finalBalance.isFinite, summary.finalBalance > 0,
              summary.netProfit.isFinite,
              summary.totalReturnPercent.isFinite,
              summary.fees.isFinite, summary.fees >= 0,
              summary.signalCount >= 0,
              summary.cancelledSignalCount >= 0,
              summary.cancelledSignalCount <= summary.signalCount,
              summary.signalCount <= result.equityCurve.count - 1,
              tradeCount <= summary.signalCount - summary.cancelledSignalCount,
              summary.completedTradeCount == tradeCount,
              approximatelyEqual(summary.finalBalance, summary.initialBalance + summary.netProfit),
              approximatelyEqual(summary.totalReturnPercent, summary.netProfit / summary.initialBalance * 100.0) else {
            return false
        }

        var totalTradeProfit = 0.0
        var totalTradeFees = 0.0
        var previousTradeExit: Int64?
        for trade in result.trades {
            guard [trade.entryPrice, trade.exitPrice, trade.quantity, trade.investmentAmount,
                   trade.buyFee, trade.sellFee, trade.netProfit, trade.profitPercent,
                   trade.maxFavorableExcursionPercent, trade.maxAdverseExcursionPercent].allSatisfy(\.isFinite),
                  trade.signalTimestampMilliseconds > metadata.startTimestampMilliseconds,
                  trade.signalTimestampMilliseconds < trade.entryTimestampMilliseconds,
                  trade.entryTimestampMilliseconds <= trade.exitTimestampMilliseconds,
                  trade.exitTimestampMilliseconds <= metadata.endTimestampMilliseconds,
                  trade.entryPrice > 0, trade.exitPrice > 0,
                  trade.quantity > 0, trade.investmentAmount >= 5_000,
                  trade.buyFee > 0, trade.buyFee < trade.investmentAmount,
                  trade.sellFee >= 0, trade.sellFee <= trade.quantity * trade.exitPrice,
                  trade.maxFavorableExcursionPercent >= 0,
                  trade.maxAdverseExcursionPercent <= 0,
                  let signalIndex = equityIndexByTimestamp[trade.signalTimestampMilliseconds],
                  let entryIndex = equityIndexByTimestamp[trade.entryTimestampMilliseconds],
                  let exitIndex = equityIndexByTimestamp[trade.exitTimestampMilliseconds],
                  entryIndex == signalIndex + 1,
                  exitIndex >= entryIndex,
                  previousTradeExit.map({ trade.signalTimestampMilliseconds > $0 }) ?? true,
                  tradeReasonIsConsistent(
                    trade,
                    endTimestampMilliseconds: metadata.endTimestampMilliseconds,
                    finalCandleClose: result.equityCurve[result.equityCurve.count - 1].price
                  ),
                  approximatelyEqual(trade.buyFee, trade.investmentAmount * CoinPilotOfflineReplay.tradingFee),
                  approximatelyEqual(trade.quantity, (trade.investmentAmount - trade.buyFee) / trade.entryPrice),
                  approximatelyEqual(
                    trade.sellFee,
                    trade.quantity * trade.exitPrice * CoinPilotOfflineReplay.tradingFee
                  ),
                  approximatelyEqual(
                    trade.netProfit,
                    trade.quantity * trade.exitPrice - trade.sellFee - trade.investmentAmount
                  ),
                  approximatelyEqual(trade.profitPercent, trade.netProfit / trade.investmentAmount * 100.0) else {
                return false
            }
            totalTradeProfit += trade.netProfit
            totalTradeFees += trade.buyFee + trade.sellFee
            previousTradeExit = trade.exitTimestampMilliseconds
        }

        return totalTradeProfit.isFinite && totalTradeFees.isFinite &&
            approximatelyEqual(summary.netProfit, totalTradeProfit) &&
            approximatelyEqual(summary.fees, totalTradeFees)
    }

    private static func isValidSource(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return !bytes.isEmpty && bytes.count <= 128
    }

    private static func isValidMarket(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (6...19).contains(bytes.count),
              bytes[0..<4].elementsEqual(Array("KRW-".utf8)) else {
            return false
        }
        return bytes[4...].allSatisfy { byte in
            (65...90).contains(byte) || (48...57).contains(byte)
        }
    }

    private static func isValidFingerprintShape(_ value: String) -> Bool {
        // Source candles are not stored in this archive, so the digest cannot be recomputed here.
        let bytes = Array(value.utf8)
        return bytes.count == 64 && bytes.allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
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
        let milliseconds = date.timeIntervalSince1970 * 1_000
        guard milliseconds.isFinite,
              milliseconds >= Double(Int64.min), milliseconds <= Double(Int64.max) else {
            return nil
        }
        return Int64(milliseconds.rounded(.towardZero))
    }

    private static func tradeReasonIsConsistent(
        _ trade: CoinPilotOfflineReplay.Trade,
        endTimestampMilliseconds: Int64,
        finalCandleClose: Double
    ) -> Bool {
        switch trade.reason {
        case "STOP_LOSS":
            return trade.exitPrice < trade.entryPrice
        case "TAKE_PROFIT":
            return trade.exitPrice > trade.entryPrice
        case "MAX_HOLD_TIME":
            return trade.exitTimestampMilliseconds - trade.entryTimestampMilliseconds >=
                Int64(CoinPilotOfflineReplay.maximumHoldMinutes) * 60_000
        case "BACKTEST_END":
            return trade.exitTimestampMilliseconds == endTimestampMilliseconds &&
                approximatelyEqual(
                    trade.exitPrice,
                    finalCandleClose * (1.0 - CoinPilotOfflineReplay.adverseSlippage)
                )
        default:
            return false
        }
    }

    private static func approximatelyEqual(_ lhs: Double, _ rhs: Double) -> Bool {
        guard lhs.isFinite, rhs.isFinite else { return false }
        let scale = max(max(abs(lhs), abs(rhs)), 1.0)
        return abs(lhs - rhs) <= max(1e-7, scale * 1e-10)
    }

    private static func defaultFileURL(fileManager: FileManager) -> URL? {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("CoinPilot", isDirectory: true)
            .appendingPathComponent("offline-replay-v1.json", isDirectory: false)
    }
}
