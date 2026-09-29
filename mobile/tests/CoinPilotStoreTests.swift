import Foundation

private actor DeferredCoinPilotAPI: CoinPilotAPIProviding {
    private var heldHosts: Set<String>
    private let requiresAuth: Bool
    private let statusOverride: [String: Any]
    private var pending: [String: CheckedContinuation<CoinPilotHTTPResponse, Error>] = [:]
    private var waiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var readRequests = 0
    private var loginTokens: [String] = []
    private var readTokens: [String?] = []
    private var readPaths: [String] = []
    private var failedPaths: Set<String> = []

    init(heldAccountHosts: Set<String> = [], requiresAuth: Bool = false, statusOverride: [String: Any] = [:]) {
        heldHosts = heldAccountHosts
        self.requiresAuth = requiresAuth
        self.statusOverride = statusOverride
    }

    func authenticationStatus(at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        Self.response(["success": true, "authRequired": requiresAuth])
    }

    func login(token: String, at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        loginTokens.append(token)
        return Self.response(["success": true])
    }

    func read(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse {
        readRequests += 1
        readPaths.append(path)
        readTokens.append(token)
        if failedPaths.contains(path) { throw CoinPilotAPIError.connection }
        let host = serverURL.host ?? ""
        if path == "/api/account", heldHosts.contains(host) {
            return try await withCheckedThrowingContinuation { continuation in
                pending[host] = continuation
                waiters.removeValue(forKey: host)?.resume()
            }
        }
        return Self.readResponse(
            path: path,
            totalAssets: host == "first.example" ? 1111 : 2222,
            statusOverride: statusOverride
        )
    }

    func waitForHeldAccount(host: String) async {
        if pending[host] != nil { return }
        await withCheckedContinuation { continuation in
            waiters[host] = continuation
        }
    }

    func releaseAccount(host: String, totalAssets: Double) {
        pending.removeValue(forKey: host)?.resume(returning: Self.accountResponse(totalAssets: totalAssets))
    }

    func readRequestCount() -> Int { readRequests }
    func recordedLoginTokens() -> [String] { loginTokens }
    func recordedReadTokens() -> [String?] { readTokens }
    func recordedReadPaths() -> [String] { readPaths }
    func setFailedPaths(_ paths: Set<String>) { failedPaths = paths }
    func setHeldHosts(_ hosts: Set<String>) { heldHosts = hosts }

    private static func readResponse(path: String, totalAssets: Double, statusOverride: [String: Any]) -> CoinPilotHTTPResponse {
        if path == "/api/account" { return accountResponse(totalAssets: totalAssets) }
        if path == "/api/status" {
            var status: [String: Any] = ["isRunning": true, "mode": "DRY_RUN", "readOnlyObserver": true]
            status.merge(statusOverride) { _, newValue in newValue }
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
        if path == "/api/market/prices" { return response([[String: Any]]()) }
        if path.hasPrefix("/api/trades") { return response([[String: Any]]()) }
        return response(["error": "unsupported test path"], statusCode: 404)
    }

    private static func accountResponse(totalAssets: Double) -> CoinPilotHTTPResponse {
        response([
            "krwBalance": totalAssets,
            "totalAssets": totalAssets,
            "profit": totalAssets - 1000,
            "profitPercent": totalAssets / 10 - 100,
            "mode": "DRY_RUN",
            "readOnlyObserver": true,
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

@MainActor
@main
struct CoinPilotStoreTests {
    static func main() async throws {
        try await logoutDiscardsLateAccountResponse()
        try await serverSwitchDiscardsPreviousAccountResponse()
        try await signInUsesAndStoresOnlyTheServerToken()
        try simulatorTokenStoreIsScopedAndVolatile()
        try await simulatorDefaultTokenStoreSupportsReadOnlySignIn()
        try nativeReadAllowlistIncludesOnlyThePaperSummary()
        try await bundledPreviewWorksWithoutCallingTheServer()
        try await bundledPreviewBuildIgnoresThePreviousServerProfile()
        try await partialRefreshMarksOnlyTheFailedResourceStale()
        try await pendingRefreshKeepsTheLastSuccessfulTimeVisible()
        try await historyFailureRemainsVisibleBesideTheChart()
        try await paperSummaryFailureDoesNotBlockTheCoreDashboard()
        try await protectiveOnlyStatusIsVisibleInTheReadOnlyApp()
        try await unknownExchangeStateBlocksTheServerTradingStatus()
        try optionalMarketTimestampsDecodeWithoutChangingExistingModelFields()
        try marketTimestampFormattingKeepsSourceAndFetchTimesDistinct()
        print("CoinPilotStore: 16 scenarios passed")
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
            "/api/market/prices",
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
        for path in [
            "/api/paper-validation",
            "/api/paper-validation/summary?details=1",
            "/api/paper-validation/start",
            "/api/paper-validation/stop",
            "/api/paper-validation/summary#fragment"
        ] {
            precondition(!CoinPilotAPIClient.isAllowedReadPath(path), "The native token must reject \(path).")
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
        precondition(store.account?.totalAssets == 4_700_000, "The bundled account sample should load.")
        precondition(store.markets.first?.sourceAsOf == "2026-09-29T00:00:00.000Z")
        precondition(store.marketSnapshotFetchedAt == "2026-09-29T00:00:03.000Z")
        precondition(store.account?.isReadOnlyObserver == true, "Bundled sample data must be explicitly read-only.")
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

        await api.setFailedPaths(["/api/market/prices"])
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
