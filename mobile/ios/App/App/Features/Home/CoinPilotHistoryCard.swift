import SwiftUI

struct CoinPilotHistoryCard: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    SectionHeading(title: "자산 기록")
                    Spacer()
                    MetadataLine(text: store.freshnessLabel(for: "portfolio-history"))
                        .font(.caption2)
                        .foregroundColor(store.isResourceStale("portfolio-history") ? CPColor.amber : CPColor.secondaryInk)
                }
                Picker("자산 기록 기간", selection: Binding(
                    get: { store.historyPeriod },
                    set: { period in Task { await store.setHistoryPeriod(period) } }
                )) {
                    ForEach(CoinPilotHistoryPeriod.allCases) { period in
                        Text(period.title).tag(period)
                    }
                }
                .pickerStyle(SegmentedPickerStyle())
                CoinPilotHistoryChart(
                    points: store.history,
                    reference: store.account?.initialSeedMoney,
                    period: store.historyPeriod,
                    emptyMessage: store.history.isEmpty
                        ? store.emptyResourceMessage(for: "portfolio-history", whenLoadedEmpty: "이 기간에 저장된 자산 기록이 없습니다.")
                        : "저장된 기록의 평가액을 확인할 수 없습니다."
                )
                if store.history.contains(where: { $0.valuationStatus == "unknown_legacy" }) {
                    Text("일부 이전 기록은 당시 시세 평가 근거를 확인할 수 없어요.")
                        .font(.footnote)
                        .foregroundColor(CPColor.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
