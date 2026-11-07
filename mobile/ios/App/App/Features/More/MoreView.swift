import SwiftUI

/// 연구실: everything that is not needed every day, grouped by purpose from the
/// registry (`CPFeature.group`). The Mac sidebar shows the same sections.
struct CoinPilotLabView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage(CPNavigation.labDestinationKey) private var pendingDestination = ""
    @State private var activeDestination: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(CPLabGroup.allCases) { group in
                    let items = CPFeatureRegistry.labItems(in: group).filter { $0.isVisible(in: store) }
                    if !items.isEmpty {
                        CPCard(group.title) {
                            VStack(spacing: 0) {
                                ForEach(items) { feature in
                                    NavigationLink(
                                        destination: CoinPilotFeatureScreen(store: store, feature: feature, isPushed: true),
                                        tag: feature.id,
                                        selection: $activeDestination
                                    ) {
                                        FeatureMenuRow(title: feature.label, detail: feature.detail, symbol: feature.icon)
                                    }
                                    .accessibilityHint(feature.detail)
                                    if feature.id != items.last?.id { CPDivider() }
                                }
                            }
                        }
                    }
                }

                Text("연구실 화면은 조회와 설정만 다룹니다. 주문은 코인·주식 화면의 확인 단계를 거쳐야 나갑니다.")
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
        .onAppear(perform: consumePendingDestination)
        .onChange(of: pendingDestination) { _ in consumePendingDestination() }
    }

    /// `CPNavigation.open(id)` for a 연구실 screen selects this tab and leaves the
    /// id here; push it once.
    private func consumePendingDestination() {
        guard !pendingDestination.isEmpty else { return }
        let destination = pendingDestination
        pendingDestination = ""
        guard let feature = CPFeatureRegistry.feature(destination),
              feature.surfaces.contains(.labLink), feature.isVisible(in: store) else { return }
        activeDestination = destination
    }
}

/// 튜닝: the editor is a sheet with its own save/close; this screen explains it
/// and opens it, so 튜닝 can be a plain list destination (and a Mac sidebar item).
struct CoinPilotTuningEntryView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var showingEditor = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                CPCard("튜닝") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("현재 작업공간 서버의 투자 비율, 손절·익절, 최대 보유 시간 같은 값을 하나씩 확인하고 바꿉니다. 저장하면 서버 설정이 바로 바뀝니다.")
                            .font(.subheadline)
                            .foregroundColor(CPColor.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                        if let reason = store.tuningBlockReason {
                            CPNotice(text: reason, tone: .info)
                        }
                        Button("튜닝값 열기") { showingEditor = true }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                            .disabled(!store.canViewTuning)
                    }
                }
                Text("여러 값을 한 번에 바꾸려면 프리셋을 쓰세요.")
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
                    .padding(.horizontal, 4)
            }
            .cpPage()
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .sheet(isPresented: $showingEditor) {
            CoinPilotTuningEditor(store: store)
        }
    }
}

/// 오프라인 리플레이 runs only in the bundled-local build, where it is the whole
/// app. In a server-connected app this screen explains that instead of showing
/// an empty market list.
struct CoinPilotOfflineReplayEntryView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        if store.isBundledLocalMarketData {
            CoinPilotLocalMarketView(store: store)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    CPCard("오프라인 리플레이") {
                        CPEmptyState(
                            symbol: "play.rectangle",
                            title: "이 앱에서는 사용하지 않는 모드입니다",
                            message: "오프라인 리플레이는 고정 시세 자료를 넣어 따로 만든 앱에서만 열립니다. 그 앱은 서버나 계좌에 연결하지 않고 저장된 시세로 과거 구간만 계산합니다. 지금 앱은 서버에 연결된 상태라 이 화면에 보여줄 자료가 없습니다."
                        )
                    }
                }
                .cpPage()
            }
            .cpReadableWidth()
            .background(CPColor.paper.ignoresSafeArea())
        }
    }
}
