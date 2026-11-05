import SwiftUI

/// Combined total across engines for the current workspace, honest about
/// what is and is not included.
///
/// - Coin account total always counts (it already contains LIVE coin horizon
///   holdings because they share the exchange account).
/// - Paper stock trader and paper horizon ledgers are separate virtual
///   accounts, so their totals are added.
/// - LIVE stock ledgers expose holdings only (cash lives at the broker), so
///   only the holdings value is added and a note says so.
struct CoinPilotHomeSummary {
    var total: Double?
    var profit: Double?
    var slices: [CoinPilotAllocationSlice] = []
    var notes: [String] = []
    var includesOtherEngines = false

    @MainActor
    init(store: CoinPilotStore) {
        let workspace = store.activeWorkspace
        let coinTotal = store.account?.valuationAvailable == false ? nil : store.totalAssets
        var parts: [(label: String, value: Double)] = []
        var profit = store.totalProfit
        if let coinTotal { parts.append(("코인", coinTotal)) }

        if !store.isBundledPreview {
            if let trader = store.stocksStatus?.trader(for: workspace) {
                if trader.isLive {
                    if trader.positionsValue > 0 {
                        parts.append(("주식", trader.positionsValue))
                        notes.append("실전 주식은 보유 종목 평가만 포함. 예수금은 증권 계좌 기준.")
                    }
                    if let unrealized = trader.unrealizedProfit { profit = (profit ?? 0) + unrealized }
                } else if let value = trader.totalAssets {
                    parts.append(("주식", value))
                    if let delta = trader.profitVersusSeed { profit = (profit ?? 0) + delta }
                }
            }
            var horizonValue: Double = 0
            var horizonProfit: Double?
            for asset in CoinPilotHorizonAsset.allCases {
                guard let runtime = store.horizonsStatus?.runtime(asset: asset, workspace: workspace) else { continue }
                if runtime.isLive {
                    // LIVE coin horizon positions sit inside the coin account (already counted).
                    if asset == .stock, runtime.positionsValue > 0 {
                        horizonValue += runtime.positionsValue
                    }
                } else if let value = runtime.totalAssets {
                    horizonValue += value
                    if let delta = runtime.profitVersusSeed { horizonProfit = (horizonProfit ?? 0) + delta }
                }
            }
            if horizonValue > 0 { parts.append(("포트폴리오", horizonValue)) }
            if let horizonProfit { profit = (profit ?? 0) + horizonProfit }
            if workspace == .live, store.horizonsStatus?.coin?.isLive == true {
                notes.append("실전 코인 포트폴리오는 코인 계좌 평가에 포함.")
            }
            if store.canOperate && (store.stocksStatus == nil || store.horizonsStatus == nil) {
                notes.append("주식·포트폴리오 확인 중 · 확인 후 합계에 반영")
            }
        }

        includesOtherEngines = parts.count > 1
        total = coinTotal == nil && parts.isEmpty ? nil : parts.reduce(0) { $0 + $1.value }
        self.profit = profit
        let sum = parts.reduce(0) { $0 + $1.value }
        if sum > 0 {
            let tints = CoinPilotAllocationBar.categoryTints
            slices = parts.enumerated().map { index, part in
                CoinPilotAllocationSlice(label: part.label, weight: part.value / sum * 100, value: part.value,
                                         tint: tints[index % tints.count])
            }
        }
    }
}

/// One row in Home's "최근 체결": coin, stock and horizon fills merged by time.
struct CoinPilotHomeFill: Identifiable {
    let id: String
    let date: Date?
    let row: AnyView

    @MainActor
    static func recent(store: CoinPilotStore, limit: Int) -> [CoinPilotHomeFill] {
        var fills: [CoinPilotHomeFill] = store.trades.prefix(limit).map { trade in
            CoinPilotHomeFill(
                id: "coin|\(trade.id)",
                date: CoinPilotMarketSnapshotMetadata.parseDate(trade.timestamp),
                row: AnyView(TradeRow(trade: trade))
            )
        }
        if !store.isBundledPreview {
            if let trader = store.stocksStatus?.trader(for: store.activeWorkspace) {
                fills += trader.recentTrades.prefix(limit).map { trade in
                    CoinPilotHomeFill(
                        id: "stock|\(trade.id)",
                        date: CoinPilotMarketSnapshotMetadata.parseDate(trade.at),
                        row: AnyView(CPListRow(
                            symbol: "chart.bar.xaxis",
                            tint: trade.action == "SELL" ? CPColor.down : CPColor.up,
                            title: "\(trade.symbol ?? "종목") \(trade.actionTitle)",
                            subtitle: "주식 · \(CoinPilotFormatting.dateTime(trade.at))",
                            value: CoinPilotFormatting.price(trade.price),
                            detail: trade.profit.map { CoinPilotFormatting.signedWon($0) },
                            detailColor: CPColor.pnl(trade.profit)
                        ))
                    )
                }
            }
            for asset in CoinPilotHorizonAsset.allCases {
                guard let runtime = store.horizonsStatus?.runtime(asset: asset, workspace: store.activeWorkspace) else { continue }
                fills += runtime.recentTrades.prefix(limit).map { trade in
                    CoinPilotHomeFill(
                        id: "horizon|\(asset.rawValue)|\(trade.id)",
                        date: CoinPilotMarketSnapshotMetadata.parseDate(trade.at),
                        row: AnyView(CPListRow(
                            symbol: "square.stack.3d.up",
                            tint: trade.action == "SELL" ? CPColor.down : CPColor.up,
                            title: "\(CoinPilotFormatting.ticker(trade.symbol)) \(trade.action == "SELL" ? "매도" : "매수")",
                            subtitle: "\(asset.title) 포트폴리오 · \(CoinPilotFormatting.dateTime(trade.at))",
                            value: CoinPilotFormatting.price(trade.price),
                            detail: trade.profit.map { CoinPilotFormatting.signedWon($0) },
                            detailColor: CPColor.pnl(trade.profit)
                        ))
                    )
                }
            }
        }
        return Array(fills.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }.prefix(limit))
    }
}
