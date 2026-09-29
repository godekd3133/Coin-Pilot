import Foundation
import CryptoKit

enum CoinPilotBundledMarketDataError: Error, Equatable, LocalizedError, Sendable {
    case missingResource
    case missingIntegrityManifest
    case fileTooLarge
    case malformed
    case malformedIntegrityManifest
    case integrityMismatch
    case unsupportedSchema
    case invalidValue

    var errorDescription: String? {
        switch self {
        case .missingResource:
            return "앱에 공개 시장 자료가 포함되지 않았습니다."
        case .missingIntegrityManifest:
            return "앱에 공개 시장 자료 검증 파일이 포함되지 않았습니다."
        case .fileTooLarge:
            return "공개 시장 자료가 허용 크기보다 큽니다."
        case .malformed:
            return "공개 시장 자료를 읽을 수 없습니다."
        case .malformedIntegrityManifest:
            return "공개 시장 자료 검증 파일을 읽을 수 없습니다."
        case .integrityMismatch:
            return "공개 시장 자료가 패키징된 검증 값과 일치하지 않습니다."
        case .unsupportedSchema:
            return "지원하지 않는 공개 시장 자료 버전입니다."
        case .invalidValue:
            return "공개 시장 자료에 허용되지 않은 값이 있습니다."
        }
    }
}

struct CoinPilotBundledMarketData: Decodable, Equatable, Sendable {
    static let maximumFileSizeBytes = 50 * 1_024 * 1_024
    static let supportedSource = "upbit-public-market-api"

    let schemaVersion: Int
    let source: String
    let generatedAt: String
    let markets: [Market]

    struct Market: Decodable, Equatable, Identifiable, Sendable {
        let market: String
        let candles: [Candle]

        var id: String { market }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case market
            case candles
        }

        init(from decoder: Decoder) throws {
            try CoinPilotBundledMarketData.rejectUnknownKeys(in: decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let container = try decoder.container(keyedBy: CodingKeys.self)
            market = try container.decode(String.self, forKey: .market)
            candles = try container.decode([Candle].self, forKey: .candles)
            guard market.range(of: "^KRW-[A-Z0-9]{2,15}$", options: .regularExpression) != nil,
                  !candles.isEmpty,
                  candles.count <= 20_000 else {
                throw CoinPilotBundledMarketDataError.invalidValue
            }

            var previousByInterval: [Int: Date] = [:]
            var seen: Set<String> = []
            for candle in candles {
                let key = "\(candle.intervalMinutes)|\(candle.timestamp)"
                guard seen.insert(key).inserted,
                      let timestamp = CoinPilotBundledMarketData.utcDate(from: candle.timestamp),
                      previousByInterval[candle.intervalMinutes].map({ timestamp > $0 }) ?? true else {
                    throw CoinPilotBundledMarketDataError.invalidValue
                }
                previousByInterval[candle.intervalMinutes] = timestamp
            }
        }
    }

    struct Candle: Decodable, Equatable, Identifiable, Sendable {
        let intervalMinutes: Int
        let timestamp: String
        let open: Double
        let high: Double
        let low: Double
        let close: Double
        let volume: Double

        var id: String { "\(intervalMinutes)-\(timestamp)" }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case intervalMinutes
            case timestamp
            case open
            case high
            case low
            case close
            case volume
        }

        init(from decoder: Decoder) throws {
            try CoinPilotBundledMarketData.rejectUnknownKeys(in: decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let container = try decoder.container(keyedBy: CodingKeys.self)
            intervalMinutes = try container.decode(Int.self, forKey: .intervalMinutes)
            timestamp = try container.decode(String.self, forKey: .timestamp)
            open = try container.decode(Double.self, forKey: .open)
            high = try container.decode(Double.self, forKey: .high)
            low = try container.decode(Double.self, forKey: .low)
            close = try container.decode(Double.self, forKey: .close)
            volume = try container.decode(Double.self, forKey: .volume)

            guard [1, 5, 15, 60].contains(intervalMinutes),
                  CoinPilotBundledMarketData.utcDate(from: timestamp) != nil,
                  [open, high, low, close, volume].allSatisfy({ $0.isFinite }),
                  open > 0,
                  high > 0,
                  low > 0,
                  close > 0,
                  volume >= 0,
                  high >= max(open, close),
                  low <= min(open, close),
                  low <= high else {
                throw CoinPilotBundledMarketDataError.invalidValue
            }
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion
        case source
        case generatedAt
        case markets
    }

    init(from decoder: Decoder) throws {
        try Self.rejectUnknownKeys(in: decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        source = try container.decode(String.self, forKey: .source)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        markets = try container.decode([Market].self, forKey: .markets)

        guard schemaVersion == 1 else { throw CoinPilotBundledMarketDataError.unsupportedSchema }
        guard source == Self.supportedSource else { throw CoinPilotBundledMarketDataError.unsupportedSchema }
        guard let generatedAtDate = Self.utcDate(from: generatedAt),
              !markets.isEmpty,
              markets.count <= 500,
              Set(markets.map(\.market)).count == markets.count else {
            throw CoinPilotBundledMarketDataError.invalidValue
        }
        let candleTimesWithinPack = markets.allSatisfy { market in
            market.candles.allSatisfy { candle in
                guard let candleDate = Self.utcDate(from: candle.timestamp) else { return false }
                return candleDate <= generatedAtDate
            }
        }
        guard candleTimesWithinPack else { throw CoinPilotBundledMarketDataError.invalidValue }
    }

    static func decode(data: Data, maximumBytes: Int = maximumFileSizeBytes) throws -> CoinPilotBundledMarketData {
        guard maximumBytes >= 0, data.count <= maximumBytes else {
            throw CoinPilotBundledMarketDataError.fileTooLarge
        }
        do {
            return try JSONDecoder().decode(CoinPilotBundledMarketData.self, from: data)
        } catch let error as CoinPilotBundledMarketDataError {
            throw error
        } catch {
            throw CoinPilotBundledMarketDataError.malformed
        }
    }

    static func decode(data: Data, digestManifest: Data?) throws -> CoinPilotBundledMarketData {
        guard let digestManifest else {
            throw CoinPilotBundledMarketDataError.missingIntegrityManifest
        }
        guard data.count <= maximumFileSizeBytes else {
            throw CoinPilotBundledMarketDataError.fileTooLarge
        }
        guard digestManifest.count == 64,
              digestManifest.allSatisfy({
                  (48...57).contains($0) || (97...102).contains($0)
              }) else {
            throw CoinPilotBundledMarketDataError.malformedIntegrityManifest
        }

        let hexDigits = Array("0123456789abcdef".utf8)
        var actualDigestBytes: [UInt8] = []
        actualDigestBytes.reserveCapacity(64)
        for byte in SHA256.hash(data: data) {
            actualDigestBytes.append(hexDigits[Int(byte >> 4)])
            actualDigestBytes.append(hexDigits[Int(byte & 0x0f)])
        }
        guard digestManifest.elementsEqual(actualDigestBytes) else {
            throw CoinPilotBundledMarketDataError.integrityMismatch
        }
        return try decode(data: data)
    }

    static func utcDate(from value: String) -> Date? {
        let bytes = Array(value.utf8)
        guard (20...30).contains(bytes.count),
              bytes[4] == 45,
              bytes[7] == 45,
              bytes[10] == 84,
              bytes[13] == 58,
              bytes[16] == 58,
              bytes.last == 90 else { return nil }

        let year = integer(from: bytes, range: 0..<4)
        let month = integer(from: bytes, range: 5..<7)
        let day = integer(from: bytes, range: 8..<10)
        let hour = integer(from: bytes, range: 11..<13)
        let minute = integer(from: bytes, range: 14..<16)
        let second = integer(from: bytes, range: 17..<19)
        guard let year, year > 0,
              let month, (1...12).contains(month),
              let day,
              let hour, (0...23).contains(hour),
              let minute, (0...59).contains(minute),
              let second, (0...59).contains(second) else { return nil }

        let isLeapYear = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let daysPerMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard day > 0, day <= daysPerMonth[month - 1] else { return nil }

        var fractionalNanoseconds: Int64 = 0
        if bytes.count == 20 {
            guard bytes[19] == 90 else { return nil }
        } else {
            guard bytes[19] == 46,
                  (22...30).contains(bytes.count) else { return nil }
            let fractionRange = 20..<(bytes.count - 1)
            guard (1...9).contains(fractionRange.count) else { return nil }
            for index in fractionRange {
                let digit = bytes[index]
                guard (48...57).contains(digit) else { return nil }
                fractionalNanoseconds = fractionalNanoseconds * 10 + Int64(digit - 48)
            }
            for _ in fractionRange.count..<9 { fractionalNanoseconds *= 10 }
        }

        let adjustedYear = year - (month <= 2 ? 1 : 0)
        let era = adjustedYear / 400
        let yearOfEra = adjustedYear - era * 400
        let adjustedMonth = month + (month > 2 ? -3 : 9)
        let dayOfYear = (153 * adjustedMonth + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        let daysSinceEpoch = era * 146_097 + dayOfEra - 719_468
        let wholeSeconds = Int64(daysSinceEpoch) * 86_400 + Int64(hour * 3_600 + minute * 60 + second)
        let interval = Double(wholeSeconds) + Double(fractionalNanoseconds) / 1_000_000_000
        return Date(timeIntervalSince1970: interval)
    }

    private static func integer(from bytes: [UInt8], range: Range<Int>) -> Int? {
        var value = 0
        for index in range {
            let digit = bytes[index]
            guard (48...57).contains(digit) else { return nil }
            value = value * 10 + Int(digit - 48)
        }
        return value
    }

    fileprivate static func rejectUnknownKeys(in decoder: Decoder, allowed: Set<String>) throws {
        let container = try decoder.container(keyedBy: CoinPilotAnyCodingKey.self)
        let actual = Set(container.allKeys.map(\.stringValue))
        guard actual.isSubset(of: allowed) else {
            throw CoinPilotBundledMarketDataError.malformed
        }
    }
}

private struct CoinPilotAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

protocol CoinPilotBundledMarketDataLoading: Sendable {
    func load() async -> Result<CoinPilotBundledMarketData, CoinPilotBundledMarketDataError>
}

struct CoinPilotBundledMarketDataSource: CoinPilotBundledMarketDataLoading, Sendable {
    private enum Backing: Sendable {
        case data(Data)
        case file(URL, URL)
        case failure(CoinPilotBundledMarketDataError)
    }

    private let backing: Backing

    init(data: Data) {
        backing = .data(data)
    }

    init(bundle: Bundle = .main) {
        guard let url = bundle.url(forResource: "CoinPilotBundledLocalMarketData", withExtension: "json") else {
            backing = .failure(.missingResource)
            return
        }
        guard let digestURL = bundle.url(forResource: "CoinPilotBundledLocalMarketData", withExtension: "sha256") else {
            backing = .failure(.missingIntegrityManifest)
            return
        }
        backing = .file(url, digestURL)
    }

    func load() async -> Result<CoinPilotBundledMarketData, CoinPilotBundledMarketDataError> {
        let backing = self.backing
        return await Task.detached(priority: .userInitiated) {
            Self.loadSynchronously(backing)
        }.value
    }

    private static func loadSynchronously(_ backing: Backing) -> Result<CoinPilotBundledMarketData, CoinPilotBundledMarketDataError> {
        do {
            switch backing {
            case .data(let suppliedData):
                return .success(try CoinPilotBundledMarketData.decode(data: suppliedData))
            case .file(let url, let digestURL):
                let values = try url.resourceValues(forKeys: [.fileSizeKey])
                guard let fileSize = values.fileSize else {
                    throw CoinPilotBundledMarketDataError.malformed
                }
                guard fileSize <= CoinPilotBundledMarketData.maximumFileSizeBytes else {
                    throw CoinPilotBundledMarketDataError.fileTooLarge
                }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                let digestValues = try digestURL.resourceValues(forKeys: [.fileSizeKey])
                guard let digestSize = digestValues.fileSize, digestSize == 64 else {
                    throw CoinPilotBundledMarketDataError.malformedIntegrityManifest
                }
                let digestManifest = try Data(contentsOf: digestURL, options: .mappedIfSafe)
                return .success(try CoinPilotBundledMarketData.decode(data: data, digestManifest: digestManifest))
            case .failure(let error):
                return .failure(error)
            }
        } catch let error as CoinPilotBundledMarketDataError {
            return .failure(error)
        } catch {
            return .failure(.malformed)
        }
    }
}
