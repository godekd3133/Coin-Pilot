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

enum CoinPilotAuthScope: String, Equatable {
    case unauthenticated
    case readOnly = "read_only"
    case mobileOperator = "mobile_operator"
    case operatorFull = "operator"

    var canOperate: Bool {
        self == .mobileOperator || self == .operatorFull
    }
}

enum CoinPilotWorkspaceMode: String, CaseIterable, Identifiable, Equatable, Hashable {
    case paper
    case live

    var id: String { rawValue }

    var title: String { self == .live ? "실거래" : "모의투자" }
    var serverMode: String { self == .live ? "LIVE" : "DRY_RUN" }
    var addressDefaultsKey: String { "coinpilot.dashboardUrl.\(rawValue)" }
}

/// Info.plist에 빌드 타임으로 박는 선택적 서버 기본값. 개인용 앱이 주소/토큰
/// 입력 없이 바로 서버에 붙도록 한다. 비어 있으면 기존 수동 입력 흐름이며,
/// 저장된 주소/토큰이 있으면 그쪽이 항상 우선한다.
/// Settings에서 한 탭으로 선택할 수 있는 미리 등록된 서버(거래소별 인스턴스 등).
struct CoinPilotServerPreset: Equatable {
    let label: String
    let url: URL
}

struct CoinPilotBundledServerConfig {
    let paper: URL?
    let live: URL?
    let token: String?
    /// secrets/plist의 paperServers/liveServers 배열. 기본값은 번들 주소 자체.
    let paperPresets: [CoinPilotServerPreset]
    let livePresets: [CoinPilotServerPreset]

    static let none = CoinPilotBundledServerConfig(
        paper: nil, live: nil, token: nil, paperPresets: [], livePresets: [])

    init(
        paper: URL? = nil,
        live: URL? = nil,
        token: String? = nil,
        paperPresets: [CoinPilotServerPreset] = [],
        livePresets: [CoinPilotServerPreset] = []
    ) {
        self.paper = paper
        self.live = live
        self.token = token
        self.paperPresets = paperPresets
        self.livePresets = livePresets
    }

    static func load(bundle: Bundle = .main) -> Self {
        resolve(
            secrets: secretsJSON(in: bundle),
            plist: [
                "paper": bundle.object(forInfoDictionaryKey: "CoinPilotPaperServerAddress") as? String,
                "live": bundle.object(forInfoDictionaryKey: "CoinPilotLiveServerAddress") as? String,
                "token": bundle.object(forInfoDictionaryKey: "CoinPilotDefaultToken") as? String
            ].compactMapValues { $0 }
        )
    }

    /// secrets(LocalSecrets.json)의 유효한 값이 plist(빌드 설정)보다 우선하고,
    /// secrets 항목이 없거나 무효하면 plist 값으로 폴백한다.
    static func resolve(secrets: [String: Any]?, plist: [String: Any]?) -> Self {
        func address(_ raw: String?) -> URL? {
            guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty,
                  let parsed = URL(string: trimmed),
                  ServerAddressPolicy.allows(parsed) else { return nil }
            return parsed
        }
        func token(_ raw: String?) -> String? {
            let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
        func presets(_ source: [String: Any]?, _ key: String, fallback: URL?) -> [CoinPilotServerPreset] {
            let rows = (source?[key] as? [[String: Any]] ?? []).compactMap { row -> CoinPilotServerPreset? in
                guard let url = address(row["url"] as? String) else { return nil }
                let label = (row["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                return CoinPilotServerPreset(label: label?.isEmpty == false ? label! : url.host ?? url.absoluteString, url: url)
            }
            if !rows.isEmpty { return rows }
            return fallback.map { [CoinPilotServerPreset(label: $0.host ?? $0.absoluteString, url: $0)] } ?? []
        }
        let paper = address(secrets?["paper"] as? String) ?? address(plist?["paper"] as? String)
        let live = address(secrets?["live"] as? String) ?? address(plist?["live"] as? String)
        return Self(
            paper: paper,
            live: live,
            token: token(secrets?["token"] as? String) ?? token(plist?["token"] as? String),
            paperPresets: presets(secrets, "paperServers", fallback: paper),
            livePresets: presets(secrets, "liveServers", fallback: live)
        )
    }

    /// 개인 전용 자격증명 리소스. 빌드 스크립트가 LocalSecrets.json이 있을 때만 복사한다.
    static func secretsJSON(in bundle: Bundle) -> [String: Any]? {
        guard let url = bundle.url(forResource: "CoinPilotLocalSecrets", withExtension: "json"),
              let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              data.count <= 16_384,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object
    }

    func url(for workspace: CoinPilotWorkspaceMode) -> URL? {
        workspace == .live ? live : paper
    }

    func presets(for workspace: CoinPilotWorkspaceMode) -> [CoinPilotServerPreset] {
        workspace == .live ? livePresets : paperPresets
    }
}

struct CoinPilotAutomationPresentation: Equatable {
    let sectionTitle: String
    let stateLabel: String
    let explanation: String
    let showsControls: Bool

    init(isBundledPreview: Bool, isRunning: Bool?) {
        if isBundledPreview {
            sectionTitle = "자동매매 예시"
            stateLabel = "예시 상태"
            explanation = "앱에 포함된 예시 상태예요. 실제 서버에서 자동매매를 실행하지 않습니다."
            showsControls = false
            return
        }

        sectionTitle = "자동매매"
        stateLabel = isRunning == true ? "실행 중" : isRunning == false ? "중지" : "확인 불가"
        explanation = isRunning == true
            ? "서버에서 자동매매를 실행 중입니다."
            : isRunning == false
                ? "서버에서 자동매매가 중지되어 있습니다."
                : "서버 실행 상태를 확인할 수 없습니다."
        showsControls = true
    }
}

struct CoinPilotOrderReviewPresentation: Equatable {
    let sectionTitle: String
    let accountTitle: String
    let buttonTitle: String
    let isEnabled: Bool
    let showsWalletControls: Bool

    init(
        isBundledPreview: Bool,
        workspace: CoinPilotWorkspaceMode,
        draftIsValid: Bool,
        blockReason: String?,
        isSubmitting: Bool
    ) {
        if isBundledPreview {
            sectionTitle = "주문 미리보기"
            accountTitle = "예시 계좌"
            buttonTitle = "예시에서는 주문할 수 없어요"
            isEnabled = false
            showsWalletControls = false
            return
        }

        sectionTitle = "직접 주문"
        accountTitle = workspace == .live ? "Upbit · 실계정" : "가상 계좌"
        buttonTitle = workspace == .live ? "실거래 주문 검토" : "모의 주문 검토"
        isEnabled = draftIsValid && blockReason == nil && !isSubmitting
        showsWalletControls = workspace == .paper
    }
}

enum CoinPilotResourceState: Equatable {
    case notRequested
    case loading
    case current(at: Date)
    case stale(lastSuccessfulAt: Date)
    case unavailable

    var isCurrent: Bool {
        if case .current = self { return true }
        return false
    }
}

enum CoinPilotTradePeriod: String, CaseIterable, Identifiable {
    case all = "전체"
    case today = "오늘"
    case week = "7일"
    case month = "30일"

    var id: String { rawValue }

    func includes(_ timestamp: String?, at now: Date, calendar: Calendar = .current) -> Bool {
        guard self != .all else { return true }
        guard let date = CoinPilotMarketSnapshotMetadata.parseDate(timestamp), date <= now else { return false }
        let startOfToday = calendar.startOfDay(for: now)
        let days = self == .week ? 6 : self == .month ? 29 : 0
        guard let start = calendar.date(byAdding: .day, value: -days, to: startOfToday) else { return false }
        return date >= start
    }
}

enum CoinPilotHistoryPeriod: String, CaseIterable, Identifiable {
    case hour = "1h"
    case day = "24h"
    case week = "7d"
    case month = "30d"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .hour: return "1시간"
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
    func mobileRead(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse
    func registerLiveCredentials(
        accessKey: String,
        secretKey: String,
        at serverURL: URL,
        token: String?
    ) async throws -> CoinPilotHTTPResponse
    func mutate(
        path: String,
        at serverURL: URL,
        token: String?,
        body: [String: Any],
        idempotencyKey: String?
    ) async throws -> CoinPilotHTTPResponse
}

extension CoinPilotAPIProviding {
    func mobileRead(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse {
        throw CoinPilotAPIError.forbidden
    }

    func registerLiveCredentials(
        accessKey: String,
        secretKey: String,
        at serverURL: URL,
        token: String?
    ) async throws -> CoinPilotHTTPResponse {
        throw CoinPilotAPIError.forbidden
    }

    func mutate(
        path: String,
        at serverURL: URL,
        token: String?,
        body: [String: Any],
        idempotencyKey: String?
    ) async throws -> CoinPilotHTTPResponse {
        throw CoinPilotAPIError.forbidden
    }
}

protocol CoinPilotTokenProviding {
    func token(for serverURL: URL) -> String?
    func save(_ token: String, for serverURL: URL) -> Bool
    func delete(for serverURL: URL)
}

struct CoinPilotPendingManualOrder: Codable, Equatable, Identifiable {
    let idempotencyKey: String
    let endpoint: String
    let requestBody: Data
    let market: String
    let side: String
    let displayAmount: String
    let mode: String
    let createdAt: Date

    var id: String { idempotencyKey }

    func bodyDictionary() -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: requestBody)) as? [String: Any]
    }
}

/// GET /api/coin-detail/:coin 응답 — 시세+보유+지표+주문 한도.
struct CoinPilotCoinDetail {
    let coin: String
    let currentPrice: Double?
    let change24hPercent: Double?
    let high24h: Double?
    let low24h: Double?
    let volume24h: Double?
    let holdingAmount: Double
    let holdingAvgPrice: Double
    let holdingValue: Double?
    let holdingProfit: Double?
    let holdingProfitPercent: Double?
    let krwBalance: Double?
    let maxBuyAmount: Double?
    let maxSellAmount: Double?
    let rsi: Double?
    let macdHistogram: Double?
    let bollingerPercentB: Double?

    init?(_ object: [String: Any]) {
        func num(_ value: Any?) -> Double? {
            let number: Double?
            if let value = value as? NSNumber { number = value.doubleValue }
            else if let value = value as? String { number = Double(value) }
            else { number = nil }
            guard let number, number.isFinite else { return nil }
            return number
        }
        guard let coin = object["coin"] as? String else { return nil }
        self.coin = coin
        currentPrice = num(object["currentPrice"])
        change24hPercent = num(object["change24h"])
        high24h = num(object["high24h"])
        low24h = num(object["low24h"])
        volume24h = num(object["volume24h"])
        let holding = object["holding"] as? [String: Any] ?? [:]
        holdingAmount = num(holding["amount"]) ?? 0
        holdingAvgPrice = num(holding["avgPrice"]) ?? 0
        holdingValue = num(holding["currentValue"])
        holdingProfit = num(holding["profit"])
        holdingProfitPercent = num(holding["profitPercent"])
        krwBalance = num(object["krwBalance"])
        maxBuyAmount = num(object["maxBuyAmount"])
        maxSellAmount = num(object["maxSellAmount"])
        let indicators = object["indicators"] as? [String: Any] ?? [:]
        rsi = num(indicators["rsi"])
        macdHistogram = num(indicators["macd"])
        bollingerPercentB = num(indicators["bb"])
    }

    var hasHolding: Bool { holdingAmount > 0 }
}

struct CoinPilotTuningField: Identifiable {
    let key: String
    let label: String
    let description: String
    let category: String
    let value: Double?
    let booleanValue: Bool?
    let minimum: Double?
    let maximum: Double?
    let step: Double?
    let displayMultiplier: Double

    var id: String { key }
    var displayValue: Double? { value.map { $0 * displayMultiplier } }
}

enum CoinPilotPendingOrderRead {
    case missing
    case saved(Data)
    case unavailable
}

protocol CoinPilotPendingOrderProviding {
    func read(for serverURL: URL) -> CoinPilotPendingOrderRead
    func save(_ data: Data, for serverURL: URL) -> Bool
    func clear(for serverURL: URL) -> Bool
}

#if targetEnvironment(simulator) || COINPILOT_TEST_SIMULATOR_TOKEN_STORE
final class CoinPilotMemoryPendingOrderStore: CoinPilotPendingOrderProviding {
    private var values: [String: Data] = [:]

    func read(for serverURL: URL) -> CoinPilotPendingOrderRead {
        values[serverURL.absoluteString].map(CoinPilotPendingOrderRead.saved) ?? .missing
    }

    func save(_ data: Data, for serverURL: URL) -> Bool {
        values[serverURL.absoluteString] = data
        return true
    }

    func clear(for serverURL: URL) -> Bool {
        values.removeValue(forKey: serverURL.absoluteString)
        return true
    }
}
#endif

enum CoinPilotAPIError: Error, Sendable {
    case invalidAddress
    case connection
    case cancelled
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
        case .cancelled:
            return "요청이 취소되었습니다."
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

    func mobileRead(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse {
        guard Self.isAllowedMobileReadPath(path) else { throw CoinPilotAPIError.forbidden }
        return try await send(path: path, method: "GET", at: serverURL, token: token, body: nil)
    }

    func registerLiveCredentials(
        accessKey: String,
        secretKey: String,
        at serverURL: URL,
        token: String?
    ) async throws -> CoinPilotHTTPResponse {
        guard serverURL.scheme?.lowercased() == "https",
              accessKey == accessKey.trimmingCharacters(in: .whitespacesAndNewlines),
              secretKey == secretKey.trimmingCharacters(in: .whitespacesAndNewlines),
              !accessKey.isEmpty,
              !secretKey.isEmpty,
              accessKey.utf8.count <= 4096,
              secretKey.utf8.count <= 4096 else {
            throw CoinPilotAPIError.forbidden
        }
        return try await send(
            path: "/api/live/credentials",
            method: "POST",
            at: serverURL,
            token: token,
            body: ["accessKey": accessKey, "secretKey": secretKey]
        )
    }

    func mutate(
        path: String,
        at serverURL: URL,
        token: String?,
        body: [String: Any],
        idempotencyKey: String? = nil
    ) async throws -> CoinPilotHTTPResponse {
        guard Self.isAllowedMobileMutation(path, body: body) else { throw CoinPilotAPIError.forbidden }
        var headers: [String: String] = [:]
        if let idempotencyKey {
            guard UUID(uuidString: idempotencyKey) != nil else { throw CoinPilotAPIError.invalidData }
            headers["Idempotency-Key"] = idempotencyKey
        }
        if [
            "/api/trade/buy", "/api/trade/sell", "/api/trade/quick", "/api/trade/execute",
            "/api/trade/execute-bundle", "/api/trade/smart-buy", "/api/trade/smart-sell",
            "/api/virtual/deposit", "/api/virtual/withdraw", "/api/virtual/reset"
        ].contains(path),
           idempotencyKey == nil {
            throw CoinPilotAPIError.invalidData
        }
        return try await send(
            path: path,
            method: "POST",
            at: serverURL,
            token: token,
            body: body,
            additionalHeaders: headers
        )
    }

    private func send(
        path: String,
        method: String,
        at serverURL: URL,
        token: String?,
        body: Any?,
        additionalHeaders: [String: String] = [:]
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
        for (name, value) in additionalHeaders {
            request.setValue(value, forHTTPHeaderField: name)
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
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw CoinPilotAPIError.connection
        }
    }

    static func requestURL(path: String, serverURL: URL) -> URL? {
        guard path.hasPrefix("/api/"),
              ServerAddressPolicy.allows(serverURL),
              serverURL.path.isEmpty || serverURL.path == "/" || serverURL.path == "/live",
              let requested = URLComponents(string: "https://coinpilot.invalid\(path)"),
              requested.host == "coinpilot.invalid",
              requested.fragment == nil,
              var server = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        let prefix = serverURL.path == "/live" ? "/live" : ""
        server.path = "\(prefix)\(requested.path)"
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
        case "/api/status", "/api/account", "/api/cumulative-pnl", "/api/today-summary", "/api/market/prices", "/api/market/prices/snapshot", "/api/paper-validation/summary", "/api/positions", "/api/parameter-ranges", "/api/investment-config", "/api/investment-presets":
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

    static func isAllowedMobileReadPath(_ path: String) -> Bool {
        if isAllowedReadPath(path) { return true }
        guard let components = URLComponents(string: "https://coinpilot.invalid\(path)"),
              components.host == "coinpilot.invalid",
              components.fragment == nil else { return false }
        let simplePaths: Set<String> = [
            "/api/statistics", "/api/portfolio-analysis", "/api/paper-validation",
            "/api/target-coins",
            "/api/parameter-ranges",
            "/api/investment-config",
            "/api/investment-presets",
            "/api/scalping-validation",
            "/api/strategy-readiness", "/api/coin-analysis", "/api/all-coin-scores",
            "/api/trading-recommendations", "/api/bundle-suggestions", "/api/news",
            "/api/news-stats", "/api/live-execution-evidence", "/api/momentum-shadow",
            "/api/strategy-research", "/api/backtest/results", "/api/optimal-config",
            "/api/optimization-history", "/api/optimization/settings", "/api/ai/providers",
            "/api/ai/monitoring", "/api/ai/events", "/api/ai/consultations",
            "/api/ai/effectiveness", "/api/ai/sessions", "/api/logs", "/api/system-status",
            "/api/stream"
        ]
        if simplePaths.contains(components.path) && (components.queryItems?.isEmpty ?? true) { return true }

        let queryItems = components.queryItems ?? []
        func hasOnlyQuery(_ allowed: Set<String>, required: Set<String> = []) -> Bool {
            let names = queryItems.map(\.name)
            return Set(names).count == names.count &&
                Set(names).isSubset(of: allowed) &&
                required.isSubset(of: Set(names))
        }
        func integerQuery(_ name: String, _ range: ClosedRange<Int>, fallback: Bool = false) -> Bool {
            guard let raw = components.queryItems?.first(where: { $0.name == name })?.value else { return fallback }
            guard let value = Int(raw), String(value) == raw else { return false }
            return range.contains(value)
        }
        let pathValue = components.path
        if pathValue.range(of: "^/api/market/candles/[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil {
            guard hasOnlyQuery(["unit", "count"], required: ["unit", "count"]),
                  let unit = components.queryItems?.first(where: { $0.name == "unit" })?.value,
                  let count = components.queryItems?.first(where: { $0.name == "count" })?.value else { return false }
            return ["1", "5", "15", "60"].contains(unit) && ["30", "60", "100"].contains(count)
        }
        if pathValue == "/api/all-coin-scores" {
            return hasOnlyQuery(["limit"], required: ["limit"]) && integerQuery("limit", 1...100)
        }
        if pathValue == "/api/news" {
            guard hasOnlyQuery(["limit", "source"], required: ["limit"]),
                  integerQuery("limit", 1...200) else { return false }
            return components.queryItems?.first(where: { $0.name == "source" })?.value.map { ["general", "system"].contains($0) } ?? true
        }
        if pathValue.range(of: "^/api/news/[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil {
            return hasOnlyQuery(["limit"]) && integerQuery("limit", 1...100, fallback: true)
        }
        if pathValue == "/api/ai/providers" {
            guard hasOnlyQuery(["refresh"]) else { return false }
            return components.queryItems?.first(where: { $0.name == "refresh" })?.value.map { $0 == "true" } ?? true
        }
        if ["/api/ai/monitoring", "/api/ai/events", "/api/ai/consultations", "/api/ai/effectiveness"].contains(pathValue) {
            guard hasOnlyQuery(["limit", "sessionId"]) else { return false }
            if components.queryItems?.contains(where: { $0.name == "limit" }) == true && !integerQuery("limit", 1...100) { return false }
            if let sessionId = components.queryItems?.first(where: { $0.name == "sessionId" })?.value {
                return sessionId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
            }
            return true
        }
        if pathValue.range(of: "^/api/ai/sessions/[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil {
            return hasOnlyQuery(["limit"]) &&
                (components.queryItems?.contains(where: { $0.name == "limit" }) != true || integerQuery("limit", 1...100))
        }
        if pathValue.range(of: "^/api/backtest/results/[A-Z0-9_-]{1,40}$", options: .regularExpression) != nil {
            return queryItems.isEmpty
        }
        if pathValue.range(of: "^/api/coin-detail/[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil {
            return queryItems.isEmpty
        }
        if pathValue == "/api/logs" {
            guard hasOnlyQuery(["type", "lines"]) else { return false }
            if let type = components.queryItems?.first(where: { $0.name == "type" })?.value,
               !["trading", "error", "trades"].contains(type) { return false }
            return components.queryItems?.contains(where: { $0.name == "lines" }) != true || integerQuery("lines", 1...500)
        }
        return false
    }

    static func isAllowedMobileMutation(_ path: String, body: [String: Any]) -> Bool {
        guard let components = URLComponents(string: "https://coinpilot.invalid\(path)"),
              components.host == "coinpilot.invalid",
              components.queryItems?.isEmpty ?? true,
              components.fragment == nil else { return false }
        let keys = Set(body.keys)
        if components.path.range(of: "^/api/ai/sessions/[A-Za-z0-9_-]{1,128}/(pause|resume|stop)$", options: .regularExpression) != nil {
            return keys.isEmpty
        }
        switch components.path {
        case "/api/trade/buy": return keys == ["coin", "amount"]
        case "/api/trade/sell": return keys == ["coin", "quantity"]
        case "/api/trade/quick", "/api/trade/execute": return keys == ["coin", "action", "amount"] || keys == ["coin", "action"]
        case "/api/trade/smart-buy": return keys == ["totalAmount", "minScore", "maxCoins"] || keys == ["totalAmount"]
        case "/api/trade/smart-sell": return keys == ["targetAmount", "strategy"] || keys == ["targetAmount"]
        case "/api/trade/execute-bundle":
            return keys.isSubset(of: ["sellCoin", "sellAmount", "buyCoin", "buyAmount"]) &&
                keys.contains("sellCoin") && keys.contains("buyCoin")
        case "/api/investment-config/update": return keys == ["investmentRatio"]
        case "/api/config/update":
            let allowed: Set<String> = [
                "investmentRatio",
                "rsiPeriod", "rsiOversold", "rsiOverbought", "oversoldLookback", "macdFast", "macdSlow",
                "macdSignal", "bbPeriod", "bbStdDev", "emaShort", "emaMid", "emaLong", "stopLossPercent",
                "takeProfitPercent", "buyThreshold", "sellThreshold", "volumeMultiplier", "volumePeriod",
                "minReboundPercent", "maxReboundPercent", "minRsiRecovery", "minVolumeRatio", "minCloseStrength",
                "trendPeriod", "trendSlopeLookback", "minTrendSlopePercent", "maxSignalRangePercent",
                "minSignalRangePercent", "positionRiskCheckIntervalMs", "entryDelayMinMs", "entryDelayMaxMs",
                "maxEntryRetracePercent", "maxEntryChasePercent", "maxHoldMinutes",
                "breakEvenTriggerPercent", "breakEvenOffsetPercent", "trailingActivationPercent",
                "trailingStopPercent", "maxLosingHoldMinutes", "winnerExtendMinutes",
                "winnerExtendMinProfitPercent", "maxEntriesPerSignalWindow", "marketRegimeEnabled",
                "marketRegimeLookback", "marketRegimeMinBreadth", "marketRegimeMinReturnPercent",
                "requireReboundBelowOverbought", "lossCircuitBreakerCount",
                "lossCircuitBreakerWindowMinutes", "lossCircuitBreakerCooldownMinutes",
                "maxRiskDataGapSeconds", "maxAnalysisDataGapSeconds", "maxCandleAgeSeconds",
                "targetCoins", "scalpMaxMarkets", "maxPositions"
            ]
            return !keys.isEmpty && keys.isSubset(of: allowed)
        case "/api/control/start", "/api/control/stop", "/api/paper-validation/stop", "/api/portfolio/snapshot", "/api/optimization/run-now":
            return keys.isEmpty
        case "/api/virtual/reset": return keys == ["seedMoney"]
        case "/api/paper-validation/start":
            return keys.isEmpty || (keys == ["reset"] && body["reset"] is Bool)
        case "/api/virtual/deposit", "/api/virtual/withdraw": return keys == ["amount"]
        case "/api/investment-presets/apply": return keys == ["presetId"]
        case "/api/optimization/toggle": return keys == ["enabled"] && body["enabled"] is Bool
        case "/api/optimization/interval": return keys == ["interval"]
        case "/api/ai/sessions": return keys.isSubset(of: ["name", "providers", "eventTypes", "autoConsultEventTypes", "autoConsult", "coins", "cooldownSeconds", "evaluationMinutes"]) && keys.contains("eventTypes")
        case "/api/ai/consult": return keys.isSubset(of: ["eventId", "event", "provider", "providers", "sessionId"]) && !keys.isEmpty
        default: return false
        }
    }
}

/// GET /api/stream의 Server-Sent Events 채널. Socket.IO 브로드캐스트와 같은
/// 이벤트를 받아 대시보드를 갱신한다. 네트워크 오류는 백오프로 재연결하고,
/// 스트림이 허용되지 않는 자격증명(401/403)은 재시도 없이 종료한다.
final class CoinPilotLiveEventStream {
    private var task: Task<Void, Never>?
    private var activeKey: String?
    private let onEvent: @MainActor (String) -> Void
    private let onConnectionChange: @MainActor (Bool) -> Void

    init(
        onEvent: @escaping @MainActor (String) -> Void,
        onConnectionChange: @escaping @MainActor (Bool) -> Void
    ) {
        self.onEvent = onEvent
        self.onConnectionChange = onConnectionChange
    }

    func start(url: URL, token: String?) {
        let key = "\(url.absoluteString)|\(token ?? "")"
        if task != nil, activeKey == key { return }
        stop()
        activeKey = key
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let onEvent = self.onEvent
        let onConnectionChange = self.onConnectionChange
        task = Task.detached(priority: .utility) {
            await CoinPilotLiveEventStream.run(
                request: request,
                onEvent: onEvent,
                onConnectionChange: onConnectionChange
            )
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        activeKey = nil
        Task { await onConnectionChange(false) }
    }

    private static func run(
        request: URLRequest,
        onEvent: @MainActor (String) -> Void,
        onConnectionChange: @MainActor (Bool) -> Void
    ) async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 0
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var backoffNanos: UInt64 = 2_000_000_000
        while !Task.isCancelled {
            do {
                let (bytes, response) = try await session.bytes(for: request)
                guard let http = response as? HTTPURLResponse else { continue }
                guard (200..<300).contains(http.statusCode) else {
                    if http.statusCode == 401 || http.statusCode == 403 { return }
                    throw URLError(.badServerResponse)
                }
                await onConnectionChange(true)
                backoffNanos = 2_000_000_000
                var eventName = ""
                for try await line in bytes.lines {
                    if Task.isCancelled { return }
                    if line.isEmpty {
                        eventName = ""
                    } else if line.hasPrefix("event:") {
                        eventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                    } else if line.hasPrefix("data:") {
                        let name = eventName.isEmpty ? "message" : eventName
                        await onEvent(name)
                    }
                }
                await onConnectionChange(false)
            } catch is CancellationError {
                return
            } catch {
                await onConnectionChange(false)
            }
            try? await Task.sleep(nanoseconds: backoffNanos)
            backoffNanos = min(backoffNanos * 2, 60_000_000_000)
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
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverURL.absoluteString,
            kSecValueData as String: Data(token.utf8)
        ]
        #if canImport(UIKit)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        #endif
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

private final class CoinPilotKeychainPendingOrderStore: CoinPilotPendingOrderProviding {
    private let service = "\(Bundle.main.bundleIdentifier ?? "com.godekd3133.coinpilot").pending-order"

    func read(for serverURL: URL) -> CoinPilotPendingOrderRead {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverURL.absoluteString,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .missing }
        guard status == errSecSuccess, let data = result as? Data else { return .unavailable }
        return .saved(data)
    }

    func save(_ data: Data, for serverURL: URL) -> Bool {
        guard clear(for: serverURL) else { return false }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverURL.absoluteString,
            kSecValueData as String: data
        ]
        #if canImport(UIKit)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        #endif
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    func clear(for serverURL: URL) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: serverURL.absoluteString
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
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
    let costBasis: Double?
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
        costBasis = Self.number(object["costBasis"])
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

    var unvaluedPositionCount: Int {
        positions.filter { position in
            guard position.valuationAvailable != false, let value = position.currentValue else { return true }
            return !value.isFinite || value < 0
        }.count
    }

    /// A partial valuation is not the total value of the holdings.
    var completePositionsValue: Double? {
        guard hasPositionsField, valuationAvailable != false, unvaluedPositionCount == 0 else { return nil }
        let value = positions.compactMap(\.currentValue).reduce(0, +)
        return value.isFinite ? value : nil
    }

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
    let liveManualPrepared: Bool?
    let liveManualPrepareOnBoot: Bool?
    let upbitCredentialsConfigured: Bool?
    let lastUpdate: String?
    let maxCandleAgeSeconds: Double?
    let exchange: String?
    let quoteCurrency: String?

    init(_ object: [String: Any]) {
        isRunning = object["isRunning"] as? Bool
        mode = object["mode"] as? String
        isReadOnlyObserver = object["readOnlyObserver"] as? Bool
        runtimeState = object["runtimeState"] as? String
        entriesPaused = object["entriesPaused"] as? Bool
        protectiveMonitorActive = object["protectiveMonitorActive"] as? Bool
        stopReason = object["stopReason"] as? String
        exchangeStateKnown = object["exchangeStateKnown"] as? Bool
        liveManualPrepared = object["liveManualPrepared"] as? Bool
        liveManualPrepareOnBoot = object["liveManualPrepareOnBoot"] as? Bool
        upbitCredentialsConfigured = object["upbitCredentialsConfigured"] as? Bool
        lastUpdate = object["lastUpdate"] as? String
        exchange = object["exchange"] as? String
        quoteCurrency = object["quoteCurrency"] as? String
        let configuredMaxAge = (object["maxCandleAgeSeconds"] as? NSNumber)?.doubleValue
            ?? (object["maxCandleAgeSeconds"] as? String).flatMap(Double.init)
        maxCandleAgeSeconds = configuredMaxAge.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
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
    let high: Double?
    let low: Double?
    let volumeKrw: Double?
    let sourceAsOf: String?
    let fetchedAt: String?
    let quoteFresh: Bool?
    let quoteFreshnessReason: String?

    var id: String { coin ?? "unknown-\(price ?? 0)" }

    var sourceAsOfDate: Date? {
        CoinPilotMarketSnapshotMetadata.parseDate(sourceAsOf)
    }

    var fetchedAtDate: Date? {
        CoinPilotMarketSnapshotMetadata.parseDate(fetchedAt)
    }

    func freshnessIssue(at now: Date, maximumAgeSeconds: TimeInterval) -> String? {
        guard let price, price.isFinite, price > 0 else {
            return "현재가를 확인할 수 없어요"
        }
        if quoteFreshnessReason == "market_snapshot_last_good" {
            return "저장된 최근 시세를 표시 중이에요. 새 시세를 확인한 뒤 주문해 주세요."
        }
        guard let sourceAsOfDate else {
            return "최근 체결 시각을 확인할 수 없어요"
        }
        if let issue = CoinPilotTimestampFreshness.issue(
            sourceAsOfDate,
            label: "최근 체결",
            at: now,
            maximumAgeSeconds: maximumAgeSeconds
        ) {
            return issue
        }
        if quoteFresh == false {
            return "현재 시세 최신 여부를 확인할 수 없어요"
        }
        return nil
    }

    init(_ object: [String: Any]) {
        coin = object["coin"] as? String
        price = Self.number(object["price"])
        change = Self.number(object["change"])
        high = Self.number(object["high"])
        low = Self.number(object["low"])
        volumeKrw = Self.number(object["volumeKrw"])
        sourceAsOf = object["sourceAsOf"] as? String
        fetchedAt = object["fetchedAt"] as? String
        quoteFresh = object["quoteFresh"] as? Bool
        quoteFreshnessReason = object["quoteFreshnessReason"] as? String
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotMarketSnapshotMetadata: Equatable {
    let complete: Bool?
    let missingMarkets: [String]?
    let marketListStale: Bool?
    let sourceAsOf: String?
    let fetchedAt: String?
    let snapshotSource: String?
    let fallbackReason: String?

    init(_ object: [String: Any]) {
        complete = object["complete"] as? Bool
        missingMarkets = object["missingMarkets"] as? [String]
        marketListStale = object["marketListStale"] as? Bool
        sourceAsOf = object["sourceAsOf"] as? String
        fetchedAt = object["fetchedAt"] as? String
        snapshotSource = object["snapshotSource"] as? String
        fallbackReason = object["fallbackReason"] as? String
    }

    var fetchedAtDate: Date? {
        Self.parseDate(fetchedAt)
    }

    var sourceAsOfDate: Date? {
        Self.parseDate(sourceAsOf)
    }

    static func parseDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    var freshnessIssue: String? {
        if snapshotSource == "last_good" {
            return "거래소 응답이 없어 저장된 최근 시세를 표시 중이에요"
        }
        if marketListStale == true {
            return "시세 종목 목록 갱신이 필요해요"
        }
        if complete == false || missingMarkets?.isEmpty == false {
            if let missingCount = missingMarkets?.count, missingCount > 0 {
                return "종목 \(missingCount)개 시세 누락"
            }
            return "일부 종목 시세 누락"
        }
        guard complete == true, missingMarkets?.isEmpty == true, marketListStale == false else {
            return "시세 상태를 확인할 수 없어요"
        }
        guard sourceAsOfDate != nil else {
            return "원본 시세 시각을 확인할 수 없어요"
        }
        guard fetchedAtDate != nil else {
            return "시세 수집 시각을 확인할 수 없어요"
        }
        return nil
    }

    func currentFetchedAt(at _: Date, maximumAgeSeconds _: TimeInterval) -> Date? {
        guard complete == true,
              missingMarkets?.isEmpty == true,
              marketListStale == false,
              snapshotSource != "last_good",
              sourceAsOfDate != nil,
              let fetchedAtDate else { return nil }
        return fetchedAtDate
    }
}

private enum CoinPilotTimestampFreshness {
    static let futureToleranceSeconds: TimeInterval = 5

    static func issue(
        _ date: Date?,
        label: String,
        at now: Date,
        maximumAgeSeconds: TimeInterval
    ) -> String? {
        guard let date else { return "\(label) 시각을 확인할 수 없어요" }
        let ageSeconds = now.timeIntervalSince(date)
        if ageSeconds < -futureToleranceSeconds {
            return "\(label) 시각이 현재보다 앞서 있어요"
        }
        if ageSeconds > maximumAgeSeconds {
            return "\(label) 시각이 오래됐어요"
        }
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
        let entryTime = object["entryTime"] as? String
        let exitTime = object["exitTime"] as? String
        timestamp = object["timestamp"] as? String ?? (action == "매도" ? exitTime ?? entryTime : entryTime ?? exitTime)
        profit = Self.number(object["profit"])
        price = Self.number(object["price"]) ?? Self.number(object["exitPrice"]) ?? Self.number(object["entryPrice"])
        amount = Self.number(object["value"]) ?? Self.number(object["total"]) ?? Self.number(object["amount"])
        source = object["source"] as? String
        id = "\(timestamp ?? "trade")-\(coin ?? "")-\(action)-\(index)"
    }

    private static func symbol(_ value: String) -> String? {
        let symbol = value.split(separator: "-").last.map(String.init) ?? value
        return symbol.isEmpty ? nil : symbol
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotCandle: Identifiable {
    let id: String
    let time: String?
    let open: Double?
    let high: Double?
    let low: Double?
    let close: Double?
    let volume: Double?

    init(_ object: [String: Any], index: Int) {
        time = object["time"] as? String
        open = Self.number(object["open"])
        high = Self.number(object["high"])
        low = Self.number(object["low"])
        close = Self.number(object["close"])
        volume = Self.number(object["volume"])
        id = time ?? "candle-\(index)"
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotAnalysisResult: Identifiable {
    let coin: String
    let currentPrice: Double?
    let change24h: Double?
    let volume24h: Double?
    let rsi: Double?
    let macdSignal: String?
    let bollingerPercent: Double?
    let buyScore: Double?
    let sellScore: Double?
    let totalScore: Double?
    let recommendation: String?
    let signalStrength: String?
    let signals: [String]

    var id: String { coin }

    init(_ object: [String: Any]) {
        coin = object["coin"] as? String ?? "UNKNOWN"
        currentPrice = Self.number(object["currentPrice"] ?? object["price"])
        change24h = Self.number(object["change24h"])
        volume24h = Self.number(object["volume24h"])
        let indicators = object["indicators"] as? [String: Any] ?? [:]
        rsi = Self.number(indicators["rsi"])
        macdSignal = indicators["macdSignal"] as? String
        bollingerPercent = Self.number(indicators["bbPercent"])
        buyScore = Self.number(object["buyScore"])
        sellScore = Self.number(object["sellScore"])
        totalScore = Self.number(object["totalScore"] ?? object["score"])
        recommendation = object["recommendation"] as? String ?? object["action"] as? String
        signalStrength = object["signalStrength"] as? String
        signals = (object["signals"] as? [String]) ?? []
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotRecommendation: Identifiable {
    let coin: String
    let action: String
    let price: Double?
    let reason: String?
    let confidence: Double?
    let hasPosition: Bool
    let averagePrice: Double?
    let profitPercent: Double?
    let suggestedAmount: Double?

    var id: String { "\(coin)-\(action)" }

    init(_ object: [String: Any]) {
        coin = object["coin"] as? String ?? "UNKNOWN"
        action = object["action"] as? String ?? object["recommendation"] as? String ?? "WAIT"
        price = Self.number(object["currentPrice"] ?? object["price"])
        reason = object["reason"] as? String
        confidence = Self.number(object["confidence"] ?? object["score"])
        hasPosition = object["hasPosition"] as? Bool ?? false
        averagePrice = Self.number(object["avgPrice"] ?? object["averagePrice"])
        profitPercent = Self.number(object["profitPercent"])
        suggestedAmount = Self.number(object["suggestedAmount"] ?? object["investmentAmount"] ?? object["amount"])
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct CoinPilotNewsArticle: Identifiable {
    let id: String
    let title: String
    let summary: String?
    let source: String?
    let url: URL?
    let timestamp: String?
    let sentiment: String?

    init(_ object: [String: Any], index: Int) {
        title = object["title"] as? String ?? "제목 없음"
        summary = object["description"] as? String ?? object["content"] as? String
        source = object["source"] as? String
        let rawURL = object["url"] as? String ?? object["link"] as? String
        url = rawURL.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" || $0.scheme == "http" ? $0 : nil }
        timestamp = object["timestamp"] as? String ?? object["pubDate"] as? String ?? object["publishedAt"] as? String
        sentiment = object["sentiment"] as? String ?? object["mood"] as? String
        id = (object["id"] as? String) ?? "\(timestamp ?? "news")-\(index)-\(title.hashValue)"
    }
}

struct CoinPilotAISession: Identifiable {
    let id: String
    let name: String
    let status: String
    let eventTypes: [String]
    let providers: [String]
    let coins: [String]
    let autoConsult: Bool
    let evaluationMinutes: Int?
    let eventCount: Int?
    let consultationCount: Int?
    let lastEventAt: String?

    init(_ object: [String: Any]) {
        id = object["id"] as? String ?? object["sessionId"] as? String ?? UUID().uuidString
        name = object["name"] as? String ?? "시장 신호 알림"
        status = object["status"] as? String ?? "UNKNOWN"
        eventTypes = object["eventTypes"] as? [String] ?? []
        providers = object["providers"] as? [String] ?? []
        coins = object["coins"] as? [String] ?? []
        autoConsult = object["autoConsult"] as? Bool ?? false
        evaluationMinutes = Self.integer(object["evaluationMinutes"])
        eventCount = Self.integer(object["eventCount"])
        consultationCount = Self.integer(object["consultationCount"])
        lastEventAt = object["lastEventAt"] as? String
    }

    private static func integer(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string) }
        return nil
    }
}

struct CoinPilotAIEvent: Identifiable {
    let id: String
    let type: String
    let coin: String?
    let action: String?
    let price: Double?
    let signalStrength: String?
    let title: String
    let detail: String?
    let timestamp: String?
    let consultationId: String?

    init(_ object: [String: Any], index: Int) {
        type = object["type"] as? String ?? object["eventType"] as? String ?? "MARKET_SIGNAL"
        coin = object["coin"] as? String ?? object["market"] as? String
        action = object["action"] as? String
        price = Self.number(object["price"])
        signalStrength = object["signalStrength"] as? String
        title = object["title"] as? String ?? object["message"] as? String ?? type
        detail = object["reason"] as? String ?? object["summary"] as? String
        timestamp = object["timestamp"] as? String ?? object["createdAt"] as? String
        consultationId = object["consultationId"] as? String ?? (object["consultation"] as? [String: Any])?["id"] as? String
        id = (object["id"] as? String) ?? (object["eventId"] as? String) ?? "event-\(index)-\(timestamp ?? "unknown")"
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
    private static let activeWorkspaceDefaultsKey = "coinpilot.native.activeWorkspace"
    private static let legacyDataModeDefaultsKey = "coinpilot.native.dataMode"
    private static let dataModeDefaultsKeyPrefix = "coinpilot.native.dataMode.profile."
    private static let maximumBundledLocalChartCandles = 200
    private static let mobileTuningKeyOrder = [
        "investmentRatio", "rsiPeriod", "rsiOversold", "rsiOverbought", "oversoldLookback",
        "macdFast", "macdSlow", "macdSignal", "bbPeriod", "bbStdDev", "emaShort", "emaMid", "emaLong",
        "stopLossPercent", "takeProfitPercent", "trailingStopPercent", "buyThreshold", "sellThreshold",
        "volumeMultiplier", "volumePeriod", "minReboundPercent", "maxReboundPercent", "minRsiRecovery",
        "minVolumeRatio", "minCloseStrength", "trendPeriod", "trendSlopeLookback", "minTrendSlopePercent",
        "maxSignalRangePercent", "minSignalRangePercent", "marketRegimeEnabled", "marketRegimeLookback",
        "marketRegimeMinBreadth", "marketRegimeMinReturnPercent", "positionRiskCheckIntervalMs",
        "maxRiskDataGapSeconds", "maxAnalysisDataGapSeconds", "maxCandleAgeSeconds", "entryDelayMinMs",
        "entryDelayMaxMs", "maxEntryRetracePercent", "maxEntryChasePercent", "breakEvenTriggerPercent",
        "breakEvenOffsetPercent", "trailingActivationPercent", "maxHoldMinutes", "maxLosingHoldMinutes",
        "winnerExtendMinutes", "winnerExtendMinProfitPercent", "maxEntriesPerSignalWindow",
        "lossCircuitBreakerCount", "lossCircuitBreakerWindowMinutes", "lossCircuitBreakerCooldownMinutes",
        "requireReboundBelowOverbought"
    ]
    private static let resourceNames = [
        "status", "account", "cumulative-pnl", "today-summary",
        "portfolio-history", "market-prices", "trades", "paper-validation-summary"
    ]
    private static let optionalResourceNames: Set<String> = ["paper-validation-summary"]
    private static let mobileFeatureFreshnessSeconds: [String: TimeInterval] = [
        "news": 300,
        "ai": 60,
        "account-analytics": 60,
        "research": 300,
        "optimization": 300
    ]
    private static var requiredResourceCount: Int {
        resourceNames.count - optionalResourceNames.count
    }

    private struct MobileFeatureRequestContext {
        let generation: Int
        let serverURL: URL
        let workspace: CoinPilotWorkspaceMode
        let token: String?
    }

    @Published private(set) var phase: CoinPilotScreenPhase = .connecting
    @Published private(set) var account: CoinPilotAccount?
    @Published private(set) var status: CoinPilotStatus?
    @Published private(set) var serverExchange: String?
    @Published private(set) var quoteCurrency = "KRW"

    @Published private(set) var pnl: CoinPilotPnL?
    @Published private(set) var todayRealizedProfit: Double?
    @Published private(set) var history: [CoinPilotHistoryPoint] = []
    @Published private(set) var markets: [CoinPilotMarketPrice] = []
    @Published private(set) var marketSnapshotMetadata: CoinPilotMarketSnapshotMetadata?
    @Published private(set) var trades: [CoinPilotTrade] = []
    @Published private(set) var paperValidationSummary: CoinPilotPaperValidationSummary?
    @Published private(set) var rawResponses: [String: CoinPilotHTTPResponse] = [:]
    @Published private(set) var serverAddress: String
    @Published var serverDraft: String
    @Published var tokenDraft = ""
    @Published var liveAccessKeyDraft = ""
    @Published var liveSecretKeyDraft = ""
    @Published private(set) var isSubmittingLiveCredentials = false
    @Published private(set) var liveCredentialMessage: String?
    @Published private(set) var connectionMessage: String?
    @Published private(set) var dashboardMessage: String?
    @Published private(set) var isRefreshing = false
    @Published private(set) var liveEventsConnected = false
    @Published private(set) var lastLiveEventAt: Date?
    @Published private(set) var isWorking = false
    @Published private(set) var didFinishInitialConnect = false
    @Published private(set) var lastCheckedAt: Date?
    @Published private(set) var historyPeriod: CoinPilotHistoryPeriod = .day
    @Published private(set) var authenticationRequired = false
    @Published private(set) var authenticationScope: CoinPilotAuthScope = .unauthenticated
    @Published private(set) var activeWorkspace: CoinPilotWorkspaceMode = .paper
    @Published private(set) var serverModeMatchesWorkspace = true
    @Published private(set) var isBundledPreview = false
    @Published private(set) var isBundledLocalMarketData = false
    @Published private(set) var canUseBundledPreview = false
    @Published private(set) var localMarketData: CoinPilotBundledMarketData?
    @Published private(set) var localMarketDataError: String?
    @Published private(set) var isLoadingLocalMarketData = false
    @Published private(set) var offlineReplayResult: CoinPilotOfflineReplay.Result?
    @Published private(set) var offlineReplayResults: [CoinPilotOfflineReplay.Result] = []
    @Published private(set) var isRunningOfflineReplay = false
    @Published private(set) var offlineReplayMessage: String?
    @Published private(set) var offlineReplayPersistenceMessage: String?
    @Published private(set) var offlineReplaySessionCheckpoint: CoinPilotOfflineReplaySessionCheckpoint?
    @Published private(set) var offlineReplaySessionFrame: CoinPilotOfflineReplay.PlaybackFrame?
    @Published private(set) var offlineReplaySessionRecoveryMessage: String?
    @Published private(set) var offlineReplaySessionMessage: String?
    @Published private(set) var isPreparingOfflineReplaySession = false
    @Published private(set) var isUpdatingOfflineReplaySession = false
    @Published private(set) var offlineReplayPlaybackSpeed: CoinPilotOfflineReplayPlaybackSpeed = .tenCandlesPerSecond
    @Published private(set) var resourceStates: [String: CoinPilotResourceState] = [:]
    @Published private(set) var pendingManualOrder: CoinPilotPendingManualOrder?
    @Published private(set) var pendingManualOrderLocked = false
    @Published private(set) var isSubmittingManualOrder = false
    @Published private(set) var orderMessage: String?
    @Published private(set) var tuningValues: [String: Any] = [:]
    @Published private(set) var tuningRanges: [String: [String: Any]] = [:]
    @Published private(set) var tuningMessage: String?
    @Published private(set) var isSavingTuning = false
    @Published private(set) var isLoadingTuning = false
    @Published private(set) var tuningMutationLocked = false
    @Published private(set) var tuningMutationReason: String?
    @Published private(set) var investmentPresets: [[String: Any]] = []
    @Published var selectedMarket = "KRW-BTC"
    @Published private(set) var selectedCandleInterval = 5
    @Published private(set) var candles: [CoinPilotCandle] = []
    @Published private(set) var marketCoinDetail: CoinPilotCoinDetail?
    @Published private(set) var systemStatus: [String: Any] = [:]
    @Published private(set) var analysisResults: [CoinPilotAnalysisResult] = []
    @Published private(set) var analysisSummary: [String: Any] = [:]
    @Published private(set) var buyRecommendations: [CoinPilotRecommendation] = []
    @Published private(set) var sellRecommendations: [CoinPilotRecommendation] = []
    @Published private(set) var bundleSuggestions: [[String: Any]] = []
    @Published private(set) var newsArticles: [CoinPilotNewsArticle] = []
    @Published private(set) var newsSentiment: [String: Any] = [:]
    @Published private(set) var aiProviderStatus: [String: Any] = [:]
    @Published private(set) var aiEffectiveness: [String: Any] = [:]
    @Published private(set) var aiSessions: [CoinPilotAISession] = []
    @Published private(set) var aiEvents: [CoinPilotAIEvent] = []
    @Published private(set) var aiConsultations: [[String: Any]] = []
    @Published private(set) var aiConsultationMessage: String?
    @Published private(set) var strategyResearch: [String: Any] = [:]
    @Published private(set) var strategyReadiness: [String: Any] = [:]
    @Published private(set) var scalpingValidation: [String: Any] = [:]
    @Published private(set) var paperValidationState: [String: Any] = [:]
    @Published private(set) var momentumShadow: [String: Any] = [:]
    @Published private(set) var liveExecutionEvidence: [String: Any] = [:]
    @Published private(set) var portfolioAnalysis: [String: Any] = [:]
    @Published private(set) var statistics: [[String: Any]] = []
    @Published private(set) var optimizationSettings: [String: Any] = [:]
    @Published private(set) var optimizationHistory: [[String: Any]] = []
    @Published private(set) var backtestResults: [String: Any] = [:]
    @Published private(set) var optimalConfig: [String: Any] = [:]
    @Published private(set) var featureMessages: [String: String] = [:]
    @Published private(set) var loadingFeatures: Set<String> = []
    @Published private(set) var refreshingFeatureGroups: Set<String> = []
    @Published private(set) var featureLastSuccessfulAt: [String: Date] = [:]
    @Published private(set) var isRunningFeatureAction = false
    @Published private(set) var isRecordingSnapshot = false

    private let api: CoinPilotAPIProviding
    private let tokens: CoinPilotTokenProviding
    private let now: () -> Date
    private let pendingOrders: CoinPilotPendingOrderProviding
    private let bundledPreview: CoinPilotBundledPreviewDataSource
    private let localMarketDataSource: CoinPilotBundledMarketDataLoading?
    private let offlineReplayResultStore: any CoinPilotOfflineReplayResultPersisting
    private let offlineReplaySessionStore: any CoinPilotOfflineReplaySessionPersisting
    private let dataModeDefaultsKey: String
    private let offlineReplaySessionUptime: () -> TimeInterval
    private var currentServerURL: URL?
    private var requestGeneration = 0
    private var lastSuccessfulResourceAt: [String: Date] = [:]
    private var bootstrapped = false
    private var shouldInferWorkspaceFromLegacyURL = false
    private var localMarketDataLoadGeneration = 0
    private var offlineReplayGeneration = 0
    private var offlineReplaySessionGeneration = 0
    private var offlineReplaySessionOperationInFlight = false
    private var offlineReplaySessionRequest: CoinPilotOfflineReplay.Request?
    private var offlineReplaySessionResult: CoinPilotOfflineReplay.Result?
    private var offlineReplaySessionLastCheckpointUptime: TimeInterval?
    private var offlineReplaySessionPersistedCursor = 0
    private var mobileFeatureRequestGenerations: [String: Int] = [:]
    private var mobileFeatureGroupGenerations: [String: Int] = [:]
    private var pendingMobileFeatureGroupRefreshes: Set<String> = []
    private var liveStream: CoinPilotLiveEventStream?
    private var liveEventRefreshTask: Task<Void, Never>?
    private let bundledServers: CoinPilotBundledServerConfig

    init(
        api: CoinPilotAPIProviding = CoinPilotAPIClient(),
        tokens: CoinPilotTokenProviding? = nil,
        bundledPreview: CoinPilotBundledPreviewDataSource = CoinPilotBundledPreviewDataSource(),
        localMarketDataSource suppliedLocalMarketDataSource: CoinPilotBundledMarketDataLoading? = nil,
        configuredDataMode: String? = nil,
        pendingOrderStore: CoinPilotPendingOrderProviding? = nil,
        offlineReplayResultStore: any CoinPilotOfflineReplayResultPersisting = CoinPilotOfflineReplayFileStore.shared,
        offlineReplaySessionStore: any CoinPilotOfflineReplaySessionPersisting = CoinPilotOfflineReplaySessionCheckpointStore.shared,
        offlineReplaySessionUptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        bundledServers: CoinPilotBundledServerConfig = .load(),
        now: @escaping () -> Date = Date.init
    ) {
        self.api = api
        self.bundledServers = bundledServers
        self.now = now
#if targetEnvironment(simulator) || COINPILOT_TEST_SIMULATOR_TOKEN_STORE
        self.tokens = tokens ?? CoinPilotSimulatorTokenStore()
        self.pendingOrders = pendingOrderStore ?? CoinPilotMemoryPendingOrderStore()
#else
        self.tokens = tokens ?? CoinPilotTokenStore()
        self.pendingOrders = pendingOrderStore ?? CoinPilotKeychainPendingOrderStore()
#endif
        self.bundledPreview = bundledPreview
        self.offlineReplayResultStore = offlineReplayResultStore
        self.offlineReplaySessionStore = offlineReplaySessionStore
        self.offlineReplaySessionUptime = offlineReplaySessionUptime
        let savedWorkspaceName = UserDefaults.standard.string(forKey: Self.activeWorkspaceDefaultsKey)
        let workspace = CoinPilotWorkspaceMode(rawValue: savedWorkspaceName ?? "") ?? .paper
        let savedProfileAddress = UserDefaults.standard.string(forKey: workspace.addressDefaultsKey)
        let legacyAddress = UserDefaults.standard.string(forKey: Self.serverDefaultsKey)
        let storedAddress = savedProfileAddress ?? (savedWorkspaceName == nil ? legacyAddress : nil)
        let url = storedAddress.flatMap(URL.init(string:)).flatMap { ServerAddressPolicy.allows($0) ? $0 : nil }
            ?? bundledServers.url(for: workspace)
        shouldInferWorkspaceFromLegacyURL = savedWorkspaceName == nil && savedProfileAddress == nil && legacyAddress != nil
        let requestedMode = configuredDataMode ??
            (Bundle.main.object(forInfoDictionaryKey: "CoinPilotDataMode") as? String ?? "server")
        let configuredMode: String
        switch requestedMode {
        case "bundled-preview", "bundled-local": configuredMode = requestedMode
        default: configuredMode = "server"
        }
        let profileDefaultsKey = "\(Self.dataModeDefaultsKeyPrefix)\(configuredMode)"
        dataModeDefaultsKey = profileDefaultsKey
        let savedMode = UserDefaults.standard.string(forKey: profileDefaultsKey)
        let legacyMode = UserDefaults.standard.string(forKey: Self.legacyDataModeDefaultsKey)
        if savedMode == nil, legacyMode == configuredMode {
            UserDefaults.standard.set(legacyMode, forKey: profileDefaultsKey)
        }
        let selectedMode = savedMode ?? (legacyMode == configuredMode ? legacyMode : configuredMode)
        let bundledPreviewAvailable = bundledPreview.isAvailable
        let usesBundledPreview = selectedMode == "bundled-preview"
        canUseBundledPreview = bundledPreviewAvailable
        isBundledPreview = usesBundledPreview
        activeWorkspace = usesBundledPreview ? .paper : workspace
        let usesBundledLocalMarketData = configuredMode == "bundled-local"
        isBundledLocalMarketData = usesBundledLocalMarketData
        localMarketDataSource = usesBundledLocalMarketData
            ? (suppliedLocalMarketDataSource ?? CoinPilotBundledMarketDataSource())
            : nil
        currentServerURL = url
        serverAddress = url.map(Self.displayAddress) ?? ""
        serverDraft = url?.absoluteString ?? ""
        resourceStates = Dictionary(uniqueKeysWithValues: Self.resourceNames.map { ($0, .notRequested) })
        if !isBundledLocalMarketData, !usesBundledPreview, let url { restorePendingManualOrder(for: url) }
    }

    func state(for resource: String) -> CoinPilotResourceState {
        resourceStates[resource] ?? .notRequested
    }

    func freshnessLabel(for resource: String) -> String {
        if resource == "market-prices", isBundledLocalMarketData {
            guard let localMarketData else {
                return localMarketDataError == nil
                    ? "앱에 저장된 고정 시세 자료를 불러오는 중"
                    : "앱에 저장된 고정 시세 자료를 사용할 수 없어요"
            }
            return "자료 생성 시각 · \(CoinPilotFormatting.utcMarketTimestamp(localMarketData.generatedAt))"
        }
        let isMarketPrices = resource == "market-prices"
        let isMarketPreview = isMarketPrices && isBundledPreview
        let checkedLabel = isMarketPreview ? "예시 자료 기준" : isMarketPrices ? "앱 확인" : "확인"
        if isMarketPrices, let issue = marketSnapshotMetadata?.freshnessIssue {
            switch state(for: resource) {
            case .loading:
                if let lastSuccess = lastSuccessfulResourceAt[resource] {
                    return "\(issue) · \(checkedLabel) \(CoinPilotFormatting.time(lastSuccess)) · 새로 확인 중"
                }
                return "\(issue) · 새로 확인 중"
            case .current(let date):
                return "\(issue) · \(checkedLabel) \(CoinPilotFormatting.time(date))"
            case .stale(let date):
                return "\(issue) · 마지막 정상 시세 \(CoinPilotFormatting.time(date))"
            case .notRequested, .unavailable:
                return issue
            }
        }
        if isMarketPrices, !isMarketPreview {
            let staleMarketCount = markets.filter {
                $0.freshnessIssue(at: now(), maximumAgeSeconds: marketPriceMaximumAgeSeconds) != nil
            }.count
            if staleMarketCount > 0 {
                return "종목 \(staleMarketCount)개 시세가 오래됐어요 · 서버 수집 \(CoinPilotFormatting.time(marketSnapshotMetadata?.fetchedAtDate))"
            }
        }
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
        marketSnapshotMetadata?.fetchedAt
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
        guard !isBundledPreview, !isBundledLocalMarketData else { return nil }
        if status?.runtimeState == "SYNC_REQUIRED" || status?.exchangeStateKnown == false {
            return "설정한 시장의 거래소 잔고와 미체결 주문을 확인하고 있어요. 확인이 끝날 때까지 신규 주문을 잠급니다."
        }
        guard status?.runtimeState == "PROTECTIVE_ONLY" || status?.protectiveMonitorActive == true else { return nil }
        switch status?.stopReason {
        case "risk_data_gap":
            return "시세가 끊겨 분석과 신규 진입을 멈췄어요. 보유 포지션은 위험 감시 중이며, 재개 여부는 서버의 복구 설정과 점검 결과에 따라 달라집니다."
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

    var canOperate: Bool {
        !isBundledPreview && !isBundledLocalMarketData &&
            (!authenticationRequired || authenticationScope.canOperate) &&
            !isObserverAccount &&
            serverModeMatchesWorkspace
    }

    var showsLiveCredentialSetup: Bool {
        activeWorkspace == .live &&
            phase == .dashboard &&
            !isBundledPreview && !isBundledLocalMarketData &&
            serverModeMatchesWorkspace && status?.mode == "LIVE" &&
            status?.upbitCredentialsConfigured == false
    }

    var showsLiveCredentialSyncPending: Bool {
        activeWorkspace == .live &&
            phase == .dashboard &&
            !isBundledPreview && !isBundledLocalMarketData &&
            serverModeMatchesWorkspace && status?.mode == "LIVE" &&
            status?.upbitCredentialsConfigured == true &&
            !isLiveCredentialSetupReady
    }

    var isLiveCredentialSetupReady: Bool {
        guard status?.upbitCredentialsConfigured == true,
              status?.exchangeStateKnown == true else { return false }
        return status?.liveManualPrepareOnBoot != true || status?.liveManualPrepared == true
    }

    var canSubmitLiveCredentials: Bool {
        canUseLiveCredentialRegistration &&
            !isSubmittingLiveCredentials &&
            !liveAccessKeyDraft.isEmpty && !liveSecretKeyDraft.isEmpty
    }

    var currentLiveCredentialTransportIsSecure: Bool? {
        guard let currentServerURL else { return nil }
        return currentServerURL.scheme?.lowercased() == "https"
    }

    var canUseLiveCredentialRegistration: Bool {
        showsLiveCredentialSetup &&
            currentLiveCredentialTransportIsSecure == true &&
            (!authenticationRequired || authenticationScope.canOperate)
    }

    var canViewTuning: Bool {
        phase == .dashboard && !isBundledPreview && !isBundledLocalMarketData && serverModeMatchesWorkspace &&
            tradingMode == activeWorkspace.serverMode &&
            (!authenticationRequired || authenticationScope != .unauthenticated)
    }

    var workspaceModeMismatchMessage: String? {
        guard let serverMode = tradingMode, serverMode != activeWorkspace.serverMode else { return nil }
        let actual = serverMode == "LIVE" ? "실거래" : serverMode == "DRY_RUN" ? "모의투자" : "확인 불가"
        let nextStep = activeWorkspace == .live
            ? "같은 IP를 쓸 수 있지만 LIVE 서버의 다른 포트나 주소로 연결해야 합니다."
            : "모의투자 서버 주소를 확인해 주세요."
        return "현재 주소는 \(actual)(\(serverMode)) 서버입니다. \(activeWorkspace.serverMode) 모드가 필요합니다. \(nextStep)"
    }

    var tuningFields: [CoinPilotTuningField] {
        Self.mobileTuningKeyOrder.compactMap { key in
            let metadata = tuningRanges[key] ?? [:]
            let value = tuningValues[key]
            let fallback = Self.tuningFallbackMetadata[key] ?? [:]
            let label = (metadata["label"] as? String) ?? fallback["label"] ?? key
            let description = (metadata["description"] as? String) ?? fallback["description"] ?? ""
            let category = (metadata["category"] as? String) ?? fallback["category"] ?? "전략"

            if ["marketRegimeEnabled", "requireReboundBelowOverbought"].contains(key),
               let booleanValue = value as? Bool {
                return CoinPilotTuningField(
                    key: key, label: label, description: description, category: category,
                    value: nil, booleanValue: booleanValue, minimum: nil, maximum: nil,
                    step: nil, displayMultiplier: 1
                )
            }
            guard let numericValue = Self.number(value) else { return nil }
            return CoinPilotTuningField(
                key: key,
                label: label,
                description: description,
                category: category,
                value: numericValue,
                booleanValue: nil,
                minimum: Self.number(metadata["min"]),
                maximum: Self.number(metadata["max"]),
                step: Self.number(metadata["step"]),
                displayMultiplier: Self.number(metadata["displayMultiplier"]) ?? 1
            )
        }
    }

    var manualOrderBlockReason: String? {
        if isBundledLocalMarketData { return "앱에 저장된 고정 시세만 제공하는 모드라 계좌 연결이나 주문을 사용할 수 없습니다." }
        guard phase == .dashboard, !isBundledPreview else { return "서버 작업공간에서만 주문할 수 있습니다." }
        guard serverModeMatchesWorkspace, status?.mode == activeWorkspace.serverMode,
              account?.mode == activeWorkspace.serverMode else { return "선택한 실거래/모의투자 서버를 확인해 주세요." }
        guard !authenticationRequired || authenticationScope.canOperate else { return "조회 전용 토큰입니다. 운영 토큰을 연결해야 주문할 수 있습니다." }
        guard !isObserverAccount else { return "읽기 전용 서버에서는 주문할 수 없습니다." }
        guard supportsAmountCurrency else {
            return "\(quoteCurrency) 기준통화의 주문 금액 규칙을 아직 지원하지 않아요. 시세와 계좌는 조회할 수 있어요."
        }
        guard !pendingManualOrderLocked else { return "이전 주문 결과를 확인한 뒤에 새 주문을 보낼 수 있습니다." }
        guard !isSubmittingManualOrder else { return "주문 결과를 확인하고 있습니다." }
        if status?.runtimeState == "PROTECTIVE_ONLY" { return runtimeSafetyMessage ?? "위험 감시 상태에서는 새 주문을 보낼 수 없습니다." }
        if status?.runtimeState == "SYNC_REQUIRED" || status?.exchangeStateKnown == false {
            return runtimeSafetyMessage ?? "거래소 잔고와 미체결 주문을 확인할 때까지 주문을 잠급니다."
        }
        if activeWorkspace == .live,
           status?.isRunning == false,
           !["operator_stop", "operator_shutdown"].contains(status?.stopReason ?? "") {
            return "실거래 안전 상태를 확인할 때까지 주문을 잠급니다."
        }
        if activeWorkspace == .paper && paperValidationSummary?.active == true {
            return "모의투자 성과 점검 중에는 계좌를 변경할 수 없습니다."
        }
#if targetEnvironment(simulator)
        if activeWorkspace == .live { return "실거래 주문은 Simulator에서 잠겨 있습니다. 실제 기기의 TestFlight 앱을 사용하세요." }
#endif
        if marketSnapshotMetadata?.snapshotSource == "last_good" {
            return marketSnapshotMetadata?.freshnessIssue ?? "저장된 최근 시세를 표시 중이에요. 새 시세를 확인한 뒤 주문해 주세요."
        }
        guard state(for: "account").isCurrent, state(for: "market-prices").isCurrent else {
            return "계좌와 시세를 새로 확인한 뒤 주문할 수 있습니다."
        }
        return nil
    }

    var marketPriceMaximumAgeSeconds: TimeInterval {
        guard let value = status?.maxCandleAgeSeconds, value.isFinite, value > 0 else { return 90 }
        return value
    }

    func marketQuoteFreshnessIssue(for marketCode: String) -> String? {
        if isBundledLocalMarketData || isBundledPreview { return nil }
        guard let market = markets.first(where: { $0.coin == marketCode }) else {
            return "이 종목의 시세를 확인할 수 없어요"
        }
        return market.freshnessIssue(at: now(), maximumAgeSeconds: marketPriceMaximumAgeSeconds)
    }

    func marketQuoteFreshnessMessage(for marketCode: String) -> String {
        if isBundledLocalMarketData {
            return "출처와 최신 여부는 온라인으로 확인하지 않습니다."
        }
        if isBundledPreview {
            return "화면 구성 확인용 예시 시세입니다."
        }
        return marketQuoteFreshnessIssue(for: marketCode) ?? "최근 체결 시각을 확인했습니다."
    }

    func marketCandleOriginLabel(candleCount: Int) -> String {
        if isBundledLocalMarketData {
            return "앱에 저장된 고정 시세 자료 · 캔들 \(candleCount)개"
        }
        if isBundledPreview {
            return "화면 구성용 예시 자료 · 캔들 \(candleCount)개"
        }
        return "캔들 \(candleCount)개 · 서버가 수집한 시세"
    }

    func manualOrderBlockReason(for market: String) -> String? {
        if let baseReason = manualOrderBlockReason { return baseReason }
        guard let price = markets.first(where: { $0.coin == market }) else {
            return "선택한 종목의 현재 시세를 확인할 수 없습니다."
        }
        return price.freshnessIssue(at: now(), maximumAgeSeconds: marketPriceMaximumAgeSeconds)
    }

    func freshMarketPrice(for market: String) -> Double? {
        guard let price = markets.first(where: { $0.coin == market }),
              price.freshnessIssue(at: now(), maximumAgeSeconds: marketPriceMaximumAgeSeconds) == nil else {
            return nil
        }
        return price.price
    }

    func manualOrderBlockReason(forMarkets marketCodes: [String]) -> String? {
        if let baseReason = manualOrderBlockReason { return baseReason }
        guard !marketCodes.isEmpty else { return "주문할 종목을 확인할 수 없습니다." }
        var checkedMarkets = Set<String>()
        for market in marketCodes where checkedMarkets.insert(market).inserted {
            if let reason = manualOrderBlockReason(for: market) { return reason }
        }
        return nil
    }

    var tuningBlockReason: String? {
        guard !isBundledLocalMarketData else { return "앱에 저장된 고정 시세만 제공하는 모드라 설정 변경·계좌 연결·주문을 사용할 수 없습니다." }
        guard phase == .dashboard, !isBundledPreview else { return "서버 작업공간에서만 설정을 바꿀 수 있습니다." }
        guard !authenticationRequired || authenticationScope.canOperate else { return "운영 토큰이 있어야 설정을 변경할 수 있습니다." }
        guard serverModeMatchesWorkspace, status?.mode == activeWorkspace.serverMode else { return "선택한 서버 모드를 확인해 주세요." }
        if status?.isRunning == true { return "자동매매를 중지한 뒤 튜닝값을 바꿀 수 있습니다." }
        if tuningMutationLocked || paperValidationSummary?.active == true {
            return tuningMutationReason ?? "모의투자 성과 점검 중에는 설정을 바꿀 수 없습니다."
        }
        return nil
    }

    var optimizationBlockReason: String? {
        guard !isBundledLocalMarketData else { return "앱에 저장된 고정 시세만 제공하는 모드라 후보 비교·계좌 연결·주문을 사용할 수 없습니다." }
        guard phase == .dashboard, !isBundledPreview else { return "서버 작업공간에서만 후보 비교를 사용할 수 있습니다." }
        guard canOperate else { return "운영 토큰이 있어야 후보 비교를 바꿀 수 있습니다." }
        guard serverModeMatchesWorkspace, status?.mode == activeWorkspace.serverMode else { return "선택한 서버 모드를 확인해 주세요." }
        if tuningMutationLocked || paperValidationSummary?.active == true {
            return tuningMutationReason ?? "모의투자 성과 점검 중에는 후보 비교를 바꿀 수 없습니다."
        }
        return nil
    }

    var paperWalletBlockReason: String? {
        guard activeWorkspace == .paper, tradingMode == "DRY_RUN", !isObserverAccount else {
            return "모의 지갑은 연결된 모의투자 서버에서만 변경할 수 있습니다."
        }
        guard canOperate else { return "운영 토큰이 있어야 모의 지갑을 변경할 수 있습니다." }
        guard supportsAmountCurrency else {
            return "\(quoteCurrency) 기준통화는 모의 지갑 금액 변경을 아직 지원하지 않아요. 계좌 조회는 계속 이용할 수 있어요."
        }
        if pendingManualOrderLocked { return "이전 지갑 변경 결과를 확인한 뒤 다시 시도해 주세요." }
        if status?.isRunning == true { return "모의 자동매매를 중지한 뒤 가상 잔액을 바꿀 수 있습니다." }
        if paperValidationSummary?.active == true || tuningMutationLocked {
            return tuningMutationReason ?? "성과 점검 세션 중에는 모의 지갑을 바꿀 수 없습니다."
        }
        return nil
    }

    private var storePaperWalletLocked: Bool { paperWalletBlockReason != nil }
    private var storePaperWalletLockedReason: String { paperWalletBlockReason ?? "모의 지갑을 변경할 수 없습니다." }

    private static let tuningFallbackMetadata: [String: [String: String]] = [
        "marketRegimeEnabled": ["label": "시장 방향 필터", "description": "시장 방향과 맞지 않는 신규 진입을 제한합니다.", "category": "Risk"],
        "requireReboundBelowOverbought": ["label": "과매수 구간 진입 제한", "description": "과매수 구간의 반등 신호로 신규 진입하지 않습니다.", "category": "Risk"]
    ]

    func bootstrap() async {
        guard !bootstrapped else { return }
        bootstrapped = true
        if isBundledLocalMarketData {
            phase = .dashboard
            didFinishInitialConnect = true
            await loadBundledLocalMarketData()
            return
        }
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

    func selectWorkspace(_ workspace: CoinPilotWorkspaceMode) {
        guard !isBundledLocalMarketData else { return }
        guard workspace != activeWorkspace else { return }
        guard !isWorking && !isSavingTuning && !isSubmittingManualOrder && !isSubmittingLiveCredentials && !isRunningFeatureAction && !isRecordingSnapshot else {
            dashboardMessage = isSubmittingManualOrder
                ? "주문 결과를 확인하는 동안에는 작업공간을 전환할 수 없습니다."
                : isSubmittingLiveCredentials
                    ? "Upbit API 키 등록이 끝난 뒤 작업공간을 전환할 수 있습니다."
                : "서버 작업을 마친 뒤 작업공간을 전환할 수 있습니다."
            return
        }
        if let currentServerURL, serverModeMatchesWorkspace {
            UserDefaults.standard.set(currentServerURL.absoluteString, forKey: activeWorkspace.addressDefaultsKey)
        }
        activeWorkspace = workspace
        UserDefaults.standard.set(workspace.rawValue, forKey: Self.activeWorkspaceDefaultsKey)
        shouldInferWorkspaceFromLegacyURL = false
        _ = beginRequestGeneration()
        stopLiveStream()
        clearLoadedData()
        isBundledPreview = false
        authenticationRequired = false
        authenticationScope = .unauthenticated
        serverModeMatchesWorkspace = true
        connectionMessage = nil
        dashboardMessage = nil
        tokenDraft = ""
        liveCredentialMessage = nil
        liveAccessKeyDraft = ""
        liveSecretKeyDraft = ""
        pendingManualOrder = nil
        pendingManualOrderLocked = false
        orderMessage = nil

        let storedURL = UserDefaults.standard.string(forKey: workspace.addressDefaultsKey)
            .flatMap(URL.init(string:))
            .flatMap { ServerAddressPolicy.allows($0) ? $0 : nil }
        guard let url = storedURL ?? bundledServers.url(for: workspace) else {
            currentServerURL = nil
            serverAddress = ""
            serverDraft = ""
            serverModeMatchesWorkspace = false
            phase = .setup
            didFinishInitialConnect = true
            return
        }
        currentServerURL = url
        serverAddress = Self.displayAddress(url)
        serverDraft = url.absoluteString
        restorePendingManualOrder(for: url)
        serverModeMatchesWorkspace = false
        phase = .connecting
        Task { _ = await connect(using: url.absoluteString) }
    }

    func useBundledPreview() {
        guard !isBundledLocalMarketData else {
            connectionMessage = "이 빌드는 앱에 저장된 고정 시세만 표시하며 계좌 연결이나 주문은 제공하지 않습니다."
            return
        }
        guard bundledPreview.isAvailable else {
            connectionMessage = "예시 데이터가 포함된 앱 빌드에서만 미리보기를 사용할 수 있어요."
            return
        }
        _ = beginRequestGeneration()
        stopLiveStream()
        isBundledPreview = true
        activeWorkspace = .paper
        UserDefaults.standard.set(CoinPilotWorkspaceMode.paper.rawValue, forKey: Self.activeWorkspaceDefaultsKey)
        UserDefaults.standard.set("bundled-preview", forKey: dataModeDefaultsKey)
        authenticationRequired = false
        authenticationScope = .unauthenticated
        connectionMessage = nil
        tokenDraft = ""
        clearLoadedData()
        serverModeMatchesWorkspace = true
        phase = .dashboard
        didFinishInitialConnect = true
        Task { await refresh() }
    }

    func useServerMode() {
        guard !isBundledLocalMarketData else { return }
        _ = beginRequestGeneration()
        stopLiveStream()
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
        guard !isBundledLocalMarketData else { return false }
        guard !isSubmittingLiveCredentials else { return false }
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
        authenticationScope = .unauthenticated
        serverModeMatchesWorkspace = false

        currentServerURL = url
        serverDraft = url.absoluteString
        serverAddress = Self.displayAddress(url)
        restorePendingManualOrder(for: url)
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
            applyExchangeProfile(
                exchange: body["exchange"] as? String,
                quoteCurrency: body["quoteCurrency"] as? String
            )
            authenticationRequired = authRequired
            guard authRequired else {
                authenticationScope = .unauthenticated
                phase = .dashboard
                await refresh()
                return generation == requestGeneration && serverModeMatchesWorkspace
            }

            let savedToken = tokens.token(for: url)
            let isBundledAddress = bundledServers.url(for: .paper) == url || bundledServers.url(for: .live) == url
            guard let token = savedToken ?? (isBundledAddress ? bundledServers.token : nil) else {
                authenticationScope = .unauthenticated
                phase = .login
                return false
            }
            let loginResponse = try await api.login(token: token, at: url)
            guard generation == requestGeneration, currentServerURL == url else { return false }
            guard (200..<300).contains(loginResponse.statusCode),
                  (try? Self.jsonObject(loginResponse.body) as? [String: Any])?["success"] as? Bool == true else {
                if loginResponse.statusCode == 401 {
                    tokens.delete(for: url)
                    authenticationScope = .unauthenticated
                    phase = .login
                    connectionMessage = "서버 인증을 확인할 수 없습니다. 서버 토큰을 다시 입력해 주세요."
                    return false
                }
                throw CoinPilotAPIError.forStatusCode(loginResponse.statusCode)
            }
            authenticationScope = Self.authScope(from: loginResponse)
            if savedToken == nil { _ = tokens.save(token, for: url) }
            let protectedResponse = try await api.read(path: "/api/status", at: url, token: token)
            guard generation == requestGeneration, currentServerURL == url else { return false }
            guard (200..<300).contains(protectedResponse.statusCode) else {
                if protectedResponse.statusCode == 401 {
                    tokens.delete(for: url)
                    authenticationScope = .unauthenticated
                    phase = .login
                    connectionMessage = "서버 인증을 확인할 수 없습니다. 서버 토큰을 다시 입력해 주세요."
                    return false
                }
                throw CoinPilotAPIError.forStatusCode(protectedResponse.statusCode)
            }
            phase = .dashboard
            await refresh()
            return generation == requestGeneration && serverModeMatchesWorkspace
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
        guard !isBundledLocalMarketData else { return false }
        guard !isSubmittingLiveCredentials else { return false }
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
        restorePendingManualOrder(for: url)
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverDefaultsKey)
        authenticationScope = .unauthenticated
        serverModeMatchesWorkspace = false
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
            applyExchangeProfile(
                exchange: statusBody["exchange"] as? String,
                quoteCurrency: statusBody["quoteCurrency"] as? String
            )
            authenticationRequired = authRequired
        if authRequired {
            let loginResponse = try await api.login(token: token, at: url)
            guard generation == requestGeneration, currentServerURL == url else { return false }
            guard (200..<300).contains(loginResponse.statusCode),
                  let loginBody = try? Self.jsonObject(loginResponse.body) as? [String: Any],
                  loginBody["success"] as? Bool == true else {
                throw CoinPilotAPIError.forStatusCode(loginResponse.statusCode)
            }
            authenticationScope = Self.authScope(from: loginResponse)
            guard tokens.save(token, for: url) else { throw CoinPilotAPIError.keychain }
        } else {
            authenticationScope = .unauthenticated
        }
            tokenDraft = ""
        phase = .dashboard
        await refresh()
        return generation == requestGeneration && serverModeMatchesWorkspace
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

    @discardableResult
    func submitLiveCredentials() async -> Bool {
        guard !isSubmittingLiveCredentials else {
            liveAccessKeyDraft = ""
            liveSecretKeyDraft = ""
            return false
        }

        let accessKey = liveAccessKeyDraft
        let secretKey = liveSecretKeyDraft
        defer {
            liveAccessKeyDraft = ""
            liveSecretKeyDraft = ""
            isSubmittingLiveCredentials = false
        }
        liveCredentialMessage = nil

        guard showsLiveCredentialSetup,
              let serverURL = currentServerURL,
              serverURL.scheme?.lowercased() == "https",
              serverModeMatchesWorkspace,
              status?.mode == "LIVE",
              activeWorkspace == .live else {
            liveCredentialMessage = "실거래 모드가 확인된 HTTPS 서버에서만 키를 등록할 수 있어요."
            return false
        }
        guard authenticationRequired
                ? authenticationScope.canOperate && tokens.token(for: serverURL)?.isEmpty == false
                : true else {
            liveCredentialMessage = "운영 권한이 있는 서버 토큰으로 로그인해 주세요."
            return false
        }
        let token = requestBearerToken(for: serverURL)
        guard accessKey == accessKey.trimmingCharacters(in: .whitespacesAndNewlines),
              secretKey == secretKey.trimmingCharacters(in: .whitespacesAndNewlines),
              !accessKey.isEmpty,
              !secretKey.isEmpty,
              accessKey.utf8.count <= 4096,
              secretKey.utf8.count <= 4096 else {
            liveCredentialMessage = "Upbit Access Key와 Secret Key를 확인해 주세요."
            return false
        }

        isSubmittingLiveCredentials = true
        do {
            let response = try await api.registerLiveCredentials(
                accessKey: accessKey,
                secretKey: secretKey,
                at: serverURL,
                token: token
            )
            liveAccessKeyDraft = ""
            liveSecretKeyDraft = ""
            guard currentServerURL == serverURL, activeWorkspace == .live,
                  serverModeMatchesWorkspace, status?.mode == "LIVE" else {
                return false
            }
            guard (200..<300).contains(response.statusCode),
                  (try? Self.jsonObject(response.body) as? [String: Any])?["success"] as? Bool == true else {
                throw CoinPilotAPIError.forStatusCode(response.statusCode)
            }

            liveCredentialMessage = "Upbit 키 등록 요청을 보냈어요. 서버의 등록 상태와 거래소 계좌 동기화를 확인하고 있습니다."
            await refresh()
            if isLiveCredentialSetupReady {
                liveCredentialMessage = "Upbit 키 등록과 거래소 계좌 동기화가 확인됐어요."
            } else if status?.upbitCredentialsConfigured == true {
                liveCredentialMessage = "Upbit 키가 등록됐어요. 잔고와 미체결 주문 확인이 끝날 때까지 실거래 주문은 잠겨 있습니다."
            } else {
                liveCredentialMessage = "서버에서 키 등록 상태를 확인하지 못했어요. 키는 입력란에서 지웠습니다."
            }
            return true
        } catch let error as CoinPilotAPIError {
            liveCredentialMessage = error.message
            return false
        } catch {
            liveCredentialMessage = CoinPilotAPIError.connection.message
            return false
        }
    }

    func updateServerAddress(_ rawAddress: String) async -> Bool {
        guard !isBundledLocalMarketData else { return false }
        guard !isSubmittingLiveCredentials else {
            liveCredentialMessage = "Upbit 키 등록이 끝난 뒤 서버 주소를 바꿀 수 있습니다."
            return false
        }
        guard let url = validatedServerURL(rawAddress) else {
            connectionMessage = "같은 Wi-Fi의 서버는 내부 주소로 연결하고, 외부 서버는 HTTPS 주소를 입력해 주세요."
            return false
        }
        return await connect(using: url.absoluteString)
    }

    func updateServerToken(_ rawToken: String) async -> String? {
        guard !isBundledLocalMarketData else {
            return "앱에 저장된 고정 시세만 제공하는 모드라 서버 토큰·계좌 연결·주문을 사용할 수 없습니다."
        }
        guard !isBundledPreview else {
            return "예시 데이터 화면에서는 토큰을 입력할 수 없습니다. 실제 서버에 연결해 주세요."
        }
        guard let serverURL = currentServerURL else {
            return "먼저 실제 서버에 연결해 주세요."
        }
        guard !isWorking, !isSubmittingManualOrder, !isRunningFeatureAction,
              !isRecordingSnapshot, !isSavingTuning else {
            return "진행 중인 서버 작업이 끝난 뒤 토큰을 변경해 주세요."
        }

        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.utf8.count <= 4096 else {
            return "서버 토큰을 입력해 주세요."
        }

        let generation = beginRequestGeneration()
        isWorking = true
        defer {
            if generation == requestGeneration { isWorking = false }
        }

        do {
            let statusResponse = try await api.authenticationStatus(at: serverURL)
            guard generation == requestGeneration, currentServerURL == serverURL else { return "서버 연결 정보가 변경되었습니다. 다시 시도해 주세요." }
            guard (200..<300).contains(statusResponse.statusCode),
                  let statusBody = try? Self.jsonObject(statusResponse.body) as? [String: Any],
                  let authRequired = statusBody["authRequired"] as? Bool else {
                throw CoinPilotAPIError.forStatusCode(statusResponse.statusCode)
            }
            applyExchangeProfile(
                exchange: statusBody["exchange"] as? String,
                quoteCurrency: statusBody["quoteCurrency"] as? String
            )
            guard authRequired else {
                authenticationRequired = false
                authenticationScope = .unauthenticated
                await refresh()
                return "이 서버는 토큰 인증을 사용하지 않습니다. 서버 인증 설정을 확인해 주세요."
            }

            let loginResponse = try await api.login(token: token, at: serverURL)
            guard generation == requestGeneration, currentServerURL == serverURL else { return "서버 연결 정보가 변경되었습니다. 다시 시도해 주세요." }
            guard (200..<300).contains(loginResponse.statusCode),
                  let loginBody = try? Self.jsonObject(loginResponse.body) as? [String: Any],
                  loginBody["success"] as? Bool == true else {
                throw CoinPilotAPIError.forStatusCode(loginResponse.statusCode)
            }
            let scope = Self.authScope(from: loginResponse)
            authenticationScope = scope
            authenticationRequired = true
            guard tokens.save(token, for: serverURL) else { throw CoinPilotAPIError.keychain }

            await refresh()
            guard phase == .dashboard else {
                return connectionMessage ?? "새 토큰으로 서버 정보를 불러오지 못했습니다. 토큰과 서버 설정을 확인해 주세요."
            }
            return nil
        } catch let error as CoinPilotAPIError {
            guard generation == requestGeneration else { return "서버 연결 정보가 변경되었습니다. 다시 시도해 주세요." }
            await refresh()
            return error.message
        } catch {
            guard generation == requestGeneration else { return "서버 연결 정보가 변경되었습니다. 다시 시도해 주세요." }
            await refresh()
            return CoinPilotAPIError.connection.message
        }
    }

    func logOut() {
        _ = beginRequestGeneration()
        stopLiveStream()
        if let currentServerURL { tokens.delete(for: currentServerURL) }
        clearLoadedData()
        connectionMessage = nil
        tokenDraft = ""
        authenticationScope = .unauthenticated
        serverModeMatchesWorkspace = true
        phase = currentServerURL == nil ? .setup : .login
    }

    // /api/stream SSE 채널 — 네이티브 앱은 Socket.IO를 번들하지 않으므로
    // 같은 브로드캐스트 이벤트를 이 경로로 받는다. 읽기 전용 토큰 등
    // 스트림이 허용되지 않는 자격증명은 조용히 폴링으로 유지한다.
    private func syncLiveStream() {
        guard phase == .dashboard,
              !isBundledPreview,
              !isBundledLocalMarketData,
              let serverURL = currentServerURL,
              let streamURL = CoinPilotAPIClient.requestURL(path: "/api/stream", serverURL: serverURL) else {
            stopLiveStream()
            return
        }
        let token = authenticationRequired ? tokens.token(for: serverURL) : nil
        if authenticationRequired && token == nil {
            stopLiveStream()
            return
        }
        if liveStream == nil {
            liveStream = CoinPilotLiveEventStream(
                onEvent: { [weak self] _ in self?.scheduleLiveEventRefresh() },
                onConnectionChange: { [weak self] connected in self?.liveEventsConnected = connected }
            )
        }
        liveStream?.start(url: streamURL, token: token)
    }

    /// 인증이 꺼진 서버(개인용 LAN 모드)에서는 nil을 반환해 Authorization 헤더를
    /// 생략한다. 인증이 켜진 서버에서는 저장된 토큰이 있어야 쓰기 요청을 보낸다.
    private func requestBearerToken(for serverURL: URL) -> String? {
        authenticationRequired ? tokens.token(for: serverURL) : nil
    }

    private func hasRequestCredentials(for serverURL: URL) -> Bool {
        !authenticationRequired || tokens.token(for: serverURL) != nil
    }

    private func stopLiveStream() {
        liveStream?.stop()
        liveEventRefreshTask?.cancel()
        liveEventRefreshTask = nil
        liveEventsConnected = false
    }

    private func scheduleLiveEventRefresh() {
        lastLiveEventAt = now()
        liveEventRefreshTask?.cancel()
        liveEventRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    func refresh() async {
        syncLiveStream()
        guard phase == .dashboard, !isRefreshing else { return }
        if isBundledLocalMarketData {
            await loadBundledLocalMarketData()
            return
        }
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
        let updatedAt = usesBundledPreview ? bundledPreview.generatedAt ?? now() : now()
        for name in Self.resourceNames { resourceStates[name] = .loading }

        let statusResult = await fetch("/api/status", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        guard generation == requestGeneration,
              serverURL == currentServerURL,
              usesBundledPreview == isBundledPreview,
              phase == .dashboard else { return }
        let preflightCancelled: Bool
        if case .failure(.cancelled) = statusResult {
            preflightCancelled = true
        } else {
            preflightCancelled = false
        }
        if Task.isCancelled || preflightCancelled {
            for name in Self.resourceNames { markResourceFailed(name) }
            return
        }
        if case .success(let response) = statusResult,
           response.statusCode == 401,
           authenticationRequired,
           let serverURL {
            tokens.delete(for: serverURL)
            _ = beginRequestGeneration()
            clearLoadedData()
            isRefreshing = false
            authenticationScope = .unauthenticated
            phase = .login
            connectionMessage = "서버 인증을 확인할 수 없습니다. 서버 토큰을 다시 입력해 주세요."
            return
        }

        let preflightStatus = decodeDictionary(statusResult).map(CoinPilotStatus.init)
        if shouldInferWorkspaceFromLegacyURL,
           let mode = preflightStatus?.mode,
           let inferredWorkspace = CoinPilotWorkspaceMode.allCases.first(where: { $0.serverMode == mode }) {
            activeWorkspace = inferredWorkspace
            UserDefaults.standard.set(inferredWorkspace.rawValue, forKey: Self.activeWorkspaceDefaultsKey)
            shouldInferWorkspaceFromLegacyURL = false
        }
        let statusResponse: CoinPilotHTTPResponse? = {
            if case .success(let response) = statusResult { return response }
            return nil
        }()
        guard let preflightStatus,
              preflightStatus.mode == activeWorkspace.serverMode else {
            clearLoadedData()
            status = preflightStatus
            serverModeMatchesWorkspace = false
            if let statusResponse, (200..<300).contains(statusResponse.statusCode), preflightStatus != nil {
                rawResponses["status"] = statusResponse
                markResourceLoaded("status", at: updatedAt)
            } else {
                markResourceFailed("status")
            }
            for name in Self.resourceNames where name != "status" {
                resourceStates[name] = .unavailable
            }
            dashboardMessage = usesBundledPreview
                ? "앱에 포함된 예시 자료를 불러오지 못했어요."
                : preflightStatus == nil
                    ? "서버 거래 모드를 확인할 수 없어 계좌 정보를 불러오지 않았어요."
                    : workspaceModeMismatchMessage ?? "서버 거래 모드를 확인할 수 없어 화면을 잠갔습니다."
            return
        }

        status = preflightStatus
        serverModeMatchesWorkspace = true
        rawResponses["status"] = statusResponse
        markResourceLoaded("status", at: updatedAt)
        if !usesBundledPreview, let serverURL {
            UserDefaults.standard.set(serverURL.absoluteString, forKey: activeWorkspace.addressDefaultsKey)
            UserDefaults.standard.set(activeWorkspace.rawValue, forKey: Self.activeWorkspaceDefaultsKey)
            UserDefaults.standard.set(serverURL.absoluteString, forKey: Self.serverDefaultsKey)
        }

        async let accountResult = fetch("/api/account", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let pnlResult = fetch("/api/cumulative-pnl", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let todayResult = fetch("/api/today-summary", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let historyResult = fetch("/api/portfolio/history?period=\(selectedPeriod.rawValue)", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let marketResult = fetch("/api/market/prices/snapshot", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let tradesResult = fetch("/api/trades?limit=30", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)
        async let paperSummaryResult = fetch("/api/paper-validation/summary", token: token, at: serverURL, usesBundledPreview: usesBundledPreview)

        let featureResults = await (accountResult, pnlResult, todayResult, historyResult, marketResult, tradesResult, paperSummaryResult)
        guard generation == requestGeneration,
              serverURL == currentServerURL,
              usesBundledPreview == isBundledPreview,
              phase == .dashboard,
              !Task.isCancelled else {
            if generation == requestGeneration {
                for name in Self.resourceNames.dropFirst() { markResourceFailed(name) }
            }
            return
        }
        let results = (
            statusResult,
            featureResults.0,
            featureResults.1,
            featureResults.2,
            featureResults.3,
            featureResults.4,
            featureResults.5,
            featureResults.6
        )
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
                authenticationScope = .unauthenticated
                phase = .login
                connectionMessage = "서버 인증을 확인할 수 없습니다. 서버 토큰을 다시 입력해 주세요."
                return
            }
        }

        var failures = 0
        var successes = 0
        if let object = decodeDictionary(results.0) {
            let newStatus = CoinPilotStatus(object)
            if shouldInferWorkspaceFromLegacyURL,
               let mode = newStatus.mode,
               let inferredWorkspace = CoinPilotWorkspaceMode.allCases.first(where: { $0.serverMode == mode }) {
                activeWorkspace = inferredWorkspace
                UserDefaults.standard.set(inferredWorkspace.rawValue, forKey: Self.activeWorkspaceDefaultsKey)
                shouldInferWorkspaceFromLegacyURL = false
            }
            guard newStatus.mode == activeWorkspace.serverMode else {
                clearLoadedData()
                status = newStatus
                serverModeMatchesWorkspace = false
                dashboardMessage = workspaceModeMismatchMessage ?? "서버 거래 모드를 확인할 수 없어 화면을 잠갔습니다."
                markResourceLoaded("status", at: updatedAt)
                return
            }
            serverModeMatchesWorkspace = true
            if !usesBundledPreview, let serverURL {
                UserDefaults.standard.set(serverURL.absoluteString, forKey: activeWorkspace.addressDefaultsKey)
                UserDefaults.standard.set(activeWorkspace.rawValue, forKey: Self.activeWorkspaceDefaultsKey)
                UserDefaults.standard.set(serverURL.absoluteString, forKey: Self.serverDefaultsKey)
            }
            status = newStatus
            applyExchangeProfile(exchange: newStatus.exchange, quoteCurrency: newStatus.quoteCurrency)
            markResourceLoaded("status", at: updatedAt)
            successes += 1
        } else {
            serverModeMatchesWorkspace = false
            markResourceFailed("status")
            failures += 1
        }

        if let object = decodeDictionary(results.1) {
            let decodedAccount = CoinPilotAccount(object)
            if decodedAccount.mode == tradingMode {
                account = decodedAccount
                markResourceLoaded("account", at: updatedAt)
                successes += 1
            } else {
                account = nil
                markResourceFailed("account")
                failures += 1
                dashboardMessage = "계좌 모드와 서버 모드가 일치하지 않아 자산·주문 화면을 잠갔습니다."
            }
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

        if let object = decodeDictionary(results.5) {
            marketSnapshotMetadata = CoinPilotMarketSnapshotMetadata(object)
            if let values = object["prices"] as? [[String: Any]] {
                markets = values.map(CoinPilotMarketPrice.init)
            } else {
                markets = []
            }
            if !markets.contains(where: { $0.coin == selectedMarket }) {
                selectedMarket = markets.first?.coin ?? "KRW-BTC"
            }
            if object["prices"] is [[String: Any]],
               let currentFetchedAt = marketSnapshotMetadata?.currentFetchedAt(
                at: updatedAt,
                maximumAgeSeconds: marketPriceMaximumAgeSeconds
               ) {
                markResourceLoaded("market-prices", at: currentFetchedAt)
                successes += 1
            } else {
                markResourceFailed("market-prices")
                failures += 1
            }
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

    func loadMarketDetail(coin: String? = nil, interval: Int? = nil) async {
        let requestedMarket = coin?.uppercased() ?? selectedMarket
        let requestedInterval = interval.flatMap { [1, 5, 15, 60].contains($0) ? $0 : nil } ?? selectedCandleInterval
        let selectionChanged = requestedMarket != selectedMarket || requestedInterval != selectedCandleInterval
        selectedMarket = requestedMarket
        selectedCandleInterval = requestedInterval
        if selectionChanged {
            candles = []
            marketCoinDetail = nil
            featureMessages.removeValue(forKey: "market")
            featureMessages.removeValue(forKey: "market-detail")
            offlineReplayMessage = nil
        }
        guard selectedMarket.range(of: "^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil else {
            featureMessages["market"] = "시장 코드를 확인해 주세요."
            candles = []
            marketCoinDetail = nil
            return
        }
        if isBundledLocalMarketData {
            guard localMarketDataError == nil, let market = localMarketData?.markets.first(where: { $0.market == selectedMarket }) else {
                featureMessages["market"] = localMarketDataError ?? "앱에 저장된 고정 시세 자료에 이 원화 시장이 없습니다."
                candles = []
                return
            }
            let availableIntervals = Array(Set(market.candles.map(\.intervalMinutes))).sorted()
            guard let resolvedInterval = availableIntervals.contains(selectedCandleInterval)
                ? selectedCandleInterval
                : availableIntervals.first else {
                featureMessages["market"] = "이 시장의 캔들 자료가 없습니다."
                candles = []
                return
            }
            selectedCandleInterval = resolvedInterval
            let rows = market.candles.filter { $0.intervalMinutes == resolvedInterval }
            let visibleRows = Array(rows.suffix(Self.maximumBundledLocalChartCandles))
            candles = visibleRows.enumerated().map { index, candle in
                CoinPilotCandle([
                    "time": candle.timestamp,
                    "open": candle.open,
                    "high": candle.high,
                    "low": candle.low,
                    "close": candle.close,
                    "volume": candle.volume
                ], index: index)
            }
            featureMessages.removeValue(forKey: "market")
            return
        }
        guard markets.contains(where: { $0.coin == selectedMarket }) || !markets.isEmpty else {
            featureMessages["market"] = "현재 작업공간의 시세 목록을 먼저 불러와 주세요."
            return
        }
        let path = "/api/market/candles/\(selectedMarket)?unit=\(selectedCandleInterval)&count=100"
        guard let payload = await loadMobileFeature("market", path: path),
              let values = payload as? [[String: Any]] else { return }
        candles = values.enumerated().map { CoinPilotCandle($0.element, index: $0.offset) }

        // 보유·지표·주문 한도는 차트와 별도 채널로 불러오고, 실패해도 차트를 유지한다.
        if let detailPayload = await loadMobileFeature(
            "market-detail",
            path: "/api/coin-detail/\(selectedMarket)"
        ) as? [String: Any] {
            marketCoinDetail = CoinPilotCoinDetail(detailPayload)
        }
    }

    /// 서버 가동 시간·최근 오류·마지막 거래 등 시스템 요약 (설정 화면 표시용).
    @discardableResult
    func loadSystemStatus() async -> Bool {
        guard let payload = await loadMobileFeature("system", path: "/api/system-status"),
              let dict = payload as? [String: Any] else { return false }
        systemStatus = dict
        return true
    }

    @discardableResult
    func runBundledOfflineReplay(marketCode: String, intervalMinutes: Int) async -> Bool {
        guard isBundledLocalMarketData else {
            offlineReplayMessage = "과거 재생은 앱에 저장된 고정 시세 자료 모드에서만 가능합니다. 이 모드에서는 계좌 연결이나 주문을 할 수 없습니다."
            return false
        }
        guard !isPreparingOfflineReplaySession,
              offlineReplaySessionCheckpoint?.status != .playing,
              offlineReplaySessionCheckpoint?.status != .paused else {
            offlineReplayMessage = "재생 세션을 먼저 일시정지하거나 처음부터 다시 설정해 주세요."
            return false
        }
        guard !isRunningOfflineReplay else { return false }
        if let blockReason = offlineReplayBlockReason(forMarket: marketCode, intervalMinutes: intervalMinutes) {
            offlineReplayResult = nil
            offlineReplayMessage = blockReason
            return false
        }
        guard localMarketDataError == nil, let dataset = localMarketData,
              let market = dataset.markets.first(where: { $0.market == marketCode }),
              localMarketIntervals(for: marketCode).contains(intervalMinutes) else {
            offlineReplayResult = nil
            offlineReplayMessage = "선택한 시장과 간격의 고정 시세 자료가 앱에 저장되어 있지 않습니다."
            return false
        }

        let sourceRows = market.candles.filter { $0.intervalMinutes == intervalMinutes }
        guard !sourceRows.isEmpty else {
            offlineReplayResult = nil
            offlineReplayMessage = "재생할 캔들 자료가 없습니다."
            return false
        }
        var replayCandles: [CoinPilotOfflineReplay.Candle] = []
        replayCandles.reserveCapacity(sourceRows.count)
        for candle in sourceRows {
            guard let date = CoinPilotBundledMarketData.utcDate(from: candle.timestamp) else {
                offlineReplayResult = nil
                offlineReplayMessage = "캔들 시각을 읽을 수 없어 재생을 중단했습니다."
                return false
            }
            let timestampMilliseconds = date.timeIntervalSince1970 * 1_000
            guard timestampMilliseconds.isFinite,
                  timestampMilliseconds > Double(Int64.min),
                  timestampMilliseconds < Double(Int64.max) else {
                offlineReplayResult = nil
                offlineReplayMessage = "캔들 시각이 지원 범위를 벗어나 재생을 중단했습니다."
                return false
            }
            replayCandles.append(CoinPilotOfflineReplay.Candle(
                timestampMilliseconds: Int64(timestampMilliseconds.rounded()),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume
            ))
        }

        let request = CoinPilotOfflineReplay.Request(
            market: marketCode,
            intervalMinutes: intervalMinutes,
            source: dataset.source,
            generatedAt: dataset.generatedAt,
            candles: replayCandles
        )
        offlineReplayResult = nil
        offlineReplayMessage = nil
        offlineReplayPersistenceMessage = nil
        offlineReplayGeneration += 1
        let replayGeneration = offlineReplayGeneration
        isRunningOfflineReplay = true
        defer {
            if offlineReplayGeneration == replayGeneration {
                isRunningOfflineReplay = false
            }
        }

        do {
            let result = try await Task.detached(priority: .userInitiated) {
                try CoinPilotOfflineReplay.run(request)
            }.value
            guard offlineReplayGeneration == replayGeneration, isBundledLocalMarketData else { return false }
            offlineReplayResult = result
            do {
                offlineReplayResults = try await offlineReplayResultStore.save(result)
                offlineReplayPersistenceMessage = nil
            } catch {
                offlineReplayPersistenceMessage = "재생은 끝났지만 이 기기에 기록을 저장하지 못했습니다."
            }
            return true
        } catch {
            offlineReplayMessage = (error as? LocalizedError)?.errorDescription ??
                "자료를 확인한 뒤 과거 재생을 완료하지 못했습니다."
            return false
        }
    }

    func offlineReplayBlockReason(forMarket marketCode: String, intervalMinutes: Int) -> String? {
        guard isBundledLocalMarketData,
              localMarketDataError == nil,
              let market = localMarketData?.markets.first(where: { $0.market == marketCode }),
              [1, 5, 15, 60].contains(intervalMinutes),
              market.candles.contains(where: { $0.intervalMinutes == intervalMinutes }) else {
            return "앱에 저장된 고정 시세 자료에 선택한 시장과 간격이 없습니다."
        }
        if intervalMinutes > CoinPilotOfflineReplay.maximumHoldMinutes {
            return CoinPilotOfflineReplay.ReplayError.intervalTooCoarse(
                intervalMinutes: intervalMinutes,
                maximumHoldMinutes: CoinPilotOfflineReplay.maximumHoldMinutes
            ).errorDescription
        }
        let count = market.candles.reduce(into: 0) { total, candle in
            if candle.intervalMinutes == intervalMinutes { total += 1 }
        }
        guard count >= CoinPilotOfflineReplay.minimumCandleCount else {
            return CoinPilotOfflineReplay.ReplayError.insufficientCandles(
                minimum: CoinPilotOfflineReplay.minimumCandleCount
            ).errorDescription
        }
        return nil
    }

    func offlineReplaySessionDelayNanoseconds(forMarket marketCode: String, intervalMinutes: Int) -> UInt64? {
        guard isBundledLocalMarketData,
              offlineReplaySessionRecoveryMessage == nil,
              offlineReplaySessionMessage == nil,
              !isUpdatingOfflineReplaySession,
              let checkpoint = offlineReplaySessionCheckpoint,
              checkpoint.status == .playing,
              checkpoint.market == marketCode,
              checkpoint.intervalMinutes == intervalMinutes,
              let speed = checkpoint.playbackSpeed else {
            return nil
        }
        return speed.sleepNanoseconds
    }

    func offlineReplaySessionPlaybackTaskID(forMarket marketCode: String, intervalMinutes: Int) -> String {
        guard let checkpoint = offlineReplaySessionCheckpoint,
              checkpoint.market == marketCode,
              checkpoint.intervalMinutes == intervalMinutes,
              let speed = checkpoint.playbackSpeed else {
            return "idle-\(marketCode)-\(intervalMinutes)"
        }
        return "\(checkpoint.datasetFingerprint)-\(checkpoint.status.rawValue)-\(checkpoint.nextCandleIndex)-\(speed.rawValue)-\(isUpdatingOfflineReplaySession)-\(offlineReplaySessionMessage ?? "")"
    }

    @discardableResult
    func startOfflineReplaySession(
        marketCode: String,
        intervalMinutes: Int
    ) async -> Bool {
        guard isBundledLocalMarketData else {
            offlineReplaySessionMessage = "과거 재생은 앱에 저장된 고정 시세 자료 모드에서만 가능합니다. 이 모드에서는 계좌 연결이나 주문을 할 수 없습니다."
            return false
        }
        guard !isRunningOfflineReplay, !isPreparingOfflineReplaySession else { return false }
        guard offlineReplaySessionRecoveryMessage == nil else {
            offlineReplaySessionMessage = "저장 상태를 복구하거나 지운 뒤 재생을 시작해 주세요."
            return false
        }
        if let blockReason = offlineReplayBlockReason(forMarket: marketCode, intervalMinutes: intervalMinutes) {
            offlineReplaySessionMessage = blockReason
            return false
        }
        if let checkpoint = offlineReplaySessionCheckpoint {
            if checkpoint.status == .playing,
               checkpoint.market == marketCode,
               checkpoint.intervalMinutes == intervalMinutes {
                return true
            }
            guard checkpoint.status == .stopped else {
                offlineReplaySessionMessage = "현재 재생 상태를 먼저 일시정지하거나 처음부터 다시 설정해 주세요."
                return false
            }
        }
        guard !offlineReplaySessionOperationInFlight else { return false }

        if let checkpoint = offlineReplaySessionCheckpoint,
           checkpoint.status == .stopped,
           checkpoint.market == marketCode,
           checkpoint.intervalMinutes == intervalMinutes,
           let request = offlineReplaySessionRequest,
           let result = offlineReplaySessionResult,
           checkpoint.matches(result.metadata, candleCount: request.candles.count) {
            let playing = makeOfflineReplaySessionCheckpoint(
                basedOn: checkpoint,
                nextCandleIndex: checkpoint.nextCandleIndex,
                status: .playing,
                speed: offlineReplayPlaybackSpeed
            )
            return await saveAndPublishOfflineReplaySession(playing, request: request, result: result, frame: nil)
        }

        guard let request = makeBundledOfflineReplayRequest(marketCode: marketCode, intervalMinutes: intervalMinutes) else {
            return false
        }

        offlineReplaySessionOperationInFlight = true
        isUpdatingOfflineReplaySession = true
        isPreparingOfflineReplaySession = true
        offlineReplaySessionMessage = nil
        offlineReplaySessionGeneration += 1
        let generation = offlineReplaySessionGeneration
        defer {
            if offlineReplaySessionGeneration == generation {
                isPreparingOfflineReplaySession = false
                isUpdatingOfflineReplaySession = false
                offlineReplaySessionOperationInFlight = false
            }
        }

        do {
            let result = try await Task.detached(priority: .userInitiated) {
                try CoinPilotOfflineReplay.run(request)
            }.value
            guard offlineReplaySessionGeneration == generation,
                  isBundledLocalMarketData,
                  localMarketData != nil else { return false }

            do {
                offlineReplayResults = try await offlineReplayResultStore.save(result)
                offlineReplayPersistenceMessage = nil
            } catch {
                offlineReplayPersistenceMessage = "재생은 가능하지만 전체 결과를 이 기기에 저장하지 못했습니다."
            }

            let checkpoint = CoinPilotOfflineReplaySessionCheckpoint(
                datasetFingerprint: result.metadata.datasetFingerprint,
                engineVersion: result.metadata.engineVersion,
                configVersion: result.metadata.configVersion,
                market: result.metadata.market,
                intervalMinutes: result.metadata.intervalMinutes,
                candleCount: request.candles.count,
                nextCandleIndex: 0,
                status: .playing,
                speed: offlineReplayPlaybackSpeed
            )
            try await offlineReplaySessionStore.saveCheckpoint(checkpoint)
            offlineReplaySessionRequest = request
            offlineReplaySessionResult = result
            offlineReplaySessionPersistedCursor = 0
            offlineReplaySessionLastCheckpointUptime = offlineReplaySessionUptime()
            offlineReplaySessionCheckpoint = checkpoint
            offlineReplaySessionFrame = nil
            offlineReplaySessionRecoveryMessage = nil
            offlineReplaySessionMessage = nil
            offlineReplayResult = result
            offlineReplayMessage = nil
            return true
        } catch {
            offlineReplaySessionMessage = (error as? LocalizedError)?.errorDescription ??
                "재생 상태를 저장하지 못해 시작하지 않았습니다."
            return false
        }
    }

    @discardableResult
    func pauseOfflineReplaySession() async -> Bool {
        guard !offlineReplaySessionOperationInFlight,
              let checkpoint = offlineReplaySessionCheckpoint,
              checkpoint.status == .playing,
              offlineReplaySessionRecoveryMessage == nil else { return false }
        offlineReplaySessionOperationInFlight = true
        isUpdatingOfflineReplaySession = true
        let paused = makeOfflineReplaySessionCheckpoint(
            basedOn: checkpoint,
            nextCandleIndex: checkpoint.nextCandleIndex,
            status: .paused,
            speed: checkpoint.playbackSpeed ?? offlineReplayPlaybackSpeed
        )
        offlineReplaySessionCheckpoint = paused
        defer {
            isUpdatingOfflineReplaySession = false
            offlineReplaySessionOperationInFlight = false
        }
        do {
            try await offlineReplaySessionStore.saveCheckpoint(paused)
            markOfflineReplaySessionCheckpointDurable(cursor: paused.nextCandleIndex)
            offlineReplaySessionMessage = nil
            return true
        } catch {
            offlineReplaySessionMessage = "일시정지는 적용됐지만 저장하지 못했습니다. 앱을 다시 열면 마지막 저장 지점부터 최대 1초 구간이 다시 나올 수 있습니다."
            return false
        }
    }

    @discardableResult
    func resumeOfflineReplaySession() async -> Bool {
        guard !offlineReplaySessionOperationInFlight,
              offlineReplaySessionRecoveryMessage == nil,
              let checkpoint = offlineReplaySessionCheckpoint,
              checkpoint.status == .paused,
              checkpoint.nextCandleIndex < checkpoint.candleCount,
              offlineReplaySessionRequest != nil,
              offlineReplaySessionResult != nil else { return false }
        offlineReplaySessionOperationInFlight = true
        isUpdatingOfflineReplaySession = true
        let playing = makeOfflineReplaySessionCheckpoint(
            basedOn: checkpoint,
            nextCandleIndex: checkpoint.nextCandleIndex,
            status: .playing,
            speed: checkpoint.playbackSpeed ?? offlineReplayPlaybackSpeed
        )
        defer {
            isUpdatingOfflineReplaySession = false
            offlineReplaySessionOperationInFlight = false
        }
        do {
            try await offlineReplaySessionStore.saveCheckpoint(playing)
            markOfflineReplaySessionCheckpointDurable(cursor: playing.nextCandleIndex)
            offlineReplaySessionCheckpoint = playing
            offlineReplayPlaybackSpeed = playing.playbackSpeed ?? offlineReplayPlaybackSpeed
            offlineReplaySessionMessage = nil
            return true
        } catch {
            offlineReplaySessionMessage = "재생 상태를 저장하지 못해 다시 시작하지 않았습니다."
            return false
        }
    }

    @discardableResult
    func resetOfflineReplaySession() async -> Bool {
        guard !offlineReplaySessionOperationInFlight else { return false }
        offlineReplaySessionOperationInFlight = true
        isUpdatingOfflineReplaySession = true
        defer {
            isUpdatingOfflineReplaySession = false
            offlineReplaySessionOperationInFlight = false
        }

        if offlineReplaySessionRecoveryMessage != nil {
            do {
                try await offlineReplaySessionStore.clearCheckpoint()
                clearOfflineReplaySessionState()
                offlineReplaySessionMessage = nil
                return true
            } catch {
                offlineReplaySessionMessage = "손상된 재생 상태를 지우지 못했습니다."
                return false
            }
        }

        guard let checkpoint = offlineReplaySessionCheckpoint else {
            offlineReplaySessionMessage = nil
            offlineReplaySessionFrame = nil
            return true
        }
        let stopped = makeOfflineReplaySessionCheckpoint(
            basedOn: checkpoint,
            nextCandleIndex: 0,
            status: .stopped,
            speed: checkpoint.playbackSpeed ?? offlineReplayPlaybackSpeed
        )
        do {
            try await offlineReplaySessionStore.saveCheckpoint(stopped)
            offlineReplaySessionCheckpoint = stopped
            offlineReplaySessionFrame = nil
            offlineReplaySessionPersistedCursor = 0
            offlineReplaySessionLastCheckpointUptime = offlineReplaySessionUptime()
            offlineReplayPlaybackSpeed = stopped.playbackSpeed ?? offlineReplayPlaybackSpeed
            offlineReplaySessionMessage = nil
            return true
        } catch {
            offlineReplaySessionCheckpoint = stopped
            offlineReplaySessionFrame = nil
            offlineReplaySessionMessage = "재생은 멈췄지만 처음 상태를 저장하지 못했습니다. 앱을 다시 열면 마지막 저장 지점부터 복원될 수 있습니다."
            return false
        }
    }

    @discardableResult
    func setOfflineReplayPlaybackSpeed(_ speed: CoinPilotOfflineReplayPlaybackSpeed) async -> Bool {
        guard !offlineReplaySessionOperationInFlight else { return false }
        guard let checkpoint = offlineReplaySessionCheckpoint else {
            offlineReplayPlaybackSpeed = speed
            return true
        }
        guard offlineReplaySessionRecoveryMessage == nil else { return false }

        offlineReplaySessionOperationInFlight = true
        isUpdatingOfflineReplaySession = true
        let updated = makeOfflineReplaySessionCheckpoint(
            basedOn: checkpoint,
            nextCandleIndex: checkpoint.nextCandleIndex,
            status: checkpoint.status,
            speed: speed
        )
        defer {
            isUpdatingOfflineReplaySession = false
            offlineReplaySessionOperationInFlight = false
        }
        do {
            try await offlineReplaySessionStore.saveCheckpoint(updated)
            markOfflineReplaySessionCheckpointDurable(cursor: updated.nextCandleIndex)
            offlineReplaySessionCheckpoint = updated
            offlineReplayPlaybackSpeed = speed
            offlineReplaySessionMessage = nil
            return true
        } catch {
            offlineReplaySessionMessage = "재생 속도를 저장하지 못해 기존 속도를 유지합니다."
            return false
        }
    }

    @discardableResult
    func advanceOfflineReplaySession(marketCode: String, intervalMinutes: Int) async -> CoinPilotOfflineReplay.PlaybackFrame? {
        guard !offlineReplaySessionOperationInFlight,
              !isPreparingOfflineReplaySession,
              offlineReplaySessionRecoveryMessage == nil,
              offlineReplaySessionMessage == nil,
              isBundledLocalMarketData,
              let checkpoint = offlineReplaySessionCheckpoint,
              checkpoint.status == .playing,
              checkpoint.market == marketCode,
              checkpoint.intervalMinutes == intervalMinutes,
              checkpoint.nextCandleIndex < checkpoint.candleCount,
              let request = offlineReplaySessionRequest,
              let result = offlineReplaySessionResult else { return nil }

        guard let frame = CoinPilotOfflineReplay.playbackFrame(
            atCandleIndex: checkpoint.nextCandleIndex,
            request: request,
            result: result
        ) else {
            offlineReplaySessionRecoveryMessage = "재생 위치와 앱 저장 자료가 맞지 않습니다. 저장 상태를 지우고 다시 시작해 주세요."
            return nil
        }

        let nextCursor = checkpoint.nextCandleIndex + 1
        let nextStatus: CoinPilotOfflineReplaySessionStatus = nextCursor == checkpoint.candleCount
            ? .completed
            : .playing
        let advanced = makeOfflineReplaySessionCheckpoint(
            basedOn: checkpoint,
            nextCandleIndex: nextCursor,
            status: nextStatus,
            speed: checkpoint.playbackSpeed ?? offlineReplayPlaybackSpeed
        )
        offlineReplaySessionCheckpoint = advanced
        offlineReplaySessionFrame = frame

        let uptime = offlineReplaySessionUptime()
        let shouldPersist = nextStatus == .completed ||
            offlineReplaySessionLastCheckpointUptime.map { uptime - $0 >= 1.0 } ?? true
        guard shouldPersist else { return frame }

        offlineReplaySessionOperationInFlight = true
        isUpdatingOfflineReplaySession = true
        defer {
            isUpdatingOfflineReplaySession = false
            offlineReplaySessionOperationInFlight = false
        }
        do {
            try await offlineReplaySessionStore.saveCheckpoint(advanced)
            markOfflineReplaySessionCheckpointDurable(cursor: advanced.nextCandleIndex)
            offlineReplaySessionMessage = nil
        } catch {
            if nextStatus != .completed {
                offlineReplaySessionCheckpoint = makeOfflineReplaySessionCheckpoint(
                    basedOn: advanced,
                    nextCandleIndex: advanced.nextCandleIndex,
                    status: .paused,
                    speed: advanced.playbackSpeed ?? offlineReplayPlaybackSpeed
                )
                offlineReplaySessionMessage = "재생 상태를 저장하지 못해 멈췄습니다. 다시 열면 마지막 저장 지점부터 최대 1초 구간이 다시 나올 수 있습니다."
            } else {
                offlineReplaySessionMessage = "과거 재생은 끝났지만 완료 상태를 저장하지 못했습니다. 다시 열면 마지막 저장 지점부터 복원될 수 있습니다."
            }
        }
        return frame
    }

    func pauseOfflineReplaySessionForInterruption() async {
        while offlineReplaySessionOperationInFlight && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        guard !Task.isCancelled else { return }
        guard offlineReplaySessionCheckpoint?.status == .playing else { return }
        _ = await pauseOfflineReplaySession()
    }

    func selectOfflineReplayResult(_ result: CoinPilotOfflineReplay.Result) {
        guard isBundledLocalMarketData, offlineReplayResults.contains(result) else { return }
        offlineReplayResult = result
        offlineReplayMessage = nil
        offlineReplayPersistenceMessage = nil
    }

    private func makeBundledOfflineReplayRequest(
        marketCode: String,
        intervalMinutes: Int
    ) -> CoinPilotOfflineReplay.Request? {
        guard localMarketDataError == nil,
              let dataset = localMarketData,
              let market = dataset.markets.first(where: { $0.market == marketCode }) else {
            offlineReplaySessionMessage = "선택한 시장의 고정 시세 자료가 앱에 저장되어 있지 않습니다."
            return nil
        }
        let sourceRows = market.candles.filter { $0.intervalMinutes == intervalMinutes }
        guard !sourceRows.isEmpty else {
            offlineReplaySessionMessage = "재생할 캔들 자료가 없습니다."
            return nil
        }

        var candles: [CoinPilotOfflineReplay.Candle] = []
        candles.reserveCapacity(sourceRows.count)
        for candle in sourceRows {
            guard let date = CoinPilotBundledMarketData.utcDate(from: candle.timestamp) else {
                offlineReplaySessionMessage = "캔들 시각을 읽을 수 없어 재생을 시작하지 않았습니다."
                return nil
            }
            let milliseconds = date.timeIntervalSince1970 * 1_000
            guard milliseconds.isFinite,
                  milliseconds > Double(Int64.min),
                  milliseconds < Double(Int64.max) else {
                offlineReplaySessionMessage = "캔들 시각이 지원 범위를 벗어나 재생을 시작하지 않았습니다."
                return nil
            }
            candles.append(CoinPilotOfflineReplay.Candle(
                timestampMilliseconds: Int64(milliseconds.rounded()),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume
            ))
        }

        return CoinPilotOfflineReplay.Request(
            market: marketCode,
            intervalMinutes: intervalMinutes,
            source: dataset.source,
            generatedAt: dataset.generatedAt,
            candles: candles
        )
    }

    private func makeOfflineReplaySessionCheckpoint(
        basedOn checkpoint: CoinPilotOfflineReplaySessionCheckpoint,
        nextCandleIndex: Int,
        status: CoinPilotOfflineReplaySessionStatus,
        speed: CoinPilotOfflineReplayPlaybackSpeed
    ) -> CoinPilotOfflineReplaySessionCheckpoint {
        CoinPilotOfflineReplaySessionCheckpoint(
            datasetFingerprint: checkpoint.datasetFingerprint,
            engineVersion: checkpoint.engineVersion,
            configVersion: checkpoint.configVersion,
            market: checkpoint.market,
            intervalMinutes: checkpoint.intervalMinutes,
            candleCount: checkpoint.candleCount,
            nextCandleIndex: nextCandleIndex,
            status: status,
            speed: speed
        )
    }

    private func saveAndPublishOfflineReplaySession(
        _ checkpoint: CoinPilotOfflineReplaySessionCheckpoint,
        request: CoinPilotOfflineReplay.Request,
        result: CoinPilotOfflineReplay.Result,
        frame: CoinPilotOfflineReplay.PlaybackFrame?
    ) async -> Bool {
        guard !offlineReplaySessionOperationInFlight else { return false }
        offlineReplaySessionOperationInFlight = true
        isUpdatingOfflineReplaySession = true
        defer {
            isUpdatingOfflineReplaySession = false
            offlineReplaySessionOperationInFlight = false
        }
        do {
            try await offlineReplaySessionStore.saveCheckpoint(checkpoint)
            offlineReplaySessionRequest = request
            offlineReplaySessionResult = result
            offlineReplaySessionCheckpoint = checkpoint
            offlineReplaySessionFrame = frame
            offlineReplayPlaybackSpeed = checkpoint.playbackSpeed ?? .tenCandlesPerSecond
            offlineReplaySessionPersistedCursor = checkpoint.nextCandleIndex
            offlineReplaySessionLastCheckpointUptime = offlineReplaySessionUptime()
            offlineReplaySessionRecoveryMessage = nil
            offlineReplaySessionMessage = nil
            offlineReplayResult = result
            return true
        } catch {
            offlineReplaySessionMessage = (error as? LocalizedError)?.errorDescription ??
                "재생 상태를 저장하지 못해 시작하지 않았습니다."
            return false
        }
    }

    private func markOfflineReplaySessionCheckpointDurable(cursor: Int) {
        offlineReplaySessionPersistedCursor = cursor
        offlineReplaySessionLastCheckpointUptime = offlineReplaySessionUptime()
    }

    private func clearOfflineReplaySessionState() {
        offlineReplaySessionCheckpoint = nil
        offlineReplaySessionFrame = nil
        offlineReplaySessionRecoveryMessage = nil
        offlineReplaySessionMessage = nil
        offlineReplaySessionRequest = nil
        offlineReplaySessionResult = nil
        offlineReplaySessionPersistedCursor = 0
        offlineReplaySessionLastCheckpointUptime = nil
        offlineReplayPlaybackSpeed = .tenCandlesPerSecond
    }

    private func requireOfflineReplaySessionRecovery(_ message: String) {
        offlineReplaySessionCheckpoint = nil
        offlineReplaySessionFrame = nil
        offlineReplaySessionRequest = nil
        offlineReplaySessionResult = nil
        offlineReplaySessionRecoveryMessage = message
    }

    private func markSessionRecoveryIfCheckpointExists() async {
        do {
            if try await offlineReplaySessionStore.loadCheckpoint() != nil {
                requireOfflineReplaySessionRecovery("저장된 재생을 복원할 앱 자료가 없습니다. 자료를 확인한 뒤 저장 상태를 지우고 다시 시작해 주세요.")
            }
        } catch {
            requireOfflineReplaySessionRecovery((error as? LocalizedError)?.errorDescription ??
                "저장된 재생 상태를 읽지 못했습니다. 지운 뒤 다시 시작할 수 있습니다.")
        }
    }

    private func restoreOfflineReplaySessionCheckpoint() async {
        guard isBundledLocalMarketData else { return }
        do {
            guard let checkpoint = try await offlineReplaySessionStore.loadCheckpoint() else {
                clearOfflineReplaySessionState()
                return
            }
            guard let request = makeBundledOfflineReplayRequest(
                marketCode: checkpoint.market,
                intervalMinutes: checkpoint.intervalMinutes
            ) else {
                requireOfflineReplaySessionRecovery("저장된 재생이 현재 앱 저장 자료와 맞지 않습니다. 재생 상태를 지우고 다시 시작해 주세요.")
                return
            }
            let result = try await Task.detached(priority: .userInitiated) {
                try CoinPilotOfflineReplay.run(request)
            }.value
            guard checkpoint.matches(result.metadata, candleCount: request.candles.count) else {
                requireOfflineReplaySessionRecovery("저장된 재생과 앱 저장 자료가 달라 이어서 열지 않았습니다. 재생 상태를 지우고 다시 시작해 주세요.")
                return
            }

            let normalized = checkpoint.status == .playing
                ? makeOfflineReplaySessionCheckpoint(
                    basedOn: checkpoint,
                    nextCandleIndex: checkpoint.nextCandleIndex,
                    status: .paused,
                    speed: checkpoint.playbackSpeed ?? .tenCandlesPerSecond
                )
                : checkpoint
            let currentFrame = normalized.nextCandleIndex > 0
                ? CoinPilotOfflineReplay.playbackFrame(
                    atCandleIndex: normalized.nextCandleIndex - 1,
                    request: request,
                    result: result
                )
                : nil
            guard normalized.nextCandleIndex == 0 || currentFrame != nil else {
                requireOfflineReplaySessionRecovery("저장된 재생 위치를 복원할 수 없습니다. 재생 상태를 지우고 다시 시작해 주세요.")
                return
            }

            offlineReplaySessionCheckpoint = normalized
            offlineReplaySessionFrame = currentFrame
            offlineReplaySessionRequest = request
            offlineReplaySessionResult = result
            offlineReplayPlaybackSpeed = normalized.playbackSpeed ?? .tenCandlesPerSecond
            offlineReplaySessionRecoveryMessage = nil
            offlineReplaySessionMessage = normalized == checkpoint ? nil :
                "이전 재생을 일시정지 상태로 복원했습니다. 이어서 보려면 재생을 눌러 주세요."
            offlineReplaySessionPersistedCursor = normalized.nextCandleIndex
            offlineReplaySessionLastCheckpointUptime = offlineReplaySessionUptime()
            offlineReplayResult = result
            if normalized != checkpoint {
                do {
                    try await offlineReplaySessionStore.saveCheckpoint(normalized)
                    offlineReplaySessionMessage = nil
                } catch {
                    offlineReplaySessionMessage = "일시정지 상태는 복원됐지만 저장하지 못했습니다. 앱을 다시 열면 마지막 저장 지점부터 복원됩니다."
                }
            }
        } catch {
            requireOfflineReplaySessionRecovery((error as? LocalizedError)?.errorDescription ??
                "저장된 재생 상태를 읽지 못했습니다. 지운 뒤 다시 시작할 수 있습니다."
            )
        }
    }

    func loadAnalysisFeatures() async {
        guard let payload = await loadMobileFeature("analysis", path: "/api/all-coin-scores?limit=60"),
              let object = payload as? [String: Any] else { return }
        analysisSummary = object
        analysisResults = (object["coins"] as? [[String: Any]] ?? []).map(CoinPilotAnalysisResult.init)
    }

    func loadRecommendations() async {
        guard let payload = await loadMobileFeature("recommendations", path: "/api/trading-recommendations"),
              let object = payload as? [String: Any] else { return }
        buyRecommendations = (object["buyRecommendations"] as? [[String: Any]] ?? []).map(CoinPilotRecommendation.init)
        sellRecommendations = (object["sellRecommendations"] as? [[String: Any]] ?? []).map(CoinPilotRecommendation.init)
    }

    func loadBundleSuggestions() async {
        guard let payload = await loadMobileFeature("bundles", path: "/api/bundle-suggestions"),
              let object = payload as? [String: Any] else { return }
        bundleSuggestions = object["bundles"] as? [[String: Any]] ?? []
    }

    func loadNewsIfStale() async {
        _ = await loadNews(force: false)
    }

    func loadNews() async {
        _ = await loadNews(force: true)
    }

    private func loadNews(force: Bool) async -> Bool {
        await refreshMobileFeatureGroup("news", force: force) { context in
            guard let payload = await self.loadMobileFeature(
                "news",
                path: "/api/news?limit=80",
                context: context
            ) as? [String: Any], self.isCurrentMobileFeatureContext(context) else { return false }
            self.newsArticles = (payload["news"] as? [[String: Any]] ?? []).enumerated().map {
                CoinPilotNewsArticle($0.element, index: $0.offset)
            }
            self.newsSentiment = payload["sentiment"] as? [String: Any] ?? [:]
            return true
        }
    }

    private func makeMobileFeatureRequestContext(featureKey: String) -> MobileFeatureRequestContext? {
        guard canOperate,
              let serverURL = currentServerURL,
              hasRequestCredentials(for: serverURL) else {
            featureMessages[featureKey] = "이 화면의 서버 권한을 확인할 수 없습니다. 운영 토큰으로 로그인해 주세요."
            return nil
        }
        let token = requestBearerToken(for: serverURL)
        return MobileFeatureRequestContext(
            generation: requestGeneration,
            serverURL: serverURL,
            workspace: activeWorkspace,
            token: token
        )
    }

    private func matchesMobileFeatureContext(_ context: MobileFeatureRequestContext) -> Bool {
        context.generation == requestGeneration &&
            currentServerURL == context.serverURL &&
            activeWorkspace == context.workspace &&
            canOperate &&
            requestBearerToken(for: context.serverURL) == context.token
    }

    private func isCurrentMobileFeatureContext(_ context: MobileFeatureRequestContext) -> Bool {
        !Task.isCancelled && matchesMobileFeatureContext(context)
    }

    private func refreshMobileFeatureGroup(
        _ group: String,
        force: Bool,
        operation: (MobileFeatureRequestContext) async -> Bool
    ) async -> Bool {
        guard let context = makeMobileFeatureRequestContext(featureKey: group) else { return false }
        let forcedRefreshPending = pendingMobileFeatureGroupRefreshes.contains(group)
        if !force, !forcedRefreshPending,
           let lastSuccessfulAt = featureLastSuccessfulAt[group] {
            let age = now().timeIntervalSince(lastSuccessfulAt)
            if age >= 0, age < (Self.mobileFeatureFreshnessSeconds[group] ?? 60) { return true }
        }
        if refreshingFeatureGroups.contains(group) {
            if force { pendingMobileFeatureGroupRefreshes.insert(group) }
            return false
        }
        let refreshWasForced = force || pendingMobileFeatureGroupRefreshes.remove(group) != nil
        let groupGeneration = mobileFeatureGroupGenerations[group, default: 0] + 1
        mobileFeatureGroupGenerations[group] = groupGeneration
        refreshingFeatureGroups.insert(group)
        defer {
            if matchesMobileFeatureContext(context),
               mobileFeatureGroupGenerations[group] == groupGeneration {
                refreshingFeatureGroups.remove(group)
            }
        }

        let loaded = await operation(context)
        guard matchesMobileFeatureContext(context),
              mobileFeatureGroupGenerations[group] == groupGeneration else { return false }
        let cancelled = Task.isCancelled
        if cancelled {
            if refreshWasForced { pendingMobileFeatureGroupRefreshes.insert(group) }
            refreshingFeatureGroups.remove(group)
            return false
        }
        if loaded && !cancelled {
            featureLastSuccessfulAt[group] = now()
            featureMessages.removeValue(forKey: group)
        } else if !cancelled {
            let detail = featureMessages[group]
            let summary = featureLastSuccessfulAt[group] == nil
                ? "자료를 불러오지 못했습니다."
                : "새 자료를 확인하지 못했습니다. 마지막 정상 확인 시각을 참고해 주세요."
            featureMessages[group] = detail.map { "\(summary) \($0)" } ?? "\(summary) 연결 상태를 확인해 주세요."
        }
        refreshingFeatureGroups.remove(group)
        let shouldRefreshAgain = pendingMobileFeatureGroupRefreshes.remove(group) != nil
        if shouldRefreshAgain && !cancelled {
            return await refreshMobileFeatureGroup(group, force: true, operation: operation)
        }
        return loaded
    }

    func loadAIDeskIfStale() async {
        _ = await loadAIDesk(force: false)
    }

    func loadAIDesk() async {
        _ = await loadAIDesk(force: true)
    }

    private func loadAIDesk(force: Bool) async -> Bool {
        guard canOperate else {
            featureMessages["ai"] = "AI 자문을 사용하려면 운영 토큰으로 로그인해 주세요."
            return false
        }
        return await refreshMobileFeatureGroup("ai", force: force) { context in
            var complete = true
            if let providers = await self.loadMobileFeature(
                "ai-providers", path: "/api/ai/providers", context: context
            ) as? [String: Any] {
                self.aiProviderStatus = providers
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let monitor = await self.loadMobileFeature(
                "ai-monitoring", path: "/api/ai/monitoring?limit=40", context: context
            ) as? [String: Any] {
                self.aiEvents = (monitor["events"] as? [[String: Any]] ?? []).enumerated().map {
                    CoinPilotAIEvent($0.element, index: $0.offset)
                }
                self.aiConsultations = monitor["consultations"] as? [[String: Any]] ?? []
                self.aiEffectiveness = monitor["effectiveness"] as? [String: Any] ?? [:]
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let sessions = await self.loadMobileFeature(
                "ai-sessions", path: "/api/ai/sessions", context: context
            ) as? [String: Any] {
                self.aiSessions = (sessions["sessions"] as? [[String: Any]] ?? []).map(CoinPilotAISession.init)
            } else {
                complete = false
            }
            return complete
        }
    }

    func loadResearchDeskIfStale() async {
        _ = await loadResearchDesk(force: false)
    }

    func loadResearchDesk() async {
        _ = await loadResearchDesk(force: true)
    }

    private func loadResearchDesk(force: Bool) async -> Bool {
        await refreshMobileFeatureGroup("research", force: force) { context in
            var complete = true
            if let value = await self.loadMobileFeature(
                "strategy-research", path: "/api/strategy-research", context: context
            ) as? [String: Any] {
                self.strategyResearch = value
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let value = await self.loadMobileFeature(
                "strategy-readiness", path: "/api/strategy-readiness", context: context
            ) as? [String: Any] {
                self.strategyReadiness = value
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let value = await self.loadMobileFeature(
                "validation", path: "/api/scalping-validation", context: context
            ) as? [String: Any] {
                self.scalpingValidation = value
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let value = await self.loadMobileFeature(
                "paper-validation", path: "/api/paper-validation", context: context
            ) as? [String: Any] {
                self.paperValidationState = value
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let value = await self.loadMobileFeature(
                "momentum-shadow", path: "/api/momentum-shadow", context: context
            ) as? [String: Any] {
                self.momentumShadow = value
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let value = await self.loadMobileFeature(
                "live-execution-evidence", path: "/api/live-execution-evidence", context: context
            ) as? [String: Any] {
                self.liveExecutionEvidence = value
            } else {
                complete = false
            }
            return complete
        }
    }

    func loadAccountAnalyticsIfStale() async {
        _ = await loadAccountAnalytics(force: false)
    }

    func loadAccountAnalytics() async {
        _ = await loadAccountAnalytics(force: true)
    }

    private func loadAccountAnalytics(force: Bool) async -> Bool {
        await refreshMobileFeatureGroup("account-analytics", force: force) { context in
            var complete = true
            if let value = await self.loadMobileFeature(
                "portfolio-analysis", path: "/api/portfolio-analysis", context: context
            ) as? [String: Any] {
                self.portfolioAnalysis = value
            } else {
                complete = false
            }
            guard self.isCurrentMobileFeatureContext(context) else { return false }
            if let value = await self.loadMobileFeature(
                "statistics", path: "/api/statistics", context: context
            ) as? [[String: Any]] {
                self.statistics = value
            } else {
                complete = false
            }
            return complete
        }
    }

    func loadOptimizationIfStale() async -> Bool {
        await loadOptimization(force: false)
    }

    @discardableResult
    func loadOptimization() async -> Bool {
        await loadOptimization(force: true)
    }

    private func loadOptimization(force: Bool) async -> Bool {
        await refreshMobileFeatureGroup("optimization", force: force) { context in
            let loaded = await self.loadOptimizationData(context: context)
            if loaded, self.isCurrentMobileFeatureContext(context) {
                self.featureLastSuccessfulAt["optimization"] = self.now()
            }
            return loaded
        }
    }

    private func loadOptimizationData(context: MobileFeatureRequestContext) async -> Bool {
        guard let settings = await loadMobileFeature(
            "optimization", path: "/api/optimization/settings", context: context
        ) as? [String: Any] else { return false }
        optimizationSettings = settings
        var complete = true
        guard isCurrentMobileFeatureContext(context) else { return false }
        if let history = await loadMobileFeature(
            "optimization-history", path: "/api/optimization-history", context: context
        ) {
            if let values = history as? [[String: Any]] { optimizationHistory = values }
            else if let object = history as? [String: Any] { optimizationHistory = object["history"] as? [[String: Any]] ?? [] }
            else { complete = false }
        } else {
            complete = false
        }
        guard isCurrentMobileFeatureContext(context) else { return false }
        if let resultPayload = await loadMobileFeature(
            "backtest", path: "/api/backtest/results", context: context
        ) {
            if let results = resultPayload as? [String: Any] {
                backtestResults = results
            } else if let results = resultPayload as? [[String: Any]] {
                backtestResults = ["entries": results]
            } else {
                complete = false
            }
        } else {
            complete = false
        }
        guard isCurrentMobileFeatureContext(context) else { return false }
        if let config = await loadMobileFeature(
            "optimal-config", path: "/api/optimal-config", context: context
        ) as? [String: Any] {
            optimalConfig = config
        } else {
            complete = false
        }
        guard isCurrentMobileFeatureContext(context) else { return false }
        if let presets = await loadMobileFeature(
            "investment-presets", path: "/api/investment-presets", context: context
        ) as? [String: Any] {
            investmentPresets = presets["presets"] as? [[String: Any]] ?? []
        } else {
            complete = false
        }
        return complete
    }

    func recordPortfolioSnapshot() async -> Bool {
        guard !isRecordingSnapshot, canOperate else {
            featureMessages["snapshot"] = canOperate ? "자산 기록을 이미 저장하고 있습니다." : "운영 토큰이 필요합니다."
            return false
        }
        let generation = requestGeneration
        isRecordingSnapshot = true
        defer {
            if generation == requestGeneration { isRecordingSnapshot = false }
        }
        guard let response = await performFeatureMutation("snapshot", path: "/api/portfolio/snapshot", body: [:]) else { return false }
        guard response["success"] as? Bool == true else { return false }
        featureMessages["snapshot"] = response["message"] as? String ?? "현재 자산 기록을 저장했습니다."
        await setHistoryPeriod(historyPeriod, force: true)
        return true
    }

    func startPaperValidation(reset: Bool = false) async -> Bool {
        guard activeWorkspace == .paper, tradingMode == "DRY_RUN", canOperate else {
            featureMessages["paper-validation"] = "모의투자 점검은 운영 권한이 있는 모의투자 서버에서만 시작할 수 있습니다."
            return false
        }
        let body: [String: Any] = reset ? ["reset": true] : [:]
        guard let response = await performFeatureMutation("paper-validation", path: "/api/paper-validation/start", body: body) else { return false }
        guard response["success"] as? Bool == true else { return false }
        return await reloadPaperValidation()
    }

    func stopPaperValidation() async -> Bool {
        guard activeWorkspace == .paper, tradingMode == "DRY_RUN", canOperate else {
            featureMessages["paper-validation"] = "모의투자 점검은 모의투자 운영 권한이 필요합니다."
            return false
        }
        guard let response = await performFeatureMutation("paper-validation", path: "/api/paper-validation/stop", body: [:]),
              response["success"] as? Bool == true else { return false }
        return await reloadPaperValidation()
    }

    func applyInvestmentPreset(id: String) async -> Bool {
        guard !id.isEmpty, canOperate, tuningBlockReason == nil else {
            tuningMessage = tuningBlockReason ?? "현재 작업공간에서 프리셋을 적용할 수 없습니다."
            return false
        }
        guard let response = await performFeatureMutation("preset", path: "/api/investment-presets/apply", body: ["presetId": id]),
              response["success"] as? Bool == true else { return false }
        tuningMessage = "선택한 설정을 적용했습니다."
        _ = await loadTuning()
        return true
    }

    func setOptimizationEnabled(_ enabled: Bool) async -> Bool {
        guard optimizationBlockReason == nil else {
            featureMessages["optimization"] = optimizationBlockReason
            return false
        }
        guard let response = await performFeatureMutation("optimization", path: "/api/optimization/toggle", body: ["enabled": enabled]),
              response["success"] as? Bool == true else { return false }
        return await loadOptimization()
    }

    func setOptimizationInterval(_ interval: Int) async -> Bool {
        guard [3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000].contains(interval),
              optimizationBlockReason == nil else {
            featureMessages["optimization"] = optimizationBlockReason ?? "비교 간격을 확인해 주세요."
            return false
        }
        guard let response = await performFeatureMutation("optimization", path: "/api/optimization/interval", body: ["interval": interval]),
              response["success"] as? Bool == true else { return false }
        return await loadOptimization()
    }

    func runOptimizationNow() async -> Bool {
        guard optimizationBlockReason == nil else {
            featureMessages["optimization"] = optimizationBlockReason
            return false
        }
        guard let response = await performFeatureMutation("optimization", path: "/api/optimization/run-now", body: [:]),
              response["success"] as? Bool == true else { return false }
        featureMessages["optimization"] = response["message"] as? String ?? "설정 후보 비교를 시작했습니다."
        return await loadOptimization()
    }

    func createAISession(
        name: String,
        providers: [String],
        eventTypes: [String],
        autoConsultEventTypes: [String],
        autoConsult: Bool,
        coins: String,
        cooldownSeconds: Int,
        evaluationMinutes: Int?
    ) async -> Bool {
        let allowedTypes: Set<String> = ["BUY_SIGNAL", "SELL_SIGNAL", "REBOUND_CANDIDATE", "BREAKING_NEWS", "BUNDLE_SUGGESTION", "TRADE_EXECUTED"]
        let selectedTypes = Array(Set(eventTypes.filter(allowedTypes.contains))).sorted()
        let selectedProviders = Array(Set(providers.map { $0.lowercased() }.filter { ["gpt", "claude"].contains($0) })).sorted()
        guard !selectedTypes.isEmpty else {
            featureMessages["ai"] = "관심 신호를 하나 이상 선택해 주세요."
            return false
        }
        guard !selectedProviders.isEmpty else {
            featureMessages["ai"] = "의견을 받을 서비스를 하나 이상 선택해 주세요."
            return false
        }
        var body: [String: Any] = [
            "name": String(name.prefix(80)), "eventTypes": selectedTypes,
            "providers": selectedProviders,
            "autoConsultEventTypes": Array(Set(autoConsultEventTypes.filter(selectedTypes.contains))).sorted(),
            "autoConsult": autoConsult, "coins": String(coins.prefix(1000)),
            "cooldownSeconds": min(max(cooldownSeconds, 30), 86_400)
        ]
        if let evaluationMinutes { body["evaluationMinutes"] = min(max(evaluationMinutes, 1), 1_440) }
        guard let response = await performFeatureMutation("ai", path: "/api/ai/sessions", body: body),
              response["success"] as? Bool == true else { return false }
        await loadAIDesk()
        return true
    }

    func updateAISession(id: String, action: String) async -> Bool {
        guard ["pause", "resume", "stop"].contains(action),
              id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { return false }
        guard let response = await performFeatureMutation("ai", path: "/api/ai/sessions/\(id)/\(action)", body: [:]),
              response["success"] as? Bool == true else { return false }
        await loadAIDesk()
        return true
    }

    func requestAIConsultation(eventId: String, provider: String? = nil) async -> Bool {
        guard !eventId.isEmpty else {
            aiConsultationMessage = "의견을 요청할 시장 신호를 선택해 주세요."
            return false
        }
        var body: [String: Any] = ["eventId": eventId]
        if let provider, !provider.isEmpty { body["provider"] = provider }
        guard let response = await performFeatureMutation("ai", path: "/api/ai/consult", body: body) else { return false }
        aiConsultationMessage = response["success"] as? Bool == true
            ? "선택한 시장 신호에 대한 자문을 받았습니다."
            : Self.message(from: response) ?? "AI 자문을 완료하지 못했습니다."
        await loadAIDesk()
        return response["success"] as? Bool == true
    }

    private func reloadPaperValidation() async -> Bool {
        guard let value = await loadMobileFeature("paper-validation", path: "/api/paper-validation") as? [String: Any] else { return false }
        paperValidationState = value
        return true
    }

    private func loadMobileFeature(
        _ key: String,
        path: String,
        context suppliedContext: MobileFeatureRequestContext? = nil
    ) async -> Any? {
        guard let context = suppliedContext ?? makeMobileFeatureRequestContext(featureKey: key) else { return nil }
        guard isCurrentMobileFeatureContext(context) else { return nil }
        let serverURL = context.serverURL
        let featureGeneration = mobileFeatureRequestGenerations[key, default: 0] + 1
        mobileFeatureRequestGenerations[key] = featureGeneration
        loadingFeatures.insert(key)
        featureMessages.removeValue(forKey: key)
        let isCurrentRequest = {
            self.isCurrentMobileFeatureContext(context) &&
                self.mobileFeatureRequestGenerations[key] == featureGeneration
        }
        defer {
            if matchesMobileFeatureContext(context),
               mobileFeatureRequestGenerations[key] == featureGeneration {
                loadingFeatures.remove(key)
            }
        }
        do {
            let response = try await api.mobileRead(path: path, at: serverURL, token: context.token)
            guard isCurrentRequest() else { return nil }
            guard (200..<300).contains(response.statusCode),
                  let object = try? Self.jsonObject(response.body),
                  (object as? [String: Any])?["error"] == nil else {
                let body = (try? Self.jsonObject(response.body)) as? [String: Any] ?? [:]
                featureMessages[key] = Self.message(from: body) ?? CoinPilotAPIError.forStatusCode(response.statusCode).message
                return nil
            }
            featureMessages.removeValue(forKey: key)
            return object
        } catch is CancellationError {
            return nil
        } catch let error as URLError where error.code == .cancelled {
            return nil
        } catch let error as CoinPilotAPIError {
            guard isCurrentRequest() else { return nil }
            if case .cancelled = error { return nil }
            featureMessages[key] = error.message
            return nil
        } catch {
            guard isCurrentRequest() else { return nil }
            featureMessages[key] = CoinPilotAPIError.connection.message
            return nil
        }
    }

    private func performFeatureMutation(_ key: String, path: String, body: [String: Any]) async -> [String: Any]? {
        guard canOperate, let serverURL = currentServerURL, hasRequestCredentials(for: serverURL) else {
            featureMessages[key] = "운영 토큰으로 로그인해 주세요."
            return nil
        }
        let token = requestBearerToken(for: serverURL)
        guard !isRunningFeatureAction else {
            featureMessages[key] = "다른 변경 요청을 처리하고 있습니다."
            return nil
        }
        guard CoinPilotAPIClient.isAllowedMobileMutation(path, body: body) else {
            featureMessages[key] = "앱에서 허용하지 않은 변경 요청입니다."
            return nil
        }
        let generation = requestGeneration
        let workspace = activeWorkspace
        isRunningFeatureAction = true
        defer {
            if generation == requestGeneration, currentServerURL == serverURL, activeWorkspace == workspace {
                isRunningFeatureAction = false
            }
        }
        do {
            let response = try await api.mutate(path: path, at: serverURL, token: token, body: body, idempotencyKey: nil)
            guard generation == requestGeneration, currentServerURL == serverURL, activeWorkspace == workspace else { return nil }
            let value = (try? Self.jsonObject(response.body)) as? [String: Any] ?? [:]
            guard (200..<300).contains(response.statusCode), value["success"] as? Bool != false else {
                let message = Self.message(from: value) ?? CoinPilotAPIError.forStatusCode(response.statusCode).message
                featureMessages[key] = message
                if response.statusCode == 401 { logOut() }
                return nil
            }
            featureMessages.removeValue(forKey: key)
            return value
        } catch let error as CoinPilotAPIError {
            guard generation == requestGeneration, currentServerURL == serverURL, activeWorkspace == workspace else { return nil }
            featureMessages[key] = error.message
            return nil
        } catch {
            guard generation == requestGeneration, currentServerURL == serverURL, activeWorkspace == workspace else { return nil }
            featureMessages[key] = CoinPilotAPIError.connection.message
            return nil
        }
    }

    func setHistoryPeriod(_ period: CoinPilotHistoryPeriod, force: Bool = false) async {
        guard !isBundledLocalMarketData else { return }
        guard force || period != historyPeriod else { return }
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

    func submitManualBuy(coin: String, amount: Double) async -> Bool {
        guard manualOrderBlockReason(for: coin) == nil else {
            orderMessage = manualOrderBlockReason(for: coin)
            return false
        }
        guard amount.isFinite, amount >= minimumOrderAmount else {
            orderMessage = "최소 매수 금액은 \(CoinPilotFormatting.won(minimumOrderAmount))입니다."
            return false
        }
        let requestURL = currentServerURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        await refresh()
        guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else {
            orderMessage = "작업공간이 바뀌어 주문을 보내지 않았습니다. 새 화면에서 다시 확인해 주세요."
            return false
        }
        guard manualOrderBlockReason(for: coin) == nil else {
            orderMessage = manualOrderBlockReason(for: coin)
            return false
        }
        guard let cash = account?.krwBalance, cash.isFinite, amount <= cash else {
            orderMessage = "현재 계좌 잔액보다 큰 금액은 주문할 수 없습니다."
            return false
        }
        guard markets.contains(where: { $0.coin == coin && ($0.price ?? 0) > 0 }) else {
            orderMessage = "선택한 종목의 현재 시세를 확인할 수 없습니다."
            return false
        }
        let normalizedAmount = normalizedQuoteAmount(amount)
        let body: [String: Any] = ["coin": coin, "amount": normalizedAmount]
        return await beginPendingManualOrder(
            endpoint: "/api/trade/buy",
            body: body,
            market: coin,
            side: "매수",
            displayAmount: CoinPilotFormatting.won(normalizedAmount)
        )
    }

    func submitManualSell(coin: String, quantity: Double) async -> Bool {
        guard manualOrderBlockReason(for: coin) == nil else {
            orderMessage = manualOrderBlockReason(for: coin)
            return false
        }
        guard quantity.isFinite, quantity > 0 else {
            orderMessage = "매도 수량을 확인해 주세요."
            return false
        }
        let requestURL = currentServerURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        await refresh()
        guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else {
            orderMessage = "작업공간이 바뀌어 주문을 보내지 않았습니다. 새 화면에서 다시 확인해 주세요."
            return false
        }
        guard manualOrderBlockReason(for: coin) == nil else {
            orderMessage = manualOrderBlockReason(for: coin)
            return false
        }
        guard let position = account?.positions.first(where: { $0.coin == coin }),
              let available = position.amount, available.isFinite, available > 0 else {
            orderMessage = "현재 보유 수량을 확인할 수 없습니다."
            return false
        }
        guard quantity <= available else {
            orderMessage = "입력한 수량이 현재 보유량보다 많습니다. 새로고침 후 다시 입력해 주세요."
            return false
        }
        let price = position.currentPrice ?? markets.first(where: { $0.coin == coin })?.price
        let estimate = price.map { CoinPilotFormatting.won($0 * quantity) } ?? "예상 금액 확인 불가"
        return await beginPendingManualOrder(
            endpoint: "/api/trade/sell",
            body: ["coin": coin, "quantity": quantity],
            market: coin,
            side: "매도",
            displayAmount: "\(quantity)개 · \(estimate)"
        )
    }

    func submitSmartBuy(totalAmount: Double, minimumScore: Int, maximumCoins: Int) async -> Bool {
        guard manualOrderBlockReason == nil else { orderMessage = manualOrderBlockReason; return false }
        guard totalAmount.isFinite, totalAmount >= minimumOrderAmount,
              (0...100).contains(minimumScore), (1...30).contains(maximumCoins) else {
            orderMessage = "금액, 최소 점수, 최대 종목 수를 확인해 주세요."
            return false
        }
        let requestURL = currentServerURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        await refresh()
        guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace,
              manualOrderBlockReason == nil else {
            orderMessage = manualOrderBlockReason ?? "서버 상태가 바뀌어 조건 매수를 보내지 않았습니다."
            return false
        }
        guard let cash = account?.krwBalance, cash.isFinite, totalAmount <= cash else {
            orderMessage = "현재 계좌 잔액보다 큰 금액은 조건 매수에 사용할 수 없습니다."
            return false
        }
        let amount = normalizedQuoteAmount(totalAmount)
        return await beginPendingManualOrder(
            endpoint: "/api/trade/smart-buy",
            body: ["totalAmount": amount, "minScore": minimumScore, "maxCoins": maximumCoins],
            market: "조건 매수",
            side: "매수",
            displayAmount: CoinPilotFormatting.won(amount)
        )
    }

    func submitSmartSell(targetAmount: Double, strategy: String) async -> Bool {
        guard manualOrderBlockReason == nil else { orderMessage = manualOrderBlockReason; return false }
        guard targetAmount.isFinite, targetAmount >= minimumSmartSellAmount,
              ["worst", "best", "overbought"].contains(strategy) else {
            orderMessage = "매도 목표 금액과 우선순위를 확인해 주세요."
            return false
        }
        let requestURL = currentServerURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        await refresh()
        guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace,
              manualOrderBlockReason == nil else {
            orderMessage = manualOrderBlockReason ?? "서버 상태가 바뀌어 조건 매도를 보내지 않았습니다."
            return false
        }
        let currentHoldingValue = account?.positions.reduce(0) { $0 + ($1.currentValue ?? 0) } ?? 0
        guard currentHoldingValue > 0, targetAmount <= currentHoldingValue else {
            orderMessage = "현재 보유 자산 평가액보다 큰 금액은 조건 매도에 사용할 수 없습니다."
            return false
        }
        let amount = normalizedQuoteAmount(targetAmount)
        return await beginPendingManualOrder(
            endpoint: "/api/trade/smart-sell",
            body: ["targetAmount": amount, "strategy": strategy],
            market: "조건 매도",
            side: "매도",
            displayAmount: CoinPilotFormatting.won(amount)
        )
    }

    func submitBundle(sellCoin: String, sellAmount: Double? = nil, buyCoin: String, buyAmount: Double? = nil) async -> Bool {
        let marketCodes = [sellCoin, buyCoin]
        guard manualOrderBlockReason(forMarkets: marketCodes) == nil else {
            orderMessage = manualOrderBlockReason(forMarkets: marketCodes)
            return false
        }
        guard sellCoin != buyCoin,
              sellCoin.range(of: "^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil,
              buyCoin.range(of: "^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil else {
            orderMessage = "매도·매수 종목을 확인해 주세요."
            return false
        }
        let requestURL = currentServerURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        await refresh()
        let refreshedMarketCodes = [sellCoin, buyCoin]
        guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace,
              manualOrderBlockReason(forMarkets: refreshedMarketCodes) == nil else {
            orderMessage = manualOrderBlockReason(forMarkets: refreshedMarketCodes) ?? "서버 상태가 바뀌어 묶음 거래를 보내지 않았습니다."
            return false
        }
        guard let holding = account?.positions.first(where: { $0.coin == sellCoin }),
              let available = holding.amount, available > 0,
              let destination = markets.first(where: { $0.coin == buyCoin }),
              let destinationPrice = destination.price, destinationPrice > 0 else {
            orderMessage = "매도할 보유량과 매수 종목의 시세를 다시 확인해 주세요."
            return false
        }
        if let sellAmount, (!sellAmount.isFinite || sellAmount <= 0 || sellAmount > available) {
            orderMessage = "매도 수량이 현재 보유량을 넘었습니다. 새로고침 후 다시 확인해 주세요."
            return false
        }
        if let buyAmount, (!buyAmount.isFinite || buyAmount < minimumOrderAmount || buyAmount > (holding.currentValue ?? 0)) {
            orderMessage = "매수 금액을 확인해 주세요. 매도 예상 금액 안에서 \(CoinPilotFormatting.won(minimumOrderAmount)) 이상이어야 합니다."
            return false
        }
        var body: [String: Any] = ["sellCoin": sellCoin, "buyCoin": buyCoin]
        if let sellAmount { body["sellAmount"] = sellAmount }
        if let buyAmount { body["buyAmount"] = normalizedQuoteAmount(buyAmount) }
        let sellDisplay = CoinPilotFormatting.won((holding.currentValue ?? 0))
        return await beginPendingManualOrder(
            endpoint: "/api/trade/execute-bundle",
            body: body,
            market: "\(CoinPilotFormatting.ticker(sellCoin)) → \(CoinPilotFormatting.ticker(buyCoin))",
            side: "묶음 거래",
            displayAmount: sellDisplay
        )
    }

    func submitRecommendation(_ recommendation: CoinPilotRecommendation, amount: Double? = nil) async -> Bool {
        guard manualOrderBlockReason(for: recommendation.coin) == nil else {
            orderMessage = manualOrderBlockReason(for: recommendation.coin)
            return false
        }
        let action = recommendation.action.uppercased()
        guard ["BUY", "SELL"].contains(action) else {
            orderMessage = "현재 추천은 주문 가능한 매수·매도 신호가 아닙니다."
            return false
        }
        let requestURL = currentServerURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        await refresh()
        guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace,
              manualOrderBlockReason(for: recommendation.coin) == nil else {
            orderMessage = manualOrderBlockReason(for: recommendation.coin) ?? "서버 상태가 바뀌어 추천 주문을 보내지 않았습니다."
            return false
        }
        var body: [String: Any] = ["coin": recommendation.coin, "action": action]
        var displayAmount = "보유량 전체"
        if action == "BUY" {
            let requested = amount ?? recommendation.suggestedAmount ?? buyAmountPresets[1]
            guard requested.isFinite, requested >= minimumOrderAmount,
                  let cash = account?.krwBalance, requested <= cash else {
                orderMessage = "매수 금액이 최소 주문 금액보다 작거나 현재 잔액을 초과합니다."
                return false
            }
            let normalizedAmount = normalizedQuoteAmount(requested)
            body["amount"] = normalizedAmount
            displayAmount = CoinPilotFormatting.won(normalizedAmount)
        } else if !(account?.positions.contains(where: { $0.coin == recommendation.coin && ($0.amount ?? 0) > 0 }) ?? false) {
            orderMessage = "현재 보유 수량이 없어 추천 매도를 실행할 수 없습니다."
            return false
        }
        return await beginPendingManualOrder(
            endpoint: "/api/trade/execute",
            body: body,
            market: recommendation.coin,
            side: action == "BUY" ? "매수" : "매도",
            displayAmount: displayAmount
        )
    }

    func retryPendingManualOrder() async -> Bool {
        guard pendingManualOrderLocked else { return false }
        guard canOperate else {
            orderMessage = "저장된 주문 결과를 확인하려면 운영 토큰이 필요합니다."
            return false
        }
        guard let pendingManualOrder else {
            orderMessage = "주문 기록을 읽지 못해 안전 확인이 필요합니다. 새 주문은 잠겨 있습니다."
            return false
        }
        return await sendPendingManualOrder(pendingManualOrder)
    }

    func updatePaperWallet(amount: Double, deposit: Bool) async -> Bool {
        guard activeWorkspace == .paper, tradingMode == "DRY_RUN", !isObserverAccount else {
            orderMessage = "모의 지갑은 연결된 모의투자 서버에서만 변경할 수 있습니다."
            return false
        }
        guard canOperate else {
            orderMessage = "모의 지갑을 변경하려면 운영 토큰이 필요합니다."
            return false
        }
        guard amount.isFinite, amount >= minimumWalletAmount else {
            orderMessage = "최소 \(CoinPilotFormatting.won(minimumWalletAmount)) 이상 입력해 주세요."
            return false
        }
        if storePaperWalletLocked {
            orderMessage = storePaperWalletLockedReason
            return false
        }
        let requestURL = currentServerURL
        let requestGeneration = self.requestGeneration
        await refresh()
        guard self.requestGeneration == requestGeneration,
              currentServerURL == requestURL,
              activeWorkspace == .paper, tradingMode == "DRY_RUN", serverModeMatchesWorkspace else {
            orderMessage = "모의투자 서버가 바뀌어 지갑 변경을 취소했습니다."
            return false
        }
        if let lock = paperWalletBlockReason {
            orderMessage = lock
            return false
        }
        if !deposit, let cash = account?.krwBalance, amount > cash {
            orderMessage = "출금 금액이 현재 가상 잔액보다 많습니다."
            return false
        }
        return await beginPendingManualOrder(
            endpoint: "/api/virtual/\(deposit ? "deposit" : "withdraw")",
            body: ["amount": normalizedQuoteAmount(amount)],
            market: "가상 지갑",
            side: deposit ? "입금" : "출금",
            displayAmount: CoinPilotFormatting.won(normalizedQuoteAmount(amount))
        )
    }

    func resetPaperWallet(seedMoney: Double) async -> Bool {
        guard activeWorkspace == .paper, tradingMode == "DRY_RUN", canOperate, !isObserverAccount else {
            orderMessage = "모의 계좌 초기화는 운영 권한이 있는 모의투자 서버에서만 할 수 있습니다."
            return false
        }
        guard seedMoney.isFinite, seedMoney >= minimumSeedAmount else {
            orderMessage = "초기 금액은 \(CoinPilotFormatting.won(minimumSeedAmount)) 이상으로 입력해 주세요."
            return false
        }
        if storePaperWalletLocked {
            orderMessage = storePaperWalletLockedReason
            return false
        }
        let requestURL = currentServerURL
        let requestGeneration = self.requestGeneration
        await refresh()
        guard self.requestGeneration == requestGeneration,
              currentServerURL == requestURL,
              activeWorkspace == .paper, tradingMode == "DRY_RUN", serverModeMatchesWorkspace,
              paperWalletBlockReason == nil else {
            orderMessage = paperWalletBlockReason ?? "모의투자 서버 상태가 바뀌어 초기화를 취소했습니다."
            return false
        }
        return await beginPendingManualOrder(
            endpoint: "/api/virtual/reset",
            body: ["seedMoney": normalizedQuoteAmount(seedMoney)],
            market: "가상 지갑",
            side: "초기화",
            displayAmount: CoinPilotFormatting.won(normalizedQuoteAmount(seedMoney))
        )
    }

    private func beginPendingManualOrder(
        endpoint: String,
        body: [String: Any],
        market: String,
        side: String,
        displayAmount: String
    ) async -> Bool {
        guard let serverURL = currentServerURL,
              hasRequestCredentials(for: serverURL),
              let requestBody = try? JSONSerialization.data(withJSONObject: body) else {
            orderMessage = "서버 인증 또는 주문 요청을 준비하지 못했습니다."
            return false
        }
        let token = requestBearerToken(for: serverURL)
        guard !pendingManualOrderLocked, !isSubmittingManualOrder else {
            orderMessage = "이전 요청의 결과를 확인한 뒤 새 주문을 보낼 수 있습니다."
            return false
        }
        let record = CoinPilotPendingManualOrder(
            idempotencyKey: UUID().uuidString.lowercased(),
            endpoint: endpoint,
            requestBody: requestBody,
            market: market,
            side: side,
            displayAmount: displayAmount,
            mode: activeWorkspace.serverMode,
            createdAt: Date()
        )
        guard let encoded = try? JSONEncoder().encode(record),
              pendingOrders.save(encoded, for: serverURL) else {
            orderMessage = "주문 중복 방지 기록을 기기의 보안 저장소에 남기지 못해 주문을 보내지 않았습니다."
            return false
        }
        pendingManualOrder = record
        pendingManualOrderLocked = true
        orderMessage = "\(side) 요청을 거래 서버에 안전하게 전달하고 있습니다."
        return await sendPendingManualOrder(record, token: token, serverURL: serverURL)
    }

    private func sendPendingManualOrder(
        _ record: CoinPilotPendingManualOrder,
        token suppliedToken: String? = nil,
        serverURL suppliedURL: URL? = nil
    ) async -> Bool {
        guard let serverURL = suppliedURL ?? currentServerURL,
              let body = record.bodyDictionary() else {
            orderMessage = "저장된 주문을 다시 확인할 서버 연결이 없습니다."
            return false
        }
        let token = suppliedToken ?? requestBearerToken(for: serverURL)
        guard authenticationRequired ? token != nil : true else {
            orderMessage = "저장된 주문을 다시 확인할 서버 연결이 없습니다."
            return false
        }
        guard serverURL == currentServerURL,
              record.mode == activeWorkspace.serverMode,
              tradingMode == record.mode,
              serverModeMatchesWorkspace else {
            orderMessage = "이전 주문이 시작된 서버 모드와 현재 작업공간이 다릅니다. 원래 작업공간으로 돌아가 결과를 확인하세요."
            return false
        }

        let generation = requestGeneration
        let workspace = activeWorkspace
        let isCurrentRequest = {
            self.requestGeneration == generation && self.currentServerURL == serverURL && self.activeWorkspace == workspace
        }
        isSubmittingManualOrder = true
        defer {
            if isCurrentRequest() { isSubmittingManualOrder = false }
        }
        do {
            let response = try await api.mutate(
                path: record.endpoint,
                at: serverURL,
                token: token,
                body: body,
                idempotencyKey: record.idempotencyKey
            )
            guard isCurrentRequest() else { return false }
            let responseBody = (try? Self.jsonObject(response.body)) as? [String: Any] ?? [:]
            let state = response.headers.first { $0.key.caseInsensitiveCompare("Idempotency-Status") == .orderedSame }?.value.lowercased()
            let serverMessage = Self.message(from: responseBody)

            if state == "pending" || state == "unknown" || state == "conflict" || response.statusCode == 202 {
                pendingManualOrderLocked = true
                orderMessage = serverMessage ?? "거래 결과를 아직 확인할 수 없습니다. 같은 요청으로 결과 확인을 반복하세요. 새 주문은 잠겨 있습니다."
                return false
            }

            if response.statusCode == 401 || response.statusCode == 403 || response.statusCode == 429 {
                if clearPendingManualOrder(for: serverURL) {
                    orderMessage = serverMessage ?? CoinPilotAPIError.forStatusCode(response.statusCode).message
                }
                return false
            }

            let succeeded = (200..<300).contains(response.statusCode) && responseBody["success"] as? Bool == true
            if state == "completed" || state == "rejected" || succeeded {
                guard clearPendingManualOrder(for: serverURL) else {
                    orderMessage = "서버는 결과를 기록했지만 기기의 중복 방지 기록을 정리하지 못했습니다. 새 주문은 계속 잠겨 있습니다."
                    return false
                }
                if succeeded {
                    orderMessage = serverMessage ?? "\(record.market) \(record.side) 요청을 처리했습니다. 체결·정산 상태를 새로 확인합니다."
                    await refresh()
                    return true
                }
                orderMessage = serverMessage ?? "주문 요청이 완료되지 않았습니다. 잔액·거래소 상태를 확인해 주세요."
                await refresh()
                return false
            }

            pendingManualOrderLocked = true
            orderMessage = serverMessage ?? "주문 응답을 확인하지 못했습니다. 중복 주문 방지를 위해 같은 요청만 재확인할 수 있습니다."
            return false
        } catch {
            guard isCurrentRequest() else { return false }
            pendingManualOrderLocked = true
            orderMessage = "서버 응답이 끊겨 주문 결과를 확정하지 못했습니다. 같은 요청으로 결과를 확인하세요. 새 주문은 잠겨 있습니다."
            return false
        }
    }

    private func clearPendingManualOrder(for serverURL: URL) -> Bool {
        guard pendingOrders.clear(for: serverURL) else {
            pendingManualOrderLocked = true
            return false
        }
        pendingManualOrder = nil
        pendingManualOrderLocked = false
        return true
    }

    func setAutomationRunning(_ shouldRun: Bool) async -> Bool {
        guard canOperate else {
            dashboardMessage = "조회 전용 연결에서는 자동매매를 변경할 수 없습니다. 운영 토큰을 연결해 주세요."
            return false
        }
        guard !isWorking, let serverURL = currentServerURL,
              hasRequestCredentials(for: serverURL) else { return false }
        let token = requestBearerToken(for: serverURL)
        let path = shouldRun ? "/api/control/start" : "/api/control/stop"
        let requestURL = serverURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        isWorking = true
        defer {
            if generation == requestGeneration, currentServerURL == requestURL, activeWorkspace == requestWorkspace {
                isWorking = false
            }
        }
        do {
            let response = try await api.mutate(path: path, at: requestURL, token: token, body: [:], idempotencyKey: nil)
            guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else { return false }
            let body = (try? Self.jsonObject(response.body)) as? [String: Any] ?? [:]
            guard (200..<300).contains(response.statusCode), body["success"] as? Bool == true else {
                dashboardMessage = Self.message(from: body) ?? CoinPilotAPIError.forStatusCode(response.statusCode).message
                return false
            }
            dashboardMessage = Self.message(from: body)
            await refresh()
            return true
        } catch {
            guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else { return false }
            dashboardMessage = CoinPilotAPIError.connection.message
            return false
        }
    }

    func loadTuning() async -> Bool {
        guard canViewTuning, let serverURL = currentServerURL else {
            tuningMessage = "서버에 연결하면 현재 작업공간의 튜닝값을 확인할 수 있습니다."
            return false
        }
        let token = authenticationRequired ? tokens.token(for: serverURL) : nil
        if authenticationRequired && token == nil {
            tuningMessage = "서버 토큰을 다시 입력해 주세요."
            return false
        }
        guard !isLoadingTuning else { return false }
        let requestURL = serverURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        isLoadingTuning = true
        defer {
            if generation == requestGeneration, currentServerURL == requestURL, activeWorkspace == requestWorkspace {
                isLoadingTuning = false
            }
        }
        do {
            async let configResponse = api.read(path: "/api/investment-config", at: requestURL, token: token)
            async let rangeResponse = api.read(path: "/api/parameter-ranges", at: requestURL, token: token)
            let (config, ranges) = try await (configResponse, rangeResponse)
            guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else { return false }
            guard (200..<300).contains(config.statusCode), (200..<300).contains(ranges.statusCode),
                  let configBody = (try? Self.jsonObject(config.body)) as? [String: Any],
                  let rangeBody = (try? Self.jsonObject(ranges.body)) as? [String: Any] else {
                tuningMessage = "서버에서 튜닝값을 불러오지 못했습니다."
                return false
            }
            var values = configBody["scalping"] as? [String: Any] ?? [:]
            values["investmentRatio"] = configBody["investmentRatio"]
            if let targetCoins = configBody["targetCoins"] as? [String] {
                values["targetCoins"] = targetCoins
            }
            if let scalpMaxMarkets = Self.number(configBody["scalpMaxMarkets"]) {
                values["scalpMaxMarkets"] = scalpMaxMarkets
            }
            if let maxPositions = Self.number(configBody["maxPositions"]) {
                values["maxPositions"] = maxPositions
            }
            tuningValues = values
            tuningRanges = rangeBody.reduce(into: [:]) { result, item in
                if let value = item.value as? [String: Any] { result[item.key] = value }
            }
            if let lock = configBody["evidenceMutationLock"] as? [String: Any] {
                tuningMutationLocked = lock["locked"] as? Bool == true
                tuningMutationReason = lock["reason"] as? String
            } else {
                tuningMutationLocked = false
                tuningMutationReason = nil
            }
            tuningMessage = nil
            return true
        } catch {
            guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else { return false }
            tuningMessage = CoinPilotAPIError.connection.message
            return false
        }
    }

    func saveTuning(_ updates: [String: Any]) async -> Bool {
        guard tuningBlockReason == nil, let serverURL = currentServerURL,
              hasRequestCredentials(for: serverURL) else {
            tuningMessage = tuningBlockReason ?? "운영 토큰을 연결해야 튜닝값을 저장할 수 있습니다."
            return false
        }
        let token = requestBearerToken(for: serverURL)
        guard !updates.isEmpty,
              CoinPilotAPIClient.isAllowedMobileMutation("/api/config/update", body: updates) else {
            tuningMessage = "변경할 설정 항목을 확인해 주세요."
            return false
        }
        isSavingTuning = true
        let requestURL = serverURL
        let requestWorkspace = activeWorkspace
        let generation = requestGeneration
        defer {
            if generation == requestGeneration, currentServerURL == requestURL, activeWorkspace == requestWorkspace {
                isSavingTuning = false
            }
        }
        do {
            let response = try await api.mutate(
                path: "/api/config/update",
                at: requestURL,
                token: token,
                body: updates,
                idempotencyKey: nil
            )
            guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else { return false }
            let body = (try? Self.jsonObject(response.body)) as? [String: Any] ?? [:]
            guard (200..<300).contains(response.statusCode), body["success"] as? Bool == true else {
                tuningMessage = Self.message(from: body) ?? CoinPilotAPIError.forStatusCode(response.statusCode).message
                return false
            }
            tuningMessage = "설정을 저장했습니다. 서버의 다음 점검부터 반영됩니다."
            _ = await loadTuning()
            return true
        } catch {
            guard requestGeneration == generation, currentServerURL == requestURL, activeWorkspace == requestWorkspace else { return false }
            tuningMessage = CoinPilotAPIError.connection.message
            return false
        }
    }

    private func fetch(
        _ path: String,
        token: String?,
        at serverURL: URL?,
        usesBundledPreview: Bool
    ) async -> Result<CoinPilotHTTPResponse, CoinPilotAPIError> {
        guard !isBundledLocalMarketData else { return .failure(.forbidden) }
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
        } catch is CancellationError {
            return .failure(.cancelled)
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

    private static func authScope(from response: CoinPilotHTTPResponse) -> CoinPilotAuthScope {
        guard let body = try? jsonObject(response.body) as? [String: Any],
              let rawScope = body["tokenScope"] as? String,
              let scope = CoinPilotAuthScope(rawValue: rawScope) else {
            // Older servers can still provide safe account reads. They never
            // silently gain mobile trading rights from an unlabelled login.
            return .readOnly
        }
        return scope
    }

    private func restorePendingManualOrder(for serverURL: URL) {
        switch pendingOrders.read(for: serverURL) {
        case .missing:
            pendingManualOrder = nil
            pendingManualOrderLocked = false
            orderMessage = nil
        case .saved(let data):
            pendingManualOrderLocked = true
            if let order = try? JSONDecoder().decode(CoinPilotPendingManualOrder.self, from: data) {
                pendingManualOrder = order
                orderMessage = "\(order.market) \(order.side) 요청이 미확정 상태로 저장되어 있습니다. 같은 요청으로 결과를 확인할 때까지 새 주문은 잠겨 있습니다."
            } else {
                pendingManualOrder = nil
                orderMessage = "이전 주문 결과 기록을 읽을 수 없어 새 주문을 잠갔습니다. 서버의 주문 기록을 먼저 확인해 주세요."
            }
        case .unavailable:
            pendingManualOrder = nil
            pendingManualOrderLocked = true
            orderMessage = "이 기기에서 이전 주문 기록을 읽을 수 없어 새 주문을 잠갔습니다. 기기 잠금을 해제한 뒤 다시 시도해 주세요."
        }
    }

    private static func message(from body: [String: Any]) -> String? {
        if let message = body["message"] as? String, !message.isEmpty { return message }
        if let error = body["error"] as? String, !error.isEmpty { return error }
        if let error = body["error"] as? [String: Any],
           let message = error["message"] as? String, !message.isEmpty { return message }
        return nil
    }

    private func clearLoadedData() {
        account = nil
        status = nil
        serverExchange = nil
        quoteCurrency = "KRW"
        CoinPilotFormatting.quoteSymbol = "₩"
        CoinPilotFormatting.quoteAssetLabel = "원화"
        pnl = nil
        todayRealizedProfit = nil
        history = []
        markets = []
        marketSnapshotMetadata = nil
        trades = []
        paperValidationSummary = nil
        candles = []
        marketCoinDetail = nil
        systemStatus = [:]
        analysisResults = []
        analysisSummary = [:]
        buyRecommendations = []
        sellRecommendations = []
        bundleSuggestions = []
        newsArticles = []
        newsSentiment = [:]
        aiProviderStatus = [:]
        aiEffectiveness = [:]
        aiSessions = []
        aiEvents = []
        aiConsultations = []
        aiConsultationMessage = nil
        strategyResearch = [:]
        strategyReadiness = [:]
        scalpingValidation = [:]
        paperValidationState = [:]
        momentumShadow = [:]
        liveExecutionEvidence = [:]
        portfolioAnalysis = [:]
        statistics = []
        optimizationSettings = [:]
        optimizationHistory = []
        backtestResults = [:]
        optimalConfig = [:]
        investmentPresets = []
        featureMessages = [:]
        loadingFeatures = []
        refreshingFeatureGroups = []
        featureLastSuccessfulAt = [:]
        tuningValues = [:]
        tuningRanges = [:]
        tuningMessage = nil
        tuningMutationLocked = false
        tuningMutationReason = nil
        pendingMobileFeatureGroupRefreshes = []
        mobileFeatureRequestGenerations = [:]
        isRunningFeatureAction = false
        isRecordingSnapshot = false
        rawResponses = [:]
        localMarketData = nil
        localMarketDataError = nil
        offlineReplayResult = nil
        offlineReplayResults = []
        isRunningOfflineReplay = false
        offlineReplayMessage = nil
        offlineReplayPersistenceMessage = nil
        offlineReplayGeneration += 1
        offlineReplaySessionGeneration += 1
        isPreparingOfflineReplaySession = false
        isUpdatingOfflineReplaySession = false
        offlineReplaySessionOperationInFlight = false
        clearOfflineReplaySessionState()
        liveAccessKeyDraft = ""
        liveSecretKeyDraft = ""
        liveCredentialMessage = nil
        isLoadingLocalMarketData = false
        localMarketDataLoadGeneration += 1
        lastCheckedAt = nil
        dashboardMessage = nil
        lastSuccessfulResourceAt = [:]
        resourceStates = Dictionary(uniqueKeysWithValues: Self.resourceNames.map { ($0, .notRequested) })
        serverModeMatchesWorkspace = false
    }

    private func loadBundledLocalMarketData() async {
        guard !isLoadingLocalMarketData else { return }
        guard let localMarketDataSource else {
            localMarketData = nil
            localMarketDataError = CoinPilotBundledMarketDataError.missingResource.localizedDescription
            await markSessionRecoveryIfCheckpointExists()
            return
        }

        localMarketDataLoadGeneration += 1
        let loadGeneration = localMarketDataLoadGeneration
        let requestGenerationAtStart = requestGeneration
        let requestedMode = isBundledLocalMarketData
        isLoadingLocalMarketData = true
        localMarketDataError = nil

        let result = await localMarketDataSource.load()
        guard localMarketDataLoadGeneration == loadGeneration else { return }
        guard requestGeneration == requestGenerationAtStart,
              isBundledLocalMarketData == requestedMode,
              requestedMode else {
            isLoadingLocalMarketData = false
            return
        }

        isLoadingLocalMarketData = false
        guard case .success(let dataset) = result else {
            localMarketData = nil
            if case .failure(let error) = result {
                localMarketDataError = error.localizedDescription
            } else {
                localMarketDataError = CoinPilotBundledMarketDataError.malformed.localizedDescription
            }
            await markSessionRecoveryIfCheckpointExists()
            return
        }

        localMarketData = dataset
        localMarketDataError = nil
        if !dataset.markets.contains(where: { $0.market == selectedMarket }) {
            selectedMarket = dataset.markets.first?.market ?? ""
        }
        do {
            offlineReplayResults = try await offlineReplayResultStore.load()
            offlineReplayResult = offlineReplayResults.first
            offlineReplayPersistenceMessage = nil
        } catch {
            offlineReplayResults = []
            offlineReplayResult = nil
            offlineReplayPersistenceMessage = "이 기기에 저장된 과거 재생 기록을 읽지 못했습니다."
        }
        await restoreOfflineReplaySessionCheckpoint()
    }

    func localMarketIntervals(for marketCode: String) -> [Int] {
        guard isBundledLocalMarketData,
              let market = localMarketData?.markets.first(where: { $0.market == marketCode }) else { return [] }
        return Array(Set(market.candles.map(\.intervalMinutes))).sorted()
    }

    func localMarketLatestCandle(for marketCode: String, interval: Int? = nil) -> CoinPilotBundledMarketData.Candle? {
        guard isBundledLocalMarketData,
              let market = localMarketData?.markets.first(where: { $0.market == marketCode }) else { return nil }
        if let interval {
            return market.candles.last(where: { $0.intervalMinutes == interval })
        }
        for preferredInterval in [5, 1, 15, 60] {
            if let latest = market.candles.last(where: { $0.intervalMinutes == preferredInterval }) {
                return latest
            }
        }
        return market.candles.last
    }

    func localMarketTimestampLabel(for marketCode: String, interval: Int? = nil) -> String {
        guard let timestamp = localMarketLatestCandle(for: marketCode, interval: interval)?.timestamp else {
            return "캔들 시각 정보가 없어요"
        }
        return "캔들 시각 · \(CoinPilotFormatting.utcMarketTimestamp(timestamp))"
    }

    func localMarketChartWindowLabel(for marketCode: String, interval: Int) -> String? {
        guard let market = localMarketData?.markets.first(where: { $0.market == marketCode }) else { return nil }
        let rows = market.candles.filter { $0.intervalMinutes == interval }
        guard let firstVisible = rows.suffix(Self.maximumBundledLocalChartCandles).first,
              let lastVisible = rows.last else { return nil }
        let visibleCount = min(rows.count, Self.maximumBundledLocalChartCandles)
        let range = "\(CoinPilotFormatting.utcMarketTimestamp(firstVisible.timestamp)) – \(CoinPilotFormatting.utcMarketTimestamp(lastVisible.timestamp))"
        if rows.count > Self.maximumBundledLocalChartCandles {
            return "최근 \(visibleCount) / 전체 \(rows.count)개 캔들 · \(range)"
        }
        return "전체 \(rows.count)개 캔들 · \(range)"
    }

    private func beginRequestGeneration() -> Int {
        requestGeneration += 1
        isRefreshing = false
        isWorking = false
        isSubmittingManualOrder = false
        isRunningFeatureAction = false
        isRecordingSnapshot = false
        isLoadingTuning = false
        isSavingTuning = false
        return requestGeneration
    }

    private func applyExchangeProfile(exchange: String?, quoteCurrency quote: String?) {
        serverExchange = exchange ?? serverExchange
        if let quote, !quote.isEmpty {
            quoteCurrency = quote
            switch quote {
            case "KRW": CoinPilotFormatting.quoteSymbol = "₩"
            case "USDT", "USDC", "FDUSD", "TUSD": CoinPilotFormatting.quoteSymbol = "$"
            default: CoinPilotFormatting.quoteSymbol = "\(quote) "
            }
            CoinPilotFormatting.quoteAssetLabel = quote == "KRW" ? "원화" : quote
        }
    }

    var supportsAmountCurrency: Bool {
        ["KRW", "USDT", "USDC", "FDUSD", "TUSD"].contains(quoteCurrency)
    }

    /// 최소 주문 금액 — 기준통화 단위. KRW 5,000 / 지원하는 USD stablecoin 5.
    var minimumOrderAmount: Double { quoteCurrency == "KRW" ? 5_000 : 5 }

    /// 모의 계좌 초기 잔액 최소값 — 기준통화 단위.
    var minimumSeedAmount: Double { quoteCurrency == "KRW" ? 100_000 : 100 }

    /// 모의 계좌 입금·출금 최소 금액 — 기준통화 단위.
    var minimumWalletAmount: Double { quoteCurrency == "KRW" ? 1_000 : 1 }

    /// 조건 매도 목표의 최소 금액 — 서버가 허용하는 기준통화 단위.
    var minimumSmartSellAmount: Double { quoteCurrency == "KRW" ? 1_000 : minimumOrderAmount }

    private func normalizedQuoteAmount(_ amount: Double) -> Double {
        quoteCurrency == "KRW" ? floor(amount) : amount
    }

    /// 매수 금액 빠른 입력 프리셋 — 기준통화 단위.
    var buyAmountPresets: [Double] {
        quoteCurrency == "KRW" ? [10_000, 50_000, 100_000, 500_000] : [10, 50, 100, 500]
    }

    /// 연결된 거래소 표시 이름. 서버가 exchange를 보내지 않으면 Upbit로 간주한다.
    var exchangeDisplayName: String {
        switch serverExchange {
        case "binance": return "Binance"
        case "upbit", nil: return "Upbit"
        default: return serverExchange?.capitalized ?? "거래소"
        }
    }

    /// 기준통화 라벨 — KRW는 "원화", 그 외는 통화 코드 그대로.
    var quoteAssetLabel: String { CoinPilotFormatting.quoteAssetLabel }

    /// 현재 워크스페이스의 번들 서버 프리셋 (거래소별 인스턴스 선택용).
    var bundledServerPresets: [CoinPilotServerPreset] { bundledServers.presets(for: activeWorkspace) }

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
        components.path = parsed.path == "/live" ? "/live" : ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private static func displayAddress(_ url: URL) -> String {
        guard let host = url.host else { return url.absoluteString }
        return host + (url.port.map { ":\($0)" } ?? "") + (url.path == "/live" ? "/live" : "")
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
    /// 연결된 서버의 기준통화 표시 기호 — status/auth-status에서 갱신된다.
    static var quoteSymbol = "₩"
    /// 기준통화 자연어 라벨 — KRW는 "원화", 그 외는 통화 코드.
    static var quoteAssetLabel = "원화"

    static func won(_ value: Double?, unavailable: String = "금액 미제공") -> String {
        guard let value, value.isFinite else { return unavailable }
        let sign = value < 0 ? "−" : ""
        return "\(sign)\(quoteSymbol)\(number(abs(value), fractionDigits: quoteSymbol == "₩" ? 0 : 8))"
    }

    static func signedWon(_ value: Double?, unavailable: String = "손익 미제공") -> String {
        guard let value, value.isFinite else { return unavailable }
        let sign = value > 0 ? "+" : value < 0 ? "−" : ""
        return "\(sign)\(quoteSymbol)\(number(abs(value), fractionDigits: quoteSymbol == "₩" ? 0 : 8))"
    }

    static func price(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "시세 미제공" }
        let fractionDigits = quoteSymbol == "₩" ? (value >= 1_000 ? 0 : value >= 1 ? 2 : 6) : 8
        return "\(quoteSymbol)\(number(value, fractionDigits: fractionDigits))"
    }

    static func percent(_ value: Double?, signed: Bool = true, unavailable: String = "변동률 미제공") -> String {
        guard let value, value.isFinite else { return unavailable }
        guard value != 0 else { return "0%" }
        let magnitude = abs(value)
        if magnitude < 0.0001 {
            let direction = value < 0 ? " 하락" : signed ? " 상승" : ""
            return "0.0001% 미만\(direction)"
        }
        let sign = signed && value > 0 ? "+" : ""
        return "\(sign)\(number(value, fractionDigits: magnitude < 0.01 ? 4 : 2))%"
    }

    static func quantity(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "수량 미제공" }
        return number(value, fractionDigits: 8)
    }

    static func editableNumber(_ value: Double) -> String {
        let text = String(value)
        return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
    }

    /// RSI, MACD 히스토그램, BB %B 같은 지표 숫자 표기.
    static func indicator(_ value: Double?, fractionDigits: Int = 2, unavailable: String = "—") -> String {
        guard let value, value.isFinite else { return unavailable }
        return number(value, fractionDigits: fractionDigits)
    }

    /// 차트 축처럼 좁은 공간에 넣는 기준통화 축약 표기. KRW는 만·억, 그 외는 K/M/B.
    static func compactWon(_ value: Double?, unavailable: String = "금액 미제공") -> String {
        guard let value, value.isFinite else { return unavailable }
        let sign = value < 0 ? "−" : ""
        let magnitude = abs(value)
        if quoteSymbol != "₩" {
            if magnitude >= 1_000_000_000 {
                return "\(sign)\(quoteSymbol)\(number(magnitude / 1_000_000_000, fractionDigits: 2))B"
            }
            if magnitude >= 1_000_000 {
                return "\(sign)\(quoteSymbol)\(number(magnitude / 1_000_000, fractionDigits: 2))M"
            }
            if magnitude >= 1_000 {
                return "\(sign)\(quoteSymbol)\(number((magnitude / 1_000).rounded(), fractionDigits: 0))K"
            }
            return "\(sign)\(quoteSymbol)\(number(magnitude, fractionDigits: magnitude >= 1 ? 2 : 4))"
        }
        if magnitude >= 100_000_000 {
            let eok = magnitude / 100_000_000
            let text = eok >= 100 ? number(eok.rounded(), fractionDigits: 0) : number(eok, fractionDigits: 1)
            return "\(sign)\(text)억원"
        }
        if magnitude >= 10_000 {
            return "\(sign)\(number((magnitude / 10_000).rounded(), fractionDigits: 0))만원"
        }
        return "\(sign)\(number(magnitude.rounded(), fractionDigits: 0))원"
    }

    /// 자산 기록 그래프의 가로축 시각. 기간에 따라 시각 또는 날짜를 보입니다.
    static func historyAxisLabel(_ value: String?, period: CoinPilotHistoryPeriod) -> String {
        guard let value, let date = parseDate(value) else { return "시각 미제공" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        switch period {
        case .hour, .day:
            formatter.dateFormat = "a h:mm"
        case .week, .month:
            formatter.dateFormat = "M월 d일"
        }
        return formatter.string(from: date)
    }

    /// UTC 캔들 시각의 짧은 표기 (예: "09.29 14:05"). 시간대 변환 없이 원본 시각을 유지합니다.
    static func shortUtcTimestamp(_ value: String?) -> String {
        guard let value, let date = parseDate(value) else { return "시각 미제공" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "MM.dd HH:mm"
        return formatter.string(from: date)
    }

    static func dateTime(_ value: String?, unavailable: String = "시각 미제공") -> String {
        guard let value, let date = parseDate(value) else { return unavailable }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일 a h:mm"
        return formatter.string(from: date)
    }

    static func localDateTime(_ value: Date?, unavailable: String = "시각 미제공") -> String {
        guard let value else { return unavailable }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일 a h:mm"
        return formatter.string(from: value)
    }

    static func marketTimestamp(_ value: String?, label: String) -> String {
        guard let value else { return "\(label) 시각 미제공" }
        guard let date = parseDate(value) else { return "\(label) 시각 형식 오류" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일 a h:mm:ss"
        return "\(label) \(formatter.string(from: date))"
    }

    static func utcMarketTimestamp(_ value: String) -> String {
        let characters = Array(value)
        guard characters.count >= 20,
              characters[4] == "-",
              characters[7] == "-",
              characters[10] == "T",
              characters[13] == ":",
              characters[16] == ":",
              characters.last == "Z" else { return "시각 형식 오류" }

        let year = String(characters[0..<4])
        let month = String(characters[5..<7])
        let day = String(characters[8..<10])
        let hour = String(characters[11..<13])
        let minute = String(characters[14..<16])
        let seconds = String(characters[17..<19])
        let fraction: String
        if characters.count > 21, characters[19] == "." {
            let digits = String(characters[20..<(characters.count - 1)])
            fraction = digits.contains(where: { $0 != "0" }) ? ".\(digits)" : ""
        } else {
            fraction = ""
        }
        return "\(year). \(month). \(day). \(hour):\(minute):\(seconds)\(fraction) UTC"
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
        let symbol = coin.split(separator: "-").last.map(String.init) ?? coin
        switch symbol {
        case "BTC": return "비트코인"
        case "ETH": return "이더리움"
        case "XRP": return "리플"
        default: return symbol.isEmpty ? "자산 미제공" : symbol
        }
    }

    static func ticker(_ coin: String?) -> String {
        guard let coin else { return "—" }
        return coin.split(separator: "-").last.map(String.init) ?? coin
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
