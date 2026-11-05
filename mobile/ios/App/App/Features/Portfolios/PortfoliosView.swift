import SwiftUI

/// 포트폴리오 탭: 기간별 슬리브 × 자산(코인·주식). Sleeves are rendered from
/// the server response — a new server profile shows up without an app change.
struct CoinPilotPortfoliosView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage("coinpilot.native.portfolios.asset") private var assetRaw = CoinPilotHorizonAsset.coin.rawValue
    @State private var confirmation: CPConfirmation?

    private var asset: CoinPilotHorizonAsset { CoinPilotHorizonAsset(rawValue: assetRaw) ?? .coin }
    private var status: CoinPilotHorizonsStatus? { store.horizonsStatus }
    private var runtime: CoinPilotHorizonRuntime? { status?.runtime(asset: asset, workspace: store.activeWorkspace) }
    private var isLoading: Bool { status == nil && store.refreshingFeatureGroups.contains(CoinPilotStore.horizonsFeatureKey) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                CPSegmented(
                    title: "자산",
                    selection: Binding(get: { asset }, set: { assetRaw = $0.rawValue }),
                    options: CoinPilotHorizonAsset.allCases.map { ($0, $0.title) }
                )
                if let message = store.featureMessages[CoinPilotStore.horizonsFeatureKey] {
                    CPNotice(text: message, tone: .info)
                }
                content
                CoinPilotFeatureFreshnessLine(
                    lastSuccessfulAt: store.featureLastSuccessfulAt[CoinPilotStore.horizonsFeatureKey],
                    error: nil
                )
                .padding(.horizontal, 4)
            }
            .cpPage()
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .refreshable { await store.loadHorizonsStatus(force: true) }
        .refreshFeatureWhenVisible(enabled: !store.isBundledPreview) {
            await store.loadHorizonsStatus(force: false)
        }
        .cpConfirmationSheet($confirmation)
    }

    @ViewBuilder
    private var content: some View {
        if store.isBundledPreview {
            NativeCard {
                CPEmptyState(symbol: "square.stack.3d.up", title: "예시 데이터: 포트폴리오 자료 없음",
                             message: "서버 연결 필요")
            }
        } else if !store.canOperate {
            NativeCard {
                CPEmptyState(symbol: "lock", title: "운영 토큰 필요",
                             message: "운영 권한 토큰으로 로그인 필요")
            }
        } else if isLoading {
            NativeCard {
                VStack(alignment: .leading, spacing: 12) {
                    CoinPilotSkeleton(width: 140, height: 14)
                    CoinPilotSkeleton(width: 220, height: 32)
                    CoinPilotSkeleton(height: 14)
                }
            }
        } else if let runtime {
            summaryCard(runtime)
            engineCard(runtime)
            allocationCard(runtime)
            ForEach(runtime.orderedSleeves, id: \.key) { item in
                sleeveCard(key: item.key, sleeve: item.sleeve, runtime: runtime)
            }
            researchCard(runtime)
            tradesCard(runtime)
        } else if status != nil {
            NativeCard {
                CPEmptyState(symbol: "pause.circle", title: "\(asset.title) 기간별 포트폴리오 꺼짐",
                             message: "서버 설정에서 기간별 포트폴리오를 켜면 이곳에 슬리브가 표시됩니다.")
            }
        } else {
            NativeCard {
                CPEmptyState(symbol: "wifi.exclamationmark", title: "포트폴리오 상태 불러오기 실패",
                             actionTitle: "다시 시도") {
                    Task { await store.loadHorizonsStatus(force: true) }
                }
            }
        }
    }

    // MARK: Sections

    private func summaryCard(_ runtime: CoinPilotHorizonRuntime) -> some View {
        NativeCard {
            VStack(alignment: .leading, spacing: CPSpace.md) {
                HStack {
                    if runtime.isLive { CPLiveIndicator() } else { CPBadge(text: "모의 · 가상 자금", tone: .info) }
                    Spacer()
                }
                if runtime.isLive {
                    HeroValue(
                        label: "\(asset.title) 포트폴리오 보유 평가",
                        value: runtime.positionsValue,
                        change: runtime.positions.compactMap(\.unrealizedProfit).reduce(0, +),
                        changeLabel: "평가 손익"
                    )
                    Text(asset == .coin
                         ? "실전 코인 포트폴리오는 코인 계좌에서 운용 · 홈 총자산에 포함"
                         : "실전 주식 포트폴리오 예수금은 증권 계좌 기준")
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    HeroValue(
                        label: "\(asset.title) 포트폴리오 총자산",
                        value: runtime.totalAssets,
                        unavailable: "평가액 미제공",
                        change: runtime.profitVersusSeed,
                        changePercent: runtime.initialSeedMoney.flatMap { seed in
                            runtime.profitVersusSeed.map { seed > 0 ? $0 / seed * 100 : 0 }
                        },
                        changeLabel: "시드 대비"
                    )
                }
                CPStatGrid(items: [
                    CPStatItem(label: "현금", value: runtime.isLive ? "계좌 기준" : CoinPilotFormatting.won(runtime.cash)),
                    CPStatItem(label: "보유", value: "\(runtime.positions.count)종목"),
                    CPStatItem(label: "실현 손익", value: CoinPilotFormatting.signedWon(runtime.realizedProfit),
                               tint: CPColor.pnl(runtime.realizedProfit)),
                    CPStatItem(label: "운용 자본 비중",
                               value: runtime.capitalRatio.map { CoinPilotFormatting.percent($0 * 100, signed: false) } ?? "—")
                ])
            }
        }
    }

    private func engineCard(_ runtime: CoinPilotHorizonRuntime) -> some View {
        CPCard("자동 운용") {
            CPEngineStatus(
                name: "\(asset.title) 기간별 포트폴리오",
                symbol: "square.stack.3d.up",
                isRunning: runtime.running,
                detail: runtime.desiredRunning == false ? "중지 상태 저장됨" : nil,
                lastRun: runtime.lastCycleAt.map { "마지막 실행 · \(CoinPilotFormatting.dateTime($0))" },
                pausedReason: runtime.pauseLabel,
                isLive: runtime.isLive,
                actionEnabled: store.canOperate && !store.isRunningFeatureAction
            ) {
                confirmation = toggleConfirmation(runtime)
            }
            if runtime.paramsValidated == false {
                CPNotice(text: "검증 통과한 연구 결과 없음 · 신규 진입 안 함", tone: .warning)
            }
            if let gate = runtime.gate, gate.canEnter == false {
                CPNotice(text: gate.reason.map { "신규 진입 안 함 · \($0)" } ?? "신규 진입 안 함", tone: .info)
            }
            if let pending = runtime.pendingOrders, pending > 0 {
                CPNotice(text: "체결을 확인하지 못한 주문 \(pending)건 · 신규 진입 잠금", tone: .warning)
            }
            if let error = runtime.lastError, !error.isEmpty {
                CPNotice(text: error, tone: .danger)
            }
        }
    }

    private func toggleConfirmation(_ runtime: CoinPilotHorizonRuntime) -> CPConfirmation {
        let start = runtime.running != true
        let target = asset
        return CPConfirmation(
            title: start ? "\(target.title) 포트폴리오 시작" : "\(target.title) 포트폴리오 중지",
            message: start
                ? (runtime.isLive
                    ? "검증 통과 슬리브만 실제 자금으로 주문. 손절·최대 보유 기간 적용."
                    : "가상 자금으로만 운용합니다.")
                : "신규 진입·리밸런싱 정지. 보유 종목은 유지.",
            confirmTitle: start ? (runtime.isLive ? "실전 시작" : "시작") : "중지",
            isDestructive: start && runtime.isLive,
            isLive: runtime.isLive
        ) {
            Task { await store.setHorizonRunning(asset: target, running: start) }
        }
    }

    private func allocationCard(_ runtime: CoinPilotHorizonRuntime) -> some View {
        let tints = CoinPilotAllocationBar.categoryTints
        let slices = runtime.orderedSleeves.enumerated().compactMap { index, item -> CoinPilotAllocationSlice? in
            guard let weight = item.sleeve.weight, weight > 0 else { return nil }
            return CoinPilotAllocationSlice(
                label: item.sleeve.label ?? item.key,
                weight: weight,
                value: nil,
                tint: tints[index % tints.count]
            )
        }
        return CPCard("슬리브 비중") {
            if slices.isEmpty {
                Text("비중 배정 슬리브 없음 · 검증 통과 슬리브만 배정")
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                CPAllocationLegendBar(slices: slices)
            }
        }
    }

    private func sleeveCard(key: String, sleeve: CoinPilotHorizonSleeve, runtime: CoinPilotHorizonRuntime) -> some View {
        let research = runtime.research(for: key)
        let positions = runtime.positions(for: key)
        return CPCard(sleeve.label ?? key, trailing: {
            verdictBadge(research)
        }) {
            HStack(spacing: 6) {
                CPBadge(text: sleeve.enabled == true ? "운용 중" : "비중 0", tone: sleeve.enabled == true ? .positive : .neutral)
                if let interval = sleeve.interval { CPBadge(text: "봉 \(interval)") }
                if let weight = sleeve.weight { CPBadge(text: "비중 \(CoinPilotFormatting.percent(weight, signed: false))", tone: .info) }
            }
            CPStatGrid(items: [
                CPStatItem(label: "OOS 수익", value: research?.outOfSampleReturnPercent.map { CoinPilotFormatting.percent($0) } ?? "—",
                           tint: CPColor.pnl(research?.outOfSampleReturnPercent)),
                CPStatItem(label: "최악 낙폭", value: research?.worstDrawdownPercent.map { CoinPilotFormatting.percent(-abs($0)) } ?? "—",
                           tint: research?.worstDrawdownPercent == nil ? CPColor.ink : CPColor.down),
                CPStatItem(label: "실현 손익", value: CoinPilotFormatting.signedWon(sleeve.realizedProfit),
                           tint: CPColor.pnl(sleeve.realizedProfit)),
                CPStatItem(label: "청산 · 승률",
                           value: (sleeve.trades ?? 0) > 0
                            ? "\(sleeve.trades ?? 0)건 · \(CoinPilotFormatting.percent(sleeve.winRate, signed: false))"
                            : "청산 없음")
            ], columns: 2)
            if positions.isEmpty {
                Text("보유 종목 없음")
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
            } else {
                VStack(spacing: 0) {
                    ForEach(positions) { position in
                        CPListRow(
                            title: CoinPilotFormatting.ticker(position.symbol),
                            subtitle: [
                                "\(CoinPilotFormatting.quantity(position.quantity))",
                                position.stopPrice.map { "손절 \(CoinPilotFormatting.price($0))" },
                                position.barsHeld.map { "\($0)봉 보유" }
                            ].compactMap { $0 }.joined(separator: " · "),
                            value: CoinPilotFormatting.price(position.lastPrice ?? position.entryPrice),
                            detail: position.unrealizedProfit.map {
                                "\(CoinPilotFormatting.signedWon($0)) \(CoinPilotFormatting.percent(position.profitPercent))"
                            } ?? "현재가 확인 전",
                            detailColor: CPColor.pnl(position.unrealizedProfit)
                        ) {
                            CoinAvatar(coin: position.symbol, size: 32)
                        }
                        if position.id != positions.last?.id { CPDivider() }
                    }
                }
            }
            if let analysis = sleeve.lastAnalysis, !analysis.top.isEmpty {
                DisclosureGroup("최근 분석 상위 \(analysis.top.count)종목") {
                    VStack(alignment: .leading, spacing: 6) {
                        if let regime = analysis.benchmarkRegime {
                            Text("기준 지수 국면 · \(regime)").font(.caption2).foregroundColor(CPColor.secondaryInk)
                        }
                        ForEach(analysis.top) { candidate in
                            HStack {
                                Text(CoinPilotFormatting.ticker(candidate.symbol))
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(CPColor.ink)
                                Spacer()
                                Text("점수 \(CoinPilotFormatting.indicator(candidate.score, fractionDigits: 0))")
                                    .font(.caption.monospacedDigit())
                                    .foregroundColor(CPColor.secondaryInk)
                                if let rsi = candidate.rsi {
                                    Text("RSI \(Int(rsi))").font(.caption2.monospacedDigit()).foregroundColor(CPColor.secondaryInk)
                                }
                            }
                        }
                    }
                    .padding(.top, 6)
                }
                .font(.caption.weight(.semibold))
                .tint(CPColor.blue)
            }
        }
    }

    @ViewBuilder
    private func verdictBadge(_ research: CoinPilotHorizonResearchSleeve?) -> some View {
        if let research {
            if research.passed == true {
                CPBadge(text: "검증 통과", tone: .positive, symbol: "checkmark")
            } else {
                CPBadge(text: "검증 실패", tone: .danger, symbol: "xmark")
            }
        } else {
            CPBadge(text: "연구 전")
        }
    }

    private func researchCard(_ runtime: CoinPilotHorizonRuntime) -> some View {
        CPCard("연구 검증") {
            if let research = runtime.research, research.hasReport {
                let passed = research.sleeves.filter { $0.passed == true }.count
                Text("\(research.sleeves.count)개 슬리브 중 \(passed)개 통과")
                    .font(.headline)
                    .foregroundColor(CPColor.ink)
                Text("훈련 구간에서 고른 설정을 이후 구간(OOS)에서 검증. 수익 양수, 대부분 구간 손실 없음, 최악 낙폭 기준 이내일 때만 비중 배정.")
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 6) {
                    PaperEvidenceRow(title: "연구 시각", value: CoinPilotFormatting.dateTime(research.generatedAt), tint: CPColor.ink)
                    if let markets = research.markets {
                        PaperEvidenceRow(title: "대상 종목", value: "\(markets)개", tint: CPColor.ink)
                    }
                    if let method = research.method {
                        PaperEvidenceRow(title: "방법", value: method, tint: CPColor.secondaryInk)
                    }
                }
            } else {
                Text("연구 결과 없음 · 서버가 주기적으로 실행")
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
            }
            if runtime.research?.schedulerRunning == true {
                CPBadge(text: "연구 실행 중", tone: .info, symbol: "hourglass")
            }
            if let error = runtime.research?.schedulerLastError, !error.isEmpty {
                CPNotice(text: error, tone: .warning)
            }
            Text("과거 성과는 미래 수익을 보장하지 않음. 현재 거래량 상위 종목 기준이라 생존 편향 가능.")
                .font(.caption2)
                .foregroundColor(CPColor.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func tradesCard(_ runtime: CoinPilotHorizonRuntime) -> some View {
        CPCard("최근 체결") {
            if runtime.recentTrades.isEmpty {
                Text("체결 기록 없음").font(.caption).foregroundColor(CPColor.secondaryInk)
            } else {
                let trades = Array(runtime.recentTrades.prefix(8))
                VStack(spacing: 0) {
                    ForEach(trades) { trade in
                        CPListRow(
                            symbol: trade.action == "SELL" ? "arrow.down.right" : "arrow.up.right",
                            tint: trade.action == "SELL" ? CPColor.down : CPColor.up,
                            title: "\(CoinPilotFormatting.ticker(trade.symbol)) \(trade.action == "SELL" ? "매도" : "매수")",
                            subtitle: [runtime.sleeves[trade.sleeve ?? ""]?.label, CoinPilotFormatting.dateTime(trade.at)]
                                .compactMap { $0 }.joined(separator: " · "),
                            value: CoinPilotFormatting.price(trade.price),
                            detail: trade.profit.map { CoinPilotFormatting.signedWon($0) },
                            detailColor: CPColor.pnl(trade.profit)
                        )
                        if trade.id != trades.last?.id { CPDivider() }
                    }
                }
            }
        }
    }
}

/// Allocation bar with a compact legend (weights only).
struct CPAllocationLegendBar: View {
    let slices: [CoinPilotAllocationSlice]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { geometry in
                HStack(spacing: 2) {
                    ForEach(slices) { slice in
                        Rectangle()
                            .fill(slice.tint)
                            .frame(width: max(2, geometry.size.width * CGFloat(slice.weight / max(totalWeight, 100)) - 2))
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(height: 8)
            .background(CPColor.surface2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("비중")
            .accessibilityValue(slices.map { "\($0.label) \(Int($0.weight.rounded()))%" }.joined(separator: ", "))
            ForEach(slices) { slice in
                HStack(spacing: 8) {
                    Rectangle().fill(slice.tint).frame(width: 8, height: 8)
                    Text(slice.label).font(.caption.weight(.medium)).foregroundColor(CPColor.ink)
                    Spacer(minLength: 8)
                    if let value = slice.value {
                        Text(CoinPilotFormatting.won(value))
                            .font(.caption.weight(.semibold)).monospacedDigit().foregroundColor(CPColor.ink)
                    }
                    Text(CoinPilotFormatting.percent(slice.weight, signed: false))
                        .font(.caption.weight(.semibold)).monospacedDigit().foregroundColor(CPColor.secondaryInk)
                }
            }
        }
    }

    private var totalWeight: Double { slices.reduce(0) { $0 + $1.weight } }
}
