import SwiftUI

/// Home answers two questions, top to bottom:
///   1. 지금 안전한가?   — engine, stop reason, protective mode, open positions
///                         with their exits, account loss guard.
///   2. 비용 빼고도 벌고 있나? — realized net P&L after fees and slippage,
///                         versus holding BTC, with an honest confidence line.
/// Everything else (account totals, fills, other engines) sits below.
struct CoinPilotHomeView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var cohortDetailsExpanded = false
    @State private var homeDetailsExpanded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                workspaceIdentity
                if store.isBundledPreview {
                    CPNotice(text: "앱 내장 예시 자료. 실제 계좌 아님.", tone: .info)
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
                    TimelineView(.periodic(from: Date(), by: 15)) { context in
                        VStack(alignment: .leading, spacing: 14) {
                            safetySection(now: context.date)
                            positionsSection(now: context.date)
                        }
                    }
                    scorecardSection
                    accountSection
                    recentActivitySection
                    otherEnginesSection
                    paperValidationSafetyStatus

                    DisclosureGroup(isExpanded: $homeDetailsExpanded) {
                        paperValidationSection.padding(.top, 10)
                    } label: {
                        Text("모의투자 성과 점검 자세히 보기")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(CPColor.ink)
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
            await store.loadScorecard(force: true)
            await store.loadStocksStatus(force: true)
            await store.loadHorizonsStatus(force: true)
        }
        .refreshFeatureWhenVisible(enabled: !store.isBundledPreview && !store.isBundledLocalMarketData) {
            await store.loadScorecard(force: false)
            if store.canOperate {
                await store.loadStocksStatus(force: false)
                await store.loadHorizonsStatus(force: false)
            }
        }
    }

    // MARK: Header

    private var workspaceIdentity: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Text("CoinPilot")
                    .font(.headline.weight(.bold))
                    .foregroundColor(CPColor.ink)
                Spacer(minLength: 0)
                modeBadge
            }
            Text("마지막 업데이트 \(HomeTime.clock(store.lastCheckedAt))")
                .font(.caption2)
                .monospacedDigit()
                .foregroundColor(store.isResourceStale("status") ? CPColor.amber : CPColor.secondaryInk)
                .accessibilityLabel("마지막 업데이트 \(HomeTime.clock(store.lastCheckedAt))")
        }
        .accessibilityElement(children: .contain)
    }

    /// Filled red block for LIVE, outlined box for paper: the two never look alike.
    @ViewBuilder
    private var modeBadge: some View {
        if store.isBundledPreview {
            HomeOutlinedBadge(text: "예시 데이터", color: CPColor.secondaryInk)
        } else if store.activeWorkspace == .live {
            CPLiveIndicator()
        } else {
            HomeOutlinedBadge(text: "모의 · 가상 자금", color: CPColor.blue)
                .accessibilityLabel("모의투자 작업공간. 실제 자금이 사용되지 않습니다")
        }
    }

    @ViewBuilder
    private var credentialStatusSection: some View {
        if store.showsLiveCredentialSetup {
            CoinPilotLiveCredentialSetupView(store: store)
        } else if store.showsLiveCredentialSyncPending {
            NativeCard {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeading(title: "실거래 계좌 확인 중")
                    Text("\(store.exchangeDisplayName) 키 등록됨. 서버의 잔고·미체결 주문 확인 전까지 실거래 주문 잠금.")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: 1. 지금 안전한가?

    private func safetySection(now: Date) -> some View {
        let state = HomeEngineState.resolve(store: store, now: now)
        let activity = store.status?.engineActivity
        return CPCard("지금 안전한가?") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Rectangle()
                        .fill(state.color)
                        .frame(width: 3, height: 18)
                        .accessibilityHidden(true)
                    Text(state.title)
                        .font(.title3.weight(.bold))
                        .foregroundColor(CPColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(state.detail)
                    .font(.subheadline)
                    .foregroundColor(CPColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let next = state.nextStep {
                    Text("다음 조치 · \(next)")
                        .font(.footnote)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if state.offersControl {
                    Button("자동매매 제어 열기") { CPNavigation.openCoins(.holdings) }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                }

                if !store.isBundledPreview, store.status != nil {
                    CPStatGrid(items: engineRows(activity: activity, now: now) + [lossGuardRow])
                }
            }
        }
    }

    private func engineRows(activity: CoinPilotEngineActivity?, now: Date) -> [CPStatItem] {
        guard let activity else {
            return [CPStatItem(label: "마지막 분석", value: "서버 미제공", tint: CPColor.secondaryInk)]
        }
        let markets = activity.lastCycleMarkets.map { count -> String in
            let quiet = activity.lastCycleInactive ?? 0
            return quiet > 0 ? "\(count)개 시장 (거래 없음 \(quiet))" : "\(count)개 시장"
        } ?? "시장 수 미제공"
        var rows = [
            CPStatItem(label: "마지막 분석",
                       value: "\(HomeTime.moment(activity.lastCycleDate, now: now)) · \(HomeTime.ago(activity.lastCycleDate, now: now))",
                       tint: CPColor.ink),
            CPStatItem(label: "분석 범위", value: markets),
            CPStatItem(label: "최근 1시간",
                       value: "신호 \(activity.signalsLastHour ?? 0)건 · 진입 \(activity.entriesLastHour ?? 0)건")
        ]
        if store.activeWorkspace == .live {
            rows.append(CPStatItem(label: "거래소 잔고 동기화",
                                   value: activity.lastExchangeSyncAt.map {
                                       HomeTime.moment(HomeTime.date($0), now: now)
                                   } ?? "기록 없음",
                                   tint: activity.lastExchangeSyncAt == nil ? CPColor.amber : CPColor.ink))
        }
        return rows
    }

    private var lossGuardRow: CPStatItem {
        guard let guardState = store.status?.accountLossGuard else {
            return CPStatItem(label: "손실 가드", value: "서버 미제공", tint: CPColor.secondaryInk)
        }
        guard guardState.enabled == true else {
            return CPStatItem(label: "손실 가드", value: "꺼짐 · 한도 미설정", tint: CPColor.secondaryInk)
        }
        if guardState.blocked == true {
            let reason = guardState.blockedReason == "daily_loss_limit" ? "일일 손실 한도 도달" : "자산 하한 미달"
            return CPStatItem(label: "손실 가드", value: "작동 · \(reason) · 신규 진입 차단", tint: CPColor.red)
        }
        var parts: [String] = []
        if let limit = guardState.dailyLossLimit, limit > 0 {
            parts.append("오늘 \(CoinPilotFormatting.signedWon(guardState.realizedToday)) / 한도 −\(CoinPilotFormatting.won(limit))")
        }
        if let floor = guardState.equityFloor, floor > 0 {
            parts.append("자산 \(CoinPilotFormatting.won(guardState.equity, unavailable: "미확인")) / 하한 \(CoinPilotFormatting.won(floor))")
        }
        return CPStatItem(label: "손실 가드", value: parts.isEmpty ? "정상" : "정상 · " + parts.joined(separator: " · "),
                          tint: CPColor.ink)
    }

    @ViewBuilder
    private func positionsSection(now: Date) -> some View {
        if !store.isBundledPreview {
            let positions = store.scorecard?.openPositions ?? []
            CPCard("보유 포지션", trailing: {
                Text(store.scorecard == nil ? "확인 전" : "\(positions.count)개")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundColor(CPColor.secondaryInk)
            }) {
                if store.scorecard == nil {
                    EmptyMessage(text: scorecardUnavailableText)
                } else if positions.isEmpty {
                    Text("열린 포지션 없음 · 시장 변동에 노출된 자금 없음")
                        .font(.subheadline)
                        .foregroundColor(CPColor.secondaryInk)
                } else {
                    VStack(spacing: 0) {
                        ForEach(positions) { position in
                            HomePositionRow(position: position, now: now)
                            if position.id != positions.last?.id { CPDivider() }
                        }
                    }
                    if store.status?.isRunning == false,
                       store.status?.runtimeState != "PROTECTIVE_ONLY" {
                        InlineNotice(text: "엔진 정지 중 · 위 손절·최대 보유 청산이 실행되지 않습니다", color: CPColor.red)
                    }
                }
            }
        }
    }

    // MARK: 2. 비용 빼고도 벌고 있나?

    @ViewBuilder
    private var scorecardSection: some View {
        if !store.isBundledPreview {
            CPCard("비용 빼고도 벌고 있나?") {
                if let card = store.scorecard, card.available != false {
                    scorecardBody(card)
                } else if let card = store.scorecard, card.reason == "read_only_observer" {
                    EmptyMessage(text: "조회 전용 서버는 성과 집계를 제공하지 않습니다. 아래 모의투자 성과 점검을 참고하세요.")
                } else {
                    EmptyMessage(text: scorecardUnavailableText,
                                 actionTitle: "다시 불러오기",
                                 isActionDisabled: store.refreshingFeatureGroups.contains(CoinPilotStore.scorecardFeatureKey)) {
                        Task { await store.loadScorecard(force: true) }
                    }
                }
            }
        }
    }

    private var scorecardUnavailableText: String {
        if store.refreshingFeatureGroups.contains(CoinPilotStore.scorecardFeatureKey) { return "불러오는 중" }
        if let message = store.featureMessages[CoinPilotStore.scorecardFeatureKey] {
            return "성과 집계를 불러오지 못함 · \(message)"
        }
        return "성과 집계 확인 전"
    }

    private func scorecardBody(_ card: CoinPilotScorecard) -> some View {
        let confidence = HomeConfidence(scorecard: card)
        let count = card.tradeCount ?? 0
        let start = HomeTime.date(card.periodStartAt)
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(count > 0 ? "\(HomeTime.day(start))부터 실현 순손익" : "실현 순손익")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CPColor.secondaryInk)
                Text(CoinPilotFormatting.signedWon(count > 0 ? card.realizedNetProfit : 0))
                    .font(.system(size: 30, weight: .bold))
                    .monospacedDigit()
                    .foregroundColor(count > 0 ? CPColor.pnl(card.realizedNetProfit) : CPColor.secondaryInk)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text(costLine(card))
                    .font(.caption)
                    .foregroundColor(card.costs?.slippageBooked == false || (card.costs?.unmodeledTradeCount ?? 0) > 0
                                     ? CPColor.amber : CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }

            CPNoticeBody(text: confidence.text, color: confidence.color)

            if count > 0 {
                CPStatGrid(items: [
                    CPStatItem(label: "청산 거래", value: "\(count)건"),
                    CPStatItem(label: "승률",
                               value: card.winRatePercent.map {
                                   "\(String(format: "%.1f", $0))% (\(card.winCount ?? 0)/\(count))"
                               } ?? "—"),
                    CPStatItem(label: "거래당 평균 순수익",
                               value: HomeConfidence.percent(card.avgNetReturnPercent),
                               tint: CPColor.pnl(card.avgNetReturnPercent)),
                    CPStatItem(label: "비용 전 평균 · 평균 비용",
                               value: "\(HomeConfidence.percent(card.avgGrossReturnPercent)) · \(card.avgCostPercent.map { String(format: "%.3f%%", $0) } ?? "—")",
                               tint: CPColor.secondaryInk),
                    CPStatItem(label: "오늘 (KST)",
                               value: "\(card.today?.tradeCount ?? 0)건 · \(CoinPilotFormatting.signedWon(card.today?.realizedNetProfit ?? 0))",
                               tint: CPColor.pnl(card.today?.realizedNetProfit))
                ])
                benchmarkBlock(card)
            }

            Text("미실현 손익 제외 · 확인 \(HomeTime.clock(store.featureLastSuccessfulAt[CoinPilotStore.scorecardFeatureKey]))")
                .font(.caption2)
                .monospacedDigit()
                .foregroundColor(CPColor.secondaryInk)
        }
    }

    private func costLine(_ card: CoinPilotScorecard) -> String {
        guard let costs = card.costs else { return "비용 반영 방식 미제공" }
        if costs.source == "exchange_fills" {
            return "실제 체결가·수수료 기준"
        }
        let fee = costs.feeRate.map { String(format: "%.2f%%", $0 * 100) } ?? "—"
        guard costs.slippageBooked == true, let slippage = costs.slippageRate else {
            return "수수료 \(fee)×2만 반영 · 슬리피지 미반영이라 실제보다 좋게 보일 수 있음"
        }
        let base = "수수료 \(fee)×2 · 슬리피지 \(String(format: "%.2f%%", slippage * 100))×2 반영 (모의 체결)"
        if let unmodeled = costs.unmodeledTradeCount, unmodeled > 0 {
            return "\(base) · 단, \(unmodeled)건은 슬리피지 반영 이전 기록이라 실제보다 좋게 보일 수 있음"
        }
        return base
    }

    @ViewBuilder
    private func benchmarkBlock(_ card: CoinPilotScorecard) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("같은 기간 BTC 그냥 보유와 비교")
                .font(.caption.weight(.semibold))
                .foregroundColor(CPColor.secondaryInk)
            if let comparison = card.comparison, let hold = comparison.holdReturnPercent {
                PaperEvidenceRow(title: "전략 (실현, 시드 기준)",
                                 value: CoinPilotFormatting.percent(comparison.strategyReturnOnSeedPercent),
                                 tint: CPColor.pnl(comparison.strategyReturnOnSeedPercent))
                PaperEvidenceRow(title: "BTC 보유",
                                 value: "\(CoinPilotFormatting.percent(hold)) (\(CoinPilotFormatting.signedWon(comparison.holdProfit)))",
                                 tint: CPColor.pnl(hold))
                if let excess = comparison.excessReturnPercent {
                    Text(excess >= 0
                         ? "BTC 보유보다 \(String(format: "%.2f", excess))%p 앞섬"
                         : "BTC 보유보다 \(String(format: "%.2f", -excess))%p 뒤처짐")
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                        .foregroundColor(CPColor.ink)
                }
                if card.benchmark?.coversFullPeriod == false {
                    Text("BTC 비교는 최근 200일만 반영")
                        .font(.caption2)
                        .foregroundColor(CPColor.amber)
                }
            } else {
                Text(benchmarkUnavailableText(card))
                    .font(.footnote)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func benchmarkUnavailableText(_ card: CoinPilotScorecard) -> String {
        switch card.benchmark?.reason {
        case "exchange_not_supported": return "이 거래소에서는 BTC 비교 미지원"
        case "fetch_failed": return "BTC 일봉을 불러오지 못해 비교 불가 · 새로고침 시 다시 시도"
        default: return card.comparison == nil && card.benchmark?.available == true
            ? "시드 금액이 없어 비교 불가"
            : "BTC 비교 자료 없음"
        }
    }

    // MARK: Below the two questions

    private var accountSection: some View {
        let summary = CoinPilotHomeSummary(store: store)
        return CPCard(summary.includesOtherEngines ? "계좌 (코인·주식·포트폴리오)" : "계좌") {
            VStack(alignment: .leading, spacing: 4) {
                CPStatGrid(items: [
                    CPStatItem(label: "총자산", value: totalValueText(summary)),
                    CPStatItem(label: summary.includesOtherEngines ? "누적 손익 (평가 포함)" : store.totalProfitLabel + " (평가 포함)",
                               value: CoinPilotFormatting.signedWon(summary.profit),
                               tint: CPColor.pnl(summary.profit)),
                    CPStatItem(label: store.quoteAssetLabel,
                               value: CoinPilotFormatting.won(store.account?.krwBalance, unavailable: "확인 필요")),
                    CPStatItem(label: "보유 코인 평가액",
                               value: CoinPilotFormatting.won(store.account?.completePositionsValue, unavailable: "확인 필요")),
                    CPStatItem(label: "확인 시각", value: store.freshnessLabel(for: "account"),
                               tint: store.isResourceStale("account") ? CPColor.amber : CPColor.secondaryInk)
                ])
                ForEach(summary.notes, id: \.self) { note in
                    Text(note)
                        .font(.caption2)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if store.account?.valuationAvailable == false || (store.account?.unvaluedPositionCount ?? 0) > 0 {
                    InlineNotice(text: "일부 코인 시세 없음 · 평가액·평가 손익에서 제외", color: CPColor.amber)
                }
            }
        }
    }

    private func totalValueText(_ summary: CoinPilotHomeSummary) -> String {
        if !store.hasLoadedResource("account") && summary.total == nil && !store.isBundledPreview { return "불러오는 중" }
        return CoinPilotFormatting.won(summary.total,
                                       unavailable: store.account?.valuationAvailable == false ? "평가액 확인 불가" : "평가액 미제공")
    }

    private var recentActivitySection: some View {
        let fills = CoinPilotHomeFill.recent(store: store, limit: 5)
        return CPCard("최근 체결", trailing: {
            NavigationLink(destination: CoinPilotActivityView(store: store)) {
                Text("전체 보기")
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(CPColor.blue)
                    .frame(minHeight: 44)
            }
        }) {
            VStack(alignment: .leading, spacing: 6) {
                MetadataLine(text: store.freshnessLabel(for: "trades"))
                    .font(.caption2)
                    .foregroundColor(CPColor.secondaryInk)
                if fills.isEmpty {
                    EmptyMessage(text: store.emptyResourceMessage(for: "trades", whenLoadedEmpty: "체결 내역 없음"),
                                 actionTitle: store.hasLoadedResource("trades") ? nil : "다시 불러오기",
                                 isActionDisabled: store.isRefreshing) {
                        Task { await store.refresh() }
                    }
                } else {
                    VStack(spacing: 0) {
                        ForEach(fills) { fill in
                            fill.row
                            if fill.id != fills.last?.id { CPDivider() }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var otherEnginesSection: some View {
        if !store.isBundledPreview {
            CPCard("다른 엔진") {
                VStack(spacing: 0) {
                    engineButton(destination: { CPNavigation.open("stocks") }) { stockEngineRow }
                    CPDivider()
                    engineButton(destination: { CPNavigation.open("portfolios") }) { horizonEngineRow(.coin) }
                    CPDivider()
                    engineButton(destination: { CPNavigation.open("portfolios") }) { horizonEngineRow(.stock) }
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
            CPEngineStatus(name: "주식 스캘퍼", symbol: "chart.bar.xaxis", isRunning: false, detail: "서버에서 꺼짐")
        } else {
            CPEngineStatus(
                name: "주식 스캘퍼",
                symbol: "chart.bar.xaxis",
                isRunning: trader?.running,
                detail: trader?.market?.title ?? (store.stocksStatus == nil ? "상태 확인 중" : "이 서버에 트레이더 없음"),
                lastRun: trader?.lastCycleAt.map { "마지막 실행 · \(HomeTime.moment(HomeTime.date($0)))" },
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
                ? (store.horizonsStatus == nil ? "상태 확인 중" : "서버에서 꺼짐")
                : passed.map { "검증 통과 슬리브 \($0)개" } ?? "연구 결과 대기",
            lastRun: runtime?.lastCycleAt.map { "마지막 실행 · \(HomeTime.moment(HomeTime.date($0)))" },
            pausedReason: runtime?.pauseLabel,
            isLive: runtime?.isLive == true
        )
    }

    // MARK: Paper validation detail (unchanged evidence, collapsed)

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
                    InlineNotice(text: "기록 끊김 · 연속 성과로 볼 수 없음", color: CPColor.amber)
                }
                if summary.configSnapshotComplete == false || summary.configurationConsistent == false {
                    InlineNotice(text: "전략 설정 기록 불완전 · 동일 조건 비교 불가", color: CPColor.amber)
                }
                if summary.cohort.available && !summary.cohort.complete {
                    InlineNotice(text: "일부 기록 읽기 실패 · 전체 집계 사용 불가", color: CPColor.amber)
                } else if summary.cohort.available && !summary.cohort.fresh {
                    InlineNotice(text: "전체 집계 오래됨", color: CPColor.amber)
                }
            }
        }
    }

    private var paperValidationSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let summary = store.paperValidationSummary, summary.available || summary.cohort.available {
                NativeCard {
                    VStack(alignment: .leading, spacing: 9) {
                        if summary.available {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(summary.active == true ? "모의 점검 실행 중" : "모의 점검 기록")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundColor(CPColor.ink)
                                    MetadataLine(text: "마지막 기록 · \(HomeTime.moment(HomeTime.date(summary.heartbeatAt)))")
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
                            CPDivider()
                            PaperEvidenceRow(title: "청산 표본",
                                             value: tradeCountLabel(summary.strict.closedTradeCount),
                                             tint: CPColor.ink)
                            PaperEvidenceRow(title: "기록 손익",
                                             value: realizedProfitLabel(summary.strict.realizedProfitKrw,
                                                                        tradeCount: summary.strict.closedTradeCount),
                                             tint: profitColor(summary.strict.realizedProfitKrw))
                            if let openCount = summary.strict.openPositionCount, openCount > 0 {
                                PaperEvidenceRow(title: "열린 모의 포지션", value: "\(openCount)건", tint: CPColor.amber)
                            }
                            if summary.costAudit.available {
                                CPDivider()
                                PaperEvidenceRow(title: "가격 차이 반영 민감도",
                                                 value: realizedProfitLabel(summary.costAudit.costStressedNetPnlKrw,
                                                                            tradeCount: summary.costAudit.evaluatedTradeCount),
                                                 tint: profitColor(summary.costAudit.costStressedNetPnlKrw))
                                if let unmodeled = summary.costAudit.unmodeledExecutionTradeCount, unmodeled > 0 {
                                    MetadataLine(text: "설정 가격 차이 추가 가정 · \(unmodeled)건")
                                        .font(.caption2)
                                        .foregroundColor(CPColor.secondaryInk)
                                } else if let modeled = summary.costAudit.modeledExecutionTradeCount, modeled > 0 {
                                    MetadataLine(text: "기록된 모의 비용 모델 포함 · \(modeled)건")
                                        .font(.caption2)
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                            }
                            if let count = summary.diagnostic.shadowClosedTradeCount {
                                CPDivider()
                                MetadataLine(text: "비교용 가상 장부 · 모의 장부 손익과 별도")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(CPColor.secondaryInk)
                                PaperEvidenceRow(title: "청산 \(count)건",
                                                 value: realizedProfitLabel(summary.diagnostic.shadowRealizedProfitKrw,
                                                                            tradeCount: count),
                                                 tint: profitColor(summary.diagnostic.shadowRealizedProfitKrw))
                            }
                        } else {
                            Text("현재 모의 점검 실행 없음 · 이전 실행 집계 표시")
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                        }

                        if summary.cohort.available {
                            CPDivider()
                            DisclosureGroup(isExpanded: $cohortDetailsExpanded) {
                                VStack(alignment: .leading, spacing: 8) {
                                    PaperEvidenceRow(title: "전체 집계 시각",
                                                     value: HomeTime.moment(HomeTime.date(summary.cohort.capturedAt)),
                                                     tint: CPColor.secondaryInk)
                                    PaperEvidenceRow(title: "전체 모의 청산", value: cohortTradeSummary(summary.cohort), tint: CPColor.ink)
                                    PaperEvidenceRow(title: "적격 수익성 거래",
                                                     value: tradeCountLabel(summary.cohort.profitabilityEvidenceTradeCount),
                                                     tint: CPColor.ink)
                                    if let evidenceProfit = summary.cohort.profitabilityEvidenceProfitKrw,
                                       (summary.cohort.profitabilityEvidenceTradeCount ?? 0) > 0 {
                                        PaperEvidenceRow(title: "비용 점검 손익",
                                                         value: CoinPilotFormatting.signedWon(evidenceProfit),
                                                         tint: profitColor(evidenceProfit))
                                    }
                                    if let unverified = summary.cohort.strictCostUnverifiedTradeCount, unverified > 0 {
                                        PaperEvidenceRow(title: "비용 확인이 안 된 거래", value: "\(unverified)건", tint: CPColor.amber)
                                    }
                                    if summary.cohort.totalStrictProfitComparable == false {
                                        Text("조건이 다른 실행의 손익은 합산하지 않음")
                                            .font(.caption2)
                                            .foregroundColor(CPColor.secondaryInk)
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

                        Text("실제 체결·정산 자료 없음")
                            .font(.caption2.weight(.medium))
                            .foregroundColor(CPColor.secondaryInk)
                    }
                }
            } else {
                NativeCard {
                    EmptyMessage(text: store.emptyResourceMessage(
                        for: "paper-validation-summary",
                        whenLoadedEmpty: store.hasLoadedResource("paper-validation-summary") ? "모의투자 점검 기록 없음" : "모의투자 점검 기록 확인 불가"
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
}

// MARK: - Pieces

/// Outlined text badge; used for paper so it never resembles the filled LIVE block.
private struct HomeOutlinedBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .overlay(RoundedRectangle(cornerRadius: 3, style: .continuous).stroke(color, lineWidth: 1))
    }
}

/// One open position: where it stops out and when max-hold closes it.
private struct HomePositionRow: View {
    let position: CoinPilotScorecard.Position
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(CoinPilotFormatting.ticker(position.coin))
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                Text("진입 \(CoinPilotFormatting.price(position.entryPrice)) · \(HomeTime.moment(HomeTime.date(position.entryTime), now: now))")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundColor(CPColor.secondaryInk)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 6)
                Text(position.unrealizedReturnPercent.map { HomeConfidence.percent($0) } ?? "시세 확인 불가")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundColor(CPColor.pnl(position.unrealizedReturnPercent))
            }
            PaperEvidenceRow(
                title: position.protectiveStopArmed == true ? "손절가 (보호 손절로 상향됨)" : "손절가",
                value: stopText,
                tint: CPColor.ink
            )
            PaperEvidenceRow(
                title: "최대 보유 청산",
                value: holdText,
                tint: maxHoldOverdue ? CPColor.red : CPColor.ink
            )
            if let losing = HomeTime.date(position.losingHoldExitAt), losing > now {
                PaperEvidenceRow(title: "손실 시 조기 청산",
                                 value: "\(HomeTime.moment(losing, now: now)) · \(HomeTime.remaining(until: losing, now: now))",
                                 tint: CPColor.secondaryInk)
            }
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private var stopText: String {
        guard let stop = position.stopLossPrice else { return "미제공" }
        let percent = position.stopLossPercent.map { " (−\(String(format: "%.2f", $0))%)" } ?? ""
        return "\(CoinPilotFormatting.price(stop))\(percent)"
    }

    private var holdText: String {
        guard let deadline = HomeTime.date(position.maxHoldExitAt) else { return "설정 없음" }
        return "\(HomeTime.moment(deadline, now: now)) · \(HomeTime.remaining(until: deadline, now: now))"
    }

    private var maxHoldOverdue: Bool {
        guard let deadline = HomeTime.date(position.maxHoldExitAt) else { return false }
        return deadline.addingTimeInterval(60) < now
    }
}
