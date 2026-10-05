import Foundation

@main
struct CoinPilotUsefulnessTests {
    static func main() {
        tradePeriodsRespectLocalCalendarBoundaries()
        completedTradeUsesItsExitDate()
        holdingsTotalRequiresEveryValuation()
        print("CoinPilotUsefulness: 3 scenarios passed")
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
