import SwiftUI

struct CoinPilotAnalysisView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var showsOrderSheet = false
    @State private var filter = "전체"
    @State private var sort = "종합 점수"

    private var results: [CoinPilotAnalysisResult] {
        let filtered = store.analysisResults.filter { result in
            switch filter {
            case "매수": return result.recommendation == "BUY"
            case "매도": return result.recommendation == "SELL"
            case "관망": return result.recommendation == "HOLD"
            default: return true
            }
        }
        return filtered.sorted { left, right in
            switch sort {
            case "매수 점수": return (left.buyScore ?? -1) > (right.buyScore ?? -1)
            case "매도 점수": return (left.sellScore ?? -1) > (right.sellScore ?? -1)
            case "변동률": return (left.change24h ?? -Double.infinity) > (right.change24h ?? -Double.infinity)
            default: return (left.totalScore ?? -1) > (right.totalScore ?? -1)
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .center) {
                            SectionHeading(title: "시장 신호")
                            Spacer()
                            Image("CoinPilotAnalysisHero")
                                .resizable()
                                .scaledToFit()
                                .frame(width: 48, height: 48)
                                .accessibilityHidden(true)
                            Button(store.loadingFeatures.contains("analysis") ? "분석 중" : "분석 실행") {
                                Task { await store.loadAnalysisFeatures() }
                            }
                            .font(.subheadline.weight(.semibold))
                            .disabled(store.loadingFeatures.contains("analysis") || !store.canOperate)
                        }
                        HStack(spacing: 12) {
                            analysisCount("분석", store.analysisSummary["totalAnalyzed"])
                            analysisCount("매수", store.analysisResults.filter { $0.recommendation == "BUY" }.count)
                            analysisCount("매도", store.analysisResults.filter { $0.recommendation == "SELL" }.count)
                            analysisCount("관망", store.analysisResults.filter { $0.recommendation == "HOLD" }.count)
                        }
                        Picker("결과 필터", selection: $filter) {
                            Text("전체").tag("전체")
                            Text("매수").tag("매수")
                            Text("매도").tag("매도")
                            Text("관망").tag("관망")
                        }
                        .pickerStyle(SegmentedPickerStyle())
                        Picker("정렬", selection: $sort) {
                            Text("종합 점수").tag("종합 점수")
                            Text("매수 점수").tag("매수 점수")
                            Text("매도 점수").tag("매도 점수")
                            Text("변동률").tag("변동률")
                        }
                        .pickerStyle(MenuPickerStyle())
                    }
                }
                if let message = store.featureMessages["analysis"] {
                    InlineNotice(text: message, color: CPColor.amber)
                } else if results.isEmpty {
                    NativeCard { EmptyMessage(text: "분석 실행을 누르면 서버가 확인한 시장 신호가 표시됩니다. 판정은 참고 정보이며 수익을 보장하지 않습니다.") }
                } else {
                    ForEach(results) { result in
                        NativeCard {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack(alignment: .firstTextBaseline) {
                                    CoinAvatar(coin: result.coin, size: 38)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(CoinPilotFormatting.ticker(result.coin)).font(.headline.weight(.semibold))
                                        Text(CoinPilotFormatting.price(result.currentPrice)).font(.caption).foregroundColor(CPColor.secondaryInk)
                                    }
                                    Spacer()
                                    Text(analysisAction(result.recommendation))
                                        .font(.caption.weight(.bold))
                                        .foregroundColor(analysisTint(result.recommendation))
                                }
                                HStack {
                                    Text("24시간 \(CoinPilotFormatting.percent(result.change24h))")
                                    Spacer()
                                    MetadataLine(text: "매수 \(result.buyScore.map { String(Int($0)) } ?? "—") · 매도 \(result.sellScore.map { String(Int($0)) } ?? "—")")
                                    Spacer()
                                    Text("종합 \(result.totalScore.map { String(Int($0)) } ?? "—")/100")
                                }
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                                CoinPilotRsiGauge(value: result.rsi)
                                if !result.signals.isEmpty {
                                    MetadataLine(text: result.signals.joined(separator: " · "))
                                        .font(.caption)
                                        .foregroundColor(CPColor.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                HStack(spacing: 8) {
                                    if result.coin.range(of: "^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil {
                                        NavigationLink(destination: CoinPilotMarketDetailView(store: store, coin: result.coin)) {
                                            Label("시세", systemImage: "chart.line.uptrend.xyaxis")
                                                .frame(maxWidth: .infinity, minHeight: 40)
                                        }
                                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                                    }
                                    Button {
                                        store.selectedMarket = result.coin
                                        showsOrderSheet = true
                                    } label: {
                                        Label("주문 열기", systemImage: "arrow.left.arrow.right")
                                            .frame(maxWidth: .infinity, minHeight: 40)
                                    }
                                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                                }
                            }
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
        .navigationTitle("전략 분석")
        .coinOrderSheet(store: store, isPresented: $showsOrderSheet)
        .cpInlineTitle()
        .task { if store.analysisResults.isEmpty { await store.loadAnalysisFeatures() } }
    }

    private func analysisCount(_ label: String, _ value: Any?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value.map { String(describing: $0) } ?? "—").font(.headline.monospacedDigit()).foregroundColor(CPColor.ink)
            Text(label).font(.caption2).foregroundColor(CPColor.secondaryInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func analysisAction(_ value: String?) -> String {
        switch value {
        case "BUY": return "매수 검토"
        case "SELL": return "매도 검토"
        case "HOLD": return "관망"
        default: return "미판정"
        }
    }

    private func analysisTint(_ value: String?) -> Color {
        switch value {
        case "BUY": return CPColor.green
        case "SELL": return CPColor.red
        default: return CPColor.secondaryInk
        }
    }
}
