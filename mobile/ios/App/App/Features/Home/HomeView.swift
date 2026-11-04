import SwiftUI

struct CoinPilotHomeView: View {
    @ObservedObject var store: CoinPilotStore
    @ScaledMetric(relativeTo: .title) private var totalAssetFontSize: CGFloat = 34
    @State private var cohortDetailsExpanded = false
    @State private var homeDetailsExpanded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                workspaceIdentity
                if store.isBundledPreview {
                    CPNotice(text: "앱에 포함된 예시 자료예요. 실제 계좌 정보가 아닙니다.", tone: .info)
                }
                if let message = store.dashboardMessage {
                    CPNotice(text: message, tone: .warning)
                }
                if let mismatchMessage = store.workspaceModeMismatchMessage,
                   mismatchMessage != store.dashboardMessage {
                    CPNotice(text: mismatchMessage, tone: .warning)
                }
                credentialStatusSection
                if let message = store.liveCredentialMessage {
                    CPNotice(text: message, tone: store.isLiveCredentialSetupReady ? .positive : .warning)
                }
                if !store.showsLiveCredentialSetup && !store.showsLiveCredentialSyncPending {
                    assetSummary
                    quickActions
                    if needsAttention { currentFocus }
                    engineSection
                    historySection
                    recentActivitySection
                    paperValidationSafetyStatus

                    DisclosureGroup(isExpanded: $homeDetailsExpanded) {
                        paperValidationSection.padding(.top, 10)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("모의투자 성과 자세히 보기")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(CPColor.ink)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .tint(CPColor.blue)
                }
            }
            .cpPage()
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .refreshable {
            await store.refresh()
            await store.loadStocksStatus(force: true)
            await store.loadHorizonsStatus(force: true)
        }
        .refreshFeatureWhenVisible(enabled: !store.isBundledPreview && store.canOperate) {
            await store.loadStocksStatus(force: false)
            await store.loadHorizonsStatus(force: false)
        }
    }

    private var workspaceIdentity: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("CoinPilot")
                .font(.headline.weight(.bold))
                .foregroundColor(CPColor.blue)
            Spacer(minLength: 0)
            if store.isBundledPreview {
                CPBadge(text: "예시 데이터", tone: .info)
            } else if store.activeWorkspace == .live {
                CPLiveIndicator(compact: true)
            } else {
                CPBadge(text: store.activeWorkspace.title, tone: .info)
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var credentialStatusSection: some View {
        if store.showsLiveCredentialSetup {
            CoinPilotLiveCredentialSetupView(store: store)
        } else if store.showsLiveCredentialSyncPending {
            NativeCard {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeading(title: "실거래 계좌 확인 중")
                    Text("\(store.exchangeDisplayName) 키가 등록됐어요. 서버가 잔고와 미체결 주문을 확인할 때까지 실거래 주문은 잠겨 있습니다.")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private var paperValidationSafetyStatus: some View {
        if let summary = store.paperValidationSummary,
           summary.available || summary.cohort.available,
           summary.continuityEligible == false || summary.analysisContinuityEligible == false ||
            summary.riskContinuityEligible == false || summary.configSnapshotComplete == false ||
            summary.configurationConsistent == false || store.isResourceStale("paper-validation-summary") ||
            (summary.cohort.available && (!summary.cohort.complete || !summary.cohort.fresh)) {
            VStack(alignment: .leading, spacing: 2) {
                if store.isResourceStale("paper-validation-summary") {
                    InlineNotice(text: store.freshnessLabel(for: "paper-validation-summary"), color: CPColor.amber)
                }
                if summary.continuityEligible == false || summary.analysisContinuityEligible == false ||
                    summary.riskContinuityEligible == false {
                    InlineNotice(text: "기록이 끊겨 이어진 성과로 판단할 수 없어요.", color: CPColor.amber)
                }
                if summary.configSnapshotComplete == false || summary.configurationConsistent == false {
                    InlineNotice(text: "전략 설정 기록이 완전하지 않아 이 결과를 같은 조건의 비교로 볼 수 없어요.", color: CPColor.amber)
                }
                if summary.cohort.available && !summary.cohort.complete {
                    InlineNotice(text: "일부 기록을 읽지 못해 전체 집계를 사용할 수 없어요.", color: CPColor.amber)
                } else if summary.cohort.available && !summary.cohort.fresh {
                    InlineNotice(text: "전체 집계가 오래돼 최신 상태로 볼 수 없어요.", color: CPColor.amber)
                }
            }
        }
    }

    private var summary: CoinPilotHomeSummary {
        CoinPilotHomeSummary(store: store)
    }

    private var assetSummary: some View {
        let summary = summary
        return NativeCard {
            VStack(alignment: .leading, spacing: CPSpace.md) {
                HeroValue(
                    label: summary.includesOtherEngines ? "총자산 (코인·주식·포트폴리오)" : "총자산",
                    value: summary.total,
                    unavailable: store.account?.valuationAvailable == false ? "평가액 확인 불가" : "평가액 미제공",
                    change: summary.profit,
                    changePercent: summary.includesOtherEngines ? nil : store.totalProfitPercent,
                    changeLabel: summary.includesOtherEngines ? "누적 손익" : store.totalProfitLabel,
                    caption: accountModeLabel,
                    isLoading: !store.hasLoadedResource("account") && store.totalAssets == nil && !store.isBundledPreview
                )
                if summary.slices.count > 1 {
                    CPAllocationLegendBar(slices: summary.slices)
                }
                CPStatGrid(items: [
                    CPStatItem(label: store.quoteAssetLabel,
                               value: CoinPilotFormatting.won(store.account?.krwBalance, unavailable: "확인 필요")),
                    CPStatItem(label: "보유 코인 평가액",
                               value: CoinPilotFormatting.won(store.account?.completePositionsValue, unavailable: "확인 필요")),
                    CPStatItem(label: store.isObserverAccount ? "평가 기준 시각" : "오늘 실현 손익 (코인)",
                               value: todaySummaryValue,
                               tint: store.isObserverAccount ? CPColor.ink : CPColor.pnl(store.todayRealizedProfit)),
                    CPStatItem(label: "확인 시각", value: store.freshnessLabel(for: "account"), tint: CPColor.secondaryInk)
                ])
                ForEach(summary.notes, id: \.self) { note in
                    Text(note)
                        .font(.caption2)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var accountNeedsRefresh: Bool {
        guard !store.isBundledPreview else { return false }
        return !store.hasLoadedResource("account") || store.isResourceStale("account")
    }

    private var needsAttention: Bool {
        store.runtimeSafetyMessage != nil || accountNeedsRefresh ||
        store.account?.valuationAvailable == false || (store.account?.unvaluedPositionCount ?? 0) > 0
    }

    private var currentFocus: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("지금 확인할 내용")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(CPColor.blue)
                if let safetyMessage = store.runtimeSafetyMessage {
                    focusDescription("자동매매 상태를 확인해 주세요", detail: safetyMessage)
                    NavigationLink("주문 전 점검 보기", destination: CoinPilotResearchDeskView(store: store))
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                } else if store.isRefreshing && !store.hasLoadedResource("account") {
                    focusDescription("자산 정보를 확인하고 있어요", detail: "계좌를 불러오면 보유 비중과 손익을 보여드릴게요.")
                    ProgressView().tint(CPColor.blue)
                } else if accountNeedsRefresh {
                    focusDescription("자산 정보를 다시 확인해 주세요", detail: "최신 계좌 정보를 불러오지 못했어요. 마지막으로 확인한 정보가 표시될 수 있습니다.")
                    refreshAction
                } else if store.account?.valuationAvailable == false || (store.account?.unvaluedPositionCount ?? 0) > 0 {
                    focusDescription("일부 코인의 시세를 확인해야 해요", detail: "시세가 없는 코인은 평가액과 손익을 계산하지 않았어요. 보유 자산에서 확인할 수 있습니다.")
                    Button("보유 자산 확인") { CPNavigation.openCoins(.holdings) }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                } else if store.account?.hasPositionsField == true, store.account?.positions.isEmpty == true {
                    focusDescription("아직 보유한 코인이 없어요", detail: "시장 화면에서 가격과 최근 흐름을 살펴보세요. 보유 코인이 생기면 여기에서 자산 변화를 확인할 수 있어요.")
                    Button("시장 둘러보기") { CPNavigation.openCoins(.market) }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                } else {
                    focusDescription(store.isBundledPreview ? "예시 자산의 구성을 살펴보세요" : "내 자산이 어떻게 나뉘어 있는지 확인하세요",
                                     detail: "보유 비중과 코인별 손익을 함께 보면 전체 자산의 변화를 이해하기 쉬워요.")
                    Button("보유 비중과 손익 보기") { CPNavigation.openCoins(.holdings) }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                }
            }
        }
    }

    private func focusDescription(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline.weight(.semibold)).foregroundColor(CPColor.ink)
            Text(detail).font(.footnote).foregroundColor(CPColor.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var refreshAction: some View {
        Button(store.isRefreshing ? "확인 중" : "새로고침") {
            Task { await store.refresh() }
        }
        .buttonStyle(CoinPilotSecondaryButtonStyle())
        .disabled(store.isRefreshing)
    }

    /// 빠른 이동 — 가장 많이 쓰는 화면으로 바로.
    private var quickActions: some View {
        HStack(spacing: 10) {
            HomeQuickAction(title: "주문", symbol: "arrow.left.arrow.right", tint: CPColor.blue) {
                CPNavigation.openCoins(.order)
            }
            HomeQuickAction(title: "코인", symbol: "bitcoinsign.circle", tint: CPColor.up) {
                CPNavigation.openCoins(.holdings)
            }
            HomeQuickAction(title: "주식", symbol: "chart.bar.xaxis", tint: CPColor.green) {
                CPNavigation.open("stocks")
            }
            HomeQuickAction(title: "포트폴리오", symbol: "square.stack.3d.up", tint: CPColor.amber) {
                CPNavigation.open("portfolios")
            }
            NavigationLink(destination: CoinPilotActivityView(store: store)) {
                HomeQuickActionContent(title: "내역", symbol: "list.bullet.rectangle", tint: CPColor.secondaryInk)
            }
            .buttonStyle(CoinPilotPressableButtonStyle())
        }
        .accessibilityElement(children: .contain)
    }

    /// 스캘퍼 · 주식 · 기간별 포트폴리오 엔진 상태. 탭하면 해당 화면으로 이동합니다.
    private var engineSection: some View {
        CPCard("자동매매 엔진") {
            VStack(spacing: 0) {
                engineButton(destination: { CPNavigation.openCoins(.holdings) }) {
                    CPEngineStatus(
                        name: "코인 스캘퍼",
                        symbol: "bolt.circle",
                        isRunning: store.isBundledPreview ? nil : store.status?.isRunning,
                        detail: store.isBundledPreview ? "예시 데이터에서는 실행하지 않아요." : store.runtimeSafetyMessage,
                        isLive: store.activeWorkspace == .live && !store.isBundledPreview
                    )
                }
                if !store.isBundledPreview {
                    CPDivider()
                    engineButton(destination: { CPNavigation.open("stocks") }) {
                        stockEngineRow
                    }
                    CPDivider()
                    engineButton(destination: { CPNavigation.open("portfolios") }) {
                        horizonEngineRow(.coin)
                    }
                    CPDivider()
                    engineButton(destination: { CPNavigation.open("portfolios") }) {
                        horizonEngineRow(.stock)
                    }
                }
            }
        }
    }

    private func engineButton<Content: View>(destination: @escaping () -> Void, @ViewBuilder content: () -> Content) -> some View {
        Button(action: destination) {
            HStack(spacing: 6) {
                content()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(CPColor.secondaryInk)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(CoinPilotPressableButtonStyle())
    }

    @ViewBuilder
    private var stockEngineRow: some View {
        let trader = store.stocksStatus?.trader(for: store.activeWorkspace)
        if let status = store.stocksStatus, !status.isEnabled {
            CPEngineStatus(name: "주식 스캘퍼", symbol: "chart.bar.xaxis", isRunning: false, detail: "서버에서 꺼져 있어요")
        } else {
            CPEngineStatus(
                name: "주식 스캘퍼",
                symbol: "chart.bar.xaxis",
                isRunning: trader?.running,
                detail: trader?.market?.title ?? (store.stocksStatus == nil ? "상태 확인 중" : "이 서버에 트레이더 없음"),
                lastRun: trader?.lastCycleAt.map { "마지막 실행 · \(CoinPilotFormatting.dateTime($0))" },
                pausedReason: trader?.pauseLabel,
                isLive: trader?.isLive == true
            )
        }
    }

    @ViewBuilder
    private func horizonEngineRow(_ asset: CoinPilotHorizonAsset) -> some View {
        let runtime = store.horizonsStatus?.runtime(asset: asset, workspace: store.activeWorkspace)
        let passed = runtime?.research?.sleeves.filter { $0.passed == true }.count
        CPEngineStatus(
            name: "\(asset.title) 포트폴리오",
            symbol: "square.stack.3d.up",
            isRunning: store.horizonsStatus == nil ? nil : (runtime?.running ?? false),
            detail: runtime == nil
                ? (store.horizonsStatus == nil ? "상태 확인 중" : "서버에서 꺼져 있어요")
                : passed.map { "검증 통과 슬리브 \($0)개" } ?? "연구 결과 대기",
            lastRun: runtime?.lastCycleAt.map { "마지막 실행 · \(CoinPilotFormatting.dateTime($0))" },
            pausedReason: runtime?.pauseLabel,
            isLive: runtime?.isLive == true
        )
    }

    private var paperValidationSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading(title: "모의투자 성과 점검")
            if let summary = store.paperValidationSummary, summary.available || summary.cohort.available {
                NativeCard {
                    VStack(alignment: .leading, spacing: 9) {
                        if summary.available {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(summary.active == true ? "모의 실행 중" : "모의 실행 기록")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundColor(CPColor.ink)
                                MetadataLine(text: "마지막 기록 · \(CoinPilotFormatting.dateTime(summary.heartbeatAt))")
                                    .font(.caption2)
                                    .foregroundColor(CPColor.secondaryInk)
                            }
                            Spacer(minLength: 8)
                            MetadataLine(text: store.freshnessLabel(for: "paper-validation-summary"))
                                .font(.caption2.weight(.medium))
                                .foregroundColor(CPColor.secondaryInk)
                                .multilineTextAlignment(.trailing)
                                .lineLimit(2)
                        }

                        Rectangle()
                            .fill(CPColor.line)
                            .frame(height: 1)

                        Text("모의 장부")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(CPColor.secondaryInk)
                        PaperEvidenceRow(
                            title: "청산 표본",
                            value: tradeCountLabel(summary.strict.closedTradeCount),
                            tint: CPColor.ink
                        )
                        PaperEvidenceRow(
                            title: "기록 손익",
                            value: realizedProfitLabel(
                                summary.strict.realizedProfitKrw,
                                tradeCount: summary.strict.closedTradeCount
                            ),
                            tint: profitColor(summary.strict.realizedProfitKrw)
                        )
                        if let openCount = summary.strict.openPositionCount, openCount > 0 {
                            PaperEvidenceRow(
                                title: "열린 모의 포지션",
                                value: "\(openCount)건",
                                tint: CPColor.amber
                            )
                        }

                        if summary.costAudit.available {
                            Rectangle()
                                .fill(CPColor.line)
                                .frame(height: 1)
                            PaperEvidenceRow(
                                title: "가격 차이 반영 민감도",
                                value: realizedProfitLabel(
                                    summary.costAudit.costStressedNetPnlKrw,
                                    tradeCount: summary.costAudit.evaluatedTradeCount
                                ),
                                tint: profitColor(summary.costAudit.costStressedNetPnlKrw)
                            )
                            if let unmodeled = summary.costAudit.unmodeledExecutionTradeCount, unmodeled > 0 {
                                MetadataLine(text: "설정 가격 차이 추가 가정 · \(unmodeled)건")
                                    .font(.caption2)
                                    .foregroundColor(CPColor.secondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else if let modeled = summary.costAudit.modeledExecutionTradeCount, modeled > 0 {
                                MetadataLine(text: "기록된 모의 비용 모델 포함 · \(modeled)건")
                                    .font(.caption2)
                                    .foregroundColor(CPColor.secondaryInk)
                            }
                        } else {
                            Text("비용 민감도를 계산할 설정이나 청산 표본이 아직 없습니다.")
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if let count = summary.diagnostic.shadowClosedTradeCount {
                            Rectangle()
                                .fill(CPColor.line)
                                .frame(height: 1)
                            MetadataLine(text: "비교용 가상 장부 · 모의 장부 손익과 별도")
                                .font(.caption.weight(.semibold))
                                .foregroundColor(CPColor.secondaryInk)
                            PaperEvidenceRow(
                                title: "청산 \(count)건",
                                value: realizedProfitLabel(
                                    summary.diagnostic.shadowRealizedProfitKrw,
                                    tradeCount: count
                                ),
                                tint: profitColor(summary.diagnostic.shadowRealizedProfitKrw)
                            )
                        }
                        } else {
                            Text("현재 모의 실행은 없어요. 이전 실행의 전체 검증 집계를 표시합니다.")
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if summary.cohort.available {
                            Rectangle()
                                .fill(CPColor.line)
                                .frame(height: 1)
                            DisclosureGroup(isExpanded: $cohortDetailsExpanded) {
                                VStack(alignment: .leading, spacing: 8) {
                                    PaperEvidenceRow(
                                        title: "전체 집계 시각",
                                        value: CoinPilotFormatting.dateTime(summary.cohort.capturedAt),
                                        tint: CPColor.secondaryInk
                                    )
                                    PaperEvidenceRow(
                                        title: "전체 모의 청산",
                                        value: cohortTradeSummary(summary.cohort),
                                        tint: CPColor.ink
                                    )
                                    PaperEvidenceRow(
                                        title: "적격 수익성 거래",
                                        value: tradeCountLabel(summary.cohort.profitabilityEvidenceTradeCount),
                                        tint: (summary.cohort.profitabilityEvidenceTradeCount ?? 0) > 0
                                            ? CPColor.green
                                            : CPColor.amber
                                    )
                                    if let evidenceProfit = summary.cohort.profitabilityEvidenceProfitKrw,
                                       (summary.cohort.profitabilityEvidenceTradeCount ?? 0) > 0 {
                                        PaperEvidenceRow(
                                            title: "비용 점검 손익",
                                            value: CoinPilotFormatting.signedWon(evidenceProfit),
                                            tint: profitColor(evidenceProfit)
                                        )
                                    } else if (summary.cohort.profitabilityEvidenceTradeCount ?? 0) > 0 {
                                        Text("적격 거래는 있지만, 설정별로 나뉘어 손익 합계는 표시하지 않아요.")
                                            .font(.caption2)
                                            .foregroundColor(CPColor.secondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    } else if (summary.cohort.strictTradeCount ?? 0) > 0 {
                                        Text("기록은 있지만, 전체 조건을 통과한 수익성 표본은 아직 없어요.")
                                            .font(.caption2)
                                            .foregroundColor(CPColor.secondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    if let unverified = summary.cohort.strictCostUnverifiedTradeCount, unverified > 0 {
                                        PaperEvidenceRow(
                                            title: "비용 확인이 안 된 거래",
                                            value: "\(unverified)건",
                                            tint: CPColor.amber
                                        )
                                    }
                                    if let shortDays = summary.cohort.sessionsBelowMinimumObservationDays, shortDays > 0 {
                                        PaperEvidenceRow(
                                            title: "관측 기간 기준 미달",
                                            value: "\(shortDays)회",
                                            tint: CPColor.secondaryInk
                                        )
                                    }
                                    if let shortTrades = summary.cohort.sessionsBelowMinimumTradeCount, shortTrades > 0 {
                                        PaperEvidenceRow(
                                            title: "최소 거래 수 기준 미달",
                                            value: "\(shortTrades)회",
                                            tint: CPColor.secondaryInk
                                        )
                                    }
                                    if summary.cohort.totalStrictProfitComparable == false {
                                        Text("조건이 다른 실행의 기록 손익은 하나로 합산하지 않아요.")
                                            .font(.caption2)
                                            .foregroundColor(CPColor.secondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                .padding(.top, 8)
                            } label: {
                                HStack(spacing: 8) {
                                    Text("전체 수익 검증")
                                        .font(.caption.weight(.semibold))
                                        .foregroundColor(CPColor.ink)
                                    Spacer(minLength: 4)
                                    Text(cohortEvidenceLabel(summary.cohort))
                                        .font(.caption2.weight(.semibold))
                                        .foregroundColor(CPColor.amber)
                                        .lineLimit(1)
                                }
                            }
                            .tint(CPColor.blue)
                        }

                        Label("실제 체결·정산 자료 없음", systemImage: "info.circle.fill")
                            .font(.caption2.weight(.medium))
                            .foregroundColor(CPColor.blue)
                    }
                }
            } else {
                NativeCard {
                    EmptyMessage(text: store.hasLoadedResource("paper-validation-summary")
                        ? store.emptyResourceMessage(
                            for: "paper-validation-summary",
                            whenLoadedEmpty: "연결된 서버에 아직 모의투자 기록이 없어요."
                        )
                        : store.emptyResourceMessage(
                            for: "paper-validation-summary",
                            whenLoadedEmpty: "모의투자 기록을 확인할 수 없어요."
                        ))
                }
            }
        }
    }

    private func tradeCountLabel(_ count: Int?) -> String {
        guard let count else { return "표본 미제공" }
        return "\(count)건"
    }

    private func realizedProfitLabel(_ profit: Double?, tradeCount: Int?) -> String {
        guard let tradeCount else { return "손익 미제공" }
        guard tradeCount > 0 else { return "청산 표본 없음" }
        return CoinPilotFormatting.signedWon(profit)
    }

    private func cohortTradeSummary(_ cohort: CoinPilotPaperForwardCohortSummary) -> String {
        guard let trades = cohort.strictTradeCount,
              let sessions = cohort.strictTradeSessionCount else { return "표본 미제공" }
        return "\(trades)건 (\(sessions)회 실행)"
    }

    private func cohortEvidenceLabel(_ cohort: CoinPilotPaperForwardCohortSummary) -> String {
        guard cohort.complete, let trades = cohort.strictTradeCount,
              let eligible = cohort.eligibleStrictTradeCount else {
            return cohort.available ? "확인 필요" : "미제공"
        }
        guard trades > 0 else { return "기록 없음" }
        return "\(eligible) / \(trades)건 적격"
    }

    private var historySection: some View {
        CoinPilotHistoryCard(store: store)
    }

    private var recentActivitySection: some View {
        let fills = CoinPilotHomeFill.recent(store: store, limit: 5)
        return NativeCard {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    SectionHeading(title: "최근 체결")
                    Spacer()
                    NavigationLink(destination: CoinPilotActivityView(store: store)) {
                        Text("전체 보기")
                            .font(.subheadline.weight(.medium))
                            .foregroundColor(CPColor.blue)
                            .frame(minHeight: 44)
                    }
                }
                MetadataLine(text: store.freshnessLabel(for: "trades"))
                    .font(.caption2)
                    .foregroundColor(CPColor.secondaryInk)
                if fills.isEmpty {
                    EmptyMessage(text: store.emptyResourceMessage(for: "trades", whenLoadedEmpty: "아직 거래 내역이 없어요."), image: "CoinPilotEmptyTrades",
                                 actionTitle: store.hasLoadedResource("trades") ? "시장 둘러보기" : "다시 불러오기",
                                 isActionDisabled: store.isRefreshing) {
                        if store.hasLoadedResource("trades") { CPNavigation.openCoins(.market) }
                        else { Task { await store.refresh() } }
                    }
                } else {
                    VStack(spacing: 0) {
                        ForEach(fills) { fill in
                            fill.row
                            if fill.id != fills.last?.id {
                                CPDivider()
                            }
                        }
                    }
                }
            }
        }
    }

    private var todaySummaryValue: String {
        if store.isObserverAccount {
            if let value = store.account?.valuationAsOf {
                return CoinPilotFormatting.dateTime(value)
            }
            return "시각 미제공"
        }
        return CoinPilotFormatting.signedWon(store.todayRealizedProfit)
    }

    private var accountModeLabel: String {
        if store.isBundledPreview { return "예시" }
        if store.isObserverAccount { return "조회 전용" }
        switch store.tradingMode {
        case "DRY_RUN": return "모의투자"
        case "LIVE": return "실거래"
        default: return "상태 확인 중"
        }
    }

}
