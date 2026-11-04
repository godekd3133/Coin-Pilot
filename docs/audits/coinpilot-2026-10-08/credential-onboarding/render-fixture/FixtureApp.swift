import SwiftUI
import Foundation

final class CredentialViewAPI: CoinPilotAPIProviding {
    private func response(_ body: [String: Any]) throws -> CoinPilotHTTPResponse {
        CoinPilotHTTPResponse(statusCode: 200, headers: [:], body: try JSONSerialization.data(withJSONObject: body))
    }
    func authenticationStatus(at serverURL: URL) async throws -> CoinPilotHTTPResponse {
        try response(["authRequired": false, "exchange": "upbit", "quoteCurrency": "KRW"])
    }
    func login(token: String, at serverURL: URL) async throws -> CoinPilotHTTPResponse { throw CoinPilotAPIError.forbidden }
    func read(path: String, at serverURL: URL, token: String?) async throws -> CoinPilotHTTPResponse {
        if path == "/api/status" { return try response(["mode": "LIVE", "isRunning": false, "exchange": "upbit", "quoteCurrency": "KRW", "upbitCredentialsConfigured": false, "exchangeStateKnown": false]) }
        if path == "/api/account" { return try response(["mode": "LIVE", "positions": [], "valuationAvailable": false, "readOnlyObserver": false]) }
        if path == "/api/market/prices/snapshot" {
            let stamp = ISO8601DateFormatter().string(from: Date())
            return try response(["prices": [], "complete": true, "missingMarkets": [],
                "marketListStale": false, "snapshotSource": "current", "sourceAsOf": stamp, "fetchedAt": stamp])
        }
        return try response(["data": [], "prices": [], "trades": []])
    }
}

@main
struct CredentialFixtureApp: App {
    init() { UserDefaults.standard.set("live", forKey: "coinpilot.native.activeWorkspace") }
    var body: some Scene {
        Window("CoinPilot HTTPS form QA", id: "credential-fixture") {
            CoinPilotNativeRootView().frame(minWidth: 880, minHeight: 640)
        }.defaultSize(width: 1000, height: 760)
    }
}
