import SwiftUI

struct CoinPilotAssetsView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if store.isBundledPreview {
                    InlineNotice(text: "앱에 포함된 예시 자료예요. 실제 계좌 정보가 아닙니다.", color: CPColor.blue, symbol: "info.circle.fill")
                }
                if let message = store.dashboardMessage {
                    InlineNotice(text: message, color: CPColor.amber)
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: CPSpace.md) {
                        HeroValue(
                            label: "코인 계좌 총자산",
                            value: store.account?.valuationAvailable == false ? nil : store.totalAssets,
                            unavailable: store.account?.valuationAvailable == false ? "평가액 확인 불가" : "평가액 미제공",
                            change: store.totalProfit,
                            changePercent: store.totalProfitPercent,
                            changeLabel: store.totalProfitLabel,
                            caption: store.freshnessLabel(for: "account"),
                            isLoading: !store.hasLoadedResource("account") && store.totalAssets == nil && !store.isBundledPreview
                        )
                        CPStatGrid(items: [
                            CPStatItem(label: store.quoteAssetLabel,
                                       value: CoinPilotFormatting.won(store.account?.krwBalance, unavailable: "잔액 미제공")),
                            CPStatItem(label: "보유 코인 평가액",
                                       value: CoinPilotFormatting.won(store.account?.completePositionsValue, unavailable: "확인 필요"))
                        ])
                    }
                }
                if !store.isBundledPreview {
                    CoinPilotAutomationControl(store: store)
                }
                if store.hasLoadedResource("account"), store.account != nil {
                    allocationSection
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(alignment: .firstTextBaseline) {
                            SectionHeading(title: "보유 코인")
                            Spacer()
                            if !sortedPositions.isEmpty {
                                MetadataLine(text: holdingsSummary)
                                    .font(.caption)
                                    .foregroundColor(CPColor.secondaryInk)
                                    .monospacedDigit()
                                    .multilineTextAlignment(.trailing)
                            }
                        }
                        if !store.hasLoadedResource("account") {
                            EmptyMessage(text: store.emptyResourceMessage(for: "account", whenLoadedEmpty: "보유 중인 코인이 없습니다."),
                                         actionTitle: "다시 불러오기", isActionDisabled: store.isRefreshing) {
                                Task { await store.refresh() }
                            }
                        } else if store.account?.hasPositionsField != true {
                            EmptyMessage(text: "보유 자산을 확인할 수 없어요.", image: "CoinPilotEmptyHoldings",
                                         actionTitle: "다시 확인", isActionDisabled: store.isRefreshing) {
                                Task { await store.refresh() }
                            }
                        } else if store.account?.positions.isEmpty != false {
                            EmptyMessage(text: "아직 보유한 코인이 없어요. 시장에서 관심 있는 코인의 가격과 흐름을 살펴보세요.", image: "CoinPilotEmptyHoldings",
                                         actionTitle: "시장 둘러보기") { CPNavigation.openCoins(.market) }
                        } else {
                            VStack(spacing: 0) {
                                ForEach(sortedPositions) { position in
                                    PositionRow(position: position, store: store)
                                    if position.id != sortedPositions.last?.id {
                                        Divider().overlay(CPColor.line)
                                    }
                                }
                            }
                        }
                    }
                }
                CoinPilotHistoryCard(store: store)
                if !store.isBundledPreview {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "자산 기록 저장")
                            Text("현재 계좌 평가를 기록해 자산 흐름에 추가합니다.")
                                .font(.caption).foregroundColor(CPColor.secondaryInk)
                            Button(store.isRecordingSnapshot ? "기록 저장 중" : "현재 자산 기록 저장") {
                                Task { _ = await store.recordPortfolioSnapshot() }
                            }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                            .disabled(!store.canOperate || store.isRecordingSnapshot)
                            if let message = store.featureMessages["snapshot"] {
                                Text(message).font(.caption).foregroundColor(CPColor.secondaryInk)
                            }
                        }
                    }
                }
                NavigationLink(destination: CoinPilotAccountAnalyticsView(store: store)) {
                    FeatureMenuRow(title: "포트폴리오 분석", detail: "", symbol: "chart.pie")
                        .padding(.horizontal, 4)
                }
                if store.isBundledPreview, let observerDate = store.account?.valuationAsOf {
                    MetadataLine(text: "예시 자료 · 평가 기준 시각 \(CoinPilotFormatting.dateTime(observerDate, unavailable: "평가 시각 미제공"))")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                } else if store.isObserverAccount, let observerDate = store.account?.valuationAsOf {
                    MetadataLine(text: "조회 전용 계좌 · 평가 기준 시각 \(CoinPilotFormatting.dateTime(observerDate, unavailable: "평가 시각 미제공"))")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                }
                if store.account?.valuationAvailable == false {
                    Text("현재 시세를 확인하지 못해 손익을 표시하지 않았어요.")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 34)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
    }

    private var holdingsSummary: String {
        let count = sortedPositions.count
        if let value = store.account?.completePositionsValue {
            return "\(count)종목 · 평가 \(CoinPilotFormatting.won(value))"
        }
        let missing = store.account?.unvaluedPositionCount ?? count
        return missing > 0 ? "\(count)종목 · \(missing)종목 시세 확인 필요" : "\(count)종목 · 평가액 확인 필요"
    }

    /// 평가액이 확인된 코인부터 큰 순서로 보여줍니다. 평가 불가 항목은 아래로 내립니다.
    private var sortedPositions: [CoinPilotPosition] {
        (store.account?.positions ?? []).sorted {
            ($0.currentValue ?? -1) > ($1.currentValue ?? -1)
        }
    }

    private var allocationSection: some View {
        let allocation = CoinPilotAllocationBar.slices(
            krwBalance: store.account?.krwBalance,
            positions: store.account?.positions ?? [],
            totalAssets: store.totalAssets
        )
        return NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(title: "자산 배분")
                if store.account?.valuationAvailable == false {
                    EmptyMessage(text: "시세를 확인하지 못해 비중을 계산할 수 없어요.")
                } else if allocation.slices.isEmpty {
                    EmptyMessage(text: allocation.unvaluedCount > 0
                        ? "보유 코인의 평가액을 확인할 수 없어 비중을 나눌 수 없어요."
                        : "비중을 계산할 자산이 없습니다.")
                } else {
                    CoinPilotAllocationBar(slices: allocation.slices)
                    if allocation.unvaluedCount > 0 {
                        Text("시세를 확인하지 못한 코인 \(allocation.unvaluedCount)개는 비중에서 제외했어요.")
                            .font(.caption2)
                            .foregroundColor(CPColor.amber)
                    }
                }
            }
        }
    }
}
