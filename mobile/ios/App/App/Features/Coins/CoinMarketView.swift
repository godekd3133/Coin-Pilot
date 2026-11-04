import SwiftUI

enum CoinPilotMarketSort: String, CaseIterable {
    case volume, change, price, name

    var title: String {
        switch self {
        case .volume: return "거래대금"
        case .change: return "등락률"
        case .price: return "가격"
        case .name: return "이름"
        }
    }
}

struct CoinPilotDiscoverView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var search = ""
    @State private var sort: CoinPilotMarketSort = .volume
    @State private var visibleLimit = 30

    private var visibleMarkets: [CoinPilotMarketPrice] {
        let source = store.markets.filter { market in
            guard let coin = market.coin else { return false }
            return search.isEmpty || coin.localizedCaseInsensitiveContains(search)
        }
        switch sort {
        case .volume: return source.sorted { ($0.volumeKrw ?? 0) > ($1.volumeKrw ?? 0) }
        case .change: return source.sorted { ($0.change ?? -.greatestFiniteMagnitude) > ($1.change ?? -.greatestFiniteMagnitude) }
        case .price: return source.sorted { ($0.price ?? 0) > ($1.price ?? 0) }
        case .name: return source.sorted { CoinPilotFormatting.symbol($0.coin) < CoinPilotFormatting.symbol($1.coin) }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !store.canOperate && !store.isBundledPreview {
                    InlineNotice(text: "시장 분석·뉴스·AI 자문은 운영 토큰으로 로그인하면 사용할 수 있습니다.", color: CPColor.amber)
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .firstTextBaseline) {
                            SectionHeading(title: "시장 관찰")
                            Spacer()
                            MetadataLine(text: store.freshnessLabel(for: "market-prices"))
                                .font(.caption2)
                                .foregroundColor(CPColor.secondaryInk)
                        }
                        HStack(spacing: 8) {
                            Image(systemName: "magnifyingglass")
                                .font(.subheadline)
                                .foregroundColor(CPColor.secondaryInk)
                            TextField("종목 검색", text: $search)
                                .cpAutocapitalizeCharacters()
                                .cpNoAutocorrection()
                                .textFieldStyle(.plain)
                            if !search.isEmpty {
                                Button {
                                    search = ""
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                                .accessibilityLabel("검색어 지우기")
                            }
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(CPColor.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 11))
                        HStack {
                            Picker("정렬", selection: $sort) {
                                ForEach(CoinPilotMarketSort.allCases, id: \.self) { option in
                                    Text(option.title).tag(option)
                                }
                            }
                            .pickerStyle(MenuPickerStyle())
                            .font(.caption.weight(.semibold))
                            .accessibilityLabel("시장 정렬 기준")
                            Spacer()
                            Text(visibleMarkets.count > visibleLimit
                                 ? "\(visibleLimit) / \(visibleMarkets.count)개"
                                 : "\(visibleMarkets.count)개 시장")
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                        }
                        if visibleMarkets.isEmpty {
                            EmptyMessage(text: search.isEmpty
                                         ? store.emptyResourceMessage(for: "market-prices", whenLoadedEmpty: "표시할 종목이 없습니다.")
                                         : "'\(search)' 검색 결과가 없습니다.",
                                         image: "CoinPilotAnalysisHero",
                                         actionTitle: search.isEmpty ? "시세 다시 확인" : "검색어 지우기",
                                         isActionDisabled: store.isRefreshing) {
                                if search.isEmpty { Task { await store.refresh() } }
                                else { search = "" }
                            }
                        } else {
                            VStack(spacing: 0) {
                                ForEach(Array(visibleMarkets.prefix(visibleLimit).enumerated()), id: \.element.id) { item in
                                    if let coin = item.element.coin {
                                        NavigationLink(destination: CoinPilotMarketDetailView(store: store, coin: coin)) {
                                            MarketRow(
                                                market: item.element,
                                                isBundledPreview: store.isBundledPreview,
                                                maximumAgeSeconds: store.marketPriceMaximumAgeSeconds,
                                                rank: sort == .volume ? item.offset + 1 : nil
                                            )
                                        }
                                        .buttonStyle(CoinPilotPressableButtonStyle())
                                        if item.element.id != visibleMarkets.prefix(visibleLimit).last?.id {
                                            Divider().overlay(CPColor.line)
                                        }
                                    }
                                }
                            }
                            if visibleMarkets.count > visibleLimit {
                                Button("종목 더 보기 (\(visibleMarkets.count - visibleLimit))") {
                                    visibleLimit += 30
                                }
                                .buttonStyle(CoinPilotSecondaryButtonStyle())
                            }
                        }
                    }
                }
                if !store.isBundledPreview {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeading(title: "분석 도구")
                            NavigationLink(destination: CoinPilotAnalysisView(store: store)) {
                                FeatureMenuRow(title: "전략 분석", detail: "신호 점수와 판단 근거", symbol: "waveform.path.ecg")
                            }
                            Divider().overlay(CPColor.line)
                            NavigationLink(destination: CoinPilotNewsView(store: store)) {
                                FeatureMenuRow(title: "뉴스", detail: "", symbol: "newspaper")
                            }
                            Divider().overlay(CPColor.line)
                            NavigationLink(destination: CoinPilotAIDeskView(store: store)) {
                                FeatureMenuRow(title: "시장 자문", detail: "관심 신호 기록과 의견 확인", symbol: "text.bubble")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 34)
        }
        .buttonStyle(CoinPilotPressableButtonStyle())
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
        .cpOnChange(of: search) { _ in visibleLimit = 30 }
        .cpOnChange(of: sort) { _ in visibleLimit = 30 }
    }
}
