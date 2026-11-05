import SwiftUI

struct CoinPilotNewsView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var filter = "전체"

    private var visibleNews: [CoinPilotNewsArticle] {
        store.newsArticles.filter { article in
            guard filter != "전체" else { return true }
            guard let sentiment = article.sentiment?.lowercased() else { return false }
            if filter == "긍정" { return sentiment.contains("positive") || sentiment.contains("bull") || sentiment.contains("긍정") }
            if filter == "부정" { return sentiment.contains("negative") || sentiment.contains("bear") || sentiment.contains("부정") }
            return sentiment.contains("neutral") || sentiment.contains("중립")
        }
    }

    private var hasClassifiedArticles: Bool {
        store.newsArticles.contains { sentimentLabel($0.sentiment) != "감성 분류 없음" }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !store.canOperate {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeading(title: "뉴스")
                            Text("뉴스를 보려면 운영 토큰이 필요합니다.")
                                .font(.subheadline)
                                .foregroundColor(CPColor.secondaryInk)
                            NavigationLink(destination: CoinPilotSettingsView(store: store)) {
                                Text("연결 설정")
                            }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                        }
                    }
                }
                if store.canOperate {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                SectionHeading(title: "뉴스")
                                Spacer()
                                Button(store.refreshingFeatureGroups.contains("news") ? "불러오는 중" : "새로고침") {
                                    Task { await store.loadNews() }
                                }
                                .font(.subheadline.weight(.semibold))
                                .disabled(store.refreshingFeatureGroups.contains("news") || !store.canOperate)
                            }
                            CoinPilotFeatureFreshnessLine(
                                lastSuccessfulAt: store.featureLastSuccessfulAt["news"],
                                error: store.featureMessages["news"]
                            )
                            if store.featureLastSuccessfulAt["news"] != nil || !store.newsArticles.isEmpty {
                                Text(sentimentSummary)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundColor(CPColor.ink)
                            }
                            if hasClassifiedArticles {
                                Picker("기사 감성", selection: $filter) {
                                    Text("전체").tag("전체")
                                    Text("긍정").tag("긍정")
                                    Text("부정").tag("부정")
                                    Text("중립").tag("중립")
                                }
                                .pickerStyle(SegmentedPickerStyle())
                                DisclosureGroup("분류 기준") {
                                    Text("기사 분위기 분류는 참고 자료이며 매매 신호나 수익 예측으로 사용하지 않습니다.")
                                        .font(.caption).foregroundColor(CPColor.secondaryInk)
                                        .padding(.top, 6)
                                }.font(.caption).frame(minHeight: 44)
                            }
                        }
                    }
                    if store.newsArticles.isEmpty {
                        NativeCard {
                            if store.refreshingFeatureGroups.contains("news") {
                                ProgressView("뉴스 불러오는 중")
                            } else {
                                EmptyMessage(text: store.featureMessages["news"] ?? "불러온 기사가 없습니다.", actionTitle: "다시 불러오기") { Task { await store.loadNews() } }
                            }
                        }
                    } else if visibleNews.isEmpty {
                        NativeCard { EmptyMessage(text: "선택한 분류의 기사가 없습니다.", actionTitle: "전체 기사 보기") { filter = "전체" } }
                    } else {
                        ForEach(visibleNews) { article in
                            NativeCard {
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack {
                                        Text(article.source ?? "출처 미상").font(.caption.weight(.semibold)).foregroundColor(CPColor.blue)
                                        Spacer()
                                        Text(CoinPilotFormatting.dateTime(article.timestamp, unavailable: "시각 미제공"))
                                            .font(.caption2).foregroundColor(CPColor.secondaryInk)
                                    }
                                    Text(article.title).font(.subheadline.weight(.semibold)).foregroundColor(CPColor.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                    if let summary = article.summary, !summary.isEmpty {
                                        Text(summary).font(.caption).foregroundColor(CPColor.secondaryInk).lineLimit(4)
                                    }
                                    HStack {
                                        if sentimentLabel(article.sentiment) != "감성 분류 없음" {
                                        Text(sentimentLabel(article.sentiment))
                                            .font(.caption2.weight(.semibold))
                                            .foregroundColor(sentimentTint(article.sentiment))
                                        }
                                        Spacer()
                                        if let url = article.url {
                                            Link(destination: url) { Label("원문", systemImage: "arrow.up.right.square").font(.caption.weight(.semibold)) }
                                        }
                                    }
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
        .navigationTitle("뉴스")
        .cpInlineTitle()
        .refreshFeatureWhenVisible(enabled: store.canOperate) { await store.loadNewsIfStale() }
    }

    private var sentimentSummary: String {
        "기사 \(visibleNews.count)건"
    }

    private func sentimentLabel(_ value: String?) -> String {
        let normalized = (value ?? "").lowercased()
        if normalized.contains("positive") || normalized.contains("bull") || normalized.contains("긍정") { return "긍정 기사" }
        if normalized.contains("negative") || normalized.contains("bear") || normalized.contains("부정") { return "부정 기사" }
        if normalized.contains("neutral") || normalized.contains("중립") { return "중립 기사" }
        return "감성 분류 없음"
    }

    private func sentimentTint(_ value: String?) -> Color {
        let normalized = (value ?? "").lowercased()
        if normalized.contains("positive") || normalized.contains("bull") || normalized.contains("긍정") { return CPColor.green }
        if normalized.contains("negative") || normalized.contains("bear") || normalized.contains("부정") { return CPColor.red }
        return CPColor.secondaryInk
    }
}
