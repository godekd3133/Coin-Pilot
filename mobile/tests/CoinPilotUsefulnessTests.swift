import Foundation

@main
struct CoinPilotUsefulnessTests {
    static func main() {
        tradePeriodsRespectLocalCalendarBoundaries()
        completedTradeUsesItsExitDate()
        holdingsTotalRequiresEveryValuation()
        tradeAmountsRespectTheirUnits()
        tuningEditsPreserveUnchangedValues()
        print("CoinPilotUsefulness: 5 scenarios passed")
    }

    private static func tradePeriodsRespectLocalCalendarBoundaries() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Seoul")!
        let now = CoinPilotMarketSnapshotMetadata.parseDate("2026-10-05T03:00:00.000Z")!
        precondition(CoinPilotTradePeriod.today.includes("2026-10-04T15:00:00.000Z", at: now, calendar: calendar),
                     "Today must start at local midnight, not UTC midnight.")
        precondition(!CoinPilotTradePeriod.today.includes("2026-10-04T14:59:59.999Z", at: now, calendar: calendar))
        precondition(CoinPilotTradePeriod.week.includes("2026-09-28T15:00:00.000Z", at: now, calendar: calendar),
                     "Seven days includes today and the preceding six local calendar days.")
        precondition(!CoinPilotTradePeriod.week.includes("2026-09-28T14:59:59.999Z", at: now, calendar: calendar))
        precondition(CoinPilotTradePeriod.month.includes("2026-09-05T15:00:00.000Z", at: now, calendar: calendar))
        precondition(!CoinPilotTradePeriod.month.includes("2026-09-05T14:59:59.999Z", at: now, calendar: calendar))
        for period in [CoinPilotTradePeriod.today, .week, .month] {
            precondition(!period.includes(nil, at: now, calendar: calendar))
            precondition(!period.includes("not-a-date", at: now, calendar: calendar))
            precondition(!period.includes("2026-10-05T03:00:00.001Z", at: now, calendar: calendar))
        }
        precondition(CoinPilotTradePeriod.all.includes(nil, at: now, calendar: calendar),
                     "All loaded trades must preserve records whose timestamp is unknown.")
    }

    private static func completedTradeUsesItsExitDate() {
        let entry = "2026-10-04T14:59:00.000Z"
        let exit = "2026-10-04T15:01:00.000Z"
        for type in ["CLOSE", "PARTIAL_CLOSE", "SELL"] {
            let trade = CoinPilotTrade(["type": type, "coin": "KRW-BTC", "entryTime": entry, "exitTime": exit], index: 0)
            precondition(trade.action == "매도" && trade.timestamp == exit,
                         "Sell filters must use the sale's exit time, including partial closes across midnight.")
            precondition(trade.profit == nil, "Missing realized PnL must not become zero.")
        }
        let buy = CoinPilotTrade(["type": "OPEN", "entryTime": entry, "exitTime": exit], index: 0)
        precondition(buy.timestamp == entry)
        let explicit = CoinPilotTrade(["type": "CLOSE", "timestamp": exit, "entryTime": entry], index: 0)
        precondition(explicit.timestamp == exit)
    }

    private static func tuningEditsPreserveUnchangedValues() {
        let ratio = CoinPilotTuningField(key: "investmentRatio", label: "비율", description: "", category: "Investment", value: 0.03,
            booleanValue: nil, minimum: 0.01, maximum: 1, step: 0.01, displayMultiplier: 100)
        let period = CoinPilotTuningField(key: "rsiPeriod", label: "RSI 기간", description: "", category: "RSI", value: 21,
            booleanValue: nil, minimum: 2, maximum: 100, step: 1, displayMultiplier: 1)
        let changes = try! CoinPilotTuningEdits.changes(fields: [ratio, period], numeric: ["investmentRatio": "4", "rsiPeriod": "21"], boolean: [:])
        precondition(changes.count == 1 && changes["investmentRatio"] as? Double == 0.04,
                     "Editing one displayed percentage must not rewrite unrelated hidden fields.")
        let unchanged = try! CoinPilotTuningEdits.changes(fields: [ratio], numeric: ["investmentRatio": "3.0"], boolean: [:])
        precondition(unchanged.isEmpty, "Equivalent formatting is not a configuration change.")
        let unrelated = CoinPilotTuningField(key: "maxEntriesPerSignalWindow", label: "최대 진입 횟수", description: "", category: "Risk", value: 0,
            booleanValue: nil, minimum: 0, maximum: 20, step: 1, displayMultiplier: 1)
        precondition(CoinPilotTuningEdits.matches(period, query: "RSI") && !CoinPilotTuningEdits.matches(unrelated, query: "RSI"),
                     "Acronym search must not combine letters across unrelated camel-case words.")
        for invalid in ["nan", "inf", "bad", "101"] {
            do {
                _ = try CoinPilotTuningEdits.changes(fields: [ratio], numeric: ["investmentRatio": invalid], boolean: [:])
                preconditionFailure("Invalid and out-of-range edits must not be sent.")
            } catch { }
        }
    }

    private static func tradeAmountsRespectTheirUnits() {
        let strategy = CoinPilotTrade(["coin": "KRW-BTC", "action": "OPEN", "type": "BUY",
            "entryPrice": 100_000_000, "amount": 0.0009995, "source": "strategy"], index: 0)
        precondition(strategy.quantity == 0.0009995 && strategy.amount == nil,
                     "A strategy's coin quantity must never be formatted as quote currency.")
        let smart = CoinPilotTrade(["type": "BUY", "amount": 100_000, "volume": 0.0009995, "source": "smart-buy"], index: 0)
        precondition(smart.amount == 100_000 && smart.quantity == 0.0009995,
                     "Smart-order quote amount and coin quantity must remain distinct.")
        let unknown = CoinPilotTrade(["type": "BUY", "amount": 0.1], index: 0)
        precondition(unknown.amount == nil && unknown.quantity == nil,
                     "An amount with unclassified units cannot become money or coin quantity.")
        let explicit = CoinPilotTrade(["type": "SELL", "value": 50_000, "quantity": 0.001, "profit": 0], index: 0)
        precondition(explicit.amount == 50_000 && explicit.quantity == 0.001 && explicit.profit == 0)
        for invalid in [true as Any, Double.nan, Double.infinity, "nan", "inf", NSNull()] {
            let trade = CoinPilotTrade(["value": invalid, "quantity": invalid, "profit": invalid], index: 0)
            precondition(trade.amount == nil && trade.quantity == nil && trade.profit == nil,
                         "Invalid numeric records must not be displayed as a monetary result.")
        }
    }

    private static func holdingsTotalRequiresEveryValuation() {
        let complete = CoinPilotAccount(["positions": [["currentValue": 100.0], ["currentValue": 250.0]]])
        precondition(complete.completePositionsValue == 350 && complete.unvaluedPositionCount == 0)
        for missing in [NSNull() as Any, -1.0, Double.nan, Double.infinity] {
            let partial = CoinPilotAccount(["positions": [["currentValue": 100.0], ["currentValue": missing]]])
            precondition(partial.completePositionsValue == nil && partial.unvaluedPositionCount == 1,
                         "A partial, invalid, or negative valuation must not appear as the holdings total.")
        }
        let unavailable = CoinPilotAccount(["valuationAvailable": false, "positions": [["currentValue": 100.0]]])
        precondition(unavailable.completePositionsValue == nil, "The server's unavailable valuation state remains authoritative.")
        let stalePosition = CoinPilotAccount(["positions": [["currentValue": 100.0, "valuationAvailable": false]]])
        precondition(stalePosition.completePositionsValue == nil && stalePosition.unvaluedPositionCount == 1,
                     "An unavailable position must not contribute a retained price to the current holdings total.")
        precondition(CoinPilotAccount([:]).completePositionsValue == nil, "Absent positions must not appear as an empty account.")
        precondition(CoinPilotAccount(["positions": []]).completePositionsValue == 0,
                     "An explicitly empty holdings list has zero holdings value.")
    }
}
