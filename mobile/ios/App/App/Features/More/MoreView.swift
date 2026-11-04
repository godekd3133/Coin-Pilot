import SwiftUI

/// 더보기: primary features that are not tabs on this platform (from the
/// registry), then the advanced tools grouped by purpose.
struct CoinPilotMoreView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                let primary = CPFeatureRegistry.moreLinks
                if !primary.isEmpty {
                    CPCard {
                        VStack(spacing: 0) {
                            ForEach(primary) { feature in
                                NavigationLink(destination: CoinPilotFeatureScreen(store: store, feature: feature)) {
                                    FeatureMenuRow(title: feature.label, detail: moreDetail(for: feature.id), symbol: feature.icon)
                                }
                                if feature.id != primary.last?.id { CPDivider() }
                            }
                        }
                    }
                }

                CPCard("기록과 분석") {
                    VStack(spacing: 0) {
                        NavigationLink(destination: CoinPilotAccountAnalyticsView(store: store)) {
                            FeatureMenuRow(title: "포트폴리오 분석", detail: "코인 계좌 비중과 코인별 성과", symbol: "chart.pie")
                        }
                        if !store.isBundledPreview {
                            CPDivider()
                            NavigationLink(destination: CoinPilotResearchDeskView(store: store)) {
                                FeatureMenuRow(title: "주문 전 점검", detail: "검증 결과와 운용 상태", symbol: "checkmark.shield")
                            }
                        }
                    }
                }

                if !store.isBundledPreview {
                    CPCard("전략 관리") {
                        VStack(spacing: 0) {
                            NavigationLink(destination: CoinPilotOptimizationView(store: store)) {
                                FeatureMenuRow(title: "설정 후보 비교", detail: "최적화 기록과 백테스트", symbol: "slider.horizontal.3")
                            }
                            CPDivider()
                            NavigationLink(destination: CoinPilotPresetView(store: store)) {
                                FeatureMenuRow(title: "전략 프리셋 · 튜닝", detail: "투자 비중과 지표 기간", symbol: "square.stack.3d.up")
                            }
                        }
                    }

                    CPCard("시장 의견") {
                        VStack(spacing: 0) {
                            NavigationLink(destination: CoinPilotNewsView(store: store)) {
                                FeatureMenuRow(title: "뉴스", detail: "코인별 뉴스와 심리", symbol: "newspaper")
                            }
                            CPDivider()
                            NavigationLink(destination: CoinPilotAIDeskView(store: store)) {
                                FeatureMenuRow(title: "시장 자문", detail: "관심 신호 기록과 의견 확인 (주문하지 않음)", symbol: "text.bubble")
                            }
                        }
                    }
                }

                Text("고급 도구는 조회와 설정만 다룹니다. 주문은 코인·주식 화면의 확인 단계를 거쳐야 나갑니다.")
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
            .cpPage()
        }
        .buttonStyle(CoinPilotPressableButtonStyle())
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
    }

    private func moreDetail(for id: String) -> String {
        switch id {
        case "activity": return "코인·주식·포트폴리오 체결 내역"
        case "settings": return "서버, 작업공간, 실전 키, 테마"
        default: return ""
        }
    }
}
