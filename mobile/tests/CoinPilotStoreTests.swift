import Foundation
import CryptoKit

private actor DeferredCoinPilotAPI: CoinPilotAPIProviding {
    private var heldHosts: Set<String>
    private var heldMarketPaths: Set<String>
    private var heldFeaturePaths: Set<String>
    private var marketRows: [[String: Any]]
    private var marketSnapshotOverride: [String: Any]?
    private var readResponseOverrides: [String: CoinPilotHTTPResponse] = [:]
    private var heldMutationPaths: Set<String> = []
    private var pendingMutations: [String: CheckedContinuation<CoinPilotHTTPResponse, Error>] = [:]
    private var mutationWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    private let requiresAuth: Bool
    private let statusOverride: [String: Any]
    private var loginTokenScope: String?
    private let isReadOnlyObserver: Bool
    private var pending: [String: CheckedContinuation<CoinPilotHTTPResponse, Error>] = [:]
    private var waiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var pendingFeatureReads: [String: CheckedContinuation<CoinPilotHTTPResponse, Error>] = [:]
    private var featureReadWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var pendingMarketReads: [String: CheckedContinuation<CoinPilotHTTPResponse, Error>] = [:]
    private var marketReadWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var readRequests = 0
    private var networkCalls = 0
    private var loginTokens: [String] = []
    private var authenticationURLs: [String] = []
    private var loginURLs: [String] = []
    private var rejectedLoginTokens: Set<String> = []
    private var authenticationUnavailable = false
    private let serverModesByAddress: [String: String]
    private var readTokens: [String?] = []
    private var readPaths: [String] = []
    private var mutationPaths: [String] = []
    private var mutationBodies: [[String: Any]] = []
    private var failedPaths: Set<String> = []
    private var cancelledPaths: Set<String> = []
    private var upbitCredentialsConfigured: Bool?
    private let credentialRegistrationStatusCode: Int
    private var credentialSubmissions: [[String: String]] = []
    private var credentialSubmissionURLs: [String] = []
    private var credentialSubmissionTokens: [String?] = []

    init(
        heldAccountHosts: Set<String> = [],
        heldMarketPaths: Set<String> = [],
        heldFeaturePaths: Set<String> = [],
        marketRows: [[String: Any]] = [],
        requiresAuth: Bool = false,
        statusOverride: [String: Any] = [:],
        loginTokenScope: String? = nil,
        isReadOnlyObserver: Bool = true,
        credentialRegistrationStatusCode: Int = 200,
        serverModesByAddress: [String: String] = [:]
    ) {
        heldHosts = heldAccountHosts
        self.heldMarketPaths = heldMarketPaths
        self.heldFeaturePaths = heldFeaturePaths
        self.marketRows = marketRows
        self.requiresAuth = requiresAuth
        self.statusOverride = statusOverride
        self.loginTokenScope = loginTokenScope
        self.isReadOnlyObserver = isReadOnlyObserver
        upbitCredentialsConfigured = statusOverride["upbitCredentialsConfigured"] as? Bool
        self.credentialRegistrationStatusCode = credentialRegistrationStatusCode
        self.serverModesByAddress = serverModesByAddress
    }

    func authenticationStatus(at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        authenticationURLs.append(serverURL.absoluteString)
        if authenticationUnavailable { throw CoinPilotAPIError.connection }
        return Self.response(["success": true, "authRequired": requiresAuth])
    }

    func login(token: String, at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        loginTokens.append(token)
        loginURLs.append(serverURL.absoluteString)
        if rejectedLoginTokens.contains(token) { return Self.response(["success": false], statusCode: 401) }
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
        if heldFeaturePaths.contains(path) {
            return try await withCheckedThrowingContinuation { continuation in
                pendingFeatureReads[path] = continuation
                featureReadWaiters.removeValue(forKey: path)?.resume()
            }
        }
        if path.hasPrefix("/api/market/candles/"), heldMarketPaths.contains(path) {
            return try await withCheckedThrowingContinuation { continuation in
                pendingMarketReads[path] = continuation
                marketReadWaiters.removeValue(forKey: path)?.resume()
            }
        }
        if let response = readResponseOverrides[path] { return response }
        return Self.readResponse(
            path: path,
            totalAssets: host == "first.example" ? 1111 : 2222,
            serverMode: serverModesByAddress[serverURL.absoluteString] ?? statusOverride["mode"] as? String ?? "DRY_RUN",
            statusOverride: statusOverride,
            isReadOnlyObserver: isReadOnlyObserver,
            upbitCredentialsConfigured: upbitCredentialsConfigured,
            marketRows: marketRows,
            marketSnapshotOverride: marketSnapshotOverride
        )
    }

    func mobileRead(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse {
        try await read(path: path, at: serverURL, token: token)
    }

    func registerLiveCredentials(
        accessKey: String,
        secretKey: String,
        at serverURL: URL,
        token: String?
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
        token: String?,
        body: [String: Any],
        idempotencyKey: String?
    ) async throws -> CoinPilotHTTPResponse {
        networkCalls += 1
        mutationPaths.append(path)
        mutationBodies.append(body)
        let key = "\(serverURL.host ?? "")\(path)"
        if heldMutationPaths.contains(path) {
            return try await withCheckedThrowingContinuation { continuation in
                pendingMutations[key] = continuation
                mutationWaiters.removeValue(forKey: key)?.resume()
            }
        }
        return Self.response(["success": true])
    }

    func setHeldMutationPaths(_ paths: Set<String>) { heldMutationPaths = paths }

    func waitForHeldMutation(host: String, path: String) async {
        let key = "\(host)\(path)"
        if pendingMutations[key] != nil { return }
        await withCheckedContinuation { continuation in mutationWaiters[key] = continuation }
    }

    func releaseHeldMutation(host: String, path: String, fails: Bool = false) {
        let continuation = pendingMutations.removeValue(forKey: "\(host)\(path)")
        if fails { continuation?.resume(throwing: CoinPilotAPIError.connection) }
        else { continuation?.resume(returning: Self.response(["success": true])) }
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

    func waitForHeldFeaturePath(_ path: String) async {
        if pendingFeatureReads[path] != nil { return }
        await withCheckedContinuation { continuation in
            featureReadWaiters[path] = continuation
        }
    }

    func releaseHeldFeaturePath(_ path: String, body: [String: Any], statusCode: Int = 200) {
        pendingFeatureReads.removeValue(forKey: path)?.resume(
            returning: Self.response(body, statusCode: statusCode)
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
    func recordedAuthenticationURLs() -> [String] { authenticationURLs }
    func recordedLoginURLs() -> [String] { loginURLs }
    func setRejectedLoginTokens(_ tokens: Set<String>) { rejectedLoginTokens = tokens }
    func setAuthenticationUnavailable(_ unavailable: Bool) { authenticationUnavailable = unavailable }
    func clearReadResponse(path: String) { readResponseOverrides.removeValue(forKey: path) }
    func recordedReadTokens() -> [String?] { readTokens }
    func recordedReadPaths() -> [String] { readPaths }
    func recordedMutationPaths() -> [String] { mutationPaths }
    func recordedMutationBodies() -> [[String: Any]] { mutationBodies }
    func recordedCredentialSubmissions() -> [[String: String]] { credentialSubmissions }
    func recordedCredentialSubmissionURLs() -> [String] { credentialSubmissionURLs }
    func recordedCredentialSubmissionTokens() -> [String?] { credentialSubmissionTokens }
    func setLoginTokenScope(_ scope: String?) { loginTokenScope = scope }
    func setFailedPaths(_ paths: Set<String>) { failedPaths = paths }
    func setCancelledPaths(_ paths: Set<String>) { cancelledPaths = paths }
    func setHeldHosts(_ hosts: Set<String>) { heldHosts = hosts }
    func setHeldMarketPaths(_ paths: Set<String>) { heldMarketPaths = paths }
    func setHeldFeaturePaths(_ paths: Set<String>) { heldFeaturePaths = paths }
    func setMarketRows(_ rows: [[String: Any]]) { marketRows = rows }
    func setMarketSnapshot(_ snapshot: [String: Any]) { marketSnapshotOverride = snapshot }
    func setReadResponse(path: String, body: Any, statusCode: Int = 200) {
        readResponseOverrides[path] = Self.response(body, statusCode: statusCode)
    }

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
        if path == "/api/news?limit=80" {
            return response([
                "news": [["id": "fixture-news", "title": "테스트 기사", "timestamp": "2026-09-30T12:00:00.000Z"]],
                "sentiment": ["overall": "neutral", "count": 1]
            ])
        }
        if path == "/api/ai/providers" { return response(["providers": [["name": "fixture", "ready": true]]]) }
        if path == "/api/ai/monitoring?limit=40" {
            return response(["events": [["id": "fixture-event"]], "consultations": [], "effectiveness": [:]])
        }
        if path == "/api/ai/sessions" { return response(["sessions": [["id": "fixture-session"]]]) }
        if path == "/api/portfolio-analysis" { return response(["summary": ["totalAssets": totalAssets], "holdings": []]) }
        if path == "/api/statistics" { return response([["key": "fixture-stat", "value": 1]]) }
        if path == "/api/strategy-research" { return response(["available": true, "generatedAt": "fixture"]) }
        if path == "/api/strategy-readiness" { return response(["status": "fixture", "available": true]) }
        if path == "/api/scalping-validation" { return response(["results": [["coin": "KRW-BTC", "status": "fixture"]]]) }
        if path == "/api/paper-validation" { return response(["active": false, "available": true]) }
        if path == "/api/momentum-shadow" { return response(["available": true, "books": [["name": "fixture"]]]) }
        if path == "/api/live-execution-evidence" { return response(["entries": [["eventType": "fixture"]]]) }
        if path == "/api/optimization/settings" { return response(["enabled": true, "interval": 60_000]) }
        if path == "/api/optimization-history" { return response(["history": [["id": "fixture-history"]]]) }
        if path == "/api/backtest/results" { return response(["entries": [["id": "fixture-backtest"]]]) }
        if path == "/api/optimal-config" { return response(["parameters": [String: Any]()]) }
        if path == "/api/investment-presets" { return response(["presets": [["id": "fixture-preset"]]]) }
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

private actor MemoryCoinPilotOfflineReplayStore: CoinPilotOfflineReplayResultPersisting {
    private var results: [CoinPilotOfflineReplay.Result] = []
    private var saveCount = 0

    func load() async throws -> [CoinPilotOfflineReplay.Result] { results }

    func save(_ result: CoinPilotOfflineReplay.Result) async throws -> [CoinPilotOfflineReplay.Result] {
        saveCount += 1
        results.removeAll {
            $0.metadata.datasetFingerprint == result.metadata.datasetFingerprint &&
                $0.metadata.market == result.metadata.market &&
                $0.metadata.intervalMinutes == result.metadata.intervalMinutes &&
                $0.metadata.configVersion == result.metadata.configVersion &&
                $0.metadata.engineVersion == result.metadata.engineVersion
        }
        results.insert(result, at: 0)
        return results
    }

    func numberOfSaves() -> Int { saveCount }
}

private actor MemoryCoinPilotOfflineReplaySessionStore: CoinPilotOfflineReplaySessionPersisting {
    private var checkpoint: CoinPilotOfflineReplaySessionCheckpoint?
    private var saveCount = 0

    func loadCheckpoint() async throws -> CoinPilotOfflineReplaySessionCheckpoint? { checkpoint }

    func saveCheckpoint(_ checkpoint: CoinPilotOfflineReplaySessionCheckpoint) async throws {
        guard checkpoint.isWellFormed else {
            throw CoinPilotOfflineReplaySessionCheckpointError.invalidCheckpoint
        }
        self.checkpoint = checkpoint
        saveCount += 1
    }

    func clearCheckpoint() async throws {
        checkpoint = nil
    }

    func numberOfSaves() -> Int { saveCount }
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
        try await fullOperatorScopeGrantsNativeControl()
        try liveManualPrepareStatusKeepsAutomationControlAvailable()
        try simulatorTokenStoreIsScopedAndVolatile()
        try await simulatorDefaultTokenStoreSupportsReadOnlySignIn()
        try nativeReadAllowlistIncludesOnlyThePaperSummary()
        try await bundledPreviewWorksWithoutCallingTheServer()
        try await bundledPreviewBuildIgnoresThePreviousServerProfile()
        try await bundledPreviewMissingResourceDoesNotFallBackToServer()
        try await refreshValidatesModeBeforePrivateReads()
        try await newsFeatureRefreshUsesTTLAndPreservesLastGoodData()
        try await featureRefreshCoalescesAndDiscardsResponsesAfterLogout()
        try await forcedFeatureRefreshRunsAfterAnInFlightAutomaticRefresh()
        try await detailFeatureGroupsRefreshIndependentlyByTTL()
        try await portfolioSnapshotReloadsTheSelectedHistoryPeriod()
        try await optimizationPartialRefreshPreservesSuccessfulTimeAndRetries()
        try await latePendingOrderResultsCannotAlterAnotherServer()
        try await lateMutationFailureCannotRepopulateLoggedOutScreen()
        try await quoteCurrencyAmountsUseTheMatchingMinimumAndPreserveDecimals()
        try await unsupportedQuoteCurrencyBlocksOnlyOrdersAndPaperWallet()
        try await tuningEditableNumbersReachTheServerWithoutChangingDecimals()
        try coinDetailPreservesUnknownValuationAndFiniteLosses()
        try await latestMarketDetailRequestWins()
        try localMarketPackRejectsInvalidData()
        try await bundledLocalMarketModeIsStrictReadOnlyAndOffline()
        try await bundledOfflineReplayUsesThePackAndStaysOffline()
        try await bundledOfflineReplaySessionResumesWithoutNetworkOrOrders()
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
        try candleTimestampsNormalizeAtTheMarketBoundary()
        try await completeMarketSnapshotUsesServerFetchedAt()
        try await lastGoodMarketSnapshotRemainsStaleAndBlocksOrders()
        try await staleMarketSourceCannotEnableManualOrder()
        try await incompleteMarketSnapshotKeepsPricesVisibleAndMarksStale()
        try await staleMarketListAndInvalidFetchedAtNeverMarkCurrent()
        try chartAxisAndPositionFormattingStayNullSafe()
        try percentFormattingPreservesSmallChanges()
        try await bundledServerDefaultsConnectAndOperateWithoutAuth()
        try await managedServersOpenBothWorkspacesWithoutAddressEntry()
        try await managedServerMigrationKeepsBuildProfilesIsolated()
        try await managedLoginVerifiesSameOriginWorkspaceToken()
        try await managedTokenReuseNeverLeaksAcrossOrigins()
        try await managedServerMismatchKeepsPrivateDataAndOrdersLocked()
        try await managedServerRetryPreservesAuthenticationAndPendingOrders()
        try await managedWorkspaceSwitchDiscardsQueuedConnections()
        try await managedAccountAuthenticationExpiryAllowsRelogin()
        print("CoinPilotStore: 60 scenarios passed")
    }

    private static func coinDetailPreservesUnknownValuationAndFiniteLosses() throws {
        let fresh = CoinPilotCoinDetail([
            "coin": "KRW-BTC", "currentPrice": 111,
            "holding": ["amount": 1, "avgPrice": 120, "currentValue": 111, "profit": -9, "profitPercent": -7.5]
        ])!
        precondition(fresh.hasHolding && fresh.currentPrice == 111 && fresh.holdingValue == 111 &&
                     fresh.holdingProfit == -9 && fresh.holdingProfitPercent == -7.5,
                     "A current valuation must preserve both its value and a real negative holding profit.")

        let stale = CoinPilotCoinDetail([
            "coin": "KRW-BTC", "currentPrice": NSNull(),
            "holding": ["amount": 1, "avgPrice": 120, "currentValue": NSNull(), "profit": NSNull(), "profitPercent": NSNull()]
        ])!
        let staleValue: Double? = stale.holdingValue
        let staleProfit: Double? = stale.holdingProfit
        precondition(stale.hasHolding && stale.currentPrice == nil && stale.holdingAvgPrice == 120 &&
                     staleValue == nil && staleProfit == nil && stale.holdingProfitPercent == nil,
                     "A stale holding remains present but an unavailable valuation or profit must not become zero.")

        let missing = CoinPilotCoinDetail(["coin": "KRW-BTC", "holding": ["amount": 1]])!
        let missingValue: Double? = missing.holdingValue
        let missingProfit: Double? = missing.holdingProfit
        precondition(missingValue == nil && missingProfit == nil,
                     "Older coin-detail responses with no valuation fields must also remain unknown.")

        let zero = CoinPilotCoinDetail([
            "coin": "KRW-BTC", "holding": ["amount": 0, "currentValue": 0, "profit": 0]
        ])!
        precondition(zero.holdingValue == 0 && zero.holdingProfit == 0,
                     "An explicitly known zero must remain distinct from an unavailable value.")

        let invalid = CoinPilotCoinDetail([
            "coin": "USDT-BTC", "currentPrice": "NaN", "change24h": "Infinity", "high24h": "Infinity",
            "low24h": "-Infinity", "volume24h": "NaN", "krwBalance": "Infinity", "maxBuyAmount": "NaN",
            "maxSellAmount": "Infinity",
            "holding": ["amount": "NaN", "avgPrice": "Infinity", "currentValue": "NaN", "profit": "-Infinity", "profitPercent": "Infinity"],
            "indicators": ["rsi": "NaN", "macd": "Infinity", "bb": "-Infinity"]
        ])!
        let invalidValue: Double? = invalid.holdingValue
        let invalidProfit: Double? = invalid.holdingProfit
        precondition(invalid.currentPrice == nil && invalid.change24hPercent == nil && invalid.high24h == nil &&
                     invalid.low24h == nil && invalid.volume24h == nil && invalid.krwBalance == nil &&
                     invalid.maxBuyAmount == nil && invalid.maxSellAmount == nil && invalidValue == nil &&
                     invalidProfit == nil && invalid.holdingProfitPercent == nil && invalid.rsi == nil &&
                     invalid.macdHistogram == nil && invalid.bollingerPercentB == nil && !invalid.hasHolding,
                     "No coin-detail numeric field may expose NaN or Infinity as a usable number.")
    }

    private static func portfolioSnapshotReloadsTheSelectedHistoryPeriod() async throws {
        let api = DeferredCoinPilotAPI(isReadOnlyObserver: false)
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        let connected = await store.connect(using: "https://snapshot-reload.example")
        precondition(connected && store.canOperate, "Snapshot testing requires an operable fake server.")
        await store.setHistoryPeriod(.week)
        precondition(store.history.isEmpty, "The fake server starts with no asset records.")
        let historyPath = "/api/portfolio/history?period=7d"
        let initialReads = await api.recordedReadPaths().filter { $0 == historyPath }.count
        await api.setReadResponse(path: historyPath, body: [
            "data": [["timestamp": "2026-10-05T10:00:00.000Z", "totalAssets": 2222]],
            "period": "7d", "count": 1
        ])

        let recorded = await store.recordPortfolioSnapshot()
        let refreshedReads = await api.recordedReadPaths().filter { $0 == historyPath }.count
        let mutations = await api.recordedMutationPaths()
        precondition(recorded && mutations == ["/api/portfolio/snapshot"],
                     "Saving an asset snapshot should issue one mutation and report that save result.")
        precondition(refreshedReads == initialReads + 1 && store.history.count == 1 &&
                     store.history.first?.totalAssets == 2222 && store.historyPeriod == .week,
                     "Saving a snapshot must immediately reload the visible period even when it is unchanged.")

        await api.setFailedPaths([historyPath])
        let secondRecorded = await store.recordPortfolioSnapshot()
        precondition(secondRecorded && store.history.count == 1 && store.isResourceStale("portfolio-history"),
                     "A saved snapshot remains successful when its follow-up read fails; keep the last chart and mark it stale.")
    }

    private static func optimizationPartialRefreshPreservesSuccessfulTimeAndRetries() async throws {
        var currentNow = Date(timeIntervalSince1970: 1_800_000_000)
        let api = DeferredCoinPilotAPI(isReadOnlyObserver: false)
        let store = CoinPilotStore(
            api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server", now: { currentNow }
        )
        let connected = await store.connect(using: "https://optimization-partial-refresh.example")
        precondition(connected && store.canOperate, "Optimization testing requires an operable fake server.")
        let initiallyLoaded = await store.loadOptimization()
        precondition(initiallyLoaded && store.featureLastSuccessfulAt["optimization"] == currentNow,
                     "An initial complete optimization read should establish its successful fetch time.")

        for failedPath in ["/api/optimization-history", "/api/backtest/results", "/api/optimal-config", "/api/investment-presets"] {
            let lastSuccessfulAt = store.featureLastSuccessfulAt["optimization"]
            currentNow = currentNow.addingTimeInterval(301)
            await api.setFailedPaths([failedPath])
            let loaded = await store.loadOptimizationIfStale()
            precondition(!loaded && store.featureLastSuccessfulAt["optimization"] == lastSuccessfulAt &&
                         store.featureMessages["optimization"] != nil,
                         "A failed optimization detail must preserve the last complete fetch time and expose the refresh failure.")
            precondition(!store.optimizationHistory.isEmpty && !store.backtestResults.isEmpty &&
                         !store.optimalConfig.isEmpty && !store.investmentPresets.isEmpty,
                         "A partial optimization refresh must retain each last-good detail.")
            let readCountAfterFailure = await api.recordedReadPaths().filter { $0 == failedPath }.count
            await api.setFailedPaths([])
            let recovered = await store.loadOptimizationIfStale()
            let readCountAfterRecovery = await api.recordedReadPaths().filter { $0 == failedPath }.count
            precondition(recovered && readCountAfterRecovery == readCountAfterFailure + 1 &&
                         store.featureLastSuccessfulAt["optimization"] == currentNow &&
                         store.featureMessages["optimization"] == nil,
                         "An incomplete group should retry immediately after the connection recovers instead of waiting five minutes.")
        }
    }

    private static func latePendingOrderResultsCannotAlterAnotherServer() async throws {
        let path = "/api/virtual/deposit"
        for fails in [false, true] {
            let api = DeferredCoinPilotAPI(statusOverride: ["isRunning": false], isReadOnlyObserver: false)
            let pendingOrders = CoinPilotMemoryPendingOrderStore()
            let store = CoinPilotStore(
                api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server", pendingOrderStore: pendingOrders
            )
            let firstURL = URL(string: "https://order-old.example")!
            let secondURL = URL(string: "https://order-new.example")!
            let connected = await store.connect(using: firstURL.absoluteString)
            precondition(connected && store.paperWalletBlockReason == nil, "The old fake wallet should be operable.")
            await api.setHeldMutationPaths([path])
            let oldOrder = Task { await store.updatePaperWallet(amount: 1_000, deposit: true) }
            await api.waitForHeldMutation(host: "order-old.example", path: path)
            precondition(store.pendingManualOrderLocked && store.isSubmittingManualOrder,
                         "The old request must retain its durable pending state while the response is held.")

            let switched = await store.connect(using: secondURL.absoluteString)
            precondition(switched && store.canOperate, "Connecting a different fake server should establish a new request context.")
            await api.releaseHeldMutation(host: "order-old.example", path: path, fails: fails)
            let oldResult = await oldOrder.value
            precondition(!oldResult && store.phase == .dashboard && store.pendingManualOrder == nil &&
                         !store.pendingManualOrderLocked && !store.isSubmittingManualOrder && store.orderMessage == nil,
                         "A late success or connection failure from the old server must not change the new server's order state.")
            guard case .saved = pendingOrders.read(for: firstURL) else {
                preconditionFailure("The old server's pending record must remain available for idempotent result recovery.")
            }
            guard case .missing = pendingOrders.read(for: secondURL) else {
                preconditionFailure("The old response must not create a pending record for the new server.")
            }
            let restored = CoinPilotStore(
                api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server", pendingOrderStore: pendingOrders
            )
            let restoredConnection = await restored.connect(using: firstURL.absoluteString)
            precondition(restoredConnection && restored.pendingManualOrderLocked && restored.pendingManualOrder != nil,
                         "Returning to the original server must offer recovery of the exact stored request.")
        }
    }

    private static func lateMutationFailureCannotRepopulateLoggedOutScreen() async throws {
        for path in ["/api/portfolio/snapshot", "/api/control/start", "/api/config/update"] {
            let api = DeferredCoinPilotAPI(statusOverride: ["isRunning": false], isReadOnlyObserver: false)
            let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
            let host = "mutation-logout.example"
            let connected = await store.connect(using: "https://\(host)")
            precondition(connected && store.canOperate, "The fake mutation requires an operable server.")
            await api.setHeldMutationPaths([path])
            let mutation = Task {
                switch path {
                case "/api/portfolio/snapshot": return await store.recordPortfolioSnapshot()
                case "/api/control/start": return await store.setAutomationRunning(true)
                default: return await store.saveTuning(["rsiOversold": 30])
                }
            }
            await api.waitForHeldMutation(host: host, path: path)
            store.logOut()
            await api.releaseHeldMutation(host: host, path: path, fails: true)
            let result = await mutation.value
            precondition(!result && store.phase == .login && store.featureMessages.isEmpty &&
                         store.dashboardMessage == nil && store.tuningMessage == nil,
                         "A failed mutation from the logged-out request context must not repopulate the cleared screen.")
        }
    }

    private static func quoteCurrencyAmountsUseTheMatchingMinimumAndPreserveDecimals() async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = formatter.string(from: Date())
        for quote in ["USDT", "USDC", "FDUSD", "TUSD", "KRW"] {
            let isKRW = quote == "KRW"
            let coin = "\(quote)-BTC"
            let buyCoin = "\(quote)-ETH"
            let api = DeferredCoinPilotAPI(
                marketRows: [
                    ["coin": coin, "price": isKRW ? 60_000_000 : 60_000, "sourceAsOf": timestamp, "fetchedAt": timestamp],
                    ["coin": buyCoin, "price": isKRW ? 3_000_000 : 3_000, "sourceAsOf": timestamp, "fetchedAt": timestamp]
                ],
                statusOverride: ["exchange": isKRW ? "upbit" : "binance", "quoteCurrency": quote, "isRunning": false],
                isReadOnlyObserver: false
            )
            await api.setReadResponse(path: "/api/account", body: [
                "krwBalance": isKRW ? 1_000_000 : 1_000, "totalAssets": isKRW ? 2_200_000 : 2_200,
                "mode": "DRY_RUN", "readOnlyObserver": false, "valuationAvailable": true,
                "positions": [["coin": coin, "amount": 0.02, "currentPrice": isKRW ? 60_000_000 : 60_000,
                               "currentValue": isKRW ? 1_200_000 : 1_200]]
            ])
            let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
            let connected = await store.connect(using: "https://quote-amount-\(quote.lowercased()).example")
            precondition(connected && store.quoteCurrency == quote && store.manualOrderBlockReason(for: coin) == nil,
                         "The test must use the server's verified quote currency and fresh fake quotes.")
            if isKRW {
                precondition(CoinPilotFormatting.won(5_000) == "₩5,000" &&
                             CoinPilotFormatting.signedWon(-5) == "−₩5" &&
                             CoinPilotFormatting.price(0.125) == "₩0.125",
                             "KRW amounts and prices must retain their existing won symbol and precision.")
            } else {
                precondition(CoinPilotFormatting.won(5.75) == "$5.75" &&
                             CoinPilotFormatting.signedWon(0.000125) == "+$0.000125" &&
                             CoinPilotFormatting.price(60_000.125) == "$60,000.125",
                             "Stablecoin amounts, small profit, and prices must retain meaningful decimals on screen.")
            }

            let buyAmount = isKRW ? 5_000.75 : 5.75
            let smartBuyAmount = isKRW ? 10_000.75 : 10.75
            let smartSellAmount = isKRW ? 2_000.25 : 5.25
            let recommendationAmount = isKRW ? 7_000.375 : 7.375
            let bundleAmount = isKRW ? 8_000.25 : 8.25
            let depositAmount = isKRW ? 1_000.75 : 1.75
            let withdrawAmount = isKRW ? 1_000.25 : 1.25
            let seedAmount = isKRW ? 100_000.125 : 100.125
            var results: [Bool] = []
            results.append(await store.submitManualBuy(coin: coin, amount: buyAmount))
            results.append(await store.submitSmartBuy(totalAmount: smartBuyAmount, minimumScore: 60, maximumCoins: 2))
            results.append(await store.submitSmartSell(targetAmount: smartSellAmount, strategy: "worst"))
            results.append(await store.submitRecommendation(CoinPilotRecommendation(["coin": coin, "action": "BUY"]), amount: recommendationAmount))
            results.append(await store.submitBundle(sellCoin: coin, sellAmount: 0.001, buyCoin: buyCoin, buyAmount: bundleAmount))
            results.append(await store.updatePaperWallet(amount: depositAmount, deposit: true))
            results.append(await store.updatePaperWallet(amount: withdrawAmount, deposit: false))
            results.append(await store.resetPaperWallet(seedMoney: seedAmount))
            precondition(results.allSatisfy { $0 },
                         "Valid \(quote) amounts must reach every order and wallet flow using that currency's minimum.")

            let paths = await api.recordedMutationPaths()
            let bodies = await api.recordedMutationBodies()
            let expected: [(String, String, Double)] = [
                ("/api/trade/buy", "amount", buyAmount),
                ("/api/trade/smart-buy", "totalAmount", smartBuyAmount),
                ("/api/trade/smart-sell", "targetAmount", smartSellAmount),
                ("/api/trade/execute", "amount", recommendationAmount),
                ("/api/trade/execute-bundle", "buyAmount", bundleAmount),
                ("/api/virtual/deposit", "amount", depositAmount),
                ("/api/virtual/withdraw", "amount", withdrawAmount),
                ("/api/virtual/reset", "seedMoney", seedAmount)
            ]
            precondition(paths.count == expected.count && bodies.count == expected.count,
                         "Each confirmed fake action should issue exactly one idempotent mutation.")
            for (index, request) in expected.enumerated() {
                let amount = (bodies[index][request.1] as? NSNumber)?.doubleValue
                precondition(paths[index] == request.0 && amount == (isKRW ? floor(request.2) : request.2),
                             "KRW retains whole-won requests; USDT/USDC must preserve the user's decimal amount.")
            }
            let belowOrderMinimum = await store.submitManualBuy(coin: coin, amount: store.minimumOrderAmount - 0.001)
            let belowSmartSellMinimum = await store.submitSmartSell(targetAmount: store.minimumSmartSellAmount - 0.001, strategy: "worst")
            let belowWalletMinimum = await store.updatePaperWallet(amount: store.minimumWalletAmount - 0.001, deposit: true)
            let belowSeedMinimum = await store.resetPaperWallet(seedMoney: store.minimumSeedAmount - 0.001)
            let finalPaths = await api.recordedMutationPaths()
            precondition(!belowOrderMinimum && !belowSmartSellMinimum && !belowWalletMinimum && !belowSeedMinimum && finalPaths == paths,
                         "Currency-specific minimums must still refuse undersized requests before mutation.")
        }
    }

    private static func unsupportedQuoteCurrencyBlocksOnlyOrdersAndPaperWallet() async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = formatter.string(from: Date())
        for quote in ["BTC", "ETH", "UNKNOWN"] {
            let coin = "\(quote)-SOL"
            let buyCoin = "\(quote)-LTC"
            let api = DeferredCoinPilotAPI(
                marketRows: [
                    ["coin": coin, "price": 100, "sourceAsOf": timestamp, "fetchedAt": timestamp],
                    ["coin": buyCoin, "price": 10, "sourceAsOf": timestamp, "fetchedAt": timestamp]
                ],
                statusOverride: ["exchange": "binance", "quoteCurrency": quote, "isRunning": false],
                isReadOnlyObserver: false
            )
            await api.setReadResponse(path: "/api/account", body: [
                "krwBalance": 1_000, "totalAssets": 2_000, "mode": "DRY_RUN",
                "readOnlyObserver": false, "valuationAvailable": true,
                "positions": [["coin": coin, "amount": 10, "currentPrice": 100, "currentValue": 1_000]]
            ])
            let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
            let connected = await store.connect(using: "https://unsupported-quote-\(quote.lowercased()).example")
            precondition(connected && store.account != nil && store.canOperate && !store.supportsAmountCurrency,
                         "An unsupported amount currency must retain its account display and ordinary server access.")
            precondition(CoinPilotFormatting.quoteAssetLabel == quote &&
                         CoinPilotFormatting.won(1) == "\(quote) 1" &&
                         CoinPilotFormatting.won(0.12345678) == "\(quote) 0.12345678" &&
                         CoinPilotFormatting.signedWon(-0.00000001) == "−\(quote) 0.00000001" &&
                         CoinPilotFormatting.signedWon(0.000125) == "+\(quote) 0.000125" &&
                         CoinPilotFormatting.price(0.00001234) == "\(quote) 0.00001234",
                         "Account amounts, profit, and prices must retain their actual quote currency and decimals.")
            precondition(store.manualOrderBlockReason?.contains(quote) == true &&
                         store.manualOrderBlockReason?.contains("조회") == true &&
                         store.paperWalletBlockReason?.contains(quote) == true,
                         "Order and wallet forms must explain the unsupported currency and available account viewing.")
            precondition(store.canViewTuning && store.tuningBlockReason == nil && store.optimizationBlockReason == nil,
                         "The amount currency gate must not expand into tuning, control, or other non-order features.")
            var results: [Bool] = []
            results.append(await store.submitManualBuy(coin: coin, amount: 5.75))
            results.append(await store.submitManualSell(coin: coin, quantity: 1))
            results.append(await store.submitSmartBuy(totalAmount: 10.75, minimumScore: 60, maximumCoins: 2))
            results.append(await store.submitSmartSell(targetAmount: 5.25, strategy: "worst"))
            results.append(await store.submitRecommendation(CoinPilotRecommendation(["coin": coin, "action": "BUY"]), amount: 7.375))
            results.append(await store.submitBundle(sellCoin: coin, sellAmount: 1, buyCoin: buyCoin, buyAmount: 8.25))
            results.append(await store.updatePaperWallet(amount: 1.75, deposit: true))
            results.append(await store.updatePaperWallet(amount: 1.25, deposit: false))
            results.append(await store.resetPaperWallet(seedMoney: 100.125))
            let mutations = await api.recordedMutationPaths()
            precondition(results.allSatisfy { !$0 } && mutations.isEmpty,
                         "Every unsupported-currency order and paper wallet method must stop before a mutation request.")
        }
    }

    private static func tuningEditableNumbersReachTheServerWithoutChangingDecimals() async throws {
        let api = DeferredCoinPilotAPI(statusOverride: ["isRunning": false], isReadOnlyObserver: false)
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        let connected = await store.connect(using: "https://tuning-number-roundtrip.example")
        precondition(connected && store.tuningBlockReason == nil,
                     "The editable-number test requires a stopped, operable fake server.")
        let values: [String: Double] = [
            "investmentRatio": 0.05, "minTrendSlopePercent": 0.001, "takeProfitPercent": 1.05, "rsiOversold": 30
        ]
        var updates: [String: Any] = [:]
        for (key, value) in values {
            let text = CoinPilotFormatting.editableNumber(value)
            guard let parsed = Double(text) else {
                preconditionFailure("A tuning value must produce an editable numeric input.")
            }
            updates[key] = parsed
        }
        precondition(CoinPilotFormatting.editableNumber(30) == "30",
                     "Whole tuning values should omit only their trailing .0.")
        let saved = await store.saveTuning(updates)
        let paths = await api.recordedMutationPaths()
        let bodies = await api.recordedMutationBodies()
        precondition(saved && paths == ["/api/config/update"] && bodies.count == 1 &&
                     Set(bodies[0].keys) == Set(values.keys),
                     "Parsed editor inputs must travel through the real Store tuning mutation once.")
        for (key, value) in values {
            precondition((bodies[0][key] as? NSNumber)?.doubleValue == value,
                         "The tuning editor must not turn \(value) into a different server configuration.")
        }
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

    private static func newsFeatureRefreshUsesTTLAndPreservesLastGoodData() async throws {
        var currentNow = Date(timeIntervalSince1970: 1_800_000_000)
        let api = DeferredCoinPilotAPI(
            requiresAuth: true,
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "server",
            now: { currentNow }
        )
        store.serverDraft = "https://news-feature-freshness.example"
        store.tokenDraft = "synthetic-mobile-operator-token"
        let connected = await store.signIn()
        precondition(connected && store.canOperate, "The feature freshness test requires a signed-in operator.")

        await store.loadNewsIfStale()
        let newsPath = "/api/news?limit=80"
        let firstReadCount = await api.recordedReadPaths().filter { $0 == newsPath }.count
        let firstSuccessAt = store.featureLastSuccessfulAt["news"]
        precondition(firstReadCount == 1 && store.newsArticles.first?.title == "테스트 기사",
                     "The first visible News load should fetch and show the server data.")
        precondition(firstSuccessAt == currentNow,
                     "The freshness time must reflect the app's successful fetch, not the server report timestamp.")

        currentNow = currentNow.addingTimeInterval(60)
        await store.loadNewsIfStale()
        let withinTTLReadCount = await api.recordedReadPaths().filter { $0 == newsPath }.count
        precondition(withinTTLReadCount == firstReadCount,
                     "Returning to the visible News page inside its TTL must not add another request.")

        await store.loadNews()
        let forcedReadCount = await api.recordedReadPaths().filter { $0 == newsPath }.count
        let forcedSuccessAt = store.featureLastSuccessfulAt["news"]
        precondition(forcedReadCount == firstReadCount + 1 && forcedSuccessAt == currentNow,
                     "Manual refresh must bypass TTL and advance the last-success time.")

        currentNow = currentNow.addingTimeInterval(60)
        await api.setFailedPaths([newsPath])
        await store.loadNews()
        precondition(store.newsArticles.first?.title == "테스트 기사",
                     "A failed refresh must keep the last successful News data.")
        precondition(store.featureLastSuccessfulAt["news"] == forcedSuccessAt,
                     "A failed request must not move the last-success timestamp.")
        precondition(store.featureMessages["news"] != nil,
                     "A failed refresh must remain visible next to the last successful timestamp.")
    }

    private static func featureRefreshCoalescesAndDiscardsResponsesAfterLogout() async throws {
        let newsPath = "/api/news?limit=80"
        let api = DeferredCoinPilotAPI(
            heldFeaturePaths: [newsPath],
            requiresAuth: true,
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        store.serverDraft = "https://news-feature-coalesce.example"
        store.tokenDraft = "synthetic-mobile-operator-token"
        let connected = await store.signIn()
        precondition(connected && store.canOperate, "The coalescing test requires a signed-in operator.")

        let firstLoad = Task { await store.loadNewsIfStale() }
        await api.waitForHeldFeaturePath(newsPath)
        let duplicateLoad = Task { await store.loadNewsIfStale() }
        await duplicateLoad.value
        let heldReadCount = await api.recordedReadPaths().filter { $0 == newsPath }.count
        precondition(heldReadCount == 1,
                     "Concurrent refresh triggers for one visible feature group must share one request.")

        store.logOut()
        await api.releaseHeldFeaturePath(newsPath, body: [
            "news": [["id": "late-news", "title": "늦은 기사"]],
            "sentiment": ["overall": "neutral", "count": 1]
        ])
        await firstLoad.value
        precondition(store.newsArticles.isEmpty && store.featureLastSuccessfulAt["news"] == nil,
                     "A detail response from the old authenticated workspace must not repopulate data after logout.")
    }

    private static func forcedFeatureRefreshRunsAfterAnInFlightAutomaticRefresh() async throws {
        let newsPath = "/api/news?limit=80"
        let api = DeferredCoinPilotAPI(
            heldFeaturePaths: [newsPath],
            requiresAuth: true,
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        store.serverDraft = "https://news-feature-forced-refresh.example"
        store.tokenDraft = "synthetic-mobile-operator-token"
        let connected = await store.signIn()
        precondition(connected && store.canOperate, "The refresh priority test requires a signed-in operator.")

        let automaticLoad = Task { await store.loadNewsIfStale() }
        await api.waitForHeldFeaturePath(newsPath)
        await store.loadNews()
        let firstReadCount = await api.recordedReadPaths().filter { $0 == newsPath }.count
        precondition(firstReadCount == 1,
                     "A manual refresh must not create a duplicate request while the automatic read is in flight.")

        await api.releaseHeldFeaturePath(newsPath, body: [
            "news": [["id": "initial", "title": "첫 자료"]],
            "sentiment": ["overall": "neutral", "count": 1]
        ])
        await api.waitForHeldFeaturePath(newsPath)
        let rerunCount = await api.recordedReadPaths().filter { $0 == newsPath }.count
        precondition(rerunCount == 2,
                     "The forced request must run once after the active automatic request completes.")
        await api.releaseHeldFeaturePath(newsPath, body: [
            "news": [["id": "refreshed", "title": "새 자료"]],
            "sentiment": ["overall": "neutral", "count": 1]
        ])
        await automaticLoad.value
        precondition(store.newsArticles.first?.title == "새 자료",
                     "The forced refresh result should replace the earlier automatic response.")
    }

    private static func detailFeatureGroupsRefreshIndependentlyByTTL() async throws {
        var currentNow = Date(timeIntervalSince1970: 1_800_000_000)
        let api = DeferredCoinPilotAPI(
            requiresAuth: true,
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "server",
            now: { currentNow }
        )
        store.serverDraft = "https://feature-groups-freshness.example"
        store.tokenDraft = "synthetic-mobile-operator-token"
        let connected = await store.signIn()
        precondition(connected && store.canOperate, "The detail refresh test requires a signed-in operator.")

        await store.loadNewsIfStale()
        await store.loadAIDeskIfStale()
        await store.loadAccountAnalyticsIfStale()
        await store.loadResearchDeskIfStale()
        _ = await store.loadOptimizationIfStale()
        precondition(store.featureLastSuccessfulAt["news"] == currentNow &&
                     store.featureLastSuccessfulAt["ai"] == currentNow &&
                     store.featureLastSuccessfulAt["account-analytics"] == currentNow &&
                     store.featureLastSuccessfulAt["research"] == currentNow &&
                     store.featureLastSuccessfulAt["optimization"] == currentNow,
                     "Each visible detail group should record its app fetch time independently.")

        let initialPaths = await api.recordedReadPaths()
        let initialNewsCount = initialPaths.filter { $0 == "/api/news?limit=80" }.count
        let initialAICount = initialPaths.filter { ["/api/ai/providers", "/api/ai/monitoring?limit=40", "/api/ai/sessions"].contains($0) }.count
        let initialAnalyticsCount = initialPaths.filter { ["/api/portfolio-analysis", "/api/statistics"].contains($0) }.count
        let researchPaths: Set<String> = [
            "/api/strategy-research", "/api/strategy-readiness", "/api/scalping-validation",
            "/api/paper-validation", "/api/momentum-shadow", "/api/live-execution-evidence"
        ]
        let optimizationPaths: Set<String> = [
            "/api/optimization/settings", "/api/optimization-history", "/api/backtest/results",
            "/api/optimal-config", "/api/investment-presets"
        ]
        let initialResearchCount = initialPaths.filter { researchPaths.contains($0) }.count
        let initialOptimizationCount = initialPaths.filter { optimizationPaths.contains($0) }.count

        currentNow = currentNow.addingTimeInterval(61)
        await store.loadNewsIfStale()
        await store.loadAIDeskIfStale()
        await store.loadAccountAnalyticsIfStale()
        await store.loadResearchDeskIfStale()
        _ = await store.loadOptimizationIfStale()
        let refreshedPaths = await api.recordedReadPaths()
        let refreshedNewsCount = refreshedPaths.filter { $0 == "/api/news?limit=80" }.count
        let refreshedAICount = refreshedPaths.filter { ["/api/ai/providers", "/api/ai/monitoring?limit=40", "/api/ai/sessions"].contains($0) }.count
        let refreshedAnalyticsCount = refreshedPaths.filter { ["/api/portfolio-analysis", "/api/statistics"].contains($0) }.count
        let refreshedResearchCount = refreshedPaths.filter { researchPaths.contains($0) }.count
        let refreshedOptimizationCount = refreshedPaths.filter { optimizationPaths.contains($0) }.count

        precondition(refreshedNewsCount == initialNewsCount,
                     "News must respect its five-minute foreground TTL.")
        precondition(refreshedAICount == initialAICount + 3,
                     "AI status, monitoring, and sessions must refresh after the one-minute TTL.")
        precondition(refreshedAnalyticsCount == initialAnalyticsCount + 2,
                     "Portfolio analysis and statistics must refresh after the one-minute TTL.")
        precondition(refreshedResearchCount == initialResearchCount,
                     "Research and optimization data must respect their five-minute TTL.")
        precondition(refreshedOptimizationCount == initialOptimizationCount,
                     "Optimization details must not be fetched again inside their own five-minute TTL.")
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
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: MemoryCoinPilotOfflineReplayStore(),
            offlineReplaySessionStore: MemoryCoinPilotOfflineReplaySessionStore()
        )
        await store.bootstrap()

        precondition(store.isBundledLocalMarketData && !store.isBundledPreview,
                     "The build-selected local profile must ignore the previous Server preference.")
        precondition(store.marketCandleOriginLabel(candleCount: 4)
                     == "앱에 저장된 고정 시세 자료 · 캔들 4개",
                     "Bundled-local details must identify the static app-pack data source.")
        precondition(store.marketQuoteFreshnessMessage(for: "KRW-BTC")
                     == "출처와 최신 여부는 온라인으로 확인하지 않습니다.",
                     "Bundled-local screens must not imply server-verified market freshness.")
        precondition(store.phase == .dashboard && store.localMarketData?.markets.count == 1,
                     "The installed local profile should open directly on its strict market pack.")
        precondition(store.account == nil && store.status == nil && store.pnl == nil && store.trades.isEmpty && store.history.isEmpty,
                     "Local market data must not create account, ledger, trade, or history records.")
        precondition(!store.canOperate && !store.canViewTuning && store.manualOrderBlockReason != nil,
                     "The local profile must remain read-only and block server or order actions.")
        precondition(store.freshnessLabel(for: "market-prices") ==
                     "자료 생성 시각 · 2026. 09. 29. 12:01:00 UTC",
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
                     "캔들 시각 · 2026. 09. 29. 11:55:00 UTC",
                     "Market timestamp presentation should keep the UTC meaning in a human-readable format.")
        let networkCalls = await api.networkCallCount()
        let mutationPaths = await api.recordedMutationPaths()
        precondition(networkCalls == 0,
                     "Loading, refreshing, detail navigation, and rejected actions must make no API calls.")
        precondition(mutationPaths.isEmpty,
                     "The local profile must never send mutations.")
    }

    private static func bundledOfflineReplayUsesThePackAndStaysOffline() async throws {
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
                if let value { defaults.set(value, forKey: key) }
                else { defaults.removeObject(forKey: key) }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("paper", forKey: "coinpilot.native.activeWorkspace")
        defaults.set("server", forKey: "coinpilot.native.dataMode")

        let api = DeferredCoinPilotAPI(requiresAuth: true)
        let replayStore = MemoryCoinPilotOfflineReplayStore()
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: CoinPilotBundledMarketDataSource(
                data: localMarketFixture(candleCount: 40, hourlyCandleCount: 18)
            ),
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: replayStore,
            offlineReplaySessionStore: MemoryCoinPilotOfflineReplaySessionStore()
        )
        await store.bootstrap()

        let completed = await store.runBundledOfflineReplay(marketCode: "KRW-BTC", intervalMinutes: 5)
        precondition(completed, "A valid bundled-local series should complete historical replay.")
        guard let result = store.offlineReplayResult else {
            fatalError("A successful replay should expose its result to the view.")
        }
        precondition(result.metadata.simulationType == "historical-simulation",
                     "The result should identify itself as a historical simulation.")
        precondition(result.metadata.market == "KRW-BTC" && result.metadata.intervalMinutes == 5,
                     "Replay should use the selected market and candle interval.")
        precondition(result.metadata.rowCount == 40 && result.equityCurve.count == 24,
                     "Replay should use all 40 source candles, not the 200-row chart window.")
        precondition(result.summary.completedTradeCount == 0 && result.summary.finalBalance == result.summary.initialBalance,
                     "A fixture without qualifying signals should not fabricate trades or profit.")
        precondition(!store.isRunningOfflineReplay && store.offlineReplayMessage == nil,
                     "The store should leave a successful replay in a settled state.")
        let savedReplayCount = await replayStore.numberOfSaves()
        precondition(store.offlineReplayResults == [result] && savedReplayCount == 1,
                     "A successful result should be saved to local replay history.")
        precondition(store.offlineReplayBlockReason(forMarket: "KRW-BTC", intervalMinutes: 60)?.contains("1시간") == true,
                     "The Store should explain why hourly candles cannot represent the 30-minute max-hold rule.")
        let hourlyCompleted = await store.runBundledOfflineReplay(marketCode: "KRW-BTC", intervalMinutes: 60)
        let savesAfterHourlyAttempt = await replayStore.numberOfSaves()
        precondition(!hourlyCompleted && savesAfterHourlyAttempt == 1,
                     "Hourly browsing data must not be recorded as a replay result at an insufficient time resolution.")

        let networkCalls = await api.networkCallCount()
        let mutationPaths = await api.recordedMutationPaths()
        precondition(networkCalls == 0 && mutationPaths.isEmpty,
                     "Bundled replay must not call authentication, data, or mutation endpoints.")
    }

    private static func bundledOfflineReplaySessionResumesWithoutNetworkOrOrders() async throws {
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
                if let value { defaults.set(value, forKey: key) }
                else { defaults.removeObject(forKey: key) }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        defaults.set("paper", forKey: "coinpilot.native.activeWorkspace")
        defaults.set("server", forKey: "coinpilot.native.dataMode")

        let api = DeferredCoinPilotAPI(requiresAuth: true)
        let sessionStore = MemoryCoinPilotOfflineReplaySessionStore()
        let resultStore = MemoryCoinPilotOfflineReplayStore()
        let fixture = CoinPilotBundledMarketDataSource(data: localMarketFixture(candleCount: 40))
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: fixture,
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: resultStore,
            offlineReplaySessionStore: sessionStore,
            offlineReplaySessionUptime: { 0 }
        )
        await store.bootstrap()

        let started = await store.startOfflineReplaySession(marketCode: "KRW-BTC", intervalMinutes: 5)
        precondition(started && store.offlineReplaySessionCheckpoint?.status == .playing,
                     "Starting local playback should persist a playing checkpoint before the first step.")
        guard let first = await store.advanceOfflineReplaySession(marketCode: "KRW-BTC", intervalMinutes: 5),
              let second = await store.advanceOfflineReplaySession(marketCode: "KRW-BTC", intervalMinutes: 5),
              let third = await store.advanceOfflineReplaySession(marketCode: "KRW-BTC", intervalMinutes: 5) else {
            fatalError("Each explicit local playback step should produce exactly one candle frame.")
        }
        precondition([first.candleIndex, second.candleIndex, third.candleIndex] == [0, 1, 2],
                     "Sequential steps should not duplicate or skip source candles.")
        let durableBeforeInterruption = try await sessionStore.loadCheckpoint()
        precondition(durableBeforeInterruption?.nextCandleIndex == 0 && durableBeforeInterruption?.status == .playing,
                     "Fast playback should batch tiny cursor checkpoints instead of rewriting on every candle.")

        let crashRelaunch = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: CoinPilotBundledMarketDataSource(data: localMarketFixture(candleCount: 40)),
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: resultStore,
            offlineReplaySessionStore: sessionStore,
            offlineReplaySessionUptime: { 0 }
        )
        await crashRelaunch.bootstrap()
        precondition(crashRelaunch.offlineReplaySessionCheckpoint?.status == .paused &&
                     crashRelaunch.offlineReplaySessionCheckpoint?.nextCandleIndex == 0 &&
                     crashRelaunch.offlineReplaySessionFrame == nil &&
                     crashRelaunch.offlineReplaySessionDelayNanoseconds(forMarket: "KRW-BTC", intervalMinutes: 5) == nil,
                     "Relaunch should pause at the durable cursor and never auto-resume stored Playing state.")
        let crashResume = await crashRelaunch.resumeOfflineReplaySession()
        let replayedFirstFrame = await crashRelaunch.advanceOfflineReplaySession(marketCode: "KRW-BTC", intervalMinutes: 5)
        precondition(crashResume && replayedFirstFrame?.candleIndex == first.candleIndex,
                     "An uncheckpointed sub-second display may rewind, but recomputation must begin at the durable cursor.")

        await crashRelaunch.pauseOfflineReplaySessionForInterruption()
        let savedPause = try await sessionStore.loadCheckpoint()
        precondition(savedPause?.status == .paused && savedPause?.nextCandleIndex == 1,
                     "Background interruption should save the next unconsumed candle index.")

        let relaunched = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: CoinPilotBundledMarketDataSource(data: localMarketFixture(candleCount: 40)),
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: resultStore,
            offlineReplaySessionStore: sessionStore,
            offlineReplaySessionUptime: { 0 }
        )
        await relaunched.bootstrap()
        precondition(relaunched.offlineReplaySessionCheckpoint?.status == .paused &&
                     relaunched.offlineReplaySessionCheckpoint?.nextCandleIndex == 1 &&
                     relaunched.offlineReplaySessionFrame?.candleIndex == 0,
                     "A clean pause should restore the displayed frame and continue at its next candle.")
        let resumed = await relaunched.resumeOfflineReplaySession()
        let resumedFrame = await relaunched.advanceOfflineReplaySession(marketCode: "KRW-BTC", intervalMinutes: 5)
        precondition(resumed && resumedFrame?.candleIndex == 1,
                     "Resume after a durable pause should continue without duplicating or skipping a candle.")
        _ = await relaunched.pauseOfflineReplaySession()

        guard let pausedCheckpoint = try await sessionStore.loadCheckpoint() else {
            fatalError("The paused session should retain a checkpoint for mismatch verification.")
        }
        let mismatchCheckpointStore = MemoryCoinPilotOfflineReplaySessionStore()
        try await mismatchCheckpointStore.saveCheckpoint(pausedCheckpoint)
        let mismatchedPackStore = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            localMarketDataSource: CoinPilotBundledMarketDataSource(data: localMarketFixture(candleCount: 41)),
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: resultStore,
            offlineReplaySessionStore: mismatchCheckpointStore,
            offlineReplaySessionUptime: { 0 }
        )
        await mismatchedPackStore.bootstrap()
        precondition(mismatchedPackStore.offlineReplaySessionRecoveryMessage != nil &&
                     mismatchedPackStore.offlineReplaySessionCheckpoint == nil,
                     "A checkpoint for another installed dataset must require explicit recovery.")
        let cleared = await mismatchedPackStore.resetOfflineReplaySession()
        let checkpointAfterRecovery = try await mismatchCheckpointStore.loadCheckpoint()
        precondition(cleared && mismatchedPackStore.offlineReplaySessionRecoveryMessage == nil &&
                     checkpointAfterRecovery == nil,
                     "Explicit recovery should clear the mismatched checkpoint before allowing a new start.")

        _ = await relaunched.resetOfflineReplaySession()
        let stopped = try await sessionStore.loadCheckpoint()
        precondition(stopped?.status == .stopped && stopped?.nextCandleIndex == 0,
                     "Reset should return the session to its initial cursor.")
        let networkCalls = await api.networkCallCount()
        let mutationPaths = await api.recordedMutationPaths()
        precondition(networkCalls == 0 && mutationPaths.isEmpty,
                     "Session start, steps, pause, resume, relaunch, mismatch recovery, and reset must stay offline and send no orders.")
    }

    private static func bundledLocalMarketMissingResourceFailsClosed() async throws {
        let api = DeferredCoinPilotAPI(requiresAuth: true)
        let store = CoinPilotStore(
            api: api,
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "bundled-local",
            offlineReplaySessionStore: MemoryCoinPilotOfflineReplaySessionStore()
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
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: MemoryCoinPilotOfflineReplayStore(),
            offlineReplaySessionStore: MemoryCoinPilotOfflineReplaySessionStore()
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
            configuredDataMode: "bundled-local",
            offlineReplayResultStore: MemoryCoinPilotOfflineReplayStore(),
            offlineReplaySessionStore: MemoryCoinPilotOfflineReplaySessionStore()
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

        let replayed = await store.runBundledOfflineReplay(marketCode: "KRW-BTC", intervalMinutes: 5)
        precondition(replayed, "A complete 1,250-candle local series should replay successfully.")
        precondition(store.offlineReplayResult?.metadata.rowCount == totalCandleCount,
                     "Replay must consume all source rows even though the chart shows only the newest 200.")
        precondition(store.offlineReplayResult?.equityCurve.count == totalCandleCount - 16,
                     "Replay's result window must cover the full series after the pinned strategy warmup.")
        precondition(store.candles.count == 200,
                     "Replay must not widen or mutate the chart-facing window.")
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

    private static func localMarketFixture(candleCount: Int = 4, hourlyCandleCount: Int = 0) -> Data {
        if candleCount == 4 && hourlyCandleCount == 0 {
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
        let hourlyCandles: [[String: Any]] = (0..<hourlyCandleCount).map { index in
            let close = 200.0 + Double(index)
            return [
                "intervalMinutes": 60,
                "timestamp": formatter.string(from: start.addingTimeInterval(Double(index) * 3_600)),
                "open": close - 0.5,
                "high": close + 1,
                "low": close - 1,
                "close": close,
                "volume": 10.0
            ]
        }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "source": CoinPilotBundledMarketData.supportedSource,
            "generatedAt": formatter.string(from: start.addingTimeInterval(max(Double(candleCount) * 300, Double(hourlyCandleCount) * 3_600))),
            "markets": [["market": "KRW-BTC", "candles": candles + hourlyCandles]]
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

    private static func candleTimestampsNormalizeAtTheMarketBoundary() throws {
        let expected = "2026-09-29T12:00:00.000Z"
        let fixtures: [[String: Any]] = [
            ["timeUtc": expected],
            ["timeUtc": expected, "time": "2026-09-29T22:00:00"],
            ["time": "2026-09-29T21:00:00"],
            ["time": "2026-09-29T21:00:00+09:00"],
            ["time": expected],
            ["timeUtc": "invalid", "time": "2026-09-29T21:00:00"]
        ]
        for (index, fixture) in fixtures.enumerated() {
            var row = fixture
            row["open"] = 100.0
            row["high"] = 102.0
            row["low"] = 99.0
            row["close"] = 101.0
            row["volume"] = 1.25
            let candle = CoinPilotCandle(row, index: index)
            precondition(candle.time == expected && candle.id == expected,
                         "UTC-only, legacy Upbit KST, and Binance offset times must represent the same candle opening instant.")
            precondition(CoinPilotFormatting.dateTime(candle.time) == CoinPilotFormatting.dateTime(expected),
                         "Every provider's candle must produce the same chart-axis label.")
            precondition(candle.time.map(CoinPilotFormatting.utcMarketTimestamp) == "2026. 09. 29. 12:00:00 UTC",
                         "The OHLCV disclosure must display UTC instead of a missing-time or invalid-format label.")
            precondition(candle.open == 100 && candle.high == 102 && candle.low == 99 &&
                         candle.close == 101 && candle.volume == 1.25,
                         "Timestamp normalization must preserve the source OHLCV values.")
        }
        for invalid: [String: Any] in [[:], ["time": "invalid"], ["timeUtc": NSNull()],
                                       ["timeUtc": "2026-09-29T12:00:00"]] {
            let candle = CoinPilotCandle(invalid, index: 7)
            precondition(candle.time == nil && candle.id == "candle-7",
                         "Missing or malformed times cannot invent a candle opening instant; timeUtc requires its declared zone.")
        }
        precondition(CoinPilotFormatting.dateTime("2026-09-29T21:00:00") == "시각 미제공",
                     "Only the candle legacy boundary may assume KST; unrelated timestamps remain strict.")
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

        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [[
                "coin": "KRW-BTC",
                "price": 60_000_000,
                "sourceAsOf": sourceTime,
                "fetchedAt": recentFetchTime,
                "quoteFresh": false
            ], [
                "coin": "KRW-ETH",
                "price": 3_000_000,
                "sourceAsOf": sourceTime,
                "fetchedAt": recentFetchTime,
                "quoteFresh": true
            ]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            sourceAsOf: sourceTime,
            fetchedAt: recentFetchTime
        ))
        await store.refresh()
        precondition(store.marketQuoteFreshnessIssue(for: "KRW-BTC")?.contains("최신 여부를 확인할 수") == true,
                     "A server freshness=false result must not be shown or treated as current solely because its timestamp is young.")
        precondition(store.manualOrderBlockReason(for: "KRW-BTC")?.contains("최신 여부를 확인할 수") == true,
                     "An explicitly unverified quote must fail closed for its selected order target.")
        precondition(store.manualOrderBlockReason(for: "KRW-ETH") == nil,
                     "A server freshness failure for one market must not block another verified fresh target.")
    }

    private static func lastGoodMarketSnapshotRemainsStaleAndBlocksOrders() async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = Date()
        let sourceTime = formatter.string(from: now.addingTimeInterval(-1))
        let fetchTime = formatter.string(from: now.addingTimeInterval(-2))
        let api = DeferredCoinPilotAPI(
            marketRows: [[
                "coin": "KRW-BTC",
                "price": 60_000_000,
                "sourceAsOf": sourceTime,
                "fetchedAt": fetchTime,
                "quoteFresh": false,
                "quoteFreshnessReason": "market_snapshot_last_good"
            ]],
            requiresAuth: true,
            statusOverride: ["mode": "DRY_RUN", "maxCandleAgeSeconds": 90],
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server")
        store.serverDraft = "https://last-good-market.example"
        store.tokenDraft = "mobile-operator-test-token"
        let signedIn = await store.signIn()
        precondition(signedIn, "The test starts from an order-capable server workspace.")

        await api.setMarketSnapshot(marketSnapshotBody(
            prices: [[
                "coin": "KRW-BTC",
                "price": 60_000_000,
                "sourceAsOf": sourceTime,
                "fetchedAt": fetchTime,
                "quoteFresh": false,
                "quoteFreshnessReason": "market_snapshot_last_good"
            ]],
            complete: true,
            missingMarkets: [],
            marketListStale: false,
            sourceAsOf: sourceTime,
            fetchedAt: fetchTime,
            snapshotSource: "last_good",
            fallbackReason: "ENETDOWN"
        ))
        await store.refresh()

        precondition(!store.state(for: "market-prices").isCurrent,
                     "A last-good fallback must not become a current market snapshot.")
        precondition(store.freshnessLabel(for: "market-prices").contains("저장된 최근 시세"),
                     "The app should explain that it is displaying saved last-good quotes.")
        precondition(store.manualOrderBlockReason(for: "KRW-BTC")?.contains("저장된 최근 시세") == true,
                     "A last-good quote must block the selected-market order action.")

        let submitted = await store.submitManualBuy(coin: "KRW-BTC", amount: 5_000)
        let mutationPaths = await api.recordedMutationPaths()
        precondition(!submitted && mutationPaths.isEmpty,
                     "Last-good display data must never reach an order mutation.")
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
        fetchedAt: Any?,
        snapshotSource: Any? = nil,
        fallbackReason: Any? = nil
    ) -> [String: Any] {
        var body: [String: Any] = [
            "prices": prices,
            "complete": complete,
            "missingMarkets": missingMarkets,
            "marketListStale": marketListStale
        ]
        if let sourceAsOf { body["sourceAsOf"] = sourceAsOf }
        if let fetchedAt { body["fetchedAt"] = fetchedAt }
        if let snapshotSource { body["snapshotSource"] = snapshotSource }
        if let fallbackReason { body["fallbackReason"] = fallbackReason }
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
                     "The setup view may explain missing keys, but only an operating scope may register them.")
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

    private static func fullOperatorScopeGrantsNativeControl() async throws {
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

        await api.setLoginTokenScope("operator")
        let fullScopeUpdateMessage = await store.updateServerToken("full-operator-test-token")
        precondition(fullScopeUpdateMessage == nil,
                     "Replacing with a full operator token should succeed for the owner's app.")
        precondition(tokens.token(for: serverURL) == "full-operator-test-token",
                     "The accepted full token should replace the saved scoped token.")
        precondition(store.phase == .dashboard && store.authenticationScope == .operatorFull && store.canOperate,
                     "The full operator scope should keep the dashboard and grant operation.")

        let controlAfterFull = await store.setAutomationRunning(false)
        precondition(controlAfterFull, "The full operator scope should reach control mutations too.")
        let fullScopeMutations = await api.recordedMutationPaths()
        precondition(fullScopeMutations == ["/api/control/stop", "/api/control/stop"],
                     "The full operator scope should send the same control mutation paths.")

        let restoredTokens = MemoryCoinPilotTokens()
        precondition(restoredTokens.save("legacy-full-operator-token", for: serverURL))
        let restoredStore = CoinPilotStore(api: api, tokens: restoredTokens)
        let restoreConnected = await restoredStore.connect(using: serverURL.absoluteString)
        precondition(restoreConnected && restoredStore.authenticationScope == .operatorFull,
                     "A previously saved full operator token should reconnect and operate.")
        precondition(restoredStore.phase == .dashboard && restoredStore.account != nil && restoredStore.status != nil,
                     "A restored full-scope token should load dashboard data.")
        precondition(restoredStore.canOperate,
                     "The restored full operator scope should grant native operation rights.")
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
        precondition(store.runtimeSafetyMessage?.contains("시세가 끊겨") == true &&
                     store.runtimeSafetyMessage?.contains("위험 감시") == true &&
                     store.runtimeSafetyMessage?.contains("서버의 복구 설정") == true,
                     "The home screen should explain the price interruption, active protection, and server recovery policy.")
    }

    private static func chartAxisAndPositionFormattingStayNullSafe() throws {
        precondition(CoinPilotFormatting.compactWon(123_456_789) == "1.2억원", "차트 축은 억 단위로 줄여야 합니다.")
        precondition(CoinPilotFormatting.compactWon(12_345_000) == "1,235만원", "차트 축은 만 단위로 줄여야 합니다.")
        precondition(CoinPilotFormatting.compactWon(9_900) == "9,900원", "만원 미만은 원 단위를 유지해야 합니다.")
        precondition(CoinPilotFormatting.compactWon(-15_000_000) == "−1,500만원", "음수 금액은 부호를 유지해야 합니다.")
        precondition(CoinPilotFormatting.compactWon(nil) == "금액 미제공", "평가 불가는 0원이 아니라 미제공으로 표시해야 합니다.")
        precondition(CoinPilotFormatting.historyAxisLabel("not-a-date", period: .day) == "시각 미제공", "형식이 다른 시각은 미제공으로 표시해야 합니다.")
        precondition(CoinPilotFormatting.historyAxisLabel("2026-09-29T14:05:00.000Z", period: .month).contains("월"),
                     "주·월 기간 축은 날짜를 표시해야 합니다.")
        precondition(CoinPilotFormatting.shortUtcTimestamp("2026-09-29T14:05:00.000Z") == "09.29 14:05",
                     "캔들 축은 UTC 시각을 그대로 보여야 합니다.")
        precondition(CoinPilotFormatting.shortUtcTimestamp(nil) == "시각 미제공")

        let position = CoinPilotPosition([
            "coin": "KRW-BTC",
            "amount": 0.5,
            "avgPrice": 100_000,
            "currentPrice": 101_000,
            "currentValue": 50_500,
            "costBasis": 50_000,
            "profit": 500,
            "profitPercent": 1.0
        ])
        precondition(position.costBasis == 50_000, "계좌 응답의 매입 금액이 포지션 모델에 도달해야 합니다.")
        precondition(position.entryPrice == 100_000)
    }

    private static func percentFormattingPreservesSmallChanges() throws {
        let smallLossPercent = -5.0 / 1_000_000 * 100
        precondition(CoinPilotFormatting.percent(smallLossPercent) == "-0.0005%",
                     "A real five-won loss on one million won must not appear as -0%.")
        precondition(CoinPilotFormatting.percent(0.0005) == "+0.0005%")
        precondition(CoinPilotFormatting.percent(0.0005, signed: false) == "0.0005%")
        precondition(CoinPilotFormatting.percent(-0.0001) == "-0.0001%")
        precondition(CoinPilotFormatting.percent(0.0099) == "+0.0099%")
        precondition(CoinPilotFormatting.percent(-0.00000001) == "0.0001% 미만 하락")
        precondition(CoinPilotFormatting.percent(0.00000001) == "0.0001% 미만 상승")
        precondition(CoinPilotFormatting.percent(0.00000001, signed: false) == "0.0001% 미만")
        precondition(CoinPilotFormatting.percent(0) == "0%" && CoinPilotFormatting.percent(-0.0) == "0%",
                     "Exact zero must stay neutral, including an IEEE negative zero.")
        precondition(CoinPilotFormatting.percent(-1.234) == "-1.23%" &&
                     CoinPilotFormatting.percent(1.234) == "+1.23%",
                     "Ordinary percentages must retain the compact two-digit format.")
        precondition(CoinPilotFormatting.percent(nil) == "변동률 미제공" &&
                     CoinPilotFormatting.percent(.nan) == "변동률 미제공" &&
                     CoinPilotFormatting.percent(.infinity, unavailable: "비중 미제공") == "비중 미제공",
                     "Unavailable and nonfinite values must not become zero or a tiny-change label.")
    }

    private static func withCleanConnectionDefaults(_ operation: () async throws -> Void) async rethrows {
        let defaults = UserDefaults.standard
        let keys = [
            "coinpilot.dashboardUrl", "coinpilot.dashboardUrl.paper", "coinpilot.dashboardUrl.live",
            "coinpilot.native.activeWorkspace", "coinpilot.native.dataMode",
            "coinpilot.native.dataMode.profile.server", "coinpilot.native.dataMode.profile.bundled-preview",
            "coinpilot.native.dataMode.profile.bundled-local"
        ]
        let previousValues = keys.map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in previousValues {
                if let value { defaults.set(value, forKey: key) }
                else { defaults.removeObject(forKey: key) }
            }
        }
        for key in keys { defaults.removeObject(forKey: key) }
        try await operation()
    }

    private static func waitForWorkspaceConnection(_ store: CoinPilotStore) async {
        for _ in 0..<2_000 {
            if !store.isWorking && store.phase != .connecting { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        preconditionFailure("The fixture workspace connection did not finish.")
    }

    private static func managedServersOpenBothWorkspacesWithoutAddressEntry() async throws {
        await withCleanConnectionDefaults {
            let paper = URL(string: "https://managed.example")!
            let live = URL(string: "https://managed.example/live")!
            let config = CoinPilotBundledServerConfig(paper: paper, live: live)
            for mode in CoinPilotWorkspaceMode.allCases {
                UserDefaults.standard.set(mode.rawValue, forKey: "coinpilot.native.activeWorkspace")
                let api = DeferredCoinPilotAPI(isReadOnlyObserver: false, serverModesByAddress: [
                    paper.absoluteString: "DRY_RUN", live.absoluteString: "LIVE"
                ])
                let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server", bundledServers: config)
                await store.bootstrap()
                precondition(store.usesManagedServerConnection && store.phase == .dashboard && store.serverModeMatchesWorkspace && store.canOperate,
                             "A fresh managed install must automatically open its matching Paper or LIVE account.")
                let urls = await api.recordedAuthenticationURLs()
                precondition(urls == [config.url(for: mode)!.absoluteString] && store.serverDraft == urls.first,
                             "Bootstrap must route to the configured URL for the selected account.")
                let ignoredCustomAddress = await store.connect(using: "https://untrusted.example")
                precondition(ignoredCustomAddress && store.serverDraft == config.url(for: mode)!.absoluteString,
                             "Managed reconnect must remain on the fixed endpoint even if an old custom draft survives.")
            }
            for key in ["coinpilot.dashboardUrl", "coinpilot.dashboardUrl.paper", "coinpilot.dashboardUrl.live", "coinpilot.native.activeWorkspace"] {
                UserDefaults.standard.removeObject(forKey: key)
            }
            let generic = CoinPilotStore(api: DeferredCoinPilotAPI(), tokens: MemoryCoinPilotTokens(), configuredDataMode: "server", bundledServers: .none)
            await generic.bootstrap()
            precondition(!generic.usesManagedServerConnection && generic.phase == .setup,
                         "A generic developer build without configured endpoints must retain manual setup.")
        }
    }

    private static func managedServerMigrationKeepsBuildProfilesIsolated() async throws {
        try await withCleanConnectionDefaults {
            let paper = URL(string: "https://migration.example")!
            let live = URL(string: "https://migration.example/live")!
            let config = CoinPilotBundledServerConfig(paper: paper, live: live)
            let defaults = UserDefaults.standard
            defaults.set("https://old-live.example", forKey: "coinpilot.dashboardUrl")
            defaults.set("https://old-paper.example", forKey: "coinpilot.dashboardUrl.paper")
            defaults.set("https://old-live.example", forKey: "coinpilot.dashboardUrl.live")
            defaults.set("bundled-preview", forKey: "coinpilot.native.dataMode.profile.server")
            let api = DeferredCoinPilotAPI(isReadOnlyObserver: false)
            let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server", bundledServers: config)
            await store.bootstrap()
            precondition(store.activeWorkspace == .paper && store.serverDraft == paper.absoluteString && !store.isBundledPreview && !store.canUseBundledPreview,
                         "Old legacy addresses and preview preferences must not redirect a managed server build.")
            precondition(defaults.string(forKey: "coinpilot.dashboardUrl.paper") == paper.absoluteString &&
                         defaults.string(forKey: "coinpilot.dashboardUrl.live") == live.absoluteString,
                         "Both stale workspace addresses must migrate to the configured endpoints.")
            store.useBundledPreview()
            precondition(!store.isBundledPreview, "A managed account build must keep its account connection after a stale preview action.")
            let previewAPI = DeferredCoinPilotAPI()
            let preview = CoinPilotStore(api: previewAPI, tokens: MemoryCoinPilotTokens(), bundledPreview: CoinPilotBundledPreviewDataSource(data: try Data(contentsOf: URL(fileURLWithPath: "ios/App/App/CoinPilotBundledPreview.json"))), configuredDataMode: "bundled-preview", bundledServers: config)
            await preview.bootstrap()
            let previewCalls = await previewAPI.networkCallCount()
            precondition(preview.isBundledPreview && !preview.usesManagedServerConnection && previewCalls == 0,
                         "A separate preview build must remain offline even when server defaults are present.")
            let localAPI = DeferredCoinPilotAPI()
            let local = CoinPilotStore(api: localAPI, tokens: MemoryCoinPilotTokens(), configuredDataMode: "bundled-local", bundledServers: config)
            await local.bootstrap()
            let localCalls = await localAPI.networkCallCount()
            precondition(local.isBundledLocalMarketData && !local.usesManagedServerConnection && localCalls == 0,
                         "A local market-data build must never bootstrap a managed account connection.")
        }
    }

    private static func managedLoginVerifiesSameOriginWorkspaceToken() async throws {
        await withCleanConnectionDefaults {
            let paper = URL(string: "https://shared-auth.example")!
            let live = URL(string: "https://shared-auth.example/live")!
            let config = CoinPilotBundledServerConfig(paper: paper, live: live)
            let tokens = MemoryCoinPilotTokens()
            let api = DeferredCoinPilotAPI(requiresAuth: true, loginTokenScope: "mobile_operator", isReadOnlyObserver: false,
                serverModesByAddress: [paper.absoluteString: "DRY_RUN", live.absoluteString: "LIVE"])
            let store = CoinPilotStore(api: api, tokens: tokens, configuredDataMode: "server", bundledServers: config)
            await store.bootstrap()
            precondition(store.usesManagedServerConnection && store.phase == .login && !store.canOperate && store.account == nil,
                         "Fresh protected installs must require token login while using their configured server automatically.")
            store.serverDraft = "https://untrusted.example"
            store.tokenDraft = "shared-mobile-test-token"
            let signedIn = await store.signIn()
            precondition(signedIn && tokens.token(for: paper) == "shared-mobile-test-token" && store.serverDraft == paper.absoluteString,
                         "A managed login must use the bundled endpoint and save only the verified server token.")
            await api.setLoginTokenScope("read_only")
            store.selectWorkspace(.live)
            await waitForWorkspaceConnection(store)
            precondition(store.phase == .dashboard && store.activeWorkspace == .live && store.serverModeMatchesWorkspace && !store.canOperate,
                         "Automatic LIVE auth must respect the scope returned by that server rather than copying Paper privileges.")
            let loginURLs = await api.recordedLoginURLs()
            precondition(loginURLs == [paper.absoluteString, live.absoluteString] && tokens.token(for: live) == "shared-mobile-test-token",
                         "A same-origin peer token must be validated with LIVE login before it is stored for that endpoint.")
            let mutations = await api.recordedMutationPaths()
            precondition(mutations.isEmpty, "Automatic account connection must never send an order or start trading.")
        }
    }

    private static func managedTokenReuseNeverLeaksAcrossOrigins() async throws {
        await withCleanConnectionDefaults {
            let paper = URL(string: "https://private-auth.example")!
            for live in [URL(string: "https://other-auth.example/live")!, URL(string: "https://private-auth.example:8443/live")!] {
                let tokens = MemoryCoinPilotTokens()
                precondition(tokens.save("private-mobile-test-token", for: paper))
                UserDefaults.standard.set("live", forKey: "coinpilot.native.activeWorkspace")
                let api = DeferredCoinPilotAPI(requiresAuth: true, loginTokenScope: "mobile_operator", isReadOnlyObserver: false)
                let store = CoinPilotStore(api: api, tokens: tokens, configuredDataMode: "server",
                    bundledServers: CoinPilotBundledServerConfig(paper: paper, live: live))
                await store.bootstrap()
                let attemptedTokens = await api.recordedLoginTokens()
                precondition(store.phase == .login && attemptedTokens.isEmpty && tokens.token(for: live) == nil,
                             "Peer token reuse must never send credentials to a different managed host or port.")
            }
        }
    }

    private static func managedServerMismatchKeepsPrivateDataAndOrdersLocked() async throws {
        await withCleanConnectionDefaults {
            let paper = URL(string: "https://mismatch.example")!
            let live = URL(string: "https://mismatch.example/live")!
            UserDefaults.standard.set("live", forKey: "coinpilot.native.activeWorkspace")
            let api = DeferredCoinPilotAPI(isReadOnlyObserver: false)
            let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server",
                bundledServers: CoinPilotBundledServerConfig(paper: paper, live: live))
            await store.bootstrap()
            let paths = await api.recordedReadPaths()
            precondition(!store.serverModeMatchesWorkspace && store.account == nil && !store.canOperate &&
                         !paths.contains("/api/account") && store.workspaceModeMismatchMessage != nil,
                         "A fixed LIVE endpoint reporting DRY_RUN must stay locked before any private account data is loaded.")
            let ordered = await store.submitManualBuy(coin: "KRW-BTC", amount: 10_000)
            let mutations = await api.recordedMutationPaths()
            precondition(!ordered && mutations.isEmpty, "Automatic routing must not weaken the server-mode order gate.")
        }
    }

    private static func managedServerRetryPreservesAuthenticationAndPendingOrders() async throws {
        try await withCleanConnectionDefaults {
            let paper = URL(string: "https://retry.example")!
            let live = URL(string: "https://retry.example/live")!
            let tokens = MemoryCoinPilotTokens()
            precondition(tokens.save("expired-test-token", for: paper))
            let pending = CoinPilotMemoryPendingOrderStore()
            let order = CoinPilotPendingManualOrder(idempotencyKey: UUID().uuidString, endpoint: "/api/trade/buy", requestBody: Data("{}".utf8),
                market: "KRW-BTC", side: "BUY", displayAmount: "10,000원", mode: "DRY_RUN", createdAt: Date())
            let encodedOrder = try JSONEncoder().encode(order)
            precondition(pending.save(encodedOrder, for: paper))
            let api = DeferredCoinPilotAPI(requiresAuth: true, loginTokenScope: "mobile_operator", isReadOnlyObserver: false)
            await api.setRejectedLoginTokens(["expired-test-token"])
            await api.setAuthenticationUnavailable(true)
            let store = CoinPilotStore(api: api, tokens: tokens, configuredDataMode: "server", pendingOrderStore: pending,
                bundledServers: CoinPilotBundledServerConfig(paper: paper, live: live, token: "personal-bundled-test-token"))
            await store.bootstrap()
            precondition(store.phase == .connecting && !store.isWorking && store.connectionMessage != nil && store.pendingManualOrder == order && store.pendingManualOrderLocked,
                         "An unavailable managed server must expose retry without losing pending order recovery.")
            precondition(tokens.token(for: paper) == "expired-test-token", "A network failure must not erase saved authentication.")
            await api.setAuthenticationUnavailable(false)
            store.serverDraft = "https://untrusted.example"
            await store.primaryConnectionAction()
            let attemptedTokens = await api.recordedLoginTokens()
            precondition(store.phase == .dashboard && !store.isWorking && attemptedTokens == ["expired-test-token", "personal-bundled-test-token"] &&
                         tokens.token(for: paper) == "personal-bundled-test-token" && store.pendingManualOrder == order && store.pendingManualOrderLocked,
                         "Retry must stay on the configured endpoint, validate a fallback token, and retain pending order locks.")
            store.logOut()
            precondition(store.phase == .dashboard && tokens.token(for: paper) == "personal-bundled-test-token" && store.pendingManualOrder == order,
                         "A stale logout action must not drop a managed install into manual setup or clear its journal.")
            await api.setReadResponse(path: "/api/status", body: ["error": "expired token"], statusCode: 401)
            await store.refresh()
            precondition(store.phase == .login && !store.isWorking && !store.canOperate && store.pendingManualOrder == order && store.pendingManualOrderLocked,
                         "Expired authentication must safely permit a new token login without losing the pending order record.")
            await api.clearReadResponse(path: "/api/status")
            store.tokenDraft = "replacement-mobile-test-token"
            await store.primaryConnectionAction()
            precondition(store.phase == .dashboard && store.pendingManualOrder == order && store.pendingManualOrderLocked &&
                         tokens.token(for: paper) == "replacement-mobile-test-token",
                         "A replacement login must reconnect automatically while unresolved orders remain locked.")
            let mutations = await api.recordedMutationPaths()
            precondition(mutations.isEmpty, "Connection recovery must not resubmit an unresolved order.")
        }
    }

    private static func managedAccountAuthenticationExpiryAllowsRelogin() async throws {
        try await withCleanConnectionDefaults {
            let paper = URL(string: "https://account-expiry.example")!
            let live = URL(string: "https://account-expiry.example/live")!
            let tokens = MemoryCoinPilotTokens()
            precondition(tokens.save("account-expired-test-token", for: paper))
            let pending = CoinPilotMemoryPendingOrderStore()
            let order = CoinPilotPendingManualOrder(idempotencyKey: UUID().uuidString, endpoint: "/api/trade/buy", requestBody: Data("{}".utf8),
                market: "KRW-BTC", side: "BUY", displayAmount: "10,000원", mode: "DRY_RUN", createdAt: Date())
            let encodedOrder = try JSONEncoder().encode(order)
            precondition(pending.save(encodedOrder, for: paper))
            let api = DeferredCoinPilotAPI(requiresAuth: true, loginTokenScope: "mobile_operator", isReadOnlyObserver: false)
            await api.setReadResponse(path: "/api/account", body: ["error": "expired token"], statusCode: 401)
            let store = CoinPilotStore(api: api, tokens: tokens, configuredDataMode: "server", pendingOrderStore: pending,
                bundledServers: CoinPilotBundledServerConfig(paper: paper, live: live))
            await store.bootstrap()
            let paths = await api.recordedReadPaths()
            precondition(paths.contains("/api/status") && paths.contains("/api/account") && store.phase == .login &&
                         !store.isWorking && !store.isRefreshing && !store.canOperate && store.account == nil &&
                         store.pendingManualOrder == order && store.pendingManualOrderLocked,
                         "An account 401 after successful status must unlock login controls and preserve pending order recovery.")
            await api.clearReadResponse(path: "/api/account")
            store.tokenDraft = "account-replacement-test-token"
            await store.primaryConnectionAction()
            precondition(store.phase == .dashboard && !store.isWorking && !store.isRefreshing && store.account != nil &&
                         tokens.token(for: paper) == "account-replacement-test-token" && store.pendingManualOrder == order && store.pendingManualOrderLocked,
                         "Token-only relogin must recover from a post-status 401 without resubmitting or clearing unresolved orders.")
            let mutations = await api.recordedMutationPaths()
            precondition(mutations.isEmpty, "Authentication recovery must not execute a pending order.")
        }
    }

    private static func managedWorkspaceSwitchDiscardsQueuedConnections() async throws {
        await withCleanConnectionDefaults {
            let paper = URL(string: "https://queued.example")!
            let live = URL(string: "https://queued.example/live")!
            let api = DeferredCoinPilotAPI(isReadOnlyObserver: false, serverModesByAddress: [paper.absoluteString: "DRY_RUN", live.absoluteString: "LIVE"])
            let store = CoinPilotStore(api: api, tokens: MemoryCoinPilotTokens(), configuredDataMode: "server",
                bundledServers: CoinPilotBundledServerConfig(paper: paper, live: live))
            await store.bootstrap()
            store.selectWorkspace(.live)
            store.selectWorkspace(.paper)
            await store.primaryConnectionAction()
            await Task.yield()
            let urls = await api.recordedAuthenticationURLs()
            precondition(store.activeWorkspace == .paper && store.phase == .dashboard && store.serverModeMatchesWorkspace && store.serverDraft == paper.absoluteString &&
                         urls.allSatisfy { $0 == paper.absoluteString },
                         "Rapid account switches must discard obsolete queued connections before they contact another workspace.")
        }
    }

    private static func bundledServerDefaultsConnectAndOperateWithoutAuth() async throws {
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

        // LocalSecrets.json 값이 plist 기본값보다 우선하고, 무효한 항목은 plist로 폴백한다.
        let merged = CoinPilotBundledServerConfig.resolve(
            secrets: ["paper": "http://192.168.0.10:3000", "token": " secrets-token "],
            plist: ["paper": "http://192.168.0.20:3000", "live": "https://live.example.com", "token": "plist-token"]
        )
        precondition(merged.paper?.absoluteString == "http://192.168.0.10:3000",
                     "secrets paper address should win over the plist default.")
        precondition(merged.live?.absoluteString == "https://live.example.com",
                     "plist live address should be used when secrets omit it.")
        precondition(merged.token == "secrets-token",
                     "secrets token should win and be trimmed.")
        let fallback = CoinPilotBundledServerConfig.resolve(
            secrets: ["paper": "not-a-url"],
            plist: ["paper": "http://192.168.0.20:3000"]
        )
        precondition(fallback.paper?.absoluteString == "http://192.168.0.20:3000",
                     "An invalid secrets address should fall back to the plist value.")
        precondition(CoinPilotBundledServerConfig.resolve(secrets: nil, plist: nil).token == nil,
                     "Empty sources should produce no bundled token.")

        // paperServers/liveServers 프리셋 목록 — 거래소별 서버 선택 UI용.
        let withPresets = CoinPilotBundledServerConfig.resolve(
            secrets: [
                "paper": "http://192.168.0.10:3000",
                "paperServers": [
                    ["label": "업비트 모의", "url": "http://192.168.0.10:3000"],
                    ["label": "바이낸스 모의", "url": "http://192.168.0.10:3002"],
                    ["label": "잘못된 주소", "url": "not-a-url"]
                ],
                "liveServers": [["label": "업비트 실전", "url": "http://192.168.0.10:3001"]]
            ],
            plist: nil
        )
        precondition(withPresets.paperPresets.count == 2 &&
                     withPresets.paperPresets[1].label == "바이낸스 모의" &&
                     withPresets.paperPresets[1].url.absoluteString == "http://192.168.0.10:3002",
                     "Preset list should keep valid label/url pairs and drop invalid URLs.")
        precondition(withPresets.livePresets.first?.label == "업비트 실전",
                     "Live presets should parse independently.")
        let presetFallback = CoinPilotBundledServerConfig.resolve(
            secrets: ["live": "https://live.example.com"], plist: nil
        )
        precondition(presetFallback.livePresets.first?.url.absoluteString == "https://live.example.com",
                     "A bundled address with no preset list should synthesize a one-item preset.")

        // Bundled address + bundled token must connect and sign in with no manual entry.
        let bundledURL = URL(string: "https://bundled-paper.example")!
        let bundledAPI = DeferredCoinPilotAPI(
            requiresAuth: true,
            loginTokenScope: "mobile_operator",
            isReadOnlyObserver: false
        )
        let bundledTokens = MemoryCoinPilotTokens()
        let bundledStore = CoinPilotStore(
            api: bundledAPI,
            tokens: bundledTokens,
            configuredDataMode: "server",
            bundledServers: CoinPilotBundledServerConfig(
                paper: bundledURL,
                live: nil,
                token: "bundled-operator-token"
            )
        )
        await bundledStore.bootstrap()
        precondition(bundledStore.serverDraft == bundledURL.absoluteString,
                     "The bundled address should become the active server URL.")
        precondition(bundledStore.phase == .dashboard && bundledStore.canOperate,
                     "Bundled address and token should open the dashboard without manual entry.")
        precondition(bundledTokens.token(for: bundledURL) == "bundled-operator-token",
                     "The bundled token should persist to the per-server store after login.")

        // A private server with dashboard auth disabled must stay fully operable
        // without any token at all.
        let openAPI = DeferredCoinPilotAPI(
            requiresAuth: false,
            statusOverride: ["isRunning": false],
            isReadOnlyObserver: false
        )
        let openStore = CoinPilotStore(
            api: openAPI,
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "server"
        )
        let openConnected = await openStore.connect(using: "https://open-lan.example")
        precondition(openConnected && openStore.canOperate,
                     "An unauthenticated private server should be fully operable.")
        let tuned = await openStore.saveTuning(["rsiOversold": 30])
        precondition(tuned, "A no-auth server should accept tuning saves without a token.")
        let automationStarted = await openStore.setAutomationRunning(true)
        precondition(automationStarted, "A no-auth server should accept the automation start request.")
        let openMutations = await openAPI.recordedMutationPaths()
        precondition(openMutations == ["/api/config/update", "/api/control/start"],
                     "No-auth mutations should reach the config and control endpoints.")

        // A saved-address workspace still wins over the bundled default.
        defaults.set("https://saved-paper.example", forKey: "coinpilot.dashboardUrl.paper")
        let savedStore = CoinPilotStore(
            api: DeferredCoinPilotAPI(requiresAuth: false, isReadOnlyObserver: false),
            tokens: MemoryCoinPilotTokens(),
            configuredDataMode: "server",
            bundledServers: CoinPilotBundledServerConfig(
                paper: bundledURL,
                live: nil,
                token: nil
            )
        )
        precondition(savedStore.serverDraft == "https://saved-paper.example",
                     "A saved server address must take precedence over the bundled default.")
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
