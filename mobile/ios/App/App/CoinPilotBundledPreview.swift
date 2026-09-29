import Foundation

struct CoinPilotBundledPreviewDataSource {
    private let payload: [String: Any]?

    init(bundle: Bundle = .main) {
        guard let url = bundle.url(forResource: "CoinPilotBundledPreview", withExtension: "json"),
              let data = try? Data(contentsOf: url) else {
            payload = nil
            return
        }
        payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    init(data: Data) {
        payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    var isAvailable: Bool { payload != nil }

    var generatedAt: Date? {
        guard let value = payload?["generatedAt"] as? String else { return nil }
        return ISO8601DateFormatter().date(from: value)
    }

    func response(for rawPath: String) throws -> CoinPilotHTTPResponse {
        guard let payload,
              let components = URLComponents(string: "https://coinpilot.invalid\(rawPath)"),
              components.host == "coinpilot.invalid",
              components.fragment == nil else {
            throw CoinPilotAPIError.invalidData
        }

        let value: Any
        switch components.path {
        case "/api/status":
            value = try requiredValue("status")
        case "/api/account":
            value = try requiredValue("account")
        case "/api/cumulative-pnl":
            value = try requiredValue("cumulativePnl")
        case "/api/today-summary":
            value = try requiredValue("todaySummary")
        case "/api/portfolio/history":
            guard let period = components.queryItems?.first(where: { $0.name == "period" })?.value,
                  let histories = payload["history"] as? [String: Any],
                  var historyResponse = histories[period] as? [String: Any],
                  let history = historyResponse["data"] as? [[String: Any]] else {
                throw CoinPilotAPIError.invalidData
            }
            historyResponse["data"] = history.map { row in
                var example = row
                example["valuationStatus"] = "example"
                example["valuationSource"] = "bundled-preview"
                if example["valuationAsOf"] == nil {
                    example["valuationAsOf"] = example["timestamp"]
                }
                return example
            }
            value = historyResponse
        case "/api/market/prices/snapshot":
            guard let prices = try requiredValue("marketPrices") as? [[String: Any]],
                  !prices.isEmpty else {
                throw CoinPilotAPIError.invalidData
            }
            let fetchedAtValues = prices.compactMap { $0["fetchedAt"] as? String }
            guard fetchedAtValues.count == prices.count,
                  Set(fetchedAtValues).count == 1,
                  let fetchedAt = fetchedAtValues.first else {
                throw CoinPilotAPIError.invalidData
            }
            let sourceAsOf: Any = prices.compactMap { $0["sourceAsOf"] as? String }.sorted().first ?? NSNull()
            value = [
                "prices": prices,
                "complete": true,
                "missingMarkets": [String](),
                "marketListStale": false,
                "sourceAsOf": sourceAsOf,
                "fetchedAt": fetchedAt
            ]
        case "/api/market/prices":
            value = try requiredValue("marketPrices")
        case "/api/paper-validation/summary":
            value = try requiredValue("paperValidationSummary")
        case "/api/trades":
            guard let trades = payload["trades"] as? [Any] else { throw CoinPilotAPIError.invalidData }
            let limit = Int(components.queryItems?.first(where: { $0.name == "limit" })?.value ?? "30") ?? 30
            value = Array(trades.prefix(max(1, min(limit, 50))))
        default:
            throw CoinPilotAPIError.forbidden
        }

        guard JSONSerialization.isValidJSONObject(value) else { throw CoinPilotAPIError.invalidData }
        return CoinPilotHTTPResponse(
            statusCode: 200,
            headers: ["Content-Type": "application/json"],
            body: try JSONSerialization.data(withJSONObject: value)
        )
    }

    private func requiredValue(_ key: String) throws -> Any {
        guard let value = payload?[key] else { throw CoinPilotAPIError.invalidData }
        return value
    }
}
