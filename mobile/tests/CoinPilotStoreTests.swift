import Foundation
import CryptoKit

private actor DeferredCoinPilotAPI: CoinPilotAPIProviding {
    private var heldHosts: Set<String>
    private var heldMarketPaths: Set<String>
    private var marketRows: [[String: Any]]
    private var marketSnapshotOverride: [String: Any]?
    private let requiresAuth: Bool
    private let statusOverride: [String: Any]
    private var loginTokenScope: String?
    private let isReadOnlyObserver: Bool
    private var pending: [String: CheckedContinuation<CoinPilotHTTPResponse, Error>] = [:]
    private var waiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var pendingMarketReads: [String: CheckedContinuation<CoinPilotHTTPResponse, Error>] = [:]
    private var marketReadWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var readRequests = 0
    private var networkCalls = 0
    private var loginTokens: [String] = []
    private var readTokens: [String?] = []
    private var readPaths: [String] = []
    private var mutationPaths: [String] = []
    private var failedPaths: Set<String> = []
    private var cancelledPaths: Set<String> = []
    private var upbitCredentialsConfigured: Bool?
    private let credentialRegistrationStatusCode: Int
    private var credentialSubmissions: [[String: String]] = []
    private var credentialSubmissionURLs: [String] = []
    private var credentialSubmissionTokens: [String] = []

    init(
        heldAccountHosts: Set<String> = [],
        heldMarketPaths: Set<String> = [],
        marketRows: [[String: Any]] = [],
        requiresAuth: Bool = false,
        statusOverride: [String: Any] = [:],
        loginTokenScope: String? = nil,
        isReadOnlyObserver: Bool = true,
        credentialRegistrationStatusCode: Int = 200
    ) {
        heldHosts = heldAccountHosts
        self.heldMarketPaths = heldMarketPaths
        self.marketRows = marketRows
        self.requiresAuth = requiresAuth
        self.statusOverride = statusOverride
        self.loginTokenScope = loginTokenScope
        self.isReadOnlyObserver = isReadOnlyObserver
        upbitCredentialsConfigured = statusOverride["upbitCredentialsConfigured"] as? Bool
        self.credentialRegistrationStatusCode = credentialRegistrationStatusCode
    }

    func authenticationStatus(at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        return Self.response(["success": true, "authRequired": requiresAuth])
    }

    func login(token: String, at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        loginTokens.append(token)
        var body: [String: Any] = ["success": true]
        if let loginTokenScope { body["tokenScope"] = loginTokenScope }
        return Self.response(body)
    }

    func read(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        readRequests += 1
        readPaths.append(path)
        readTokens.append(token)
        if cancelledPaths.contains(path) { throw CancellationError() }
        if failedPaths.contains(path) { throw CoinPilotAPIError.connection }
        let host = serverURL.host ?? ""
        if path == "/api/account", heldHosts.contains(host) {
            return try await withCheckedThrowingContinuation { continuation in
                pending[host] = continuation
                waiters.removeValue(forKey: host)?.resume()
            }
        }
        if path.hasPrefix("/api/market/candles/"), heldMarketPaths.contains(path) {
            return try await withCheckedThrowingContinuation { continuation in
                pendingMarketReads[path] = continuation
                marketReadWaiters.removeValue(forKey: path)?.resume()
            }
        }
        return Self.readResponse(
            path: path,
            totalAssets: host == "first.example" ? 1111 : 2222,
            serverMode: statusOverride["mode"] as? String ?? "DRY_RUN",
            statusOverride: statusOverride,
            isReadOnlyObserver: isReadOnlyObserver,
            upbitCredentialsConfigured: upbitCredentialsConfigured,
            marketRows: marketRows,
            marketSnapshotOverride: marketSnapshotOverride
        )
    }

    func mobileRead(path: String, at serverURL: URL, token: String) async throws -> CoinPilotHTTPResponse {
        try await read(path: path, at: serverURL, token: token)
    }

    func registerLiveCredentials(
        accessKey: String,
        secretKey: String,
        at serverURL: URL,
        token: String
    ) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        mutationPaths.append("/api/live/credentials")
        credentialSubmissions.append(["accessKey": accessKey, "secretKey": secretKey])
        credentialSubmissionURLs.append(serverURL.absoluteString)
        credentialSubmissionTokens.append(token)
        if (200..<300).contains(credentialRegistrationStatusCode) {
            upbitCredentialsConfigured = true
            return Self.response(["success": true])
        }
        return Self.response(["error": "credential registration failed"], statusCode: credentialRegistrationStatusCode)
    }

    func mutate(
        path: String,
        at serverURL: URL,
        token: String,
        body: [String: Any],
        idempotencyKey: String?
    ) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        mutationPaths.append(path)
        return Self.response(["success": true])
    }

    func waitForHeldAccount(host: String) async {
        if pending[host] != nil { return }
        await withCheckedContinuation { continuation in
            waiters[host] = continuation
        }
    }

    func releaseAccount(host: String, totalAssets: Double) {
        pending.removeValue(forKey: host)?.resume(
            returning: Self.accountResponse(totalAssets: totalAssets, isReadOnlyObserver: isReadOnlyObserver)
        )
    }

    func waitForHeldMarketPath(_ path: String) async {
        if pendingMarketReads[path] != nil { return }
        await withCheckedContinuation { continuation in
            marketReadWaiters[path] = continuation
        }
    }

    func releaseMarketPath(_ path: String, close: Double, statusCode: Int = 200) {
        pendingMarketReads.removeValue(forKey: path)?.resume(
            returning: Self.marketCandleResponse(close: close, statusCode: statusCode)
        )
    }

    func readRequestCount() -> Int { readRequests }
    func networkCallCount() -> Int { networkCalls }
    func recordedLoginTokens() -> [String] { loginTokens }
    func recordedReadTokens() -> [String?] { readTokens }
    func recordedReadPaths() -> [String] { readPaths }
    func recordedMutationPaths() -> [String] { mutationPaths }
    func recordedCredentialSubmissions() -> [[String: String]] { credentialSubmissions }
    func recordedCredentialSubmissionURLs() -> [String] { credentialSubmissionURLs }
    func recordedCredentialSubmissionTokens() -> [String] { credentialSubmissionTokens }
    func setLoginTokenScope(_ scope: String?) { loginTokenScope = scope }
    func setFailedPaths(_ paths: Set<String>) { failedPaths = paths }
    func setCancelledPaths(_ paths: Set<String>) { cancelledPaths = paths }
    func setHeldHosts(_ hosts: Set<String>) { heldHosts = hosts }
    func setHeldMarketPaths(_ paths: Set<String>) { heldMarketPaths = paths }
    func setMarketRows(_ rows: [[String: Any]]) { marketRows = rows }
    func setMarketSnapshot(_ snapshot: [String: Any]) { marketSnapshotOverride = snapshot }

    private static func readResponse(
        path: String,
        totalAssets: Double,
        serverMode: String,
        statusOverride: [String: Any],
        isReadOnlyObserver: Bool,
        upbitCredentialsConfigured: Bool?,
        marketRows: [[String: Any]],
        marketSnapshotOverride: [String: Any]?
    ) -> CoinPilotHTTPResponse {
        if path == "/api/account" {
            return accountResponse(totalAssets: totalAssets, mode: serverMode, isReadOnlyObserver: isReadOnlyObserver)
        }
        if path == "/api/status" {
            var status: [String: Any] = ["isRunning": true, "mode": serverMode, "readOnlyObserver": isReadOnlyObserver]
            status.merge(statusOverride) { _, newValue in newValue }
            if let upbitCredentialsConfigured {
                status["upbitCredentialsConfigured"] = upbitCredentialsConfigured
            }
            return response(status)
        }
        if path == "/api/cumulative-pnl" {
            return response([
                "initialSeedMoney": 1000,
                "totalAssets": totalAssets,
                "profit": totalAssets - 1000,
                "profitPercent": totalAssets / 10 - 100,
                "readOnlyObserver": true
            ])
        }
        if path == "/api/today-summary" { return response(["realizedProfit": 0]) }
        if path == "/api/paper-validation/summary" {
            return response([
                "schema": "coinpilot.paper-validation-mobile-summary.v1",
                "researchOnly": true,
                "promoted": false,
                "actualFillsObserved": false,
                "available": true,
                "active": false,
                "configSnapshotComplete": true,
                "continuityEligible": true,
                "strict": ["closedTradeCount": 3, "realizedProfitKrw": -125.0, "openPositionCount": 0],
                "diagnostic": ["shadowClosedTradeCount": 2, "shadowRealizedProfitKrw": -300.0, "shadowOpenPositionCount": 1],
                "cohort": ["available": true, "complete": true, "fresh": true,
                           "sessionCount": 5, "strictTradeCount": 8, "strictTradeSessionCount": 3,
                           "eligibleStrictSessionCount": 0, "eligibleStrictTradeCount": 0,
                           "profitabilityEvidenceTradeCount": 0, "strictCostUnverifiedTradeCount": 2,
                           "totalStrictProfitComparable": false, "actualFillsObserved": false,
                           "promoted": false],
                "costAudit": ["available": true, "actualFillsObserved": false, "evaluatedTradeCount": 3,
                              "unmodeledExecutionTradeCount": 3, "configuredSlippagePercent": 0.1,
                              "recordedNetPnlKrw": -125.0, "modeledSlippageDragKrw": 250.0,
                              "costStressedNetPnlKrw": -375.0]
            ])
        }
        if path.hasPrefix("/api/portfolio/history") {
            return response(["data": [[String: Any]](), "period": "24h", "count": 0])
        }
        if path == "/api/market/prices/snapshot" {
            let fetchedAt = Date()
            let sourceAsOf = fetchedAt.addingTimeInterval(-1)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return response(marketSnapshotOverride ?? [
                "prices": marketRows,
                "complete": true,
                "missingMarkets": [String](),
                "marketListStale": false,
                "sourceAsOf": formatter.string(from: sourceAsOf),
                "fetchedAt": formatter.string(from: fetchedAt)
            ])
        }
        if path == "/api/market/prices" { return response(marketRows) }
        if path.hasPrefix("/api/trades") { return response([[String: Any]]()) }
        return response(["error": "unsupported test path"], statusCode: 404)
    }

    private static func marketCandleResponse(close: Double, statusCode: Int) -> CoinPilotHTTPResponse {
        if !(200..<300).contains(statusCode) {
            return response(["error": "synthetic candle read failure"], statusCode: statusCode)
        }
        return response([[
            "time": "2026-09-29T12:00:00.000Z",
            "open": close - 1,
            "high": close + 2,
            "low": close - 2,
            "close": close,
            "volume": 1.25
        ]])
    }

    private static func accountResponse(
        totalAssets: Double,
        mode: String = "DRY_RUN",
        isReadOnlyObserver: Bool = true
    ) -> CoinPilotHTTPResponse {
        response([
            "krwBalance": totalAssets,
            "totalAssets": totalAssets,
            "profit": totalAssets - 1000,
            "profitPercent": totalAssets / 10 - 100,
            "mode": mode,
            "readOnlyObserver": isReadOnlyObserver,
            "valuationAvailable": true,
            "positions": [[String: Any]]()
        ])
    }

    private static func response(_ body: Any, statusCode: Int = 200) -> CoinPilotHTTPResponse {
        CoinPilotHTTPResponse(
            statusCode: statusCode,
            headers: ["Content-Type": "application/json"],
            body: try! JSONSerialization.data(withJSONObject: body)
        )
    }
}

private final class MemoryCoinPilotTokens: CoinPilotTokenProviding {
    private var values: [String: String] = [:]
    func token(for serverURL: URL) -> String? { values[serverURL.absoluteString] }
    func save(_ token: String, for serverURL: URL) -> Bool {
        values[serverURL.absoluteString] = token
        return true
    }
    func delete(for serverURL: URL) { values.removeValue(forKey: serverURL.absoluteString) }
}

private actor DeferredBundledMarketDataLoader: CoinPilotBundledMarketDataLoading {
    private var pending: CheckedContinuation<Result<CoinPilotBundledMarketData, CoinPilotBundledMarketDataError>, Never>?
    private var startWaiter: CheckedContinuation<Void, Never>?

    func load() async -> Result<CoinPilotBundledMarketData, CoinPilotBundledMarketDataError> {
        await withCheckedContinuation { continuation in
            pending = continuation
            startWaiter?.resume()
            startWaiter = nil
        }
    }

    func waitUntilStarted() async {
        if pending != nil { return }
        await withCheckedContinuation { continuation in
            startWaiter = continuation
        }
    }

    func complete(_ result: Result<CoinPilotBundledMarketData, CoinPilotBundledMarketDataError>) {
        pending?.resume(returning: result)
        pending = nil
    }
}

@MainActor
@main
struct CoinPilotStoreTests {
    static func main() async throws {
        try await logoutDiscardsLateAccountResponse()
        try await serverSwitchDiscardsPreviousAccountResponse()
        try await liveWorkspaceUsesItsOwnAddressAndRejectsPaperMode()
        try await liveCredentialRegistrationUsesEphemeralKeysAndWaitsForSync()
        try await liveCredentialRegistrationRequiresHttpsAndMobileOperatorScope()
        try await signInUsesAndStoresOnlyTheServerToken()
        try await fullOperatorScopeFailsClosedAndClearsPriorSession()
        try liveManualPrepareStatusKeepsAutomationControlAvailable()
        try simulatorTokenStoreIsScopedAndVolatile()
        try await simulatorDefaultTokenStoreSupportsReadOnlySignIn()
        try nativeReadAllowlistIncludesOnlyThePaperSummary()
        try await bundledPreviewWorksWithoutCallingTheServer()
        try await bundledPreviewBuildIgnoresThePreviousServerProfile()
        try await bundledPreviewMissingResourceDoesNotFallBackToServer()
        try await refreshValidatesModeBeforePrivateReads()
        try await latestMarketDetailRequestWins()
        try localMarketPackRejectsInvalidData()
        try await bundledLocalMarketModeIsStrictReadOnlyAndOffline()
        try await bundledLocalMarketMissingResourceFailsClosed()
        try await bundledLocalLoadKeepsTheStoreResponsive()
        try await bundledLocalChartUsesOnlyTheNewestBoundedWindow()
        try await partialRefreshMarksOnlyTheFailedResourceStale()
        try await pendingRefreshKeepsTheLastSuccessfulTimeVisible()
        try await historyFailureRemainsVisibleBesideTheChart()
        try await paperSummaryFailureDoesNotBlockTheCoreDashboard()
        try await protectiveOnlyStatusIsVisibleInTheReadOnlyApp()
        try await unknownExchangeStateBlocksTheServerTradingStatus()
        try optionalMarketTimestampsDecodeWithoutChangingExistingModelFields()
        try marketTimestampFormattingKeepsSourceAndFetchTimesDistinct()
        try await completeMarketSnapshotUsesServerFetchedAt()
        try await staleMarketSourceCannotEnableManualOrder()
        try await incompleteMarketSnapshotKeepsPricesVisibleAndMarksStale()
        try await staleMarketListAndInvalidFetchedAtNeverMarkCurrent()
        print("CoinPilotStore: 33 scenarios passed")
    }

    private static func bundledPreviewMissingResourceDoesNotFallBackToServer() async throws {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl",
            "coinpilot.dashboardUrl.paper",
            "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace",
            "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server",
            "coinpilot.native.dataMode.profile.bundled-preview"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        let liveURL = URL(string: "https://saved-live-profile.example")!
        defaults.set("live", forKey: "coinpilot.native.activeWorkspace")
        defaults.set(liveURL.absoluteString, forKey: "coinpilot.dashboardUrl.live")
        defaults.set("bundled-preview", forKey: "coinpilot.native.dataMode.profile.bundled-preview")

        let api = DeferredCoinPilotAPI(
            requiresAuth: true,
            statusOverride: ["mode": "LIVE"]
        )
        let tokens = MemoryCoinPilotTokens()
        precondition(tokens.save("synthetic-previous-server-token", for: liveURL))
        let store = CoinPilotStore(
            api: api,
            tokens: tokens,
            bundledPreview: CoinPilotBundledPreviewDataSource(data: Data()),
            configuredDataMode: "bundled-preview"
        )

        await store.bootstrap()

        precondition(store.isBundledPreview && !store.canUseBundledPreview,
                     "The selected Preview profile must remain selected when its packaged file is missing.")
        precondition(store.activeWorkspace == .paper && store.phase == .dashboard,
                     "Preview should normalize a restored LIVE workspace to its sample Paper view.")
        precondition(store.account == nil && store.status == nil && store.trades.isEmpty,
                     "A missing Preview resource must not display data from the saved LIVE server profile.")
        precondition(store.dashboardMessage?.contains("앱에 포함된 예시 자료") == true,
                     "A missing Preview pack should show a local data error instead of a server error.")
        let networkCalls = await api.networkCallCount()
        precondition(networkCalls == 0,
                     "A missing Preview pack must not use the saved server address or token.")
    }

    private static func refreshValidatesModeBeforePrivateReads() async throws {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl",
            "coinpilot.dashboardUrl.paper",
            "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace",
            "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("paper", forKey: "coinpilot.native.activeWorkspace")

        let mismatchAPI = DeferredCoinPilotAPI(statusOverride: ["mode": "LIVE"])
        let mismatchStore = CoinPilotStore(
            api: mismatchAPI,
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "server"
        )
        let mismatchConnected = await mismatchStore.connect(using: "https://mode-mismatch.example")
        precondition(!mismatchConnected && mismatchStore.status?.mode == "LIVE" &&
                     !mismatchStore.serverModeMatchesWorkspace,
                     "The mismatched server mode should remain visible and locked.")
        let mismatchReads = await mismatchAPI.recordedReadPaths()
        precondition(mismatchReads == ["/api/status"],
                     "An unexpected LIVE server must not receive account, history, market, or trade reads.")

        let unknownModeAPI = DeferredCoinPilotAPI()
        await unknownModeAPI.setFailedPaths(["/api/status"])
        let unknownModeStore = CoinPilotStore(
            api: unknownModeAPI,
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "server"
        )
        let unknownModeConnected = await unknownModeStore.connect(using: "https://status-unavailable.example")
        precondition(!unknownModeConnected && unknownModeStore.account == nil &&
                     !unknownModeStore.serverModeMatchesWorkspace,
                     "Unknown server mode must keep account data unavailable.")
        let unknownModeReads = await unknownModeAPI.recordedReadPaths()
        precondition(unknownModeReads == ["/api/status"],
                     "A failed mode check must stop before account or other private reads.")
    }

    private static func latestMarketDetailRequestWins() async throws {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl",
            "coinpilot.dashboardUrl.paper",
            "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace",
            "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("paper", forKey: "coinpilot.native.activeWorkspace")

        let btcPath = "/api/market/candles/KRW-BTC?unit=5&count=100"
        let ethPath = "/api/market/candles/KRW-ETH?unit=5&count=100"
        let api = DeferredCoinPilotAPI(
            heldMarketPaths: [btcPath, ethPath],
            marketRows: [
                ["coin": "KRW-BTC", "price": 100_000.0],
                ["coin": "KRW-ETH", "price": 200_000.0]
            ],
            requiresAuth: true,
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        store.serverDraft = "https://market-detail.example"
        store.tokenDraft = "synthetic-mobile-operator-token"
        let connected = await store.signIn()
        precondition(connected && store.canOperate, "The synthetic mobile operator should open the Market detail route.")

        let btcLoad = Task { await store.loadMarketDetail(coin: "KRW-BTC", interval: 5) }
        await api.waitForHeldMarketPath(btcPath)
        precondition(store.selectedMarket == "KRW-BTC" && store.candles.isEmpty,
                     "Changing the selected market should clear a previous chart while its new request is loading.")

        let ethLoad = Task { await store.loadMarketDetail(coin: "KRW-ETH", interval: 5) }
        await api.waitForHeldMarketPath(ethPath)
        await api.releaseMarketPath(ethPath, close: 200_000)
        await ethLoad.value
        precondition(store.selectedMarket == "KRW-ETH" && store.candles.last?.close == 200_000,
                     "The current market response should populate the matching detail chart.")

        await api.releaseMarketPath(btcPath, close: 100_000, statusCode: 503)
        await btcLoad.value
        precondition(store.selectedMarket == "KRW-ETH" && store.candles.last?.close == 200_000,
                     "A late response from the previous market must not replace the current chart.")
        precondition(store.featureMessages["market"] == nil && !store.loadingFeatures.contains("market"),
                     "A stale request failure must not add an error or clear current loading state.")

        await api.setCancelledPaths([ethPath])
        await store.loadMarketDetail(coin: "KRW-ETH", interval: 5)
        precondition(store.candles.last?.close == 200_000 &&
                     store.featureMessages["market"] == nil &&
                     !store.loadingFeatures.contains("market"),
                     "Cancellation should preserve the selected chart without presenting a connection error.")
    }

    private static func localMarketPackRejectsInvalidData() throws {
        let validData = localMarketFixture()
        let decoded = try CoinPilotBundledMarketData.decode(data: validData)
        precondition(decoded.schemaVersion == 1 && decoded.markets.count == 1,
                     "A valid public market and OHLCV pack should load.")
        precondition(decoded.markets[0].candles.count == 4,
                     "The local pack should keep the source OHLCV rows.")
        expectMarketDataError(.invalidValue) {
            try CoinPilotBundledMarketData.decode(data: replacing(
                "\"generatedAt\":\"2026-09-29T12:01:00.000Z\"",
                with: "\"generatedAt\":\"2026-09-29T12:00:59.999Z\"",
                in: validData
            ))
        }

        expectMarketDataError(.fileTooLarge) {
            try CoinPilotBundledMarketData.decode(data: validData, maximumBytes: validData.count - 1)
        }
        expectMarketDataError(.malformed) {
            try CoinPilotBundledMarketData.decode(data: Data("{\"schemaVersion\":1".utf8))
        }
        expectMarketDataError(.unsupportedSchema) {
            try CoinPilotBundledMarketData.decode(data: replacing(
                "\"schemaVersion\":1", with: "\"schemaVersion\":2", in: validData
            ))
        }
        expectMarketDataError(.malformed) {
            try CoinPilotBundledMarketData.decode(data: replacing(
                "\"generatedAt\":", with: "\"unexpectedAccount\":{},\"generatedAt\":", in: validData
            ))
        }
        expectMarketDataError(.malformed) {
            try CoinPilotBundledMarketData.decode(data: replacing(
                "\"market\":\"KRW-BTC\"", with: "\"market\":\"KRW-BTC\",\"privateTrades\":[]", in: validData
            ))
        }
        expectMarketDataError(.unsupportedSchema) {
            try CoinPilotBundledMarketData.decode(data: replacing(
                "\"source\":\"upbit-public-market-api\"", with: "\"source\":\"other\"", in: validData
            ))
        }

        let matchingManifest = Data(SHA256.hash(data: validData).map { byte in
            let digits = Array("0123456789abcdef".utf8)
            return [digits[Int(byte >> 4)], digits[Int(byte & 0x0f)]]
        }.flatMap { $0 })
        let verified = try CoinPilotBundledMarketData.decode(data: validData, digestManifest: matchingManifest)
        precondition(verified == decoded, "A matching SHA-256 sidecar should permit decoding the bundled bytes.")

        expectMarketDataError(.missingIntegrityManifest) {
            try CoinPilotBundledMarketData.decode(data: validData, digestManifest: nil)
        }
        expectMarketDataError(.malformedIntegrityManifest) {
            try CoinPilotBundledMarketData.decode(data: validData, digestManifest: Data("not-a-digest".utf8))
        }
        expectMarketDataError(.integrityMismatch) {
            try CoinPilotBundledMarketData.decode(
                data: validData,
                digestManifest: Data(String(repeating: "0", count: 64).utf8)
            )
        }
    }

    private static func bundledLocalMarketModeIsStrictReadOnlyAndOffline() async throws {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl",
            "coinpilot.dashboardUrl.paper",
            "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace",
            "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server",
            "coinpilot.native.dataMode.profile.bundled-preview",
            "coinpilot.native.dataMode.profile.bundled-local"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("paper", forKey: "coinpilot.native.activeWorkspace")
        defaults.set("server", forKey: "coinpilot.native.dataMode")
        defaults.set("https://stale-server-profile.example", forKey: "coinpilot.dashboardUrl.paper")

        let api = DeferredCoinPilotAPI(requiresAuth: true)
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: CoinPilotBundledMarketDataSource(data: localMarketFixture()),
            configuredDataMode: "bundled-local"
        )
        await store.bootstrap()

        precondition(store.isBundledLocalMarketData && !store.isBundledPreview,
                     "The build-selected local profile must ignore the previous Server preference.")
        precondition(store.marketCandleOriginLabel(candleCount: 4)
                     == "앱에 포함된 공개 자료 · 캔들 4개",
                     "Bundled-local details must identify the static app-pack data source.")
        precondition(store.marketQuoteFreshnessMessage(for: "KRW-BTC")
                     == "앱에 포함된 공개 시세 자료입니다. 최신성 자동 확인은 제공되지 않습니다.",
                     "Bundled-local screens must not imply server-verified market freshness.")
        precondition(store.phase == .dashboard && store.localMarketData?.markets.count == 1,
                     "The installed local profile should open directly on its strict market pack.")
        precondition(store.account == nil && store.status == nil && store.pnl == nil && store.trades.isEmpty && store.history.isEmpty,
                     "Local market data must not create account, ledger, trade, or history records.")
        precondition(!store.canOperate && !store.canViewTuning && store.manualOrderBlockReason != nil,
                     "The local profile must remain read-only and block server or order actions.")
        precondition(store.freshnessLabel(for: "market-prices") ==
                     "앱 저장 자료 생성 · 2026. 09. 29. 12:01:00 UTC",
                     "The market header should show a readable UTC package timestamp without substituting app time.")

        let connected = await store.connect(using: "https://stale-server-profile.example")
        let signedIn = await store.signIn()
        let orderSent = await store.submitManualBuy(coin: "KRW-BTC", amount: 5_000)
        let automationChanged = await store.setAutomationRunning(false)
        await store.refresh()
        await store.loadMarketDetail(coin: "KRW-BTC", interval: 5)
        precondition(!connected && !signedIn && !orderSent && !automationChanged,
                     "Local mode must reject connection, sign-in, order, and automation entry points.")
        precondition(store.candles.count == 2 && store.candles.last?.time == "2026-09-29T11:55:00.000Z",
                     "Market detail should use the exact selected source rows in chronological order.")
        precondition(store.localMarketTimestampLabel(for: "KRW-BTC", interval: 5) ==
                     "원본 캔들 · 2026. 09. 29. 11:55:00 UTC",
                     "Market timestamp presentation should keep the UTC meaning in a human-readable format.")
        let networkCalls = await api.networkCallCount()
        let mutationPaths = await api.recordedMutationPaths()
        precondition(networkCalls == 0,
                     "Loading, refreshing, detail navigation, and rejected actions must make no API calls.")
        precondition(mutationPaths.isEmpty,
                     "The local profile must never send mutations.")
    }

    private static func bundledLocalMarketMissingResourceFailsClosed() async throws {
        let api = DeferredCoinPilotAPI(requiresAuth: true)
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "bundled-local"
        )
        await store.bootstrap()
        precondition(store.isBundledLocalMarketData && store.phase == .dashboard,
                     "A missing local pack must not fall back to Server or fictional Preview.")
        precondition(store.localMarketData == nil && store.localMarketDataError != nil,
                     "A missing packaged resource should remain an explicit fail-closed state.")
        precondition(store.account == nil && store.markets.isEmpty,
                     "A missing local resource must not be filled with preview or account data.")
        let networkCalls = await api.networkCallCount()
        precondition(networkCalls == 0,
                     "The missing-resource state must not attempt a server connection.")
    }

    private static func bundledLocalLoadKeepsTheStoreResponsive() async throws {
        let loader = DeferredBundledMarketDataLoader()
        let store = CoinPilotStore(
            api: DeferredCoinPilotAPI(),
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: loader,
            configuredDataMode: "bundled-local"
        )
        let bootstrap = Task { await store.bootstrap() }

        await loader.waitUntilStarted()
        precondition(store.phase == .dashboard && store.didFinishInitialConnect,
                     "The local Market route should appear while the package load is pending.")
        precondition(store.isLoadingLocalMarketData && store.localMarketData == nil,
                     "The source state should expose loading instead of synchronously decoding during Store initialization.")
        store.selectedMarket = "KRW-BTC"
        precondition(store.selectedMarket == "KRW-BTC",
                     "The main actor should continue processing view state while market data loads.")

        let fixture = try CoinPilotBundledMarketData.decode(data: localMarketFixture())
        await loader.complete(.success(fixture))
        await bootstrap.value
        precondition(!store.isLoadingLocalMarketData && store.localMarketData?.markets.count == 1,
                     "The successful background result should be applied after the generation check.")
    }

    private static func bundledLocalChartUsesOnlyTheNewestBoundedWindow() async throws {
        let totalCandleCount = 1_250
        let fixture = localMarketFixture(candleCount: totalCandleCount)
        let store = CoinPilotStore(
            api: DeferredCoinPilotAPI(),
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: CoinPilotBundledMarketDataSource(data: fixture),
            configuredDataMode: "bundled-local"
        )
        await store.bootstrap()
        await store.loadMarketDetail(coin: "KRW-BTC", interval: 5)

        let packagedCandles = store.localMarketData?.markets.first?.candles ?? []
        precondition(packagedCandles.count == totalCandleCount,
                     "The packaged history should remain complete while the chart uses a bounded display window.")
        precondition(store.candles.count == 200,
                     "The chart-facing Store collection must cap visible candles at 200.")
        precondition(store.candles.first?.time == localMarketFixtureTimestamp(index: totalCandleCount - 200),
                     "The visible chart should start at the oldest row in the newest-200-candle window.")
        precondition(store.candles.last?.time == localMarketFixtureTimestamp(index: totalCandleCount - 1),
                     "The visible chart should end at the newest source row.")
        precondition(store.localMarketChartWindowLabel(for: "KRW-BTC", interval: 5) ==
                     "최근 200 / 전체 1250개 캔들 · 2026. 09. 28. 15:30:00 UTC – 2026. 09. 29. 08:05:00 UTC",
                     "The UI summary should identify the visible range and total preserved history in UTC.")
    }

    private static func expectMarketDataError(
        _ expected: CoinPilotBundledMarketDataError,
        operation: () throws -> CoinPilotBundledMarketData
    ) {
        do {
            _ = try operation()
            preconditionFailure("Expected local market data rejection: \(expected)")
        } catch let error as CoinPilotBundledMarketDataError {
            precondition(error == expected, "Expected \(expected), received \(error).")
        } catch {
            preconditionFailure("Expected \(expected), received \(error).")
        }
    }

    private static func replacing(_ target: String, with replacement: String, in data: Data) -> Data {
        let source = String(decoding: data, as: UTF8.self)
        return Data(source.replacingOccurrences(of: target, with: replacement).utf8)
    }

    private static func localMarketFixture(candleCount: Int = 4) -> Data {
        if candleCount == 4 {
            return Data(#"{"schemaVersion":1,"source":"upbit-public-market-api","generatedAt":"2026-09-29T12:01:00.000Z","markets":[{"market":"KRW-BTC","candles":[{"intervalMinutes":1,"timestamp":"2026-09-29T12:00:00.000Z","open":100.0,"high":102.0,"low":99.0,"close":101.0,"volume":2.0},{"intervalMinutes":1,"timestamp":"2026-09-29T12:01:00.000Z","open":101.0,"high":112.0,"low":100.0,"close":110.0,"volume":3.0},{"intervalMinutes":5,"timestamp":"2026-09-29T11:50:00.000Z","open":90.0,"high":96.0,"low":89.0,"close":95.0,"volume":10.0},{"intervalMinutes":5,"timestamp":"2026-09-29T11:55:00.000Z","open":95.0,"high":106.0,"low":94.0,"close":105.0,"volume":11.0}]}]}"#.utf8)
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let start = formatter.date(from: "2026-09-25T00:00:00Z")!
        let candles: [[String: Any]] = (0..<candleCount).map { index in
            let open = 100.0 + Double(index % 1_000)
            return [
                "intervalMinutes": 5,
                "timestamp": formatter.string(from: start.addingTimeInterval(Double(index) * 300)),
                "open": open,
                "high": open + 2,
                "low": open - 1,
                "close": open + 1,
                "volume": 1.5
            ]
        }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "source": CoinPilotBundledMarketData.supportedSource,
            "generatedAt": formatter.string(from: start.addingTimeInterval(Double(candleCount) * 300)),
            "markets": [["market": "KRW-BTC", "candles": candles]]
        ]
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private static func localMarketFixtureTimestamp(index: Int) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let start = formatter.date(from: "2026-09-25T00:00:00Z")!
        return formatter.string(from: start.addingTimeInterval(Double(index) * 300))
    }

    private static func optionalMarketTimestampsDecodeWithoutChangingExistingModelFields() throws {
        let sourceAsOf = "2026-09-29T12:00:00.000Z"
        let fetchedAt = "2026-09-29T12:00:01.000Z"

        let account = CoinPilotAccount([
            "totalAssets": 1200,
            "valuationAsOf": sourceAsOf,
            "sourceAsOf": sourceAsOf,
            "fetchedAt": fetchedAt,
            "positions": [[
                "coin": "KRW-BTC",
                "sourceAsOf": sourceAsOf,
                "fetchedAt": fetchedAt
            ]]
        ])
        precondition(account.totalAssets == 1200)
        precondition(account.valuationAsOf == sourceAsOf)
        precondition(account.sourceAsOf == sourceAsOf)
        precondition(account.fetchedAt == fetchedAt)
        precondition(account.positions.first?.sourceAsOf == sourceAsOf)
        precondition(account.positions.first?.fetchedAt == fetchedAt)

        let pnl = CoinPilotPnL([
            "totalAssets": 1200,
            "sourceAsOf": sourceAsOf,
            "fetchedAt": fetchedAt
        ])
        precondition(pnl.totalAssets == 1200)
        precondition(pnl.sourceAsOf == sourceAsOf)
        precondition(pnl.fetchedAt == fetchedAt)

        let historyPoint = CoinPilotHistoryPoint([
            "timestamp": fetchedAt,
            "totalAssets": 1200,
            "valuationAsOf": sourceAsOf,
            "sourceAsOf": sourceAsOf,
            "fetchedAt": fetchedAt
        ], index: 0)
        precondition(historyPoint.id == fetchedAt)
        precondition(historyPoint.valuationAsOf == sourceAsOf)
        precondition(historyPoint.sourceAsOf == sourceAsOf)
        precondition(historyPoint.fetchedAt == fetchedAt)

        let marketPrice = CoinPilotMarketPrice([
            "coin": "KRW-BTC",
            "price": 100,
            "sourceAsOf": sourceAsOf,
            "fetchedAt": fetchedAt
        ])
        precondition(marketPrice.coin == "KRW-BTC")
        precondition(marketPrice.price == 100)
        precondition(marketPrice.sourceAsOf == sourceAsOf)
        precondition(marketPrice.fetchedAt == fetchedAt)
        precondition(CoinPilotStore.marketSnapshotFetchedAt(from: [marketPrice]) == fetchedAt)

        let sameSnapshotMarket = CoinPilotMarketPrice([
            "coin": "KRW-ETH",
            "sourceAsOf": "2026-09-29T12:00:02.000Z",
            "fetchedAt": fetchedAt
        ])
        let inconsistentSnapshotMarket = CoinPilotMarketPrice([
            "coin": "KRW-XRP",
            "sourceAsOf": sourceAsOf,
            "fetchedAt": "2026-09-29T12:00:03.000Z"
        ])
        precondition(CoinPilotStore.marketSnapshotFetchedAt(from: [marketPrice, sameSnapshotMarket]) == fetchedAt,
                     "Repeated per-market fetchedAt values should resolve to one snapshot timestamp.")
        precondition(CoinPilotStore.marketSnapshotFetchedAt(from: [marketPrice, inconsistentSnapshotMarket]) == nil,
                     "Conflicting fetchedAt values must not be presented as one snapshot time.")
        precondition(CoinPilotStore.marketSnapshotFetchedAt(from: []) == nil,
                     "An empty market set must not invent a snapshot timestamp.")

        precondition(CoinPilotAccount([:]).sourceAsOf == nil)
        precondition(CoinPilotAccount([:]).fetchedAt == nil)
        precondition(CoinPilotPnL([:]).sourceAsOf == nil)
        precondition(CoinPilotPnL([:]).fetchedAt == nil)
        precondition(CoinPilotHistoryPoint([:], index: 1).sourceAsOf == nil)
        precondition(CoinPilotHistoryPoint([:], index: 1).fetchedAt == nil)
        precondition(CoinPilotMarketPrice([:]).sourceAsOf == nil)
        precondition(CoinPilotMarketPrice([:]).fetchedAt == nil)

        let nullTimestamps: [String: Any] = ["sourceAsOf": NSNull(), "fetchedAt": NSNull()]
        precondition(CoinPilotAccount(nullTimestamps).sourceAsOf == nil)
        precondition(CoinPilotAccount(nullTimestamps).fetchedAt == nil)
        precondition(CoinPilotPnL(nullTimestamps).sourceAsOf == nil)
        precondition(CoinPilotPnL(nullTimestamps).fetchedAt == nil)
        precondition(CoinPilotHistoryPoint(nullTimestamps, index: 2).sourceAsOf == nil)
        precondition(CoinPilotHistoryPoint(nullTimestamps, index: 2).fetchedAt == nil)
        precondition(CoinPilotMarketPrice(nullTimestamps).sourceAsOf == nil)
        precondition(CoinPilotMarketPrice(nullTimestamps).fetchedAt == nil)
    }

    private static func marketTimestampFormattingKeepsSourceAndFetchTimesDistinct() throws {
        let sourceAsOf = "2026-09-29T12:00:00.000Z"
        let fetchedAt = "2026-09-29T12:00:03.000Z"
        let exchangeLabel = CoinPilotFormatting.marketTimestamp(sourceAsOf, label: "최근 체결")
        let serverLabel = CoinPilotFormatting.marketTimestamp(fetchedAt, label: "서버 시세 수집")
        let sourceValueOnly = CoinPilotFormatting.marketTimestamp(sourceAsOf, label: "시각")
        let fetchedValueOnly = CoinPilotFormatting.marketTimestamp(fetchedAt, label: "시각")

        precondition(exchangeLabel.hasPrefix("최근 체결 "), "Per-market sourceAsOf should be labeled as the latest trade time.")
        precondition(serverLabel.hasPrefix("서버 시세 수집 "), "The snapshot timestamp should be labeled as server collection time.")
        precondition(exchangeLabel != serverLabel, "Source and server fetch timestamps must remain distinct.")
        precondition(sourceValueOnly != fetchedValueOnly, "The source and fetch time values should retain their separate timestamps.")
        precondition(CoinPilotFormatting.marketTimestamp(nil, label: "최근 체결") == "최근 체결 시각 미제공")
        precondition(CoinPilotFormatting.marketTimestamp("invalid", label: "서버 시세 수집") == "서버 시세 수집 시각 형식 오류")
        precondition(CoinPilotFormatting.utcMarketTimestamp("2026-09-29T12:00:00.000Z") ==
                     "2026. 09. 29. 12:00:00 UTC",
                     "Zero fractional seconds should keep the second precision without technical zero padding.")
        precondition(CoinPilotFormatting.utcMarketTimestamp("2026-09-29T12:00:00.123400Z") ==
                     "2026. 09. 29. 12:00:00.123400 UTC",
                     "Nonzero fractional source precision must remain visible.")
    }

    private static func completeMarketSnapshotUsesServerFetchedAt() async throws {
        let now = Date()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let sourceAsOf = formatter.string(from: now.addingTimeInterval(-1))
        let fetchedAt = formatter.string(from: now.addingTimeInterval(-0.5))
        let prices: [[String: Any]] = [[
            "coin": "KRW-BTC",
            "price": 60_000_000,
            "sourceAsOf": sourceAsOf,
            "fetchedAt": fetchedAt
        ]]
        let api = DeferredCoinPilotAPI(marketRows: prices)
        await api.setMarketSnapshot([
            "prices": prices,
            "complete": true,
            "missingMarkets": [String](),
            "marketListStale": false,
            "sourceAsOf": sourceAsOf,
            "fetchedAt": fetchedAt
        ])
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), now: { now })
        let connected = await store.connect(using: "https://market-snapshot-complete.example")

        precondition(connected, "A complete market snapshot should load with the dashboard.")
        guard case .current(let currentAt) = store.state(for: "market-prices"),
              let metadata = store.marketSnapshotMetadata,
              let expectedAt = metadata.currentFetchedAt(at: now, maximumAgeSeconds: 90) else {
            fatalError("A complete, fresh snapshot with a valid fetchedAt should be current.")
        }
        precondition(currentAt == expectedAt,
                     "Market freshness should use the server's snapshot fetchedAt instead of the app request time.")
        precondition(metadata.complete == true && metadata.missingMarkets?.isEmpty == true && metadata.marketListStale == false,
                     "The client should consume all market completeness fields.")
        precondition(metadata.sourceAsOf == sourceAsOf && metadata.fetchedAt == fetchedAt,
                     "The client should retain snapshot-level source and fetch timestamps.")
        precondition(store.markets.first?.price == 60_000_000,
                     "Snapshot prices should populate the market list.")
    }

    private static func staleMarketSourceCannotEnableManualOrder() async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = Date()
        let sourceTime = formatter.string(from: now.addingTimeInterval(-1))
        let fetchTime = formatter.string(from: now.addingTimeInterval(-0.5))
        let api = DeferredCoinPilotAPI(
            marketRows: [[
                "coin": "KRW-BTC",
                "price": 60_000_000,
                "sourceAsOf": sourceTime,
                "fetchedAt": fetchTime
            ]],
            requiresAuth: true,
            statusOverride: ["mode": "DRY_RUN", "maxCandleAgeSeconds": 90],
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        store.serverDraft = "https://stale-market-order.example"
        store.tokenDraft = "mobile-operator-test-token"

        let signedIn = await store.signIn()
        precondition(signedIn && store.canOperate,
                     "The test must start from an otherwise order-capable Paper dashboard.")

        let staleSourceTime = formatter.string(from: now.addingTimeInterval(-600))
        let recentFetchTime = formatter.string(from: now.addingTimeInterval(-0.5))
        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [[
                "coin": "KRW-BTC",
                "price": 60_000_000,
                "sourceAsOf": sourceTime,
                "fetchedAt": recentFetchTime
            ], [
                "coin": "KRW-ETH",
                "price": 3_000_000,
                "sourceAsOf": staleSourceTime,
                "fetchedAt": recentFetchTime
            ]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            sourceAsOf: staleSourceTime,
            fetchedAt: recentFetchTime
        ))
        await store.refresh()

        precondition(store.state(for: "market-prices").isCurrent,
                     "One thinly traded market must not make the freshly collected full snapshot unavailable.")
        precondition(store.freshnessLabel(for: "market-prices").contains("종목 1개 시세가 오래됐어요"),
                     "The dashboard must visibly identify the stale market count.")
        precondition(store.manualOrderBlockReason(for: "KRW-BTC") == nil,
                     "One old market must not block a fresh order target.")
        precondition(store.manualOrderBlockReason(for: "KRW-ETH")?.contains("오래됐어요") == true,
                     "A recent server fetch must not make the stale exchange-price timestamp orderable.")
        precondition(store.marketQuoteFreshnessMessage(for: "KRW-BTC") == "최근 체결 시각을 확인했습니다.",
                     "Market details should describe a fresh selected quote using the same order-age rule.")
        precondition(store.marketQuoteFreshnessMessage(for: "KRW-ETH").contains("오래됐어요"),
                     "Market details should explain when this selected quote is stale.")
        let submitted = await store.submitManualBuy(coin: "KRW-ETH", amount: 5_000)
        let mutationPaths = await api.recordedMutationPaths()
        precondition(!submitted && mutationPaths.isEmpty,
                     "A recent server fetch must not make a stale exchange-price timestamp orderable.")

        let futureSourceTime = formatter.string(from: now.addingTimeInterval(6))
        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [[
                "coin": "KRW-BTC",
                "price": 60_000_000,
                "sourceAsOf": futureSourceTime,
                "fetchedAt": recentFetchTime
            ], [
                "coin": "KRW-ETH",
                "price": 3_000_000,
                "sourceAsOf": sourceTime,
                "fetchedAt": recentFetchTime
            ]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            sourceAsOf: sourceTime,
            fetchedAt: recentFetchTime
        ))
        await store.refresh()
        precondition(store.manualOrderBlockReason(for: "KRW-BTC")?.contains("앞서") == true,
                     "A future-dated quote beyond the clock-skew allowance must be blocked.")
        precondition(store.manualOrderBlockReason(for: "KRW-ETH") == nil,
                     "A future timestamp for one market must not block a different fresh order target.")
    }

    private static func incompleteMarketSnapshotKeepsPricesVisibleAndMarksStale() async throws {
        let api = DeferredCoinPilotAPI(marketRows: [["coin": "KRW-BTC", "price": 60_000_000]])
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://market-snapshot-incomplete.example")
        precondition(connected, "The fixture should load an initial complete snapshot.")
        guard case .current(let previousSuccess) = store.state(for: "market-prices") else {
            fatalError("The initial complete snapshot should be current.")
        }

        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [["coin": "KRW-BTC", "price": 61_000_000]],
            complete: false,
            missingMarkets: ["KRW-ETH"],
            marketListStale: false,
            fetchedAt: "2026-09-29T12:01:03.000Z"
        ))
        await store.refresh()

        guard case .stale(let lastSuccess) = store.state(for: "market-prices") else {
            fatalError("An incomplete snapshot must not be marked current.")
        }
        precondition(lastSuccess == previousSuccess,
                     "An incomplete response must keep the last complete snapshot time.")
        precondition(store.markets.count == 1 && store.markets.first?.price == 61_000_000,
                     "Prices present in a partial snapshot should remain displayable.")
        let label = store.freshnessLabel(for: "market-prices")
        precondition(label.contains("종목 1개 시세 누락"),
                     "The existing freshness label should explain which snapshot is incomplete: \(label), metadata: \(String(describing: store.marketSnapshotMetadata))")
    }

    private static func staleMarketListAndInvalidFetchedAtNeverMarkCurrent() async throws {
        let api = DeferredCoinPilotAPI(marketRows: [["coin": "KRW-BTC", "price": 60_000_000]])
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://market-snapshot-metadata.example")
        precondition(connected, "The fixture should load an initial complete snapshot.")
        guard case .current(let previousSuccess) = store.state(for: "market-prices") else {
            fatalError("The initial complete snapshot should be current.")
        }

        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [["coin": "KRW-BTC", "price": 61_000_000]],
            complete: true,
            missingMarkets: [],
            marketListStale: true,
            fetchedAt: "2026-09-29T12:01:03.000Z"
        ))
        await store.refresh()
        guard case .stale(let staleListSuccess) = store.state(for: "market-prices") else {
            fatalError("A stale market list must prevent the snapshot from being current.")
        }
        precondition(staleListSuccess == previousSuccess &&
                     store.freshnessLabel(for: "market-prices").contains("종목 목록 갱신이 필요"),
                     "A stale market list should retain the last complete time and explain the list issue.")

        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [["coin": "KRW-BTC", "price": 62_000_000]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            fetchedAt: "invalid-timestamp"
        ))
        await store.refresh()
        guard case .stale(let invalidTimeSuccess) = store.state(for: "market-prices") else {
            fatalError("An invalid fetchedAt timestamp must prevent the snapshot from being current.")
        }
        precondition(invalidTimeSuccess == previousSuccess &&
                     store.freshnessLabel(for: "market-prices").contains("수집 시각을 확인할 수 없어요"),
                     "An invalid fetchedAt should retain the last complete time and explain the bad timestamp.")

        let validFetchTime = "2026-09-29T12:02:03.000Z"
        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [["coin": "KRW-BTC", "price": 62_500_000]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            sourceAsOf: "invalid-source-time",
            fetchedAt: validFetchTime
        ))
        await store.refresh()
        guard case .stale(let invalidSourceSuccess) = store.state(for: "market-prices") else {
            fatalError("An invalid sourceAsOf timestamp must prevent the snapshot from being current.")
        }
        precondition(invalidSourceSuccess == previousSuccess &&
                     store.marketSnapshotFetchedAt == validFetchTime &&
                     store.freshnessLabel(for: "market-prices").contains("원본 시세 시각을 확인할 수 없어요"),
                     "An invalid sourceAsOf should remain unverified while preserving the valid fetchedAt.")

        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [["coin": "KRW-BTC", "price": 62_750_000]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            sourceAsOf: nil,
            fetchedAt: validFetchTime
        ))
        await store.refresh()
        guard case .stale(let missingSourceSuccess) = store.state(for: "market-prices") else {
            fatalError("A missing sourceAsOf timestamp must prevent the snapshot from being current.")
        }
        precondition(missingSourceSuccess == previousSuccess &&
                     store.marketSnapshotFetchedAt == validFetchTime &&
                     store.freshnessLabel(for: "market-prices").contains("원본 시세 시각을 확인할 수 없어요"),
                     "A missing sourceAsOf should remain unverified while preserving the valid fetchedAt.")

        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [["coin": "KRW-BTC", "price": 63_000_000]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            fetchedAt: nil
        ))
        await store.refresh()
        guard case .stale(let missingTimeSuccess) = store.state(for: "market-prices") else {
            fatalError("A missing fetchedAt timestamp must prevent the snapshot from being current.")
        }
        precondition(missingTimeSuccess == previousSuccess &&
                     store.freshnessLabel(for: "market-prices").contains("수집 시각을 확인할 수 없어요"),
                     "A missing fetchedAt should remain visibly unverified.")
    }

    private static func marketSnapshotBody(
        prices: [[String: Any]],
        complete: Bool,
        missingMarkets: [String],
        marketListStale: Bool,
        sourceAsOf: Any? = "2026-09-29T12:00:00.000Z",
        fetchedAt: Any?
    ) -> [String: Any] {
        var body: [String: Any] = [
            "prices": prices,
            "complete": complete,
            "missingMarkets": missingMarkets,
            "marketListStale": marketListStale
        ]
        if let sourceAsOf { body["sourceAsOf"] = sourceAsOf }
        if let fetchedAt { body["fetchedAt"] = fetchedAt }
        return body
    }

    private static func logoutDiscardsLateAccountResponse() async throws {
        let api = DeferredCoinPilotAPI(heldAccountHosts: ["first.example"])
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connection = Task { await store.connect(using: "https://first.example") }
        await api.waitForHeldAccount(host: "first.example")

        store.logOut()
        await api.releaseAccount(host: "first.example", totalAssets: 1111)
        let connected = await connection.value

        precondition(!connected, "A connection superseded by logout must not complete as current.")
        precondition(store.phase == .login, "Logout must keep the login screen active.")
        precondition(store.account == nil, "A late response after logout must not restore account data.")
    }

    private static func serverSwitchDiscardsPreviousAccountResponse() async throws {
        let api = DeferredCoinPilotAPI(heldAccountHosts: ["first.example"])
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let firstConnection = Task { await store.connect(using: "https://first.example") }
        await api.waitForHeldAccount(host: "first.example")

        let secondConnected = await store.connect(using: "https://second.example")
        precondition(secondConnected, "The current server should connect successfully.")
        precondition(store.account?.totalAssets == 2222, "The current server's account should be displayed.")

        await api.releaseAccount(host: "first.example", totalAssets: 1111)
        let firstConnected = await firstConnection.value
        precondition(!firstConnected, "An old server connection should be discarded.")
        precondition(store.account?.totalAssets == 2222, "A late response must not replace the current server's account.")
    }

    private static func liveWorkspaceUsesItsOwnAddressAndRejectsPaperMode() async throws {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl",
            "coinpilot.dashboardUrl.paper",
            "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace",
            "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server",
            "coinpilot.native.dataMode.profile.bundled-preview"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("paper", forKey: "coinpilot.native.activeWorkspace")

        let paperAddress = "https://shared-host.example:3000"
        let paperStore = CoinPilotStore(
            api: DeferredCoinPilotAPI(),
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "server"
        )
        let paperConnected = await paperStore.connect(using: paperAddress)
        precondition(paperConnected, "The Paper server should connect in its matching workspace.")
        precondition(defaults.string(forKey: "coinpilot.dashboardUrl.paper") == paperAddress,
                     "The matching Paper address should be stored for the Paper profile.")

        paperStore.selectWorkspace(.live)
        precondition(paperStore.activeWorkspace == .live, "The selected workspace should change to LIVE.")
        precondition(paperStore.phase == .setup, "An unconfigured LIVE profile should open server setup.")
        precondition(paperStore.serverDraft.isEmpty,
                     "The Paper address must not be copied into an unconfigured LIVE address field.")
        precondition(defaults.string(forKey: "coinpilot.dashboardUrl.live") == nil,
                     "Selecting LIVE must not create a profile address before a matching server connects.")

        paperStore.serverDraft = paperAddress
        let paperEndpointAcceptedAsLive = await paperStore.connect(using: paperAddress)
        precondition(!paperEndpointAcceptedAsLive, "A DRY_RUN endpoint must not connect as LIVE.")
        precondition(paperStore.status?.mode == "DRY_RUN", "The UI should retain the actual mode returned by the server.")
        precondition(paperStore.serverModeMatchesWorkspace == false, "A mode mismatch must keep the workspace locked.")
        precondition(paperStore.workspaceModeMismatchMessage?.contains("DRY_RUN") == true,
                     "The connection explanation should name the actual server mode.")
        precondition(paperStore.workspaceModeMismatchMessage?.contains("다른 포트") == true,
                     "The LIVE connection explanation should tell the user how to share an IP safely.")
        precondition(defaults.string(forKey: "coinpilot.dashboardUrl.live") == nil,
                     "A mismatched Paper URL must not be saved as the LIVE profile address.")

        let liveAddress = "https://shared-host.example:3001"
        let liveAPI = DeferredCoinPilotAPI(
            requiresAuth: true,
            statusOverride: ["mode": "LIVE"],
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let liveTokens = MemoryCoinPilotTokens()
        let liveStore = CoinPilotStore(api: liveAPI, tokens: liveTokens, configuredDataMode: "server")
        liveStore.serverDraft = liveAddress
        liveStore.tokenDraft = "live-workspace-test-token"
        let liveConnected = await liveStore.signIn()

        precondition(liveConnected, "A LIVE endpoint on a separate port should connect to the LIVE workspace.")
        precondition(liveStore.status?.mode == "LIVE", "The LIVE status should reach the selected workspace.")
        precondition(liveStore.account?.mode == "LIVE", "The LIVE account must match the LIVE server status.")
        precondition(liveStore.canOperate, "A matching LIVE endpoint with mobile scope should enable supported controls.")
        precondition(defaults.string(forKey: "coinpilot.dashboardUrl.live") == liveAddress,
                     "Only a matching LIVE endpoint should be saved to the LIVE profile.")
        let liveMutationPaths = await liveAPI.recordedMutationPaths()
        precondition(liveMutationPaths.isEmpty, "Connecting and reading the LIVE workspace must not place an order.")
    }

    private static func liveCredentialRegistrationUsesEphemeralKeysAndWaitsForSync() async throws {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl",
            "coinpilot.dashboardUrl.paper",
            "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace",
            "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server",
            "coinpilot.native.dataMode.profile.bundled-preview",
            "coinpilot.live.credentials.accessKey",
            "coinpilot.live.credentials.secretKey"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("live", forKey: "coinpilot.native.activeWorkspace")

        let api = DeferredCoinPilotAPI(
            requiresAuth: true,
            statusOverride: [
                "mode": "LIVE",
                "upbitCredentialsConfigured": false,
                "exchangeStateKnown": false,
                "readOnlyObserver": false
            ],
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let tokens = MemoryCoinPilotTokens()
        let store = CoinPilotStore(api: api, tokens: tokens, configuredDataMode: "server")
        let liveURL = URL(string: "https://shared-host.example/live")!
        store.serverDraft = liveURL.absoluteString
        store.tokenDraft = "mobile-operator-test-token"

        let connected = await store.signIn()
        precondition(connected, "The LIVE-prefixed server should connect before key registration.")
        precondition(store.status?.upbitCredentialsConfigured == false,
                     "The LIVE dashboard should read the server's explicit missing-key state.")
        precondition(store.showsLiveCredentialSetup,
                     "The credential form should only appear for a matching LIVE server that reports missing keys.")
        precondition(store.canUseLiveCredentialRegistration && store.canSubmitLiveCredentials == false,
                     "A mobile operator on HTTPS may register keys after entering both fields.")
        precondition(store.serverAddress == "shared-host.example/live",
                     "The displayed LIVE address should retain its base path prefix.")

        store.liveAccessKeyDraft = "test-access-key-123"
        store.liveSecretKeyDraft = "test-secret-key-456"
        precondition(store.canSubmitLiveCredentials, "A mobile operator should be able to submit both key fields over HTTPS.")
        let submitted = await store.submitLiveCredentials()
        precondition(submitted, "A successful server credential registration should trigger status refresh.")
        precondition(store.liveAccessKeyDraft.isEmpty && store.liveSecretKeyDraft.isEmpty,
                     "Both key fields must be cleared after the attempt.")
        precondition(store.status?.upbitCredentialsConfigured == true,
                     "The status refresh should read the server's configured-key state.")
        precondition(!store.showsLiveCredentialSetup && store.showsLiveCredentialSyncPending,
                     "Key entry should close after status confirms registration while sync remains unknown.")
        precondition(store.status?.exchangeStateKnown == false,
                     "The test should keep the setup pending until exchange state is known.")

        let submissions = await api.recordedCredentialSubmissions()
        precondition(submissions == [[
            "accessKey": "test-access-key-123",
            "secretKey": "test-secret-key-456"
        ]], "The registration payload should contain only the two exact server contract fields.")
        let mutationPaths = await api.recordedMutationPaths()
        precondition(mutationPaths.filter { $0 == "/api/live/credentials" }.count == 1,
                     "The app should submit the credential request exactly once.")
        let submissionURLs = await api.recordedCredentialSubmissionURLs()
        precondition(submissionURLs == [liveURL.absoluteString],
                     "The credentials should be sent to the selected LIVE base URL.")
        let submissionTokens = await api.recordedCredentialSubmissionTokens()
        precondition(submissionTokens == ["mobile-operator-test-token"],
                     "The request should use the server-scoped mobile operator token.")
        precondition(tokens.token(for: liveURL) == "mobile-operator-test-token",
                     "The server token should remain stored under the complete LIVE URL.")
        precondition(tokens.token(for: URL(string: "https://shared-host.example")!) == nil,
                     "A LIVE /live token must remain separate from the same host's root Paper URL token.")
        for key in ["coinpilot.live.credentials.accessKey", "coinpilot.live.credentials.secretKey"] {
            precondition(defaults.object(forKey: key) == nil, "The app must not persist Upbit key fields in UserDefaults.")
        }
        let persistedDefaults = defaults.dictionaryRepresentation().values.map { String(describing: $0) }
        precondition(!persistedDefaults.contains(where: {
            $0.contains("test-access-key-123") || $0.contains("test-secret-key-456")
        }), "The entered Upbit keys must not appear in any UserDefaults value.")
        let resolvedStatusURL = CoinPilotAPIClient.requestURL(path: "/api/status", serverURL: liveURL)
        let resolvedCredentialsURL = CoinPilotAPIClient.requestURL(path: "/api/live/credentials", serverURL: liveURL)
        precondition(resolvedStatusURL?.path == "/live/api/status" &&
                     resolvedCredentialsURL?.path == "/live/api/live/credentials",
                     "The /live base path should prefix API routes without replacing the Paper root.")
        precondition(CoinPilotAPIClient.requestURL(
            path: "/api/status",
            serverURL: URL(string: "https://shared-host.example/other")!
        ) == nil, "Arbitrary server path prefixes must remain rejected.")

        let failingAPI = DeferredCoinPilotAPI(
            requiresAuth: true,
            statusOverride: [
                "mode": "LIVE",
                "upbitCredentialsConfigured": false,
                "exchangeStateKnown": false,
                "readOnlyObserver": false
            ],
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false,
            credentialRegistrationStatusCode: 500
        )
        let failingStore = CoinPilotStore(api: failingAPI, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        failingStore.serverDraft = "https://failed-registration.example/live"
        failingStore.tokenDraft = "mobile-operator-test-token"
        let failingServerConnected = await failingStore.signIn()
        precondition(failingServerConnected, "A LIVE server that can reject key registration should still connect.")
        failingStore.liveAccessKeyDraft = "failed-access-key-test"
        failingStore.liveSecretKeyDraft = "failed-secret-key-test"
        let failureWasReported = await failingStore.submitLiveCredentials()
        precondition(!failureWasReported, "A server failure should not be reported as a successful registration.")
        precondition(failingStore.liveAccessKeyDraft.isEmpty && failingStore.liveSecretKeyDraft.isEmpty,
                     "Both fields must clear when the server rejects the registration attempt.")
        precondition(failingStore.liveCredentialMessage?.contains("failed-access-key-test") == false &&
                     failingStore.liveCredentialMessage?.contains("failed-secret-key-test") == false,
                     "Registration errors must not echo either key into the interface.")
    }

    private static func liveCredentialRegistrationRequiresHttpsAndMobileOperatorScope() async throws {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl",
            "coinpilot.dashboardUrl.paper",
            "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace",
            "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server",
            "coinpilot.native.dataMode.profile.bundled-preview"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value {
                    defaults.set(value, forKey: key)
                } else {
                    defaults.removeObject(forKey: key)
                }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("live", forKey: "coinpilot.native.activeWorkspace")

        let liveStatus = [
            "mode": "LIVE",
            "upbitCredentialsConfigured": false,
            "exchangeStateKnown": false,
            "readOnlyObserver": false
        ] as [String: Any]
        let httpAPI = DeferredCoinPilotAPI(
            requiresAuth: true,
            statusOverride: liveStatus,
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let httpStore = CoinPilotStore(api: httpAPI, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        httpStore.serverDraft = "http://192.168.1.77:3000/live"
        httpStore.tokenDraft = "mobile-operator-test-token"
        let httpConnected = await httpStore.signIn()
        precondition(httpConnected, "A private HTTP test server may expose LIVE mode for local status checks.")
        httpStore.liveAccessKeyDraft = "http-access-test"
        httpStore.liveSecretKeyDraft = "http-secret-test"
        precondition(httpStore.showsLiveCredentialSetup && !httpStore.canSubmitLiveCredentials,
                     "Missing-key setup may explain the HTTPS requirement, but must not enable insecure submission.")
        let httpSubmitted = await httpStore.submitLiveCredentials()
        precondition(!httpSubmitted, "The key submission must reject HTTP transport.")
        precondition(httpStore.liveAccessKeyDraft.isEmpty && httpStore.liveSecretKeyDraft.isEmpty,
                     "The fields must still clear when HTTPS preflight rejects an attempt.")
        let httpSubmissions = await httpAPI.recordedCredentialSubmissions()
        precondition(httpSubmissions.isEmpty,
                     "The insecure attempt must not reach the API implementation.")

        let readOnlyAPI = DeferredCoinPilotAPI(
            requiresAuth: true,
            statusOverride: liveStatus,
            loginTokenScope: "read_only",
            isReadOnlyObserver: true
        )
        let readOnlyStore = CoinPilotStore(api: readOnlyAPI, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        readOnlyStore.serverDraft = "https://read-only.example/live"
        readOnlyStore.tokenDraft = "read-only-test-token"
        let readOnlyConnected = await readOnlyStore.signIn()
        precondition(readOnlyConnected, "A read-only LIVE account may connect for status display.")
        readOnlyStore.liveAccessKeyDraft = "read-only-access-test"
        readOnlyStore.liveSecretKeyDraft = "read-only-secret-test"
        precondition(readOnlyStore.showsLiveCredentialSetup && !readOnlyStore.canUseLiveCredentialRegistration,
                     "The setup view may explain missing keys, but only mobile_operator may register them.")
        let readOnlySubmitted = await readOnlyStore.submitLiveCredentials()
        precondition(!readOnlySubmitted, "A read-only token must not register exchange keys.")
        precondition(readOnlyStore.liveAccessKeyDraft.isEmpty && readOnlyStore.liveSecretKeyDraft.isEmpty,
                     "The fields must clear after a rejected permission attempt.")
        let readOnlySubmissions = await readOnlyAPI.recordedCredentialSubmissions()
        precondition(readOnlySubmissions.isEmpty,
                     "The read-only attempt must not reach the API implementation.")
        precondition(CoinPilotStatus(["mode": "LIVE"]).upbitCredentialsConfigured == nil,
                     "An omitted status field must not be treated as an explicit missing-key report.")
    }

    private static func liveManualPrepareStatusKeepsAutomationControlAvailable() throws {
        let status = CoinPilotStatus([
            "mode": "LIVE",
            "isRunning": false,
            "exchangeStateKnown": true,
            "liveManualPrepared": true,
            "liveManualPrepareOnBoot": true
        ])
        precondition(status.liveManualPrepared == true && status.liveManualPrepareOnBoot == true,
                     "Manual-prepare status should reach the native status model.")
        precondition(status.exchangeStateKnown == true && status.isRunning == false,
                     "Prepared status should still distinguish known exchange state from a stopped process.")
        let control = CoinPilotAutomationPresentation(isBundledPreview: false, isRunning: status.isRunning)
        precondition(control.showsControls && control.stateLabel == "중지",
                     "A prepared, stopped LIVE process must keep the explicit automation controls available.")
    }

    private static func signInUsesAndStoresOnlyTheServerToken() async throws {
        let api = DeferredCoinPilotAPI(requiresAuth: true)
        let tokens = MemoryCoinPilotTokens()
        let store = CoinPilotStore(api: api, tokens: tokens)
        let serverURL = URL(string: "https://read.example")!
        store.serverDraft = serverURL.absoluteString
        store.tokenDraft = "read-only-token"

        let signedIn = await store.signIn()
        precondition(signedIn, "A valid read-only token should reach the dashboard.")
        precondition(store.phase == .dashboard, "Successful sign-in should show the dashboard.")
        precondition(tokens.token(for: serverURL) == "read-only-token", "The token should be stored per server.")
        let submittedTokens = await api.recordedLoginTokens()
        precondition(submittedTokens == ["read-only-token"], "The entered token should be sent to login.")

        let paths = await api.recordedReadPaths()
        let expectedPaths: Set<String> = [
            "/api/status",
            "/api/account",
            "/api/cumulative-pnl",
            "/api/today-summary",
            "/api/portfolio/history?period=24h",
            "/api/market/prices/snapshot",
            "/api/trades?limit=30",
            "/api/paper-validation/summary"
        ]
        precondition(Set(paths) == expectedPaths, "The app should request only its server read allowlist.")
        precondition(store.paperValidationSummary?.strict.closedTradeCount == 3, "The paper summary should preserve the strict sample count.")
        precondition(store.paperValidationSummary?.strict.realizedProfitKrw == -125, "The strict ledger P&L should be parsed.")
        precondition(store.paperValidationSummary?.costAudit.costStressedNetPnlKrw == -375, "The separate cost sensitivity should be parsed.")
        precondition(store.paperValidationSummary?.actualFillsObserved == false, "Paper evidence must never be labelled as actual fills.")
        precondition(store.paperValidationSummary?.cohort.eligibleStrictTradeCount == 0, "Ineligible aggregate trades must not look like a passing profitability sample.")
        precondition(store.paperValidationSummary?.cohort.totalStrictProfitComparable == false, "Heterogeneous session P&L must remain non-comparable.")
        let readTokens = await api.recordedReadTokens()
        precondition(readTokens.allSatisfy { $0 == "read-only-token" }, "Each server read should use the saved token.")
    }

    private static func fullOperatorScopeFailsClosedAndClearsPriorSession() async throws {
        let api = DeferredCoinPilotAPI(
            requiresAuth: true,
            statusOverride: ["isRunning": false],
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let tokens = MemoryCoinPilotTokens()
        let store = CoinPilotStore(api: api, tokens: tokens)
        let serverURL = URL(string: "https://scope-boundary.example")!
        store.serverDraft = serverURL.absoluteString
        store.tokenDraft = "mobile-operator-test-token"

        let mobileSignedIn = await store.signIn()
        precondition(mobileSignedIn && store.canOperate,
                     "The mobile operator scope should still authorize native operations.")
        precondition(store.status != nil && store.account != nil,
                     "A successful mobile scope should have dashboard data before the next sign-in.")
        precondition(tokens.token(for: serverURL) == "mobile-operator-test-token",
                     "The mobile-scoped token should remain stored for this server.")

        let mobileControlChanged = await store.setAutomationRunning(false)
        precondition(mobileControlChanged, "The mobile operator scope should still reach supported control mutations.")
        let initialMutationPaths = await api.recordedMutationPaths()
        precondition(initialMutationPaths == ["/api/control/stop"],
                     "Only the mobile-scoped test token should reach the control mutation.")

        let readsBeforeFullScopeUpdate = await api.readRequestCount()
        await api.setLoginTokenScope("operator")
        let fullScopeUpdateMessage = await store.updateServerToken("full-operator-test-token")
        let readsAfterFullScopeUpdate = await api.readRequestCount()
        precondition(fullScopeUpdateMessage?.contains("DASHBOARD_MOBILE_TOKEN") == true,
                     "Replacing a token with full operator scope should explain the required mobile token.")
        precondition(tokens.token(for: serverURL) == nil,
                     "A rejected replacement full token must not remain in the native token store.")
        precondition(store.phase == .login && store.account == nil && store.status == nil,
                     "Rejecting a full token replacement must clear the prior dashboard view.")
        precondition(readsAfterFullScopeUpdate == readsBeforeFullScopeUpdate,
                     "Token replacement must reject full scope before loading protected dashboard data.")

        await api.setLoginTokenScope("mobile_operator")
        store.serverDraft = serverURL.absoluteString
        store.tokenDraft = "mobile-operator-test-token-2"
        let secondMobileSignIn = await store.signIn()
        precondition(secondMobileSignIn && store.account != nil && store.status != nil,
                     "The same server should still accept a mobile-scoped token after rejection.")
        let readsBeforeFullScopeSignIn = await api.readRequestCount()

        await api.setLoginTokenScope("operator")
        store.tokenDraft = "full-operator-test-token"
        let fullOperatorSignedIn = await store.signIn()
        let readsAfterFullScopeSignIn = await api.readRequestCount()

        precondition(!fullOperatorSignedIn, "The full operator scope must be rejected in iOS sign-in.")
        precondition(store.authenticationScope == .operatorFull,
                     "The response scope should still be parsed before the full-scope rejection.")
        precondition(!store.authenticationScope.canOperate,
                     "The parsed full operator scope must not grant native mutation permission.")
        precondition(store.connectionMessage?.contains("DASHBOARD_MOBILE_TOKEN") == true,
                     "The rejected login should clearly tell the user which scoped token to use.")
        precondition(store.tokenDraft.isEmpty, "The rejected full operator credential should be cleared from the login form.")
        precondition(tokens.token(for: serverURL) == nil,
                     "A rejected full operator credential must not remain in the native token store.")
        precondition(store.phase == .login && store.account == nil && store.status == nil,
                     "Rejecting a full scope for the same server must clear the prior dashboard view.")
        precondition(readsAfterFullScopeSignIn == readsBeforeFullScopeSignIn,
                     "The full operator scope must be rejected before protected dashboard reads.")

        let orderSent = await store.submitManualBuy(coin: "KRW-BTC", amount: 5_000)
        let walletChanged = await store.updatePaperWallet(amount: 1_000, deposit: true)
        let controlChanged = await store.setAutomationRunning(false)
        precondition(!orderSent && !walletChanged && !controlChanged,
                     "Order, wallet, and control mutations must all fail closed after full-scope rejection.")
        let mutationPaths = await api.recordedMutationPaths()
        precondition(mutationPaths == initialMutationPaths,
                     "The full operator scope must not add any mutation request path.")

        let restoredTokens = MemoryCoinPilotTokens()
        precondition(restoredTokens.save("legacy-full-operator-token", for: serverURL))
        let restoredStore = CoinPilotStore(api: api, tokens: restoredTokens)
        let restoreConnected = await restoredStore.connect(using: serverURL.absoluteString)
        let readsAfterRestore = await api.readRequestCount()
        precondition(!restoreConnected && restoredTokens.token(for: serverURL) == nil,
                     "A previously saved full operator token must be evicted on reconnect.")
        precondition(restoredStore.phase == .login && restoredStore.account == nil && restoredStore.status == nil,
                     "A restored full-scope token must not load dashboard data.")
        precondition(readsAfterRestore == readsBeforeFullScopeSignIn,
                     "Reconnect must reject a restored full-scope token before protected reads.")
    }

    private static func simulatorTokenStoreIsScopedAndVolatile() throws {
        let tokens = CoinPilotSimulatorTokenStore()
        let first = URL(string: "http://192.168.1.10:3138")!
        let second = URL(string: "http://192.168.1.11:3138")!
        precondition(tokens.save("first-test-token", for: first))
        precondition(tokens.save("second-test-token", for: second))
        precondition(tokens.token(for: first) == "first-test-token")
        precondition(tokens.token(for: second) == "second-test-token")
        tokens.delete(for: first)
        precondition(tokens.token(for: first) == nil)
        precondition(tokens.token(for: second) == "second-test-token")
        precondition(CoinPilotSimulatorTokenStore().token(for: second) == nil,
                     "Simulator tokens must not survive a new store instance.")
    }

    private static func simulatorDefaultTokenStoreSupportsReadOnlySignIn() async throws {
        let api = DeferredCoinPilotAPI(requiresAuth: true)
        let store = CoinPilotStore(api: api, configuredDataMode: "server")
        let serverURL = URL(string: "https://simulator.example")!
        store.serverDraft = serverURL.absoluteString
        store.tokenDraft = "volatile-read-only-token"

        let signedIn = await store.signIn()
        precondition(signedIn, "The simulator's volatile token provider should finish read-only sign-in.")
        precondition(store.phase == .dashboard, "Simulator sign-in should show the observer dashboard.")
        let submitted = await api.recordedLoginTokens()
        let used = await api.recordedReadTokens()
        precondition(submitted == ["volatile-read-only-token"], "Only the entered read-only token should be submitted.")
        precondition(used.allSatisfy { $0 == "volatile-read-only-token" }, "Dashboard reads should use the volatile token.")
    }

    private static func nativeReadAllowlistIncludesOnlyThePaperSummary() throws {
        precondition(CoinPilotAPIClient.isAllowedReadPath("/api/paper-validation/summary"), "The exact summary GET path should be allowed.")
        precondition(CoinPilotAPIClient.isAllowedReadPath("/api/market/prices/snapshot"), "The exact market snapshot GET path should be allowed.")
        precondition(CoinPilotAPIClient.isAllowedMobileReadPath("/api/market/prices/snapshot"), "The market snapshot should be included in the mobile read allowlist.")
        for path in [
            "/api/paper-validation",
            "/api/paper-validation/summary?details=1",
            "/api/paper-validation/start",
            "/api/paper-validation/stop",
            "/api/paper-validation/summary#fragment"
        ] {
            precondition(!CoinPilotAPIClient.isAllowedReadPath(path), "The native token must reject \(path).")
        }
        for path in [
            "/api/market/prices/snapshot?extra=1",
            "/api/market/prices/snapshot#fragment"
        ] {
            precondition(!CoinPilotAPIClient.isAllowedMobileReadPath(path), "The mobile token must reject \(path).")
        }
    }

    private static func bundledPreviewWorksWithoutCallingTheServer() async throws {
        UserDefaults.standard.removeObject(forKey: "coinpilot.dashboardUrl")
        UserDefaults.standard.removeObject(forKey: "coinpilot.native.dataMode")
        UserDefaults.standard.removeObject(forKey: "coinpilot.native.dataMode.profile.server")
        UserDefaults.standard.removeObject(forKey: "coinpilot.native.dataMode.profile.bundled-preview")
        let fixtureURL = URL(fileURLWithPath: "ios/App/App/CoinPilotBundledPreview.json")
        let source = CoinPilotBundledPreviewDataSource(data: try Data(contentsOf: fixtureURL))
        let api = DeferredCoinPilotAPI()
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            bundledPreview: source
        )

        store.useBundledPreview()
        for _ in 0..<100 where !store.hasLoadedResource("account") {
            await Task.yield()
        }

        precondition(store.isBundledPreview, "The preview mode should stay selected.")
        precondition(store.freshnessLabel(for: "market-prices").hasPrefix("예시 자료 기준 "),
                     "Preview request freshness should be labelled as its sample-data timestamp.")
        precondition(store.status?.isRunning == true,
                     "The fixture should cover a positive sample engine status.")
        let automationPresentation = CoinPilotAutomationPresentation(
            isBundledPreview: store.isBundledPreview,
            isRunning: store.status?.isRunning
        )
        precondition(automationPresentation.sectionTitle == "자동매매 예시",
                     "Preview status must be labelled as an example.")
        precondition(automationPresentation.stateLabel == "예시 상태",
                     "A sample isRunning flag must not appear as an active server state.")
        precondition(!automationPresentation.showsControls,
                     "Bundled preview must not show server auto-trading controls.")
        precondition(automationPresentation.explanation.contains("실제 서버에서 자동매매를 실행하지 않습니다"),
                     "Preview must explicitly say the server engine is not running.")
        let previewOrderPresentation = CoinPilotOrderReviewPresentation(
            isBundledPreview: true,
            workspace: .paper,
            draftIsValid: true,
            blockReason: nil,
            isSubmitting: false
        )
        precondition(previewOrderPresentation.sectionTitle == "주문 미리보기",
                     "Bundled preview must distinguish sample orders from server orders.")
        precondition(previewOrderPresentation.accountTitle == "예시 계좌",
                     "Bundled preview must not imply an editable server wallet.")
        precondition(previewOrderPresentation.buttonTitle == "예시에서는 주문할 수 없어요",
                     "Preview order CTA must describe the unavailable action.")
        precondition(!previewOrderPresentation.isEnabled && !previewOrderPresentation.showsWalletControls,
                     "Bundled preview must never expose enabled order or wallet controls.")
        precondition(store.account?.totalAssets == 4_700_000, "The bundled account sample should load.")
        precondition(store.markets.first?.sourceAsOf == "2026-09-29T00:00:00.000Z")
        precondition(store.marketSnapshotFetchedAt == "2026-09-29T00:00:03.000Z")
        precondition(store.marketSnapshotMetadata?.complete == true &&
                     store.marketSnapshotMetadata?.missingMarkets?.isEmpty == true &&
                     store.marketSnapshotMetadata?.marketListStale == false,
                     "Bundled preview should synthesize complete, fresh market metadata locally.")
        precondition(store.marketSnapshotMetadata?.sourceAsOf == "2026-09-29T00:00:00.000Z" &&
                     store.marketSnapshotMetadata?.fetchedAt == "2026-09-29T00:00:03.000Z",
                     "Bundled preview should keep snapshot-level source and fetch times.")
        precondition(store.account?.isReadOnlyObserver == true, "Bundled sample data must be explicitly read-only.")
        precondition(store.manualOrderBlockReason != nil,
                     "Bundled preview must not allow a sample holding to be sold.")
        precondition(store.paperValidationSummary?.strict.closedTradeCount == 8, "The preview should include clearly labelled paper-evidence sample data.")
        precondition(store.paperValidationSummary?.actualFillsObserved == false, "Preview paper data must not imply observed fills.")
        precondition(store.paperValidationSummary?.cohort.eligibleStrictTradeCount == 0, "The preview should show that raw paper closes are not automatically eligible evidence.")
        let apiReadCount = await api.readRequestCount()
        precondition(apiReadCount == 0, "Bundled preview must not make server API calls.")

        let history = try source.response(for: "/api/portfolio/history?period=7d")
        let historyBody = try JSONSerialization.jsonObject(with: history.body) as! [String: Any]
        let historyRows = historyBody["data"] as? [[String: Any]] ?? []
        precondition(historyRows.count == 7, "Local history periods should load independently.")
        precondition(historyRows.allSatisfy { $0["valuationStatus"] as? String == "example" }, "Bundled chart data must keep its example provenance.")

        let hourHistory = try source.response(for: "/api/portfolio/history?period=1h")
        let hourHistoryBody = try JSONSerialization.jsonObject(with: hourHistory.body) as! [String: Any]
        let hourHistoryRows = hourHistoryBody["data"] as? [[String: Any]] ?? []
        precondition(hourHistoryRows.count == 5, "The bundled one-hour history should return its fictional sample rows.")
        precondition(hourHistoryRows.allSatisfy {
            $0["valuationStatus"] as? String == "example" && $0["valuationSource"] as? String == "bundled-preview"
        }, "The one-hour sample must retain explicit fictional example provenance.")

        await store.setHistoryPeriod(.hour)
        precondition(store.historyPeriod == .hour, "The preview store should retain the selected one-hour period.")
        precondition(store.history.count == 5, "Selecting one hour should load its bundled history rows into the store.")
        precondition(store.history.first?.timestamp == "2026-09-28T23:00:00.000Z" &&
                     store.history.last?.timestamp == "2026-09-29T00:00:00.000Z",
                     "The selected one-hour period should return the expected sample history range.")
        precondition(store.history.allSatisfy { $0.valuationStatus == "example" },
                     "The store should retain example provenance on the one-hour history rows.")

        let legacyPoint = CoinPilotHistoryPoint([
            "timestamp": "2026-09-29T00:00:00Z",
            "totalAssets": 1000,
            "valuationStatus": "unknown_legacy"
        ], index: 0)
        precondition(legacyPoint.valuationStatus == "unknown_legacy", "Legacy chart provenance must reach the native UI model.")
    }

    private static func bundledPreviewBuildIgnoresThePreviousServerProfile() async throws {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "coinpilot.dashboardUrl")
        defaults.removeObject(forKey: "coinpilot.native.dataMode.profile.server")
        defaults.removeObject(forKey: "coinpilot.native.dataMode.profile.bundled-preview")
        defaults.set("server", forKey: "coinpilot.native.dataMode")

        let fixtureURL = URL(fileURLWithPath: "ios/App/App/CoinPilotBundledPreview.json")
        let source = CoinPilotBundledPreviewDataSource(data: try Data(contentsOf: fixtureURL))
        let api = DeferredCoinPilotAPI()
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            bundledPreview: source,
            configuredDataMode: "bundled-preview"
        )

        precondition(store.isBundledPreview, "A preview build must not inherit an old server-mode preference.")
        await store.bootstrap()
        precondition(store.phase == .dashboard, "A preview build should open local data without server setup.")
        precondition(store.account?.totalAssets == 4_700_000, "Preview account data should load locally.")
        precondition(store.paperValidationSummary?.available == true, "The preview paper summary should load from the bundled sample.")
        let apiReadCount = await api.readRequestCount()
        precondition(apiReadCount == 0, "A preview build must not call the server while bootstrapping.")

        defaults.set("bundled-preview", forKey: "coinpilot.native.dataMode")
        defaults.set("bundled-preview", forKey: "coinpilot.native.dataMode.profile.bundled-preview")
        let serverProfile = CoinPilotStore(
            api: DeferredCoinPilotAPI(),
            tokens: MemoryCoinPilotTokens(),
            bundledPreview: source,
            configuredDataMode: "server"
        )
        precondition(!serverProfile.isBundledPreview, "A server build must not inherit the preview profile preference.")

        defaults.removeObject(forKey: "coinpilot.native.dataMode")
        defaults.removeObject(forKey: "coinpilot.native.dataMode.profile.server")
        defaults.removeObject(forKey: "coinpilot.native.dataMode.profile.bundled-preview")
    }

    private static func partialRefreshMarksOnlyTheFailedResourceStale() async throws {
        let api = DeferredCoinPilotAPI()
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://status.example")
        precondition(connected, "The server fixture should connect.")
        let previousCheck = store.lastCheckedAt
        guard case .current(let previousMarketUpdate) = store.state(for: "market-prices") else {
            fatalError("A complete first response should mark market prices current.")
        }

        await api.setFailedPaths(["/api/market/prices/snapshot"])
        await store.refresh()

        guard case .stale(let lastSuccess) = store.state(for: "market-prices") else {
            fatalError("A failed refresh should mark only that resource stale.")
        }
        precondition(lastSuccess == previousMarketUpdate, "The stale marker should preserve the last successful resource timestamp.")
        precondition(store.lastCheckedAt == previousCheck, "A partial refresh must not advance the all-data check time.")
        precondition(store.account?.totalAssets == 2222, "Successful account data should remain available.")
        guard case .current = store.state(for: "account"),
              case .current = store.state(for: "trades") else {
            fatalError("A partial failure should leave successfully refreshed resources current.")
        }
        precondition(store.dashboardMessage?.contains("일부 정보") == true, "The dashboard should explain a partial refresh.")
        precondition(store.freshnessLabel(for: "market-prices").contains("앱에서 시세를 새로 확인하지 못했어요"),
                     "A failed market refresh should be distinguished from the exchange quote timestamp.")
    }

    private static func pendingRefreshKeepsTheLastSuccessfulTimeVisible() async throws {
        let api = DeferredCoinPilotAPI()
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://pending-refresh.example")
        precondition(connected, "The server fixture should connect before a pending refresh.")
        guard case .current(let previousAccountUpdate) = store.state(for: "account") else {
            fatalError("The initial account response should be current.")
        }

        await api.setHeldHosts(["pending-refresh.example"])
        let refresh = Task { await store.refresh() }
        await api.waitForHeldAccount(host: "pending-refresh.example")

        guard case .loading = store.state(for: "account"),
              case .loading = store.state(for: "market-prices") else {
            fatalError("In-flight resource requests should remain marked as loading.")
        }
        let previousTime = CoinPilotFormatting.time(previousAccountUpdate)
        precondition(store.hasLoadedResource("account"), "A visible last-known account value should remain loaded while refreshing.")
        precondition(store.freshnessLabel(for: "account").contains(previousTime), "The account should keep its last successful time while refreshing.")
        precondition(store.freshnessLabel(for: "account").contains("새로 확인 중"), "The UI should distinguish an in-flight request from a fresh value.")
        precondition(store.freshnessLabel(for: "market-prices").contains("새로 확인 중"), "Each visible last-known resource should retain a pending freshness label.")
        precondition(store.freshnessLabel(for: "market-prices").contains("앱 확인"),
                     "The market refresh label should describe the app's request time, not quote time.")

        await api.releaseAccount(host: "pending-refresh.example", totalAssets: 2222)
        await refresh.value
    }

    private static func historyFailureRemainsVisibleBesideTheChart() async throws {
        let api = DeferredCoinPilotAPI()
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://history-refresh.example")
        precondition(connected, "The server fixture should connect before the history refresh.")
        guard case .current(let previousHistoryUpdate) = store.state(for: "portfolio-history") else {
            fatalError("The initial history response should be current.")
        }

        await api.setFailedPaths(["/api/portfolio/history?period=24h"])
        await store.refresh()

        guard case .stale(let lastSuccess) = store.state(for: "portfolio-history") else {
            fatalError("A history refresh failure should preserve its stale state beside the existing chart.")
        }
        precondition(lastSuccess == previousHistoryUpdate, "The chart freshness should keep the previous successful timestamp.")
        precondition(store.isResourceStale("portfolio-history"), "The chart header should be able to show a stale treatment.")
        precondition(store.freshnessLabel(for: "portfolio-history").contains(CoinPilotFormatting.time(previousHistoryUpdate)), "The chart freshness label should name the last successful update.")
    }

    private static func paperSummaryFailureDoesNotBlockTheCoreDashboard() async throws {
        let api = DeferredCoinPilotAPI()
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://summary-optional.example")
        precondition(connected, "The core dashboard should connect.")

        await api.setFailedPaths(["/api/paper-validation/summary"])
        await store.refresh()

        guard case .stale = store.state(for: "paper-validation-summary") else {
            fatalError("A failed optional summary read should retain its last-known value as stale.")
        }
        precondition(store.account?.totalAssets == 2222, "Account data should remain available when the optional summary endpoint is absent.")
        precondition(store.dashboardMessage == nil, "An older server missing the optional summary should not trigger a dashboard-wide warning.")
    }

    private static func protectiveOnlyStatusIsVisibleInTheReadOnlyApp() async throws {
        let api = DeferredCoinPilotAPI(statusOverride: [
            "runtimeState": "PROTECTIVE_ONLY",
            "entriesPaused": true,
            "protectiveMonitorActive": true,
            "stopReason": "risk_data_gap"
        ])
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://protective.example")

        precondition(connected, "Protective-only status should not make read-only account data unavailable.")
        precondition(store.status?.runtimeState == "PROTECTIVE_ONLY", "The runtime state should reach the app model.")
        precondition(store.status?.protectiveMonitorActive == true, "The app should know that position monitoring remains active.")
        precondition(store.runtimeSafetyMessage?.contains("시세 공백") == true, "The home screen should explain the protective-only state.")
    }

    private static func unknownExchangeStateBlocksTheServerTradingStatus() async throws {
        let api = DeferredCoinPilotAPI(statusOverride: [
            "runtimeState": "SYNC_REQUIRED",
            "entriesPaused": true,
            "protectiveMonitorActive": false,
            "stopReason": "exchange_state_unverified",
            "exchangeStateKnown": false
        ])
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens())
        let connected = await store.connect(using: "https://sync-required.example")

        precondition(connected, "An unresolved exchange state should not hide read-only account data.")
        precondition(store.status?.exchangeStateKnown == false, "The server account-state boundary should reach the app model.")
        precondition(store.runtimeSafetyMessage?.contains("거래소 잔고") == true, "The home screen should explain why new orders are locked.")
    }
}
