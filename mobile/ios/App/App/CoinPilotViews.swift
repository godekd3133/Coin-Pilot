import SwiftUI

private enum CoinPilotColors {
    static let paper = Color(red: 249 / 255, green: 250 / 255, blue: 251 / 255)
    static let surface = Color.white
    static let ink = Color(red: 25 / 255, green: 31 / 255, blue: 40 / 255)
    static let secondaryInk = Color(red: 107 / 255, green: 118 / 255, blue: 132 / 255)
    static let line = Color(red: 229 / 255, green: 232 / 255, blue: 235 / 255)
    static let blue = Color(red: 27 / 255, green: 100 / 255, blue: 218 / 255)
    static let green = Color(red: 2 / 255, green: 118 / 255, blue: 72 / 255)
    static let red = Color(red: 165 / 255, green: 25 / 255, blue: 38 / 255)
    static let amber = Color(red: 0.62, green: 0.43, blue: 0.16)
}

struct CoinPilotNativeRootView: View {
    @StateObject private var store = CoinPilotStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if store.phase == .dashboard {
                CoinPilotTabView(store: store)
            } else if !store.didFinishInitialConnect {
                CoinPilotStartupView()
            } else {
                CoinPilotConnectionView(store: store)
            }
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .preferredColorScheme(.light)
        .tint(CoinPilotColors.blue)
        .animation(.easeInOut(duration: 0.2), value: store.phase)
        .task { await store.bootstrap() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            if store.phase == .dashboard { await store.refresh() }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                } catch {
                    return
                }
                guard store.phase == .dashboard else { continue }
                await store.refresh()
            }
        }
    }
}

private struct CoinPilotStartupView: View {
    var body: some View {
        VStack(spacing: 14) {
            Text("CoinPilot")
                .font(.title2.weight(.bold))
                .foregroundColor(CoinPilotColors.blue)
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: CoinPilotColors.blue))
            Text("계좌 화면을 준비하고 있어요")
                .font(.body.weight(.medium))
                .foregroundColor(CoinPilotColors.secondaryInk)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CoinPilotColors.paper.ignoresSafeArea())
    }
}

private struct CoinPilotConnectionView: View {
    @ObservedObject var store: CoinPilotStore
    @FocusState private var tokenFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("CoinPilot")
                        .font(.headline.weight(.bold))
                        .foregroundColor(CoinPilotColors.blue)
                    Spacer()
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(store.phase == .login ? "서버에 로그인하세요" : "서버 주소를 입력하세요")
                        .font(.title.weight(.bold))
                        .foregroundColor(CoinPilotColors.ink)
                    Text(store.phase == .login
                         ? "읽기 전용 토큰으로 계좌와 거래 기록을 불러옵니다."
                         : "연결 후 자산과 거래 기록을 이 앱에서 확인할 수 있어요.")
                        .font(.body)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 10) {
                    FieldTitle(title: "서버 주소")
                    TextField("https://example.com", text: $store.serverDraft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .padding(.horizontal, 15)
                        .frame(minHeight: 54)
                        .background(CoinPilotColors.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(CoinPilotColors.line, lineWidth: 1))
                        .accessibilityLabel("서버 주소")
                    Text("같은 Wi-Fi의 서버는 내부 주소로, 외부 서버는 HTTPS 주소로 연결해 주세요.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }

                if store.phase == .login {
                    VStack(alignment: .leading, spacing: 10) {
                        FieldTitle(title: "읽기 전용 토큰")
                        SecureField("토큰 입력", text: $store.tokenDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .textFieldStyle(.plain)
                            .font(.body)
                            .padding(.horizontal, 15)
                            .frame(minHeight: 54)
                            .background(CoinPilotColors.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(CoinPilotColors.line, lineWidth: 1))
                            .focused($tokenFocused)
                            .accessibilityLabel("읽기 전용 서버 토큰")
                        Text(tokenStorageNotice)
                            .font(.footnote)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                    }
                }

                if let message = store.connectionMessage {
                    Text(message)
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(CoinPilotColors.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.updatesFrequently)
                }

                Button {
                    tokenFocused = false
                    Task { await store.primaryConnectionAction() }
                } label: {
                    HStack(spacing: 9) {
                        if store.isWorking { ProgressView().tint(.white) }
                        Text(store.isWorking ? "연결 중" : store.phase == .login ? "로그인" : store.phase == .setup ? "서버 확인" : "다시 연결")
                            .font(.headline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 54)
                    .foregroundColor(.white)
                    .background(CoinPilotColors.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
                .disabled(store.isWorking)

                if store.canUseBundledPreview {
                    Button {
                        store.useBundledPreview()
                    } label: {
                        HStack(spacing: 8) {
                            Text("예시 데이터로 둘러보기")
                                .font(.body.weight(.semibold))
                            Image(systemName: "arrow.right")
                                .font(.footnote.weight(.semibold))
                        }
                        .foregroundColor(CoinPilotColors.blue)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                }

                Label("조회 전용 · 주문은 실행하지 않습니다", systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 22)
            .padding(.top, 20)
            .padding(.bottom, 36)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
    }

    private var tokenStorageNotice: String {
#if targetEnvironment(simulator)
        return "Simulator에서는 앱이 실행되는 동안만 임시 보관됩니다. 앱을 다시 열면 토큰을 입력해 주세요."
#else
        return "토큰은 이 기기의 보안 저장소에 보관됩니다."
#endif
    }
}

private struct FieldTitle: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.body.weight(.semibold))
            .foregroundColor(CoinPilotColors.ink)
    }
}

private struct CoinPilotTabView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage("coinpilot.native.selectedTab") private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationView {
                CoinPilotHomeView(store: store)
                    .navigationTitle("홈")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { refreshToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .tabItem { Label("홈", systemImage: "house") }
            .tag(0)

            NavigationView {
                CoinPilotAssetsView(store: store)
                    .navigationTitle("보유 자산")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { refreshToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .tabItem { Label("자산", systemImage: "chart.pie") }
            .tag(1)

            NavigationView {
                CoinPilotActivityView(store: store)
                    .navigationTitle("거래 내역")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { refreshToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .tabItem { Label("거래", systemImage: "arrow.left.arrow.right") }
            .tag(2)

            NavigationView {
                CoinPilotSettingsView(store: store)
                    .navigationTitle("설정")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .tabItem { Label("설정", systemImage: "gearshape") }
            .tag(3)
        }
    }

    private var refreshToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigationBarTrailing) {
            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .disabled(store.isRefreshing)
            .accessibilityLabel("새로고침")
        }
    }
}

private struct CoinPilotHomeView: View {
    @ObservedObject var store: CoinPilotStore
    @ScaledMetric(relativeTo: .title) private var totalAssetFontSize: CGFloat = 31
    @State private var cohortDetailsExpanded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 17) {
                HStack {
                    HStack(spacing: 7) {
                        Circle()
                            .fill(store.isBundledPreview ? CoinPilotColors.blue : CoinPilotColors.green)
                            .frame(width: 7, height: 7)
                        Text(store.isBundledPreview ? "예시 데이터" : store.isObserverAccount ? "조회 전용" : "서버 연결")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(CoinPilotColors.ink)
                    }
                    .padding(.horizontal, 11)
                    .padding(.vertical, 8)
                    .background(CoinPilotColors.surface)
                    .clipShape(Capsule())
                    Spacer()
                    Text(store.isBundledPreview ? "화면 미리보기" : store.serverAddress)
                        .font(.caption.weight(.medium))
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .lineLimit(1)
                }
                if store.isBundledPreview {
                    InlineNotice(text: "앱에 포함된 예시 자료예요. 실제 계좌 정보가 아닙니다.", color: CoinPilotColors.blue)
                }
                if let message = store.dashboardMessage {
                    InlineNotice(text: message, color: CoinPilotColors.amber)
                }
                if let safetyMessage = store.runtimeSafetyMessage {
                    InlineNotice(text: safetyMessage, color: CoinPilotColors.amber)
                }
                assetSummary
                paperValidationSection
                historySection
                marketSection
                recentActivitySection
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
    }

    private var assetSummary: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 15) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("총자산")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(CoinPilotColors.secondaryInk)
                        Text(store.freshnessLabel(for: "account"))
                            .font(.caption2)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                    }
                    Spacer()
                    Text(accountModeLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(CoinPilotColors.blue)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(CoinPilotColors.blue.opacity(0.10))
                        .clipShape(Capsule())
                }
                Text(CoinPilotFormatting.won(
                    store.account?.valuationAvailable == false ? nil : store.totalAssets,
                    unavailable: store.account?.valuationAvailable == false ? "평가액 확인 불가" : "평가액 미제공"
                ))
                    .font(.system(size: totalAssetFontSize, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(CoinPilotColors.ink)
                    .minimumScaleFactor(0.68)
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(store.totalProfitLabel)
                        .font(.caption.weight(.medium))
                        .foregroundColor(CoinPilotColors.secondaryInk)
                    Text(CoinPilotFormatting.signedWon(store.totalProfit))
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(profitColor(store.totalProfit))
                    if let percent = store.totalProfitPercent {
                        Text(CoinPilotFormatting.percent(percent))
                            .font(.caption.weight(.medium))
                            .foregroundColor(profitColor(store.totalProfit))
                    }
                }
                Rectangle()
                    .fill(CoinPilotColors.line)
                    .frame(height: 1)
                HStack {
                    Text(store.isObserverAccount ? "평가 기준 시각" : "오늘 실현 손익")
                        .font(.caption)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                    Spacer()
                    Text(todaySummaryValue)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CoinPilotColors.ink)
                        .lineLimit(1)
                }
            }
        }
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
                                    .foregroundColor(CoinPilotColors.ink)
                                Text("마지막 기록 · \(CoinPilotFormatting.dateTime(summary.heartbeatAt))")
                                    .font(.caption2)
                                    .foregroundColor(CoinPilotColors.secondaryInk)
                            }
                            Spacer(minLength: 8)
                            Text(store.freshnessLabel(for: "paper-validation-summary"))
                                .font(.caption2.weight(.medium))
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                .multilineTextAlignment(.trailing)
                                .lineLimit(2)
                        }

                        Rectangle()
                            .fill(CoinPilotColors.line)
                            .frame(height: 1)

                        Text("모의 장부")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(CoinPilotColors.secondaryInk)
                        PaperEvidenceRow(
                            title: "청산 표본",
                            value: tradeCountLabel(summary.strict.closedTradeCount),
                            tint: CoinPilotColors.ink
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
                                tint: CoinPilotColors.amber
                            )
                        }

                        if summary.costAudit.available {
                            Rectangle()
                                .fill(CoinPilotColors.line)
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
                                Text("설정 가격 차이 추가 가정 · \(unmodeled)건")
                                    .font(.caption2)
                                    .foregroundColor(CoinPilotColors.secondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else if let modeled = summary.costAudit.modeledExecutionTradeCount, modeled > 0 {
                                Text("기록된 모의 비용 모델 포함 · \(modeled)건")
                                    .font(.caption2)
                                    .foregroundColor(CoinPilotColors.secondaryInk)
                            }
                        } else {
                            Text("비용 민감도를 계산할 설정이나 청산 표본이 아직 없습니다.")
                                .font(.caption)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if let count = summary.diagnostic.shadowClosedTradeCount {
                            Rectangle()
                                .fill(CoinPilotColors.line)
                                .frame(height: 1)
                            Text("비교용 가상 장부 · 모의 장부 손익과 별도")
                                .font(.caption.weight(.semibold))
                                .foregroundColor(CoinPilotColors.secondaryInk)
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
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        if summary.cohort.available {
                            Rectangle()
                                .fill(CoinPilotColors.line)
                                .frame(height: 1)
                            DisclosureGroup(isExpanded: $cohortDetailsExpanded) {
                                VStack(alignment: .leading, spacing: 8) {
                                    PaperEvidenceRow(
                                        title: "전체 집계 시각",
                                        value: CoinPilotFormatting.dateTime(summary.cohort.capturedAt),
                                        tint: CoinPilotColors.secondaryInk
                                    )
                                    PaperEvidenceRow(
                                        title: "전체 모의 청산",
                                        value: cohortTradeSummary(summary.cohort),
                                        tint: CoinPilotColors.ink
                                    )
                                    PaperEvidenceRow(
                                        title: "적격 수익성 거래",
                                        value: tradeCountLabel(summary.cohort.profitabilityEvidenceTradeCount),
                                        tint: (summary.cohort.profitabilityEvidenceTradeCount ?? 0) > 0
                                            ? CoinPilotColors.green
                                            : CoinPilotColors.amber
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
                                            .foregroundColor(CoinPilotColors.secondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    } else if (summary.cohort.strictTradeCount ?? 0) > 0 {
                                        Text("기록은 있지만, 전체 조건을 통과한 수익성 표본은 아직 없어요.")
                                            .font(.caption2)
                                            .foregroundColor(CoinPilotColors.secondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    if let unverified = summary.cohort.strictCostUnverifiedTradeCount, unverified > 0 {
                                        PaperEvidenceRow(
                                            title: "비용 확인이 안 된 거래",
                                            value: "\(unverified)건",
                                            tint: CoinPilotColors.amber
                                        )
                                    }
                                    if let shortDays = summary.cohort.sessionsBelowMinimumObservationDays, shortDays > 0 {
                                        PaperEvidenceRow(
                                            title: "관측 기간 기준 미달",
                                            value: "\(shortDays)회",
                                            tint: CoinPilotColors.secondaryInk
                                        )
                                    }
                                    if let shortTrades = summary.cohort.sessionsBelowMinimumTradeCount, shortTrades > 0 {
                                        PaperEvidenceRow(
                                            title: "최소 거래 수 기준 미달",
                                            value: "\(shortTrades)회",
                                            tint: CoinPilotColors.secondaryInk
                                        )
                                    }
                                    if summary.cohort.totalStrictProfitComparable == false {
                                        Text("조건이 다른 실행의 기록 손익은 하나로 합산하지 않아요.")
                                            .font(.caption2)
                                            .foregroundColor(CoinPilotColors.secondaryInk)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    if !summary.cohort.complete {
                                        InlineNotice(text: "일부 기록을 읽지 못해 전체 집계를 사용할 수 없어요.", color: CoinPilotColors.amber)
                                    } else if !summary.cohort.fresh {
                                        InlineNotice(text: "전체 집계가 오래돼 최신 상태로 볼 수 없어요.", color: CoinPilotColors.amber)
                                    }
                                }
                                .padding(.top, 8)
                            } label: {
                                HStack(spacing: 8) {
                                    Text("전체 수익 검증")
                                        .font(.caption.weight(.semibold))
                                        .foregroundColor(CoinPilotColors.ink)
                                    Spacer(minLength: 4)
                                    Text(cohortEvidenceLabel(summary.cohort))
                                        .font(.caption2.weight(.semibold))
                                        .foregroundColor(CoinPilotColors.amber)
                                        .lineLimit(1)
                                }
                            }
                            .tint(CoinPilotColors.blue)
                        }

                        if summary.continuityEligible == false || summary.analysisContinuityEligible == false ||
                            summary.riskContinuityEligible == false {
                            InlineNotice(text: "기록이 끊겨 이어진 성과로 판단할 수 없어요.", color: CoinPilotColors.amber)
                        }
                        if summary.configSnapshotComplete == false || summary.configurationConsistent == false {
                            InlineNotice(text: "전략 설정 기록이 완전하지 않아 이 결과를 같은 조건의 비교로 볼 수 없어요.", color: CoinPilotColors.amber)
                        }
                        Label("실제 체결·정산 자료 없음", systemImage: "info.circle.fill")
                            .font(.caption2.weight(.medium))
                            .foregroundColor(CoinPilotColors.blue)
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
        return "\(trades)건 · \(sessions)회 실행"
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
        NativeCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    SectionHeading(title: "자산 기록")
                    Spacer()
                    Text(store.freshnessLabel(for: "portfolio-history"))
                        .font(.caption2)
                        .foregroundColor(store.isResourceStale("portfolio-history") ? CoinPilotColors.amber : CoinPilotColors.secondaryInk)
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
                CoinPilotHistoryChart(points: store.history)
                    .frame(height: 122)
                if store.history.contains(where: { $0.valuationStatus == "unknown_legacy" }) {
                    Text("일부 이전 기록은 당시 시세 평가 근거를 확인할 수 없어요.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if store.history.compactMap(\.totalAssets).count < 2 {
                    Text(store.history.isEmpty
                         ? store.emptyResourceMessage(for: "portfolio-history", whenLoadedEmpty: "표시할 자산 기록이 없습니다.")
                         : "그래프로 보려면 자산 기록이 더 필요합니다.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
            }
        }
    }

    private var marketSection: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    SectionHeading(title: "주요 시세")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(store.freshnessLabel(for: "market-prices"))
                            .font(.caption2)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                        Text(CoinPilotFormatting.marketTimestamp(
                            store.marketSnapshotFetchedAt,
                            label: store.isBundledPreview ? "예시 수집" : "서버 시세 수집"
                        ))
                        .font(.caption2)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .multilineTextAlignment(.trailing)
                    }
                }
                let visibleMarkets = prioritizedMarkets
                if visibleMarkets.isEmpty {
                    EmptyMessage(text: store.emptyResourceMessage(for: "market-prices", whenLoadedEmpty: "표시할 시세가 없습니다."))
                } else {
                    VStack(spacing: 0) {
                        ForEach(visibleMarkets) { market in
                            MarketRow(market: market, isBundledPreview: store.isBundledPreview)
                            if market.id != visibleMarkets.last?.id {
                                Divider().overlay(CoinPilotColors.line)
                            }
                        }
                    }
                }
            }
        }
    }

    private var recentActivitySection: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    SectionHeading(title: "최근 거래")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(min(store.trades.count, 3))건")
                            .font(.footnote)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                        Text(store.freshnessLabel(for: "trades"))
                            .font(.caption2)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                    }
                }
                if store.trades.isEmpty {
                    EmptyMessage(text: store.emptyResourceMessage(for: "trades", whenLoadedEmpty: "아직 거래 내역이 없습니다."))
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(store.trades.prefix(3))) { trade in
                            TradeRow(trade: trade)
                            if trade.id != store.trades.prefix(3).last?.id {
                                Divider().overlay(CoinPilotColors.line)
                            }
                        }
                    }
                }
            }
        }
    }

    private var prioritizedMarkets: [CoinPilotMarketPrice] {
        let symbols = ["KRW-BTC", "KRW-ETH", "KRW-XRP"]
        let selected = symbols.compactMap { symbol in store.markets.first(where: { $0.coin == symbol }) }
        return Array((selected.isEmpty ? Array(store.markets.prefix(3)) : selected).prefix(3))
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

private struct CoinPilotHistoryChart: View {
    let points: [CoinPilotHistoryPoint]

    var body: some View {
        GeometryReader { geometry in
            let values = points.compactMap(\.totalAssets).filter(\.isFinite)
            if values.count >= 2 {
                ZStack {
                    VStack(spacing: 0) {
                        ForEach(0..<3, id: \.self) { _ in
                            Divider().overlay(CoinPilotColors.line.opacity(0.7))
                            Spacer(minLength: 0)
                        }
                    }
                    .padding(.vertical, 8)
                    filledPath(values: values, size: geometry.size)
                        .fill(CoinPilotColors.green.opacity(0.08))
                    linePath(values: values, size: geometry.size)
                        .stroke(CoinPilotColors.blue, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                }
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(CoinPilotColors.surface)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(CoinPilotColors.line, lineWidth: 1))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("자산 기록 그래프")
        .accessibilityValue(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        let values = points.compactMap(\.totalAssets).filter(\.isFinite)
        guard let first = values.first, let last = values.last else {
            return "표시할 자산 기록이 없습니다."
        }
        let summary = "첫 기록 총자산 \(CoinPilotFormatting.won(first)), 최근 기록 총자산 \(CoinPilotFormatting.won(last))"
        return points.contains(where: { $0.valuationStatus == "unknown_legacy" })
            ? "\(summary). 일부 과거 기록의 평가 근거를 확인할 수 없습니다."
            : summary
    }

    private func linePath(values: [Double], size: CGSize) -> Path {
        let bounds = valueBounds(values)
        let spread = max(bounds.upperBound - bounds.lowerBound, 1)
        var path = Path()
        for (index, value) in values.enumerated() {
            let x = size.width * CGFloat(index) / CGFloat(max(values.count - 1, 1))
            let y = size.height - 10 - CGFloat((value - bounds.lowerBound) / spread) * max(size.height - 20, 1)
            if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
            else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        return path
    }

    private func filledPath(values: [Double], size: CGSize) -> Path {
        var path = linePath(values: values, size: size)
        path.addLine(to: CGPoint(x: size.width, y: size.height))
        path.addLine(to: CGPoint(x: 0, y: size.height))
        path.closeSubpath()
        return path
    }

    private func valueBounds(_ values: [Double]) -> ClosedRange<Double> {
        let minimum = values.min() ?? 0
        let maximum = values.max() ?? 0
        if minimum == maximum { return (minimum - 1)...(maximum + 1) }
        let padding = (maximum - minimum) * 0.06
        return (minimum - padding)...(maximum + padding)
    }
}

private struct CoinPilotAssetsView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if store.isBundledPreview {
                    InlineNotice(text: "앱에 포함된 예시 자료예요. 실제 계좌 정보가 아닙니다.", color: CoinPilotColors.blue)
                }
                if let message = store.dashboardMessage {
                    InlineNotice(text: message, color: CoinPilotColors.amber)
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 15) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("총자산")
                                .font(.subheadline.weight(.medium))
                                .foregroundColor(CoinPilotColors.secondaryInk)
                            Text(store.freshnessLabel(for: "account"))
                                .font(.caption2)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                            Text(CoinPilotFormatting.won(
                                store.account?.valuationAvailable == false ? nil : store.totalAssets,
                                unavailable: store.account?.valuationAvailable == false ? "평가액 확인 불가" : "평가액 미제공"
                            ))
                                .font(.title2.weight(.bold))
                                .monospacedDigit()
                                .foregroundColor(CoinPilotColors.ink)
                                .minimumScaleFactor(0.72)
                                .lineLimit(1)
                        }
                        Divider().overlay(CoinPilotColors.line)
                        HStack {
                            SectionHeading(title: "원화")
                            Spacer()
                            Text(CoinPilotFormatting.won(store.account?.krwBalance, unavailable: "잔액 미제공"))
                                .font(.body.weight(.semibold))
                                .foregroundColor(CoinPilotColors.ink)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 7) {
                        SectionHeading(title: "보유 코인")
                        if !store.hasLoadedResource("account") {
                            EmptyMessage(text: store.emptyResourceMessage(for: "account", whenLoadedEmpty: "보유 중인 코인이 없습니다."))
                        } else if store.account?.hasPositionsField != true {
                            EmptyMessage(text: "보유 자산을 확인할 수 없습니다.")
                        } else if store.account?.positions.isEmpty != false {
                            EmptyMessage(text: "보유 중인 코인이 없습니다.")
                        } else {
                            VStack(spacing: 0) {
                                ForEach(store.account?.positions ?? []) { position in
                                    PositionRow(position: position)
                                    if position.id != store.account?.positions.last?.id {
                                        Divider().overlay(CoinPilotColors.line)
                                    }
                                }
                            }
                        }
                    }
                }
                if store.isBundledPreview, let observerDate = store.account?.valuationAsOf {
                    Text("예시 자료 · 평가 기준 시각 \(CoinPilotFormatting.dateTime(observerDate, unavailable: "평가 시각 미제공"))")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                } else if store.isObserverAccount, let observerDate = store.account?.valuationAsOf {
                    Text("조회 전용 계좌 · 평가 기준 시각 \(CoinPilotFormatting.dateTime(observerDate, unavailable: "평가 시각 미제공"))")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
                if store.account?.valuationAvailable == false {
                    Text("현재 시세를 확인하지 못해 손익을 표시하지 않았어요.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 34)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
    }
}

private struct CoinPilotActivityView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let message = store.dashboardMessage {
                    InlineNotice(text: message, color: CoinPilotColors.amber)
                }
                Text(store.isBundledPreview
                     ? "앱에 포함된 예시 거래 내역입니다. 실제 체결·정산 정보가 아니에요."
                     : "표시된 내역은 서버 기록입니다. 거래소 체결·정산 내역은 거래소에서 확인해 주세요.")
                    .font(.subheadline)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                if !store.isBundledPreview {
                    Text(store.freshnessLabel(for: "trades"))
                        .font(.caption)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
                if store.trades.isEmpty {
                    NativeCard {
                        EmptyMessage(text: store.emptyResourceMessage(for: "trades", whenLoadedEmpty: "아직 거래 내역이 없습니다."))
                    }
                } else {
                    NativeCard {
                        VStack(spacing: 0) {
                            ForEach(store.trades) { trade in
                                TradeRow(trade: trade)
                                if trade.id != store.trades.last?.id {
                                    Divider().overlay(CoinPilotColors.line)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 34)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
    }
}

private struct CoinPilotSettingsView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var showingServerEditor = false
    @State private var showingLogoutConfirmation = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionHeading(title: "데이터 출처")
                        if store.isBundledPreview {
                            SettingsRow(title: "자료", value: "앱에 포함된 예시 데이터", symbol: "internaldrive")
                            Text("실제 계좌·시세·체결 정보가 아닌 화면 미리보기입니다.")
                                .font(.subheadline)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                            Button("실제 서버 연결") { store.useServerMode() }
                                .font(.body.weight(.semibold))
                                .foregroundColor(CoinPilotColors.blue)
                                .padding(.top, 2)
                        } else {
                            SettingsRow(
                                title: "서버 주소",
                                value: store.serverAddress.isEmpty ? "설정되지 않음" : store.serverAddress,
                                symbol: "network"
                            )
                            Button("서버 주소 변경") { showingServerEditor = true }
                                .font(.body.weight(.semibold))
                                .foregroundColor(CoinPilotColors.blue)
                                .padding(.top, 2)
                            if store.canUseBundledPreview {
                                Button("예시 데이터로 보기") { store.useBundledPreview() }
                                    .font(.body.weight(.semibold))
                                    .foregroundColor(CoinPilotColors.blue)
                            }
                        }
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionHeading(title: store.isObserverAccount ? "계좌 권한" : "자동매매 상태")
                        SettingsRow(title: "거래 모드", value: modeName(store.tradingMode), symbol: "arrow.left.arrow.right")
                        SettingsRow(title: store.isObserverAccount ? "조회 권한" : "실행 상태", value: engineState, symbol: store.isObserverAccount ? "eye" : "antenna.radiowaves.left.and.right")
                        Text(engineExplanation)
                            .font(.subheadline)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionHeading(title: "앱 정보")
                        SettingsRow(title: "버전", value: appVersion, symbol: "iphone")
                        SettingsRow(title: "마지막 확인", value: CoinPilotFormatting.time(store.lastCheckedAt), symbol: "clock")
                    }
                }

                if store.authenticationRequired {
                    Button(role: .destructive) {
                        showingLogoutConfirmation = true
                    } label: {
                        Text("이 기기에서 로그아웃")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .foregroundColor(CoinPilotColors.red)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 35)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .sheet(isPresented: $showingServerEditor) {
            CoinPilotServerEditor(store: store)
        }
        .confirmationDialog("이 기기에서 로그아웃할까요?", isPresented: $showingLogoutConfirmation, titleVisibility: .visible) {
            Button("로그아웃", role: .destructive) { store.logOut() }
            Button("취소", role: .cancel) {}
        } message: {
            Text("이 기기에 저장된 서버 토큰을 삭제합니다. 서버 주소는 유지됩니다.")
        }
    }

    private var engineState: String {
        if store.status?.runtimeState == "SYNC_REQUIRED" || store.status?.exchangeStateKnown == false {
            return "계좌 확인 중"
        }
        if store.runtimeSafetyMessage != nil { return "위험 감시 전용" }
        if store.isObserverAccount { return "조회 전용" }
        switch store.status?.isRunning {
        case true: return "실행 중"
        case false: return "중지"
        case nil: return "확인할 수 없음"
        }
    }

    private var engineExplanation: String {
        if let safetyMessage = store.runtimeSafetyMessage { return safetyMessage }
        if store.isObserverAccount { return "이 계좌는 조회 전용입니다. 앱에서는 주문을 실행하지 않습니다." }
        switch store.status?.isRunning {
        case true: return "자동매매가 실행 중입니다. 앱을 닫아도 서버에서 계속 실행됩니다."
        case false: return "자동매매가 중지되어 있습니다. 앱을 닫아도 다시 시작되지 않습니다."
        case nil: return "자동매매 상태를 확인하지 못했습니다."
        }
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "—"
        let build = info["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
    }

    private func modeName(_ mode: String?) -> String {
        switch mode {
        case "DRY_RUN": return "모의투자"
        case "LIVE": return "실거래"
        default: return "확인할 수 없음"
        }
    }
}

private struct CoinPilotServerEditor: View {
    @ObservedObject var store: CoinPilotStore
    @Environment(\.dismiss) private var dismiss
    @State private var address: String
    @State private var message: String?

    init(store: CoinPilotStore) {
        self.store = store
        _address = State(initialValue: store.serverDraft)
    }

    var body: some View {
        NavigationView {
            Form {
                Section {
                        TextField("https://example.com", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                } header: {
                    Text("서버 주소")
                } footer: {
                    Text("같은 Wi-Fi의 서버는 내부 주소로, 외부 서버는 HTTPS 주소로 연결해 주세요.")
                }
                if let message {
                    Text(message).foregroundColor(CoinPilotColors.red)
                }
                Section {
                    Button {
                        Task {
                            let updated = await store.updateServerAddress(address)
                            if updated { dismiss() }
                            else { message = store.connectionMessage }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if store.isWorking { ProgressView().padding(.trailing, 6) }
                            Text(store.isWorking ? "연결 중" : "저장하고 연결")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .disabled(store.isWorking)
                }
            }
            .background(CoinPilotColors.paper)
            .navigationTitle("서버 주소")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("취소") { dismiss() }
                }
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
    }
}

private struct SettingsRow: View {
    let title: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.headline)
                .foregroundColor(CoinPilotColors.secondaryInk)
                .frame(width: 23)
            Text(title)
                .font(.body)
                .foregroundColor(CoinPilotColors.secondaryInk)
            Spacer(minLength: 10)
            Text(value)
                .font(.body.weight(.medium))
                .foregroundColor(CoinPilotColors.ink)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
    }
}

private struct PositionRow: View {
    let position: CoinPilotPosition

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(CoinPilotFormatting.symbol(position.coin))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CoinPilotColors.ink)
                HStack(spacing: 5) {
                    Text(CoinPilotFormatting.ticker(position.coin))
                    Text("·")
                    Text(CoinPilotFormatting.quantity(position.amount))
                }
                .font(.footnote)
                .foregroundColor(CoinPilotColors.secondaryInk)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 5) {
                Text(CoinPilotFormatting.won(position.currentValue, unavailable: "평가액 미제공"))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CoinPilotColors.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                HStack(spacing: 5) {
                    Text(CoinPilotFormatting.signedWon(position.profit))
                    if let percent = position.profitPercent {
                        Text(CoinPilotFormatting.percent(percent))
                    }
                }
                .font(.caption.weight(.medium))
                .foregroundColor(profitColor(position.profit))
            }
        }
        .padding(.vertical, 14)
    }
}

private struct MarketRow: View {
    let market: CoinPilotMarketPrice
    let isBundledPreview: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(CoinPilotFormatting.symbol(market.coin))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CoinPilotColors.ink)
                Text(CoinPilotFormatting.ticker(market.coin))
                    .font(.caption)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                Text(CoinPilotFormatting.marketTimestamp(
                    market.sourceAsOf,
                    label: isBundledPreview ? "예시 체결" : "최근 체결"
                ))
                .font(.caption2)
                .foregroundColor(CoinPilotColors.secondaryInk)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(CoinPilotFormatting.price(market.price))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CoinPilotColors.ink)
                Text(CoinPilotFormatting.percent(market.change))
                    .font(.caption.weight(.medium))
                    .foregroundColor(profitColor(market.change))
            }
        }
        .padding(.vertical, 12)
    }
}

private struct TradeRow: View {
    let trade: CoinPilotTrade

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: trade.action == "매수" ? "arrow.down.left" : trade.action == "매도" ? "arrow.up.right" : "arrow.left.arrow.right")
                .font(.body.weight(.medium))
                .foregroundColor(CoinPilotColors.ink)
                .frame(width: 34, height: 34)
                .background(CoinPilotColors.surface)
                .clipShape(Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text("\(trade.coin ?? "자산 미제공") · \(trade.action)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(CoinPilotColors.ink)
                    .lineLimit(1)
                Text(CoinPilotFormatting.dateTime(trade.timestamp, unavailable: "거래 시각 미제공"))
                    .font(.caption)
                    .foregroundColor(CoinPilotColors.secondaryInk)
            }
            Spacer(minLength: 5)
            VStack(alignment: .trailing, spacing: 4) {
                Text(valueText)
                    .font(.footnote.weight(.semibold))
                    .foregroundColor(trade.profit == nil ? CoinPilotColors.ink : profitColor(trade.profit))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                if trade.profit != nil {
                    Text("손익")
                        .font(.caption2)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
            }
        }
        .padding(.vertical, 12)
    }

    private var valueText: String {
        if let profit = trade.profit { return CoinPilotFormatting.signedWon(profit) }
        if let price = trade.price { return CoinPilotFormatting.price(price) }
        if let amount = trade.amount { return CoinPilotFormatting.won(amount) }
        return "금액 미제공"
    }
}

private struct SectionHeading: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.headline.weight(.bold))
            .foregroundColor(CoinPilotColors.ink)
    }
}

private struct PaperEvidenceRow: View {
    let title: String
    let value: String
    let tint: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.caption)
                .foregroundColor(CoinPilotColors.secondaryInk)
            Spacer(minLength: 6)
            Text(value)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundColor(tint)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
        }
    }
}

private struct NativeCard<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CoinPilotColors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(CoinPilotColors.line.opacity(0.72), lineWidth: 0.8)
            }
    }
}

private struct EmptyMessage: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundColor(CoinPilotColors.secondaryInk)
            .padding(.vertical, 10)
    }
}

private struct InlineNotice: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundColor(color)
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundColor(CoinPilotColors.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private func profitColor(_ value: Double?) -> Color {
    guard let value else { return CoinPilotColors.secondaryInk }
    if value > 0 { return CoinPilotColors.green }
    if value < 0 { return CoinPilotColors.red }
    return CoinPilotColors.secondaryInk
}
