import SwiftUI

/// 주식 탭: 모의/실전 주식 트레이더 상태, 장 운영, 보유 종목, 시작/정지, 모의 초기화.
struct CoinPilotStocksView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var selectedMode: String?
    @State private var confirmation: CPConfirmation?

    private var status: CoinPilotStocksStatus? { store.stocksStatus }

    /// Traders the server actually runs (a process runs paper OR live; both is possible).
    private var availableModes: [String] {
        guard let status else { return [] }
        return [("paper", status.paper), ("live", status.live)].compactMap { $0.1 == nil ? nil : $0.0 }
    }

    private var mode: String {
        if let selectedMode, availableModes.contains(selectedMode) { return selectedMode }
        let preferred = store.activeWorkspace == .live ? "live" : "paper"
        return availableModes.contains(preferred) ? preferred : (availableModes.first ?? preferred)
    }

    private var trader: CoinPilotStockTrader? { mode == "live" ? status?.live : status?.paper }
    private var isLoading: Bool { status == nil && store.refreshingFeatureGroups.contains(CoinPilotStore.stocksFeatureKey) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let message = store.featureMessages[CoinPilotStore.stocksFeatureKey] {
                    CPNotice(text: message, tone: .info)
                }
                content
                CoinPilotFeatureFreshnessLine(
                    lastSuccessfulAt: store.featureLastSuccessfulAt[CoinPilotStore.stocksFeatureKey],
                    error: nil
                )
                .padding(.horizontal, 4)
            }
            .cpPage()
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .refreshable { await store.loadStocksStatus(force: true) }
        .refreshFeatureWhenVisible(enabled: !store.isBundledPreview) {
            await store.loadStocksStatus(force: false)
        }
        .cpConfirmationSheet($confirmation)
    }

    @ViewBuilder
    private var content: some View {
        if store.isBundledPreview {
            NativeCard {
                CPEmptyState(symbol: "chart.bar.xaxis", title: "예시 데이터: 주식 자료 없음",
                             message: "서버 연결 필요")
            }
        } else if !store.canOperate {
            NativeCard {
                CPEmptyState(symbol: "lock", title: "운영 토큰 필요",
                             message: "운영 권한 토큰으로 로그인 필요")
            }
        } else if isLoading {
            skeleton
        } else if let status, !status.isEnabled {
            NativeCard {
                CPEmptyState(symbol: "pause.circle", title: "이 서버에서는 주식 자동매매를 쓰지 않습니다",
                             message: "토스증권 국내 주식 단타 기능입니다. 서버에서 켜면 상태와 시작·정지가 이곳에 나타납니다. 코인 자동매매에는 영향이 없습니다.")
            }
        } else if let status {
            if availableModes.count > 1 {
                CPSegmented(
                    title: "주식 계좌",
                    selection: Binding(get: { mode }, set: { selectedMode = $0 }),
                    options: availableModes.map { ($0, $0 == "live" ? "실전" : "모의") }
                )
            }
            if status.credentialsConfigured == false {
                CPNotice(text: "증권사 API 키 미등록 · 주식 자동매매 시작 불가", tone: .warning)
            }
            if let trader {
                summaryCard(trader)
                engineCard(trader, status: status)
                sessionCard(trader)
                holdingsCard(trader)
                tradesCard(trader)
                signalsCard(trader)
                if !trader.isLive { resetCard(trader) }
                universeCard(status)
            } else {
                NativeCard {
                    CPEmptyState(symbol: "questionmark.circle", title: "이 서버에는 \(mode == "live" ? "실전" : "모의") 주식 트레이더 없음",
                                 message: "모의 서버는 모의 주식, 실전 서버는 실전 주식을 운용합니다.")
                }
            }
        } else {
            NativeCard {
                CPEmptyState(symbol: "wifi.exclamationmark", title: "주식 상태 불러오기 실패",
                             actionTitle: "다시 시도") {
                    Task { await store.loadStocksStatus(force: true) }
                }
            }
        }
    }

    private var skeleton: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                CoinPilotSkeleton(width: 120, height: 14)
                CoinPilotSkeleton(width: 220, height: 32)
                CoinPilotSkeleton(height: 44)
            }
        }
    }

    // MARK: Sections

    private func summaryCard(_ trader: CoinPilotStockTrader) -> some View {
        NativeCard {
            VStack(alignment: .leading, spacing: CPSpace.md) {
                HStack {
                    if trader.isLive { CPLiveIndicator() } else { CPBadge(text: "모의 · 가상 자금", tone: .info) }
                    Spacer()
                }
                if trader.isLive {
                    HeroValue(
                        label: "실전 보유 종목 평가",
                        value: trader.positionsValue,
                        change: trader.unrealizedProfit,
                        changeLabel: "평가 손익"
                    )
                    Text("실전 예수금은 증권 계좌 기준 · 합계 제외")
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    HeroValue(
                        label: "모의 주식 총자산",
                        value: trader.totalAssets,
                        unavailable: "평가액 미제공",
                        change: trader.profitVersusSeed,
                        changePercent: trader.initialSeedMoney.flatMap { seed in
                            trader.profitVersusSeed.map { seed > 0 ? $0 / seed * 100 : 0 }
                        },
                        changeLabel: "시드 대비"
                    )
                }
                CPStatGrid(items: [
                    CPStatItem(label: "현금", value: trader.isLive ? "증권 계좌 기준" : CoinPilotFormatting.won(trader.cash)),
                    CPStatItem(label: "보유 종목",
                               value: "\(trader.positions.count)\(trader.maxPositions.map { " / \($0)" } ?? "")종목"),
                    CPStatItem(label: "실현 손익",
                               value: CoinPilotFormatting.signedWon(trader.statistics?.totalProfit),
                               tint: CPColor.pnl(trader.statistics?.totalProfit)),
                    CPStatItem(label: "승률",
                               value: trader.statistics?.totalTrades.map { $0 > 0 ? CoinPilotFormatting.percent(trader.statistics?.winRate, signed: false) + " · \($0)건" : "청산 없음" } ?? "—")
                ])
            }
        }
    }

    private func engineCard(_ trader: CoinPilotStockTrader, status: CoinPilotStocksStatus) -> some View {
        let canControl = store.canOperate && status.credentialsConfigured != false && !store.isRunningFeatureAction
        return CPCard("자동매매") {
            CPEngineStatus(
                name: trader.isLive ? "실전 주식 스캘퍼" : "모의 주식 스캘퍼",
                symbol: "bolt.horizontal.circle",
                isRunning: trader.running,
                detail: trader.desiredRunning == false ? "중지 상태 저장됨 · 서버 재시작 시에도 유지" : nil,
                lastRun: trader.lastCycleAt.map { "마지막 실행 · \(CoinPilotFormatting.dateTime($0))" },
                pausedReason: trader.pauseLabel,
                isLive: trader.isLive,
                actionEnabled: canControl
            ) {
                confirmation = toggleConfirmation(trader)
            }
            if let pending = trader.pendingOrders, pending > 0 {
                CPNotice(text: "체결을 확인하지 못한 주문 \(pending)건 · 신규 진입 잠금", tone: .warning)
            }
            if let error = trader.lastError, !error.isEmpty {
                CPNotice(text: error, tone: .danger)
            }
        }
    }

    private func toggleConfirmation(_ trader: CoinPilotStockTrader) -> CPConfirmation {
        let start = trader.running != true
        let modeKey = trader.isLive ? "live" : "paper"
        return CPConfirmation(
            title: start ? (trader.isLive ? "실전 주식 자동매매 시작" : "모의 주식 자동매매 시작")
                : "주식 자동매매 중지",
            message: start
                ? (trader.isLive
                    ? "정규장 중 실제 계좌로 시장가 주문. 장 마감 전 전량 정리."
                    : "가상 자금으로만 주문. 실제 계좌 영향 없음.")
                : "신규 진입 정지. 보유 종목은 서버 정리 규칙에 따름.",
            confirmTitle: start ? (trader.isLive ? "실전 시작" : "모의 시작") : "중지",
            isDestructive: start && trader.isLive,
            isLive: trader.isLive
        ) {
            Task { await store.setStockTraderRunning(mode: modeKey, running: start) }
        }
    }

    private func sessionCard(_ trader: CoinPilotStockTrader) -> some View {
        CPCard("장 운영", trailing: {
            if let market = trader.market {
                CPBadge(text: market.open == true ? "개장" : "마감",
                        tone: market.mustFlatten == true ? .warning : market.open == true ? .positive : .neutral)
            } else {
                CPBadge(text: "확인 전")
            }
        }) {
            if let market = trader.market {
                Text(market.title)
                    .font(.headline)
                    .foregroundColor(CPColor.ink)
                if let detail = market.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    CPBadge(text: market.canEnter == true ? "신규 진입 가능" : "신규 진입 불가",
                            tone: market.canEnter == true ? .positive : .neutral)
                    if market.mustFlatten == true { CPBadge(text: "마감 전 정리", tone: .warning) }
                }
            } else {
                Text("엔진이 한 번 실행되면 장 운영 상태가 표시됩니다.")
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
            }
        }
    }

    private func holdingsCard(_ trader: CoinPilotStockTrader) -> some View {
        CPCard("보유 종목", trailing: {
            Text("\(trader.positions.count)종목").font(.caption).foregroundColor(CPColor.secondaryInk)
        }) {
            if trader.positions.isEmpty {
                CPEmptyState(symbol: "tray", title: "보유 종목 없음",
                             message: "")
            } else {
                VStack(spacing: 0) {
                    ForEach(trader.positions) { position in
                        CPListRow(
                            title: position.symbol,
                            subtitle: "\(CoinPilotFormatting.quantity(position.quantity))주 · 매수 \(CoinPilotFormatting.price(position.entryPrice))",
                            value: CoinPilotFormatting.price(position.lastPrice ?? position.entryPrice),
                            detail: position.unrealizedProfit.map {
                                "\(CoinPilotFormatting.signedWon($0)) \(CoinPilotFormatting.percent(position.profitPercent))"
                            } ?? "현재가 확인 전",
                            detailColor: CPColor.pnl(position.unrealizedProfit)
                        ) {
                            CoinAvatar(coin: position.symbol)
                        }
                        if position.id != trader.positions.last?.id { CPDivider() }
                    }
                }
            }
        }
    }

    private func tradesCard(_ trader: CoinPilotStockTrader) -> some View {
        CPCard("최근 체결") {
            if trader.recentTrades.isEmpty {
                Text("체결 기록 없음").font(.caption).foregroundColor(CPColor.secondaryInk)
            } else {
                VStack(spacing: 0) {
                    let trades = Array(trader.recentTrades.prefix(10))
                    ForEach(trades) { trade in
                        CPListRow(
                            symbol: trade.action == "SELL" ? "arrow.down.right" : "arrow.up.right",
                            tint: trade.action == "SELL" ? CPColor.down : CPColor.up,
                            title: "\(trade.symbol ?? "종목") \(trade.actionTitle)",
                            subtitle: [CoinPilotFormatting.dateTime(trade.at), trade.reason].compactMap { $0 }.joined(separator: " · "),
                            value: "\(CoinPilotFormatting.quantity(trade.quantity))주 · \(CoinPilotFormatting.price(trade.price))",
                            detail: trade.profit.map { CoinPilotFormatting.signedWon($0) },
                            detailColor: CPColor.pnl(trade.profit)
                        )
                        if trade.id != trades.last?.id { CPDivider() }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func signalsCard(_ trader: CoinPilotStockTrader) -> some View {
        if !trader.recentSignals.isEmpty {
            NativeDisclosureCard(title: "최근 신호 \(trader.recentSignals.count)건") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(trader.recentSignals) { signal in
                        HStack(alignment: .top, spacing: 8) {
                            CPBadge(text: signal.valid == true ? "진입 가능" : "보류",
                                    tone: signal.valid == true ? .positive : .neutral)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(signal.symbol ?? "종목") · \(signal.reason ?? "신호")")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(CPColor.ink)
                                if let rejection = signal.rejection {
                                    Text(rejection).font(.caption2).foregroundColor(CPColor.secondaryInk)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func resetCard(_ trader: CoinPilotStockTrader) -> some View {
        let blocked = !trader.positions.isEmpty
        return CPCard("모의 계좌 초기화") {
            Text(blocked
                 ? "보유 종목이 있어 초기화 불가. 정리 후 다시 시도."
                 : "모의 주식 거래 기록과 현금을 시드머니로 초기화. 실전 계좌 영향 없음.")
                .font(.caption)
                .foregroundColor(CPColor.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            Button("모의 계좌 초기화") {
                confirmation = CPConfirmation(
                    title: "모의 주식 계좌 초기화",
                    message: "거래 기록과 현금이 시드머니\(trader.initialSeedMoney.map { " \(CoinPilotFormatting.won($0))" } ?? "")로 초기화. 되돌릴 수 없음.",
                    confirmTitle: "초기화",
                    isDestructive: true
                ) {
                    Task { await store.resetStockPaper() }
                }
            }
            .buttonStyle(CoinPilotSecondaryButtonStyle())
            .disabled(blocked || store.isRunningFeatureAction || !store.canOperate)
        }
    }

    @ViewBuilder
    private func universeCard(_ status: CoinPilotStocksStatus) -> some View {
        if !status.universe.isEmpty || status.universeError != nil {
            NativeDisclosureCard(title: "감시 종목 \(status.universe.count)개") {
                VStack(alignment: .leading, spacing: 8) {
                    if let error = status.universeError {
                        CPNotice(text: error, tone: .warning)
                    }
                    if !status.universe.isEmpty {
                        Text(status.universe.joined(separator: ", "))
                            .font(.caption.monospaced())
                            .foregroundColor(CPColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let updatedAt = status.universeUpdatedAt {
                        Text("갱신 · \(CoinPilotFormatting.dateTime(updatedAt))")
                            .font(.caption2)
                            .foregroundColor(CPColor.secondaryInk)
                    }
                }
            }
        }
    }
}
