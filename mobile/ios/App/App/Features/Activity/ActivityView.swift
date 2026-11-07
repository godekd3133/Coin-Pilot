import SwiftUI

struct CoinPilotActivityView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var actionFilter = "전체"
    @State private var period: CoinPilotTradePeriod = .all
    @State private var search = ""
    @State private var source = "coin"

    private var filteredTrades: [CoinPilotTrade] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let now = Date()
        return store.trades.filter { trade in
            (actionFilter == "전체" || trade.action == actionFilter) &&
                period.includes(trade.timestamp, at: now) &&
                (query.isEmpty || (trade.coin ?? "").localizedCaseInsensitiveContains(query))
        }.sorted {
            (CoinPilotMarketSnapshotMetadata.parseDate($0.timestamp) ?? .distantPast) >
                (CoinPilotMarketSnapshotMetadata.parseDate($1.timestamp) ?? .distantPast)
        }
    }

    private struct TradeDay: Identifiable {
        let date: Date?
        let trades: [CoinPilotTrade]
        var id: String { date.map { String($0.timeIntervalSince1970) } ?? "unknown" }
        var title: String {
            guard let date else { return "거래 시각 미제공" }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "ko_KR")
            formatter.dateFormat = "M월 d일 EEEE"
            let label = formatter.string(from: date)
            return Calendar.current.isDateInToday(date) ? "오늘  \(label)" : label
        }
    }

    private var groupedTrades: [TradeDay] {
        let groups = Dictionary(grouping: filteredTrades) { trade in
            CoinPilotMarketSnapshotMetadata.parseDate(trade.timestamp).map { Calendar.current.startOfDay(for: $0) }
        }
        return groups.map { TradeDay(date: $0.key, trades: $0.value) }
            .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !store.isBundledPreview {
                    CPSegmented(title: "내역 종류", selection: $source,
                                options: [("coin", "코인"), ("stock", "주식"), ("horizon", "포트폴리오")])
                }
                if source != "coin" {
                    CoinPilotEngineActivityList(store: store, source: source)
                } else {
                if let message = store.dashboardMessage {
                    InlineNotice(text: message, color: CPColor.amber)
                }
                if store.isBundledPreview {
                    InlineNotice(text: "예시 거래 내역", color: CPColor.blue, symbol: "info.circle.fill")
                }
                MetadataLine(text: store.freshnessLabel(for: "trades"))
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
                if store.trades.isEmpty {
                    NativeCard {
                        EmptyMessage(text: store.emptyResourceMessage(for: "trades", whenLoadedEmpty: "거래 내역 없음"),
                                     image: "CoinPilotEmptyTrades",
                                     actionTitle: store.hasLoadedResource("trades") ? "시장 둘러보기" : "다시 불러오기",
                                     isActionDisabled: store.isRefreshing) {
                            if store.hasLoadedResource("trades") { CPNavigation.openCoins(.market) }
                            else { Task { await store.refresh() } }
                        }
                    }
                } else {
                    filters
                    activitySummary
                    if filteredTrades.isEmpty {
                        NativeCard {
                            EmptyMessage(text: "조건에 맞는 거래 없음",
                                         actionTitle: "필터 초기화") {
                                actionFilter = "전체"
                                period = .all
                                search = ""
                            }
                        }
                    } else {
                        ForEach(groupedTrades) { group in
                            NativeCard {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(group.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundColor(CPColor.ink)
                                    ForEach(group.trades) { trade in
                                        if let receipt = trade.receipt {
                                            NavigationLink(destination: CoinPilotTradeReceiptView(trade: trade, receipt: receipt)) {
                                                ReceiptTradeRow(trade: trade, receipt: receipt)
                                            }
                                            .buttonStyle(.plain)
                                            .accessibilityHint("거래 영수증 열기")
                                        } else {
                                            TradeRow(trade: trade)
                                        }
                                        if trade.id != group.trades.last?.id {
                                            Divider().overlay(CPColor.line)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                }
            }
            .cpPage()
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle("거래 내역")
        .cpInlineTitle()
        .refreshable {
            await store.refresh()
            await store.loadStocksStatus(force: true)
            await store.loadHorizonsStatus(force: true)
        }
        .refreshFeatureWhenVisible(enabled: !store.isBundledPreview && store.canOperate && source != "coin") {
            await store.loadStocksStatus(force: false)
            await store.loadHorizonsStatus(force: false)
        }
    }

    private var filters: some View {
        VStack(spacing: 12) {
            Picker("거래 기간", selection: $period) {
                ForEach(CoinPilotTradePeriod.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(SegmentedPickerStyle())
            Picker("거래 종류", selection: $actionFilter) {
                ForEach(["전체", "매수", "매도"], id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(SegmentedPickerStyle())
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass").foregroundColor(CPColor.secondaryInk)
                TextField("거래한 종목 검색", text: $search)
                    .cpAutocapitalizeCharacters()
                    .cpNoAutocorrection()
                    .textFieldStyle(.plain)
                    .accessibilityLabel("거래한 종목 검색")
                if !search.isEmpty {
                    Button { search = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundColor(CPColor.secondaryInk)
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("거래 종목 검색어 지우기")
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(CPColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: 11))
        }
    }

    private var activitySummary: some View {
        let profits = filteredTrades.compactMap(\.profit)
        return NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("조회 기록").font(.caption).foregroundColor(CPColor.secondaryInk)
                        Text("\(filteredTrades.count)건").font(.title3.weight(.semibold)).monospacedDigit()
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 5) {
                        Text("기록된 실현 손익").font(.caption).foregroundColor(CPColor.secondaryInk)
                        Text(profits.isEmpty ? "—" : CoinPilotFormatting.signedWon(profits.reduce(0, +)))
                            .font(.title3.weight(.semibold)).monospacedDigit()
                            .foregroundColor(profits.isEmpty ? CPColor.secondaryInk : profitColor(profits.reduce(0, +)))
                        if !profits.isEmpty {
                            Text("손익 제공 \(profits.count)건").font(.caption2).foregroundColor(CPColor.secondaryInk)
                        }
                    }
                }
                DisclosureGroup("집계 기준") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("불러온 \(store.trades.count)건에 필터를 적용한 결과입니다. 전체 누적 손익과 다를 수 있습니다.")
                        if store.trades.contains(where: { $0.source == "strategy" }) {
                            Text("주문 기록과 전략 기록이 함께 포함됩니다.")
                        }
                        Text("손익이 제공된 거래만 합산합니다. 거래소의 최종 체결·정산 내역과 다를 수 있습니다.")
                        if period != .all { Text("기간은 기기 시간 기준으로 오늘을 포함합니다.") }
                    }.padding(.top, 6)
                }
                .font(.caption)
                .foregroundColor(CPColor.secondaryInk)
                .frame(minHeight: 44)
            }
        }
    }

}

/// Stock and horizon fills from the engine status responses (the server keeps
/// the most recent 20–30 per engine).
struct CoinPilotEngineActivityList: View {
    @ObservedObject var store: CoinPilotStore
    let source: String

    private struct Row: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let value: String
        let profit: Double?
        let isSell: Bool
        let date: Date?
    }

    private var rows: [Row] {
        if source == "stock" {
            let traders = [store.stocksStatus?.paper, store.stocksStatus?.live].compactMap { $0 }
            return traders.flatMap { trader in
                trader.recentTrades.map { trade in
                    Row(id: "\(trader.mode ?? "")|\(trade.id)",
                        title: "\(trade.symbol ?? "종목") \(trade.actionTitle)",
                        subtitle: [trader.isLive ? "실전" : "모의", CoinPilotFormatting.dateTime(trade.at), trade.reason]
                            .compactMap { $0 }.joined(separator: " · "),
                        value: "\(CoinPilotFormatting.quantity(trade.quantity))주 · \(CoinPilotFormatting.price(trade.price))",
                        profit: trade.profit, isSell: trade.action == "SELL",
                        date: CoinPilotMarketSnapshotMetadata.parseDate(trade.at))
                }
            }.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
        }
        let runtimes = CoinPilotHorizonAsset.allCases.compactMap { asset in
            store.horizonsStatus?.runtime(asset: asset, workspace: store.activeWorkspace).map { (asset, $0) }
        }
        return runtimes.flatMap { asset, runtime in
            runtime.recentTrades.map { trade in
                Row(id: "\(asset.rawValue)|\(trade.id)",
                    title: "\(CoinPilotFormatting.ticker(trade.symbol)) \(trade.action == "SELL" ? "매도" : "매수")",
                    subtitle: ["\(asset.title) · \(runtime.sleeves[trade.sleeve ?? ""]?.label ?? trade.sleeve ?? "")",
                               CoinPilotFormatting.dateTime(trade.at), trade.reason].compactMap { $0 }.joined(separator: " · "),
                    value: CoinPilotFormatting.price(trade.price),
                    profit: trade.profit, isSell: trade.action == "SELL",
                    date: CoinPilotMarketSnapshotMetadata.parseDate(trade.at))
            }
        }.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }

    var body: some View {
        let rows = rows
        let loaded = source == "stock" ? store.stocksStatus != nil : store.horizonsStatus != nil
        CPCard(source == "stock" ? "주식 체결" : "포트폴리오 체결") {
            if !loaded {
                Text(store.featureMessages[source == "stock" ? CoinPilotStore.stocksFeatureKey : CoinPilotStore.horizonsFeatureKey]
                     ?? "불러오는 중")
                    .font(.caption).foregroundColor(CPColor.secondaryInk)
            } else if rows.isEmpty {
                CPEmptyState(symbol: "tray", title: "체결 기록 없음")
            } else {
                VStack(spacing: 0) {
                    ForEach(rows) { row in
                        CPListRow(
                            symbol: row.isSell ? "arrow.down.right" : "arrow.up.right",
                            tint: row.isSell ? CPColor.down : CPColor.up,
                            title: row.title, subtitle: row.subtitle, value: row.value,
                            detail: row.profit.map { CoinPilotFormatting.signedWon($0) },
                            detailColor: CPColor.pnl(row.profit)
                        )
                        if row.id != rows.last?.id { CPDivider() }
                    }
                }
            }
            Text("엔진별 최근 체결만 표시. 전체 기록은 서버 로그.")
                .font(.caption2).foregroundColor(CPColor.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
