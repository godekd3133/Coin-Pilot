import SwiftUI

/// 코인 탭: 보유 · 시장 · 주문 with the scalper engine card on 보유.
struct CoinPilotCoinsView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage(CPNavigation.coinsSegmentKey) private var segment = CPCoinsSegment.holdings.rawValue

    private var selection: Binding<CPCoinsSegment> {
        Binding(
            get: { CPCoinsSegment(rawValue: segment) ?? .holdings },
            set: { segment = $0.rawValue }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            CPSegmented(
                title: "코인 화면",
                selection: selection,
                options: CPCoinsSegment.allCases.map { ($0, $0.title) }
            )
            .padding(.horizontal, CPSpace.page)
            .padding(.top, 8)
            .padding(.bottom, 6)
            .cpReadableWidth()
            .background(CPColor.paper)

            switch selection.wrappedValue {
            case .holdings:
                CoinPilotAssetsView(store: store)
            case .market:
                CoinPilotDiscoverView(store: store)
            case .order:
                CoinPilotTradingView(store: store)
            }
        }
        .background(CPColor.paper.ignoresSafeArea())
    }
}

/// Presents the order screen as a sheet from a pushed detail (market detail,
/// analysis) so the user does not lose the navigation stack.
struct CoinPilotOrderSheetModifier: ViewModifier {
    @ObservedObject var store: CoinPilotStore
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        content.sheet(isPresented: $isPresented) {
            CoinPilotNavigationHost {
                CoinPilotTradingView(store: store)
                    .modifier(CoinPilotLiveWorkspaceBanner(store: store))
                    .navigationTitle("주문")
                    .cpInlineTitle()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("닫기") { isPresented = false }
                        }
                    }
            }
            .cpEditorSheetFrame()
        }
    }
}

extension View {
    func coinOrderSheet(store: CoinPilotStore, isPresented: Binding<Bool>) -> some View {
        modifier(CoinPilotOrderSheetModifier(store: store, isPresented: isPresented))
    }
}
