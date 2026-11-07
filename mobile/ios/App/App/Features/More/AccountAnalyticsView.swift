import SwiftUI

struct CoinPilotAccountAnalyticsView: View {
    @ObservedObject var store: CoinPilotStore

    private var summary: [String: Any] { store.portfolioAnalysis["summary"] as? [String: Any] ?? [:] }
    private var holdings: [[String: Any]] { store.portfolioAnalysis["holdings"] as? [[String: Any]] ?? [] }
    private var gainers: [[String: Any]] {
        (store.portfolioAnalysis["topGainers"] as? [[String: Any]] ?? []).filter { (number($0["profitPercent"]) ?? 0) > 0 }
    }
    private var losers: [[String: Any]] {
        (store.portfolioAnalysis["topLosers"] as? [[String: Any]] ?? []).filter { (number($0["profitPercent"]) ?? 0) < 0 }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            SectionHeading(title: "포트폴리오 구성")
                            Spacer()
                            Button(store.refreshingFeatureGroups.contains("account-analytics") ? "불러오는 중" : "새로고침") {
                                Task { await store.loadAccountAnalytics() }
                            }
                                .font(.caption.weight(.semibold))
                                .disabled(!store.canOperate || store.refreshingFeatureGroups.contains("account-analytics"))
                        }
                        CoinPilotFeatureFreshnessLine(
                            lastSuccessfulAt: store.featureLastSuccessfulAt["account-analytics"],
                            error: store.featureMessages["account-analytics"]
                        )
                        if summary.isEmpty {
                            EmptyMessage(text: store.featureMessages["account-analytics"] ?? store.featureMessages["portfolio-analysis"] ?? "포트폴리오 분석 자료가 아직 없습니다.")
                        } else {
                            if let message = store.featureMessages["account-analytics"] {
                                InlineNotice(text: message, color: CPColor.amber)
                            }
                            HStack(alignment: .center, spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("총 자산")
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                    Text(CoinPilotFormatting.won(number(summary["totalAssets"])))
                                        .font(.title3.weight(.bold))
                                        .monospacedDigit()
                                        .foregroundColor(CPColor.ink)
                                }
                                Spacer()
                            }
                            LazyVGrid(
                                columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)],
                                spacing: 8
                            ) {
                                MetricTile(title: "보유 자산 평가", value: CoinPilotFormatting.won(number(summary["totalValue"])))
                                MetricTile(title: "매입 원가", value: CoinPilotFormatting.won(number(summary["totalCost"])))
                                MetricTile(title: "현금 잔액", value: CoinPilotFormatting.won(number(summary["krwBalance"])))
                                MetricTile(
                                    title: "보유 코인 평가손익",
                                    value: CoinPilotFormatting.signedWon(number(summary["totalProfit"])),
                                    detail: number(summary["totalProfitPercent"]).map { CoinPilotFormatting.percent($0) },
                                    tint: profitColor(number(summary["totalProfit"]))
                                )
                            }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "보유 비중")
                        if holdings.isEmpty {
                            EmptyMessage(text: "현재 보유한 코인이 없습니다.")
                        }
                        let allocationSlices = CoinPilotAllocationBar.slices(summary: summary, holdings: holdings)
                        if !allocationSlices.isEmpty {
                            CoinPilotAllocationBar(slices: allocationSlices)
                            Divider().overlay(CPColor.line)
                        }
                        ForEach(Array(holdings.enumerated()), id: \.offset) { item in
                            let holding = item.element
                            let coin = holding["coin"] as? String ?? "자산"
                            let weight = number(holding["weight"])
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(CoinPilotFormatting.ticker(coin)).font(.subheadline.weight(.semibold))
                                    Text("비중 \(CoinPilotFormatting.percent(weight, signed: false))")
                                        .font(.caption2).foregroundColor(CPColor.secondaryInk)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 4) {
                                    Text(CoinPilotFormatting.won(number(holding["currentValue"])))
                                        .font(.subheadline.weight(.semibold))
                                    Text(CoinPilotFormatting.signedWon(number(holding["profit"])))
                                        .font(.caption).foregroundColor(profitColor(number(holding["profit"])))
                                }
                            }
                            if let weight {
                                ProgressView(value: max(0, min(weight, 100)), total: 100)
                                    .tint(CPColor.blue)
                            }
                            if item.offset != holdings.count - 1 { Divider().overlay(CPColor.line) }
                        }
                    }
                }
                if !gainers.isEmpty || !losers.isEmpty {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "평가 손익")
                            ForEach(Array(gainers.enumerated()), id: \.offset) { item in
                                AnalyticsMarketRow(title: "수익 종목", value: item.element)
                            }
                            ForEach(Array(losers.enumerated()), id: \.offset) { item in
                                AnalyticsMarketRow(title: "손실 종목", value: item.element)
                            }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "거래 통계")
                        if store.statistics.isEmpty {
                            EmptyMessage(text: "아직 집계된 거래 통계가 없습니다.")
                        }
                        ForEach(Array(store.statistics.enumerated()), id: \.offset) { item in
                            let value = item.element
                            Text(CoinPilotFormatting.ticker(value["coin"] as? String ?? "전략"))
                                .font(.subheadline.weight(.semibold))
                            AnalyticsMetric(title: "청산 거래", value: number(value["totalTrades"]).map { "\(CoinPilotFormatting.quantity($0))회" } ?? "미제공")
                            AnalyticsMetric(title: "승률", value: value["winRate"] as? String ?? "미제공")
                            AnalyticsMetric(title: "실현 손익", value: value["totalProfit"] as? String ?? "미제공")
                            if let average = value["avgProfit"] as? String { AnalyticsMetric(title: "거래당 평균", value: average) }
                            if item.offset != store.statistics.count - 1 { Divider().overlay(CPColor.line) }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle("계좌 분석")
        .cpInlineTitle()
        .refreshFeatureWhenVisible(enabled: store.canOperate) { await store.loadAccountAnalyticsIfStale() }
    }

    private func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

struct AnalyticsMetric: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title).font(.caption).foregroundColor(CPColor.secondaryInk)
            Spacer()
            Text(value).font(.caption.weight(.semibold)).foregroundColor(CPColor.ink).multilineTextAlignment(.trailing)
        }
    }
}

/// 요약 지표를 타일로 표시합니다. detail은 값 아래의 보조 문구입니다.
struct MetricTile: View {
    let title: String
    let value: String
    var detail: String? = nil
    var tint: Color = CPColor.ink

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundColor(CPColor.secondaryInk)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundColor(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let detail {
                Text(detail)
                    .font(.caption2.weight(.medium))
                    .monospacedDigit()
                    .foregroundColor(tint == CPColor.ink ? CPColor.secondaryInk : tint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(CPColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct AnalyticsMarketRow: View {
    let title: String
    let value: [String: Any]

    private var profitPercent: Double? {
        if let number = value["profitPercent"] as? NSNumber { return number.doubleValue }
        if let string = value["profitPercent"] as? String { return Double(string) }
        return nil
    }

    var body: some View {
        HStack {
            MetadataLine(text: "\(title) · \(CoinPilotFormatting.ticker(value["coin"] as? String))")
                .font(.caption.weight(.semibold)).foregroundColor(CPColor.ink)
            Spacer()
            Text(profitPercent.map { CoinPilotFormatting.percent($0) } ?? "변동률 미제공")
                .font(.caption.weight(.semibold)).monospacedDigit()
                .foregroundColor(profitColor(profitPercent))
        }
    }
}
