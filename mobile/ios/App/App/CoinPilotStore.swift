import Combine
import CoreFoundation
import Foundation
import Security

enum CoinPilotScreenPhase: Equatable {
    case connecting
    case setup
    case login
    case dashboard
}

enum CoinPilotResourceState: Equatable {
    case notRequested
    case loading
    case current(at: Date)
    case stale(lastSuccessfulAt: Date)
    case unavailable
}

enum CoinPilotHistoryPeriod: String, CaseIterable, Identifiable {
    case day = "24h"
    case week = "7d"
    case month = "30d"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .day: return "24시간"
        case .week: return "7일"
        case .month: return "30일"
        }
    }
}

struct CoinPilotHTTPResponse: Sendable {
    let statusCode: Int
    let headers: [String: String]
    let body: Data
}

protocol CoinPilotAPIProviding {
    func authenticationStatus(at serverURL: URL) async throws -> CoinPilotHTTPResponse
    func login(token: String, at serverURL: URL) async throws -> CoinPilotHTTPResponse
    func read(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse
}

protocol CoinPilotTokenProviding {
    func token(for serverURL: URL) -> String?
    func save(_ token: String, for serverURL: URL) -> Bool
    func delete(for serverURL: URL)
}

enum CoinPilotAPIError: Error, Sendable {
    case invalidAddress
    case connection
    case invalidResponse
    case unauthorized
    case forbidden
    case rateLimited
    case server
    case invalidData
    case keychain

    var message: String {
        switch self {
        case .invalidAddress:
            return "서버 주소를 확인해 주세요."
        case .connection:
            return "서버에 연결하지 못했습니다. 인터넷 연결과 서버 주소를 확인해 주세요."
        case .invalidResponse:
            return "서버 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요."
        case .unauthorized:
            return "서버 토큰을 확인해 주세요."
        case .forbidden:
            return "이 요청을 처리할 권한이 없습니다."
        case .rateLimited:
            return "로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요."
        case .server:
            return "서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."
        case .invalidData:
            return "서버에서 받은 정보를 확인할 수 없습니다."
        case .keychain:
            return "서버 토큰을 이 기기에 저장하지 못했습니다. 다시 시도해 주세요."
        }
    }

    static func forStatusCode(_ statusCode: Int) -> CoinPilotAPIError {
        switch statusCode {
        case 401: return .unauthorized
        case 403: return .forbidden
        case 429: return .rateLimited
        case 500...599: return .server
        default: return .invalidResponse
        }
    }
}

final class CoinPilotAPIClient: CoinPilotAPIProviding, @unchecked Sendable {
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
    }

    func authenticationStatus(at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        try await send(path: "/api/auth/status", method: "GET", at: serverURL, token: nil, body: nil)
    }

    func login(token: String, at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        try await send(path: "/api/auth/login", method: "POST", at: serverURL, token: nil, body: ["token": token])
    }

    func read(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse {
        guard Self.isAllowedReadPath(path) else { throw CoinPilotAPIError.forbidden }
        return try await send(path: path, method: "GET", at: serverURL, token: token, body: nil)
    }

    private func send(
        path: String,
        method: String,
        at serverURL: URL,
        token: String?,
        body: [String: String]?
    ) async throws -> CoinPilotHTTPResponse {
        guard let url = Self.requestURL(path: path, serverURL: serverURL) else {
            throw CoinPilotAPIError.invalidAddress
        }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw CoinPilotAPIError.invalidResponse }
            let headers = http.allHeaderFields.reduce(into: [String: String]()) { result, item in
                result[String(describing: item.key)] = String(describing: item.value)
            }
            return CoinPilotHTTPResponse(statusCode: http.statusCode, headers: headers, body: data)
        } catch let error as CoinPilotAPIError {
            throw error
        } catch {
            throw CoinPilotAPIError.connection
        }
    }

    private static func requestURL(path: String, serverURL: URL) -> URL? {
        guard path.hasPrefix("/api/"),
              let requested = URLComponents(string: "https://coinpilot.invalid\(path)"),
              requested.host == "coinpilot.invalid",
              requested.fragment == nil,
              var server = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        server.path = requested.path
        server.query = requested.query
        server.fragment = nil
        return server.url
    }

    static func isAllowedReadPath(_ path: String) -> Bool {
        guard let components = URLComponents(string: "https://coinpilot.invalid\(path)"),
              components.host == "coinpilot.invalid",
              components.fragment == nil else {
            return false
        }

        let queryItems = components.queryItems ?? []
        switch components.path {
        case "/api/status", "/api/account", "/api/cumulative-pnl", "/api/today-summary", "/api/market/prices", "/api/paper-validation/summary":
            return queryItems.isEmpty
        case "/api/portfolio/history":
            guard queryItems.count == 1, queryItems.first?.name == "period",
                  let value = queryItems.first?.value else { return false }
            return CoinPilotHistoryPeriod.allCases.contains(where: { $0.rawValue == value })
        case "/api/trades":
            guard queryItems.count == 1, queryItems.first?.name == "limit",
                  let value = Int(queryItems.first?.value ?? ""), (1...50).contains(value) else {
                return false
            }
            return true
        default:
            return false
        }
    }
}

private final class CoinPilotTokenStore: CoinPilotTokenProviding {
    private let service = Bundle.main.bundleIdentifier ?? "com.godekd3133.coinpilot"

    func token(for serverURL: URL) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverURL.absoluteString,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ token: String, for serverURL: URL) -> Bool {
        delete(for: serverURL)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverURL.absoluteString,
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    func delete(for serverURL: URL) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverURL.absoluteString
        ]
        SecItemDelete(query as CFDictionary)
    }
}

#if targetEnvironment(simulator) || COINPILOT_TEST_SIMULATOR_TOKEN_STORE
/// Ad-hoc simulator builds lack the physical app's Keychain entitlement. Keep
/// simulator test tokens in process memory only; never fall back to a file or
/// UserDefaults. Physical iOS builds continue to use Keychain above.
final class CoinPilotSimulatorTokenStore: CoinPilotTokenProviding {
    private var values: [String: String] = [:]

    func token(for serverURL: URL) -> String? {
        values[serverURL.absoluteString]
    }

    func save(_ token: String, for serverURL: URL) -> Bool {
        values[serverURL.absoluteString] = token
        return true
    }

    func delete(for serverURL: URL) {
        values.removeValue(forKey: serverURL.absoluteString)
    }
}
#endif

struct CoinPilotPosition: Identifiable {
    let coin: String?
    let amount: Double?
    let entryPrice: Double?
    let currentPrice: Double?
    let currentValue: Double?
    let profit: Double?
    let profitPercent: Double?
    let source: String?
    let valuationAvailable: Bool?
    let valuationAsOf: String?
    let sourceAsOf: String?
    let fetchedAt: String?

    var id: String { "\(coin ?? "unknown")-\(source ?? "position")" }

    init(_ object: [String: Any]) {
        coin = Self.string(object["coin"])
        amount = Self.number(object["amount"])
        entryPrice = Self.number(object["avgPrice"]) ?? Self.number(object["entryPrice"])
        currentPrice = Self.number(object["currentPrice"])
        currentValue = Self.number(object["currentValue"])
        profit = Self.number(object["profit"])
        profitPercent = Self.number(object["profitPercent"])
        source = Self.string(object["source"])
        valuationAvailable = Self.bool(object["valuationAvailable"])
        valuationAsOf = Self.string(object["valuationAsOf"])
        sourceAsOf = Self.string(object["sourceAsOf"])
        fetchedAt = Self.string(object["fetchedAt"])
    }

    private static func string(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? String ?? String(describing: value)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }

    private static func bool(_ value: Any?) -> Bool? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? Bool
    }
}

struct CoinPilotAccount {
    let krwBalance: Double?
    let totalAssets: Double?
    let initialSeedMoney: Double?
    let realizedProfit: Double?
    let profit: Double?
    let profitPercent: Double?
    let mode: String?
    let isReadOnlyObserver: Bool?
    let valuationAvailable: Bool?
    let valuationStatus: String?
    let valuationAsOf: String?
    let sourceAsOf: String?
    let fetchedAt: String?
    let positions: [CoinPilotPosition]
    let hasPositionsField: Bool

    init(_ object: [String: Any]) {
        krwBalance = Self.number(object["krwBalance"])
        totalAssets = Self.number(object["totalAssets"])
        initialSeedMoney = Self.number(object["initialSeedMoney"])
        realizedProfit = Self.number(object["realizedProfit"])
        profit = Self.number(object["profit"])
        profitPercent = Self.number(object["profitPercent"])
        mode = Self.string(object["mode"])
        isReadOnlyObserver = Self.bool(object["readOnlyObserver"])
        valuationAvailable = Self.bool(object["valuationAvailable"])
        valuationStatus = Self.string(object["valuationStatus"])
        valuationAsOf = Self.string(object["valuationAsOf"])
        sourceAsOf = Self.string(object["sourceAsOf"])
        fetchedAt = Self.string(object["fetchedAt"])
        if let values = object["positions"] as? [[String: Any]] {
            positions = values.map(CoinPilotPosition.init)
            hasPositionsField = true
        } else {
            positions = []
            hasPositionsField = false
        }
    }

    private static func string(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? String ?? String(describing: value)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }

    private static func bool(_ value: Any?) -> Bool? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? Bool
    }
}

struct CoinPilotStatus {
    let isRunning: Bool?
    let mode: String?
    let isReadOnlyObserver: Bool?
    let runtimeState: String?
    let entriesPaused: Bool?
    let protectiveMonitorActive: Bool?
    let stopReason: String?
    let exchangeStateKnown: Bool?
    let lastUpdate: String?

    init(_ object: [String: Any]) {
        isRunning = object["isRunning"] as? Bool
        mode = object["mode"] as? String
        isReadOnlyObserver = object["readOnlyObserver"] as? Bool
        runtimeState = object["runtimeState"] as? String
        entriesPaused = object["entriesPaused"] as? Bool
        protectiveMonitorActive = object["protectiveMonitorActive"] as? Bool
        stopReason = object["stopReason"] as? String
        exchangeStateKnown = object["exchangeStateKnown"] as? Bool
        lastUpdate = object["lastUpdate"] as? String
    }
}

struct CoinPilotPnL {
    let totalAssets: Double?
    let profit: Double?
    let profitPercent: Double?
    let valuationAvailable: Bool?
    let valuationStatus: String?
    let sourceAsOf: String?
    let fetchedAt: String?

    init(_ object: [String: Any]) {
        totalAssets = Self.number(object["totalAssets"])
        profit = Self.number(object["profit"])
        profitPercent = Self.number(object["profitPercent"])
        valuationAvailable = object["valuationAvailable"] as? Bool
        valuationStatus = object["valuationStatus"] as? String
        sourceAsOf = object["sourceAsOf"] as? String
        fetchedAt = object["fetchedAt"] as? String
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotHistoryPoint: Identifiable {
    let id: String
    let timestamp: String?
    let totalAssets: Double?
    let valuationStatus: String?
    let valuationAsOf: String?
    let sourceAsOf: String?
    let fetchedAt: String?

    init(_ object: [String: Any], index: Int) {
        timestamp = object["timestamp"] as? String
        totalAssets = Self.number(object["totalAssets"])
        valuationStatus = object["valuationStatus"] as? String
        valuationAsOf = object["valuationAsOf"] as? String
        sourceAsOf = object["sourceAsOf"] as? String
        fetchedAt = object["fetchedAt"] as? String
        id = timestamp ?? "point-\(index)"
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotMarketPrice: Identifiable {
    let coin: String?
    let price: Double?
    let change: Double?
    let sourceAsOf: String?
    let fetchedAt: String?

    var id: String { coin ?? "unknown-\(price ?? 0)" }

    init(_ object: [String: Any]) {
        coin = object["coin"] as? String
        price = Self.number(object["price"])
        change = Self.number(object["change"])
        sourceAsOf = object["sourceAsOf"] as? String
        fetchedAt = object["fetchedAt"] as? String
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotTrade: Identifiable {
    let id: String
    let coin: String?
    let action: String
    let timestamp: String?
    let profit: Double?
    let price: Double?
    let amount: Double?
    let source: String?

    init(_ object: [String: Any], index: Int) {
        let type = (object["type"] as? String ?? "").uppercased()
        let rawAction = (object["action"] as? String ?? object["side"] as? String ?? type).uppercased()
        let sellCoin = (object["sell"] as? [String: Any])?["coin"] as? String
        let buyCoin = (object["buy"] as? [String: Any])?["coin"] as? String
        if type == "BUNDLE_TRADE", let sellCoin, let buyCoin {
            coin = "\(Self.symbol(sellCoin) ?? sellCoin) → \(Self.symbol(buyCoin) ?? buyCoin)"
            action = "묶음 거래"
        } else {
            coin = Self.symbol((object["coin"] as? String) ?? "")
            if rawAction.contains("BUY") || rawAction.contains("OPEN") {
                action = "매수"
            } else if rawAction.contains("SELL") || rawAction.contains("CLOSE") {
                action = "매도"
            } else {
                action = "거래"
            }
        }
        timestamp = object["timestamp"] as? String ?? object["entryTime"] as? String ?? object["exitTime"] as? String
        profit = Self.number(object["profit"])
        price = Self.number(object["price"]) ?? Self.number(object["exitPrice"]) ?? Self.number(object["entryPrice"])
        amount = Self.number(object["value"]) ?? Self.number(object["total"]) ?? Self.number(object["amount"])
        source = object["source"] as? String
        id = "\(timestamp ?? "trade")-\(coin ?? "")-\(action)-\(index)"
    }

    private static func symbol(_ value: String) -> String? {
        let symbol = value.replacingOccurrences(of: "KRW-", with: "")
        return symbol.isEmpty ? nil : symbol
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotPaperBookSummary {
    let closedTradeCount: Int?
    let realizedProfitKrw: Double?
    let openPositionCount: Int?

    init(_ object: [String: Any]) {
        closedTradeCount = Self.integer(object["closedTradeCount"])
        realizedProfitKrw = Self.number(object["realizedProfitKrw"])
        openPositionCount = Self.integer(object["openPositionCount"])
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = Self.number(value), number >= 0 else { return nil }
        return Int(number)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotPaperDiagnosticSummary {
    let shadowClosedTradeCount: Int?
    let shadowRealizedProfitKrw: Double?
    let shadowOpenPositionCount: Int?
    let looseClosedTradeCount: Int?
    let looseRealizedProfitKrw: Double?
    let looseOpenPositionCount: Int?

    init(_ object: [String: Any]) {
        shadowClosedTradeCount = Self.integer(object["shadowClosedTradeCount"])
        shadowRealizedProfitKrw = Self.number(object["shadowRealizedProfitKrw"])
        shadowOpenPositionCount = Self.integer(object["shadowOpenPositionCount"])
        looseClosedTradeCount = Self.integer(object["looseClosedTradeCount"])
        looseRealizedProfitKrw = Self.number(object["looseRealizedProfitKrw"])
        looseOpenPositionCount = Self.integer(object["looseOpenPositionCount"])
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = Self.number(value), number >= 0 else { return nil }
        return Int(number)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotPaperCostAudit {
    let available: Bool
    let actualFillsObserved: Bool
    let evaluatedTradeCount: Int?
    let modeledExecutionTradeCount: Int?
    let unmodeledExecutionTradeCount: Int?
    let configuredSlippagePercent: Double?
    let recordedNetPnlKrw: Double?
    let modeledSlippageDragKrw: Double?
    let costStressedNetPnlKrw: Double?
    let slippageAppliedToStrictPaperLedger: Bool?
    let note: String?

    init(_ object: [String: Any]) {
        available = object["available"] as? Bool ?? false
        // A paper cost model is not evidence of exchange fills.
        actualFillsObserved = false
        evaluatedTradeCount = Self.integer(object["evaluatedTradeCount"])
        modeledExecutionTradeCount = Self.integer(object["modeledExecutionTradeCount"])
        unmodeledExecutionTradeCount = Self.integer(object["unmodeledExecutionTradeCount"])
        configuredSlippagePercent = Self.number(object["configuredSlippagePercent"])
        recordedNetPnlKrw = Self.number(object["recordedNetPnlKrw"])
        modeledSlippageDragKrw = Self.number(object["modeledSlippageDragKrw"])
        costStressedNetPnlKrw = Self.number(object["costStressedNetPnlKrw"])
        slippageAppliedToStrictPaperLedger = object["slippageAppliedToStrictPaperLedger"] as? Bool
        note = object["note"] as? String
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = Self.number(value), number >= 0 else { return nil }
        return Int(number)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotPaperForwardCohortSummary {
    let available: Bool
    let complete: Bool
    let fresh: Bool
    let capturedAt: String?
    let readErrorCount: Int?
    let sessionCount: Int?
    let activeSessionCount: Int?
    let endedSessionCount: Int?
    let strictTradeCount: Int?
    let strictTradeSessionCount: Int?
    let eligibleStrictSessionCount: Int?
    let eligibleStrictTradeCount: Int?
    let profitabilityEvidenceSessionCount: Int?
    let profitabilityEvidenceTradeCount: Int?
    let profitabilityEvidenceProfitKrw: Double?
    let strictCostUnverifiedTradeCount: Int?
    let sessionsBelowMinimumObservationDays: Int?
    let sessionsBelowMinimumTradeCount: Int?
    let totalStrictProfitComparable: Bool?
    let actualFillsObserved: Bool
    let promoted: Bool

    init(_ object: [String: Any]) {
        available = object["available"] as? Bool ?? false
        complete = object["complete"] as? Bool ?? false
        fresh = object["fresh"] as? Bool ?? false
        capturedAt = object["capturedAt"] as? String
        readErrorCount = Self.integer(object["readErrorCount"])
        sessionCount = Self.integer(object["sessionCount"])
        activeSessionCount = Self.integer(object["activeSessionCount"])
        endedSessionCount = Self.integer(object["endedSessionCount"])
        strictTradeCount = Self.integer(object["strictTradeCount"])
        strictTradeSessionCount = Self.integer(object["strictTradeSessionCount"])
        eligibleStrictSessionCount = Self.integer(object["eligibleStrictSessionCount"])
        eligibleStrictTradeCount = Self.integer(object["eligibleStrictTradeCount"])
        profitabilityEvidenceSessionCount = Self.integer(object["profitabilityEvidenceSessionCount"])
        profitabilityEvidenceTradeCount = Self.integer(object["profitabilityEvidenceTradeCount"])
        profitabilityEvidenceProfitKrw = Self.number(object["profitabilityEvidenceProfitKrw"])
        strictCostUnverifiedTradeCount = Self.integer(object["strictCostUnverifiedTradeCount"])
        sessionsBelowMinimumObservationDays = Self.integer(object["sessionsBelowMinimumObservationDays"])
        sessionsBelowMinimumTradeCount = Self.integer(object["sessionsBelowMinimumTradeCount"])
        totalStrictProfitComparable = object["totalStrictProfitComparable"] as? Bool
        // A historical paper cohort never proves exchange fills or order settlement.
        actualFillsObserved = false
        promoted = false
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = Self.number(value), number >= 0 else { return nil }
        return Int(number)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotPaperValidationSummary {
    let available: Bool
    let active: Bool?
    let state: String?
    let heartbeatAt: String?
    let stopReason: String?
    let configSnapshotComplete: Bool?
    let configurationConsistent: Bool?
    let continuityEligible: Bool?
    let heartbeatContinuityEligible: Bool?
    let analysisContinuityEligible: Bool?
    let analysisMissingMarketCount: Int?
    let riskContinuityEligible: Bool?
    let interruptionCount: Int?
    let strict: CoinPilotPaperBookSummary
    let diagnostic: CoinPilotPaperDiagnosticSummary
    let costAudit: CoinPilotPaperCostAudit
    let cohort: CoinPilotPaperForwardCohortSummary
    let researchOnly: Bool
    let promoted: Bool
    let actualFillsObserved: Bool

    init(_ object: [String: Any]) {
        available = object["available"] as? Bool ?? false
        active = Self.bool(object["active"])
        state = object["state"] as? String
        heartbeatAt = object["heartbeatAt"] as? String
        stopReason = object["stopReason"] as? String
        configSnapshotComplete = Self.bool(object["configSnapshotComplete"])
        configurationConsistent = Self.bool(object["configurationConsistent"])
        continuityEligible = Self.bool(object["continuityEligible"])
        heartbeatContinuityEligible = Self.bool(object["heartbeatContinuityEligible"])
        analysisContinuityEligible = Self.bool(object["analysisContinuityEligible"])
        analysisMissingMarketCount = Self.integer(object["analysisMissingMarketCount"])
        riskContinuityEligible = Self.bool(object["riskContinuityEligible"])
        interruptionCount = Self.integer(object["interruptionCount"])
        strict = CoinPilotPaperBookSummary(object["strict"] as? [String: Any] ?? [:])
        diagnostic = CoinPilotPaperDiagnosticSummary(object["diagnostic"] as? [String: Any] ?? [:])
        costAudit = CoinPilotPaperCostAudit(object["costAudit"] as? [String: Any] ?? [:])
        cohort = CoinPilotPaperForwardCohortSummary(object["cohort"] as? [String: Any] ?? [:])
        researchOnly = object["researchOnly"] as? Bool ?? false
        promoted = object["promoted"] as? Bool ?? false
        actualFillsObserved = false
    }

    private static func bool(_ value: Any?) -> Bool? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? Bool
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = Self.number(value), number >= 0 else { return nil }
        return Int(number)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

@MainActor
final class CoinPilotStore: ObservableObject {
    private static let serverDefaultsKey = "coinpilot.dashboardUrl"
    private static let legacyDataModeDefaultsKey = "coinpilot.native.dataMode"
    private static let dataModeDefaultsKeyPrefix = "coinpilot.native.dataMode.profile."
    private static let resourceNames = [
        "status", "account", "cumulative-pnl", "today-summary",
        "portfolio-history", "market-prices", "trades", "paper-validation-summary"
    ]
    private static let optionalResourceNames: Set<String> = ["paper-validation-summary"]
    private static var requiredResourceCount: Int {
        resourceNames.count - optionalResourceNames.count
    }

    @Published private(set) var phase: CoinPilotScreenPhase = .connecting
    @Published private(set) var account: CoinPilotAccount?
    @Published private(set) var status: CoinPilotStatus?
    @Published private(set) var pnl: CoinPilotPnL?
    @Published private(set) var todayRealizedProfit: Double?
    @Published private(set) var history: [CoinPilotHistoryPoint] = []
    @Published private(set) var markets: [CoinPilotMarketPrice] = []
    @Published private(set) var trades: [CoinPilotTrade] = []
    @Published private(set) var paperValidationSummary: CoinPilotPaperValidationSummary?
    @Published private(set) var rawResponses: [String: CoinPilotHTTPResponse] = [:]
    @Published private(set) var serverAddress: String
    @Published var serverDraft: String
    @Published var tokenDraft = ""
    @Published private(set) var connectionMessage: String?
    @Published private(set) var dashboardMessage: String?
    @Published private(set) var isRefreshing = false
    @Published private(set) var isWorking = false
    @Published private(set) var didFinishInitialConnect = false
    @Published private(set) var lastCheckedAt: Date?
    @Published private(set) var historyPeriod: CoinPilotHistoryPeriod = .day
    @Published private(set) var authenticationRequired = false
    @Published private(set) var isBundledPreview = false
    @Published private(set) var canUseBundledPreview = false
    @Published private(set) var resourceStates: [String: CoinPilotResourceState] = [:]

    private let api: CoinPilotAPIProviding
    private let tokens: CoinPilotTokenProviding
    private let bundledPreview: CoinPilotBundledPreviewDataSource
    private let dataModeDefaultsKey: String
    private var currentServerURL: URL?
    private var requestGeneration = 0
    private var lastSuccessfulResourceAt: [String: Date] = [:]
    private var bootstrapped = false

    init(
        api: CoinPilotAPIProviding = CoinPilotAPIClient(),
        tokens: CoinPilotTokenProviding? = nil,
        bundledPreview: CoinPilotBundledPreviewDataSource = CoinPilotBundledPreviewDataSource(),
        configuredDataMode: String? = nil
    ) {
        self.api = api
#if targetEnvironment(simulator) || COINPILOT_TEST_SIMULATOR_TOKEN_STORE
        self.tokens = tokens ?? CoinPilotSimulatorTokenStore()
#else
        self.tokens = tokens ?? CoinPilotTokenStore()
#endif
        self.bundledPreview = bundledPreview
        let stored = UserDefaults.standard.string(forKey: Self.serverDefaultsKey)
        let url = stored.flatMap(URL.init(string:)).flatMap { ServerAddressPolicy.allows($0) ? $0 : nil }
        let requestedMode = configuredDataMode ??
            (Bundle.main.object(forInfoDictionaryKey: "CoinPilotDataMode") as? String ?? "server")
        let configuredMode = requestedMode == "bundled-preview" ? "bundled-preview" : "server"
        let profileDefaultsKey = "\(Self.dataModeDefaultsKeyPrefix)\(configuredMode)"
        dataModeDefaultsKey = profileDefaultsKey
        let savedMode = UserDefaults.standard.string(forKey: profileDefaultsKey)
        let legacyMode = UserDefaults.standard.string(forKey: Self.legacyDataModeDefaultsKey)
        if savedMode == nil, legacyMode == configuredMode {
            UserDefaults.standard.set(legacyMode, forKey: profileDefaultsKey)
        }
        let selectedMode = savedMode ?? (legacyMode == configuredMode ? legacyMode : configuredMode)
        let bundledPreviewAvailable = bundledPreview.isAvailable
        canUseBundledPreview = bundledPreviewAvailable
        isBundledPreview = bundledPreviewAvailable && selectedMode == "bundled-preview"
        currentServerURL = url
        serverAddress = url.map(Self.displayAddress) ?? ""
        serverDraft = url?.absoluteString ?? ""
        resourceStates = Dictionary(uniqueKeysWithValues: Self.resourceNames.map { ($0, .notRequested) })
    }

    func state(for resource: String) -> CoinPilotResourceState {
        resourceStates[resource] ?? .notRequested
    }

    func freshnessLabel(for resource: String) -> String {
        let isMarketPrices = resource == "market-prices"
        let isMarketPreview = isMarketPrices && isBundledPreview
        let checkedLabel = isMarketPreview ? "예시 자료 기준" : isMarketPrices ? "앱 확인" : "확인"
        switch state(for: resource) {
        case .notRequested:
            if isMarketPreview { return "예시 시세 자료 미제공" }
            return isMarketPrices ? "앱 시세 확인 전" : "확인 전"
        case .loading:
            if let lastSuccess = lastSuccessfulResourceAt[resource] {
                return "\(checkedLabel) \(CoinPilotFormatting.time(lastSuccess)) · 새로 확인 중"
            }
            if isMarketPreview { return "예시 시세 자료 불러오는 중" }
            return isMarketPrices ? "앱에서 시세 확인 중" : "확인 중"
        case .current(let date):
            return "\(checkedLabel) \(CoinPilotFormatting.time(date))"
        case .stale(let date):
            if isMarketPreview {
                return "예시 시세 자료를 불러오지 못했어요 · \(CoinPilotFormatting.time(date))"
            }
            if isMarketPrices {
                return "앱에서 시세를 새로 확인하지 못했어요 · 마지막 앱 확인 \(CoinPilotFormatting.time(date))"
            }
            return "새로 확인하지 못했어요 · \(CoinPilotFormatting.time(date))"
        case .unavailable:
            if isMarketPreview { return "예시 시세 자료를 불러올 수 없어요" }
            return isMarketPrices ? "앱에서 시세를 확인할 수 없어요" : "확인할 수 없어요"
        }
    }

    var marketSnapshotFetchedAt: String? {
        Self.marketSnapshotFetchedAt(from: markets)
    }

    static func marketSnapshotFetchedAt(from markets: [CoinPilotMarketPrice]) -> String? {
        guard let first = markets.first?.fetchedAt,
              markets.allSatisfy({ $0.fetchedAt == first }) else { return nil }
        return first
    }

    func hasLoadedResource(_ resource: String) -> Bool {
        switch state(for: resource) {
        case .current, .stale: return true
        case .loading: return lastSuccessfulResourceAt[resource] != nil
        case .notRequested, .unavailable: return false
        }
    }

    func isResourceStale(_ resource: String) -> Bool {
        if case .stale = state(for: resource) { return true }
        return false
    }

    func emptyResourceMessage(for resource: String, whenLoadedEmpty: String) -> String {
        switch state(for: resource) {
        case .notRequested:
            return "불러오는 중이에요."
        case .loading:
            if let lastSuccess = lastSuccessfulResourceAt[resource] {
                return "새 정보를 확인하는 중이에요 · 마지막 확인 \(CoinPilotFormatting.time(lastSuccess))"
            }
            return "불러오는 중이에요."
        case .unavailable:
            return "정보를 불러오지 못했어요. 다시 시도해 주세요."
        case .current:
            return whenLoadedEmpty
        case .stale(let date):
            return "새 정보를 확인하지 못했어요 · 마지막 확인 \(CoinPilotFormatting.time(date))"
        }
    }

    var isObserverAccount: Bool {
        status?.isReadOnlyObserver == true || account?.isReadOnlyObserver == true
    }

    var runtimeSafetyMessage: String? {
        guard !isBundledPreview else { return nil }
        if status?.runtimeState == "SYNC_REQUIRED" || status?.exchangeStateKnown == false {
            return "설정한 시장의 거래소 잔고와 미체결 주문을 확인하고 있어요. 확인이 끝날 때까지 신규 주문을 잠급니다."
        }
        guard status?.runtimeState == "PROTECTIVE_ONLY" || status?.protectiveMonitorActive == true else { return nil }
        switch status?.stopReason {
        case "risk_data_gap":
            return "시세 공백으로 분석과 신규 진입을 멈췄어요. 열린 포지션은 위험 감시 중이며, 자동으로 매매를 재개하지 않습니다."
        case "analysis_data_gap":
            return "분석 자료 공백으로 신규 진입을 멈췄어요. 열린 포지션은 위험 감시를 계속합니다."
        default:
            return "안전 점검으로 신규 진입을 멈추고 기존 포지션을 감시하고 있어요."
        }
    }

    var totalAssets: Double? {
        if isObserverAccount { return account?.totalAssets }
        return account?.totalAssets ?? pnl?.totalAssets
    }

    var totalProfit: Double? {
        if isObserverAccount { return account?.profit ?? account?.realizedProfit }
        return account?.profit ?? pnl?.profit
    }

    var totalProfitLabel: String {
        guard isObserverAccount else { return "누적 손익" }
        if account?.profit != nil { return "평가 손익" }
        if account?.realizedProfit != nil { return "실현 손익" }
        return "모의투자 손익"
    }

    var totalProfitPercent: Double? {
        if isObserverAccount { return account?.profitPercent }
        return account?.profitPercent ?? pnl?.profitPercent
    }

    var tradingMode: String? {
        status?.mode ?? account?.mode
    }

    func bootstrap() async {
        guard !bootstrapped else { return }
        bootstrapped = true
        if isBundledPreview {
            phase = .dashboard
            await refresh()
            didFinishInitialConnect = true
            return
        }

        guard let currentServerURL else {
            phase = .setup
            didFinishInitialConnect = true
            return
        }
        _ = await connect(using: currentServerURL.absoluteString)
        didFinishInitialConnect = true
    }

    func primaryConnectionAction() async {
        if phase == .login {
            _ = await signIn()
        } else {
            _ = await connect(using: serverDraft)
        }
    }

    func useBundledPreview() {
        guard bundledPreview.isAvailable else {
            connectionMessage = "예시 데이터가 포함된 앱 빌드에서만 미리보기를 사용할 수 있어요."
            return
        }
        _ = beginRequestGeneration()
        isBundledPreview = true
        UserDefaults.standard.set("bundled-preview", forKey: dataModeDefaultsKey)
        authenticationRequired = false
        connectionMessage = nil
        tokenDraft = ""
        clearLoadedData()
        phase = .dashboard
        didFinishInitialConnect = true
        Task { await refresh() }
    }

    func useServerMode() {
        _ = beginRequestGeneration()
        isBundledPreview = false
        UserDefaults.standard.set("server", forKey: dataModeDefaultsKey)
        clearLoadedData()
        connectionMessage = nil
        tokenDraft = ""
        didFinishInitialConnect = true
        guard let currentServerURL else {
            phase = .setup
            return
        }
        phase = .connecting
        Task { _ = await connect(using: currentServerURL.absoluteString) }
    }

    func connect(using rawAddress: String) async -> Bool {
        guard let url = validatedServerURL(rawAddress) else {
            phase = .setup
            connectionMessage = "같은 Wi-Fi의 서버는 내부 주소로 연결하고, 외부 서버는 HTTPS 주소를 입력해 주세요."
            return false
        }

        let generation = beginRequestGeneration()
        isWorking = true
        defer {
            if generation == requestGeneration { isWorking = false }
        }
        let changed = isBundledPreview || url.absoluteString != currentServerURL?.absoluteString
        isBundledPreview = false
        UserDefaults.standard.set("server", forKey: dataModeDefaultsKey)
        connectionMessage = nil

        currentServerURL = url
        serverDraft = url.absoluteString
        serverAddress = Self.displayAddress(url)
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverDefaultsKey)
        if changed { clearLoadedData() }
        phase = .connecting

        do {
            let response = try await api.authenticationStatus(at: url)
            guard generation == requestGeneration, currentServerURL == url else { return false }
            guard (200..<300).contains(response.statusCode),
                  let body = try? Self.jsonObject(response.body) as? [String: Any],
                  let authRequired = body["authRequired"] as? Bool else {
                throw CoinPilotAPIError.forStatusCode(response.statusCode)
            }
            authenticationRequired = authRequired
            guard authRequired else {
                phase = .dashboard
                await refresh()
                return generation == requestGeneration
            }

            guard let token = tokens.token(for: url) else {
                phase = .login
                return false
            }
            let protectedResponse = try await api.read(path: "/api/status", at: url, token: token)
            guard generation == requestGeneration, currentServerURL == url else { return false }
            guard (200..<300).contains(protectedResponse.statusCode) else {
                if protectedResponse.statusCode == 401 {
                    tokens.delete(for: url)
                    phase = .login
                    connectionMessage = "서버 인증을 확인할 수 없습니다. 서버 토큰을 다시 입력해 주세요."
                    return false
                }
                throw CoinPilotAPIError.forStatusCode(protectedResponse.statusCode)
            }
            phase = .dashboard
            await refresh()
            return generation == requestGeneration
        } catch let error as CoinPilotAPIError {
            guard generation == requestGeneration else { return false }
            phase = .connecting
            connectionMessage = error.message
            return false
        } catch {
            guard generation == requestGeneration else { return false }
            phase = .connecting
            connectionMessage = CoinPilotAPIError.connection.message
            return false
        }
    }

    func signIn() async -> Bool {
        let generation = beginRequestGeneration()
        isWorking = true
        defer {
            if generation == requestGeneration { isWorking = false }
        }
        connectionMessage = nil
        guard let url = validatedServerURL(serverDraft) else {
            connectionMessage = "같은 Wi-Fi의 서버는 내부 주소로 연결하고, 외부 서버는 HTTPS 주소를 입력해 주세요."
            phase = .setup
            return false
        }
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.utf8.count <= 4096 else {
            connectionMessage = "서버 토큰을 입력해 주세요."
            return false
        }

        let changed = isBundledPreview || url.absoluteString != currentServerURL?.absoluteString
        isBundledPreview = false
        UserDefaults.standard.set("server", forKey: dataModeDefaultsKey)
        currentServerURL = url
        serverDraft = url.absoluteString
        serverAddress = Self.displayAddress(url)
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverDefaultsKey)
        if changed { clearLoadedData() }
        phase = .connecting

        do {
            let statusResponse = try await api.authenticationStatus(at: url)
            guard generation == requestGeneration, currentServerURL == url else { return false }
            guard (200..<300).contains(statusResponse.statusCode),
                  let statusBody = try? Self.jsonObject(statusResponse.body) as? [String: Any],
                  let authRequired = statusBody["authRequired"] as? Bool else {
                throw CoinPilotAPIError.forStatusCode(statusResponse.statusCode)
            }
            authenticationRequired = authRequired
            if authRequired {
                let loginResponse = try await api.login(token: token, at: url)
                guard generation == requestGeneration, currentServerURL == url else { return false }
                guard (200..<300).contains(loginResponse.statusCode) else {
                    throw CoinPilotAPIError.forStatusCode(loginResponse.statusCode)
                }
                guard tokens.save(token, for: url) else { throw CoinPilotAPIError.keychain }
            }
            tokenDraft = ""
            phase = .dashboard
            await refresh()
            return generation == requestGeneration
        } catch let error as CoinPilotAPIError {
            guard generation == requestGeneration else { return false }
            phase = .login
            connectionMessage = error.message
            return false
        } catch {
            guard generation == requestGeneration else { return false }
            phase = .login
            connectionMessage = CoinPilotAPIError.connection.message
            return false
        }
    }

    func updateServerAddress(_ rawAddress: String) async -> Bool {
        guard let url = validatedServerURL(rawAddress) else {
            connectionMessage = "같은 Wi-Fi의 서버는 내부 주소로 연결하고, 외부 서버는 HTTPS 주소를 입력해 주세요."
            return false
        }
        return await connect(using: url.absoluteString)
    }

    func logOut() {
        _ = beginRequestGeneration()
        if let currentServerURL { tokens.delete(for: currentServerURL) }
        clearLoadedData()
        connectionMessage = nil
        tokenDraft = ""
        phase = currentServerURL == nil ? .setup : .login
    }

    func refresh() async {
        guard phase == .dashboard, !isRefreshing else { return }
        let generation = requestGeneration
        let serverURL = currentServerURL
        let usesBundledPreview = isBundledPreview
        guard usesBundledPreview || serverURL != nil else {
            dashboardMessage = "서버 주소를 입력해 주세요."
            return
        }
        isRefreshing = true
        dashboardMessage = nil
        defer {
            if generation == requestGeneration { isRefreshing = false }
        }
        let token = !usesBundledPreview && authenticationRequired
            ? serverURL.flatMap { tokens.token(for: $0) }
            : nil
        let selectedPeriod = historyPeriod
        for name in Self.resourceNames { resourceStates[name] = .loading }

        async let statusResult = fetch("/api/status", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let accountResult = fetch("/api/account", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let pnlResult = fetch("/api/cumulative-pnl", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let todayResult = fetch("/api/today-summary", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let historyResult = fetch("/api/portfolio/history?period=\(selectedPeriod.rawValue)", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let marketResult = fetch("/api/market/prices", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let tradesResult = fetch("/api/trades?limit=30", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let paperSummaryResult = fetch("/api/paper-validation/summary", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)

        let results = await (statusResult, accountResult, pnlResult, todayResult, historyResult, marketResult, tradesResult, paperSummaryResult)
        guard generation == requestGeneration,
              serverURL == currentServerURL,
              usesBundledPreview == isBundledPreview,
              phase == .dashboard else { return }
        let responses: [Result<CoinPilotHTTPResponse, CoinPilotAPIError>] = [
            results.0, results.1, results.2, results.3, results.4, results.5, results.6, results.7
        ]
        var latestResponses: [String: CoinPilotHTTPResponse] = [:]
        for (index, name) in Self.resourceNames.enumerated() {
            if case .success(let response) = responses[index] {
                latestResponses[name] = response
            }
        }
        rawResponses = latestResponses

        if responses.contains(where: { result in
            if case .success(let response) = result { return response.statusCode == 401 }
            return false
        }) {
            if authenticationRequired, let serverURL {
                tokens.delete(for: serverURL)
                _ = beginRequestGeneration()
                clearLoadedData()
                phase = .login
                connectionMessage = "서버 인증을 확인할 수 없습니다. 서버 토큰을 다시 입력해 주세요."
                return
            }
        }

        var failures = 0
        var successes = 0
        let updatedAt = usesBundledPreview ? bundledPreview.generatedAt ?? Date() : Date()

        if let object = decodeDictionary(results.0) {
            status = CoinPilotStatus(object)
            markResourceLoaded("status", at: updatedAt)
            successes += 1
        } else { markResourceFailed("status"); failures += 1 }

        if let object = decodeDictionary(results.1) {
            account = CoinPilotAccount(object)
            markResourceLoaded("account", at: updatedAt)
            successes += 1
        } else { markResourceFailed("account"); failures += 1 }

        if let object = decodeDictionary(results.2) {
            pnl = CoinPilotPnL(object)
            markResourceLoaded("cumulative-pnl", at: updatedAt)
            successes += 1
        } else { markResourceFailed("cumulative-pnl"); failures += 1 }

        if let object = decodeDictionary(results.3) {
            todayRealizedProfit = Self.number(object["realizedProfit"])
            markResourceLoaded("today-summary", at: updatedAt)
            successes += 1
        } else { markResourceFailed("today-summary"); failures += 1 }

        if let object = decodeDictionary(results.4), object["error"] == nil,
           let values = object["data"] as? [[String: Any]] {
            history = values.enumerated().map { CoinPilotHistoryPoint($0.element, index: $0.offset) }
            markResourceLoaded("portfolio-history", at: updatedAt)
            successes += 1
        } else { markResourceFailed("portfolio-history"); failures += 1 }

        if let values = decodeArray(results.5) {
            markets = values.map(CoinPilotMarketPrice.init)
            markResourceLoaded("market-prices", at: updatedAt)
            successes += 1
        } else { markResourceFailed("market-prices"); failures += 1 }

        if let values = decodeArray(results.6) {
            trades = values.enumerated().map { CoinPilotTrade($0.element, index: $0.offset) }
            markResourceLoaded("trades", at: updatedAt)
            successes += 1
        } else { markResourceFailed("trades"); failures += 1 }

        if let object = decodeDictionary(results.7),
           object["schema"] as? String == "coinpilot.paper-validation-mobile-summary.v1" {
            paperValidationSummary = CoinPilotPaperValidationSummary(object)
            markResourceLoaded("paper-validation-summary", at: updatedAt)
        } else {
            // Older servers can keep the core account dashboard working without the new optional summary.
            markResourceFailed("paper-validation-summary")
        }

        if successes == Self.requiredResourceCount {
            lastCheckedAt = updatedAt
            dashboardMessage = nil
        } else if successes > 0 {
            dashboardMessage = "일부 정보를 새로 확인하지 못했어요. 표시된 항목의 마지막 확인 시각을 살펴봐 주세요."
        } else {
            dashboardMessage = usesBundledPreview
                ? "앱에 포함된 예시 자료를 불러오지 못했어요."
                : "서버에서 정보를 불러오지 못했어요. 연결 상태를 확인한 뒤 다시 시도해 주세요."
        }
    }

    func setHistoryPeriod(_ period: CoinPilotHistoryPeriod) async {
        guard period != historyPeriod else { return }
        historyPeriod = period
        guard phase == .dashboard else { return }
        let generation = requestGeneration
        let serverURL = currentServerURL
        let usesBundledPreview = isBundledPreview
        guard usesBundledPreview || serverURL != nil else { return }
        let token = !usesBundledPreview && authenticationRequired
            ? serverURL.flatMap { tokens.token(for: $0) }
            : nil
        resourceStates["portfolio-history"] = .loading
        let result = await fetch(
            "/api/portfolio/history?period=\(period.rawValue)",
            token: token,
            at: serverURL,
            usesBundledPreview: usesBundledPreview
        )
        guard generation == requestGeneration,
              serverURL == currentServerURL,
              period == historyPeriod,
              usesBundledPreview == isBundledPreview else { return }
        if case .success(let response) = result {
            rawResponses["portfolio-history"] = response
        }
        if let object = decodeDictionary(result), object["error"] == nil,
           let values = object["data"] as? [[String: Any]] {
            history = values.enumerated().map { CoinPilotHistoryPoint($0.element, index: $0.offset) }
            markResourceLoaded("portfolio-history", at: usesBundledPreview ? bundledPreview.generatedAt ?? Date() : Date())
            dashboardMessage = nil
        } else if case .success(let response) = result, response.statusCode == 401, authenticationRequired,
                  let serverURL {
            tokens.delete(for: serverURL)
            _ = beginRequestGeneration()
            clearLoadedData()
            phase = .login
            connectionMessage = "서버 인증을 확인할 수 없습니다. 서버 토큰을 다시 입력해 주세요."
        } else {
            markResourceFailed("portfolio-history")
            dashboardMessage = "자산 기록을 불러오지 못했습니다."
        }
    }

    private func fetch(
        _ path: String,
        token: String?,
        at serverURL: URL?,
        usesBundledPreview: Bool
    ) async -> Result<CoinPilotHTTPResponse, CoinPilotAPIError> {
        if usesBundledPreview {
            do {
                return .success(try bundledPreview.response(for: path))
            } catch let error as CoinPilotAPIError {
                return .failure(error)
            } catch {
                return .failure(.invalidData)
            }
        }
        guard let serverURL else { return .failure(.invalidAddress) }
        do {
            return .success(try await api.read(path: path, at: serverURL, token: token))
        } catch let error as CoinPilotAPIError {
            return .failure(error)
        } catch {
            return .failure(.connection)
        }
    }

    private func decodeDictionary(_ result: Result<CoinPilotHTTPResponse, CoinPilotAPIError>) -> [String: Any]? {
        guard case .success(let response) = result,
              (200..<300).contains(response.statusCode),
              let object = try? Self.jsonObject(response.body) as? [String: Any],
              object["error"] == nil else { return nil }
        return object
    }

    private func decodeArray(_ result: Result<CoinPilotHTTPResponse, CoinPilotAPIError>) -> [[String: Any]]? {
        guard case .success(let response) = result,
              (200..<300).contains(response.statusCode),
              let object = try? Self.jsonObject(response.body) as? [[String: Any]] else { return nil }
        return object
    }

    private func clearLoadedData() {
        account = nil
        status = nil
        pnl = nil
        todayRealizedProfit = nil
        history = []
        markets = []
        trades = []
        paperValidationSummary = nil
        rawResponses = [:]
        lastCheckedAt = nil
        dashboardMessage = nil
        lastSuccessfulResourceAt = [:]
        resourceStates = Dictionary(uniqueKeysWithValues: Self.resourceNames.map { ($0, .notRequested) })
    }

    private func beginRequestGeneration() -> Int {
        requestGeneration += 1
        isRefreshing = false
        isWorking = false
        return requestGeneration
    }

    private func markResourceLoaded(_ name: String, at date: Date) {
        lastSuccessfulResourceAt[name] = date
        resourceStates[name] = .current(at: date)
    }

    private func markResourceFailed(_ name: String) {
        if let previousDate = lastSuccessfulResourceAt[name] {
            resourceStates[name] = .stale(lastSuccessfulAt: previousDate)
        } else {
            resourceStates[name] = .unavailable
        }
    }

    private func validatedServerURL(_ rawAddress: String) -> URL? {
        let value = rawAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = URL(string: value),
              ServerAddressPolicy.allows(parsed),
              var components = URLComponents(url: parsed, resolvingAgainstBaseURL: false) else { return nil }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func displayAddress(_ url: URL) -> String {
        guard let host = url.host else { return url.absoluteString }
        return host + (url.port.map { ":\($0)" } ?? "")
    }

    private static func jsonObject(_ data: Data) throws -> Any {
        try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

enum CoinPilotFormatting {
    static func won(_ value: Double?, unavailable: String = "금액 미제공") -> String {
        guard let value, value.isFinite else { return unavailable }
        let sign = value < 0 ? "−" : ""
        return "\(sign)₩\(number(abs(value), fractionDigits: 0))"
    }

    static func signedWon(_ value: Double?, unavailable: String = "손익 미제공") -> String {
        guard let value, value.isFinite else { return unavailable }
        let sign = value > 0 ? "+" : value < 0 ? "−" : ""
        return "\(sign)₩\(number(abs(value), fractionDigits: 0))"
    }

    static func price(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "시세 미제공" }
        let fractionDigits = value >= 1_000 ? 0 : value >= 1 ? 2 : 6
        return "₩\(number(value, fractionDigits: fractionDigits))"
    }

    static func percent(_ value: Double?, signed: Bool = true, unavailable: String = "변동률 미제공") -> String {
        guard let value, value.isFinite else { return unavailable }
        let sign = signed && value > 0 ? "+" : ""
        return "\(sign)\(number(value, fractionDigits: 2))%"
    }

    static func quantity(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "수량 미제공" }
        return number(value, fractionDigits: 8)
    }

    static func dateTime(_ value: String?, unavailable: String = "시각 미제공") -> String {
        guard let value, let date = parseDate(value) else { return unavailable }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일 a h:mm"
        return formatter.string(from: date)
    }

    static func marketTimestamp(_ value: String?, label: String) -> String {
        guard let value else { return "\(label) 시각 미제공" }
        guard let date = parseDate(value) else { return "\(label) 시각 형식 오류" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일 a h:mm:ss"
        return "\(label) \(formatter.string(from: date))"
    }

    static func time(_ date: Date?) -> String {
        guard let date else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "a h:mm"
        return formatter.string(from: date)
    }

    static func symbol(_ coin: String?) -> String {
        guard let coin else { return "자산 미제공" }
        let symbol = coin.replacingOccurrences(of: "KRW-", with: "")
        switch symbol {
        case "BTC": return "비트코인"
        case "ETH": return "이더리움"
        case "XRP": return "리플"
        default: return symbol.isEmpty ? "자산 미제공" : symbol
        }
    }

    static func ticker(_ coin: String?) -> String {
        guard let coin else { return "—" }
        return coin.replacingOccurrences(of: "KRW-", with: "")
    }

    private static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    private static func number(_ value: Double, fractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = fractionDigits
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}
