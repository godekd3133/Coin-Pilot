import SwiftUI

/// Combined total across engines for the current workspace, honest about
/// what is and is not included.
///
/// - Coin account total always counts (it already contains LIVE coin horizon
///   holdings because they share the exchange account).
/// - Paper stock trader and paper horizon ledgers are separate virtual
///   accounts, so their totals are added.
/// - LIVE stock ledgers expose holdings only (cash lives at the broker), so
///   only the holdings value is added and a note says so.
struct CoinPilotHomeSummary {
    var total: Double?
    var profit: Double?
    var slices: [CoinPilotAllocationSlice] = []
    var notes: [String] = []
    var includesOtherEngines = false

    @MainActor
    init(store: CoinPilotStore) {
        let workspace = store.activeWorkspace
        let coinTotal = store.account?.valuationAvailable == false ? nil : store.totalAssets
        var parts: [(label: String, value: Double)] = []
        var profit = store.totalProfit
        if let coinTotal { parts.append(("코인", coinTotal)) }

        if !store.isBundledPreview {
            if let trader = store.stocksStatus?.trader(for: workspace) {
                if trader.isLive {
                    if trader.positionsValue > 0 {
                        parts.append(("주식", trader.positionsValue))
                        notes.append("실전 주식은 보유 종목 평가만 포함. 예수금은 증권 계좌 기준.")
                    }
                    if let unrealized = trader.unrealizedProfit { profit = (profit ?? 0) + unrealized }
                } else if let value = trader.totalAssets {
                    parts.append(("주식", value))
                    if let delta = trader.profitVersusSeed { profit = (profit ?? 0) + delta }
                }
            }
            var horizonValue: Double = 0
            var horizonProfit: Double?
            for asset in CoinPilotHorizonAsset.allCases {
                guard let runtime = store.horizonsStatus?.runtime(asset: asset, workspace: workspace) else { continue }
                if runtime.isLive {
                    // LIVE coin horizon positions sit inside the coin account (already counted).
                    if asset == .stock, runtime.positionsValue > 0 {
                        horizonValue += runtime.positionsValue
                    }
                } else if let value = runtime.totalAssets {
                    horizonValue += value
                    if let delta = runtime.profitVersusSeed { horizonProfit = (horizonProfit ?? 0) + delta }
                }
            }
            if horizonValue > 0 { parts.append(("포트폴리오", horizonValue)) }
            if let horizonProfit { profit = (profit ?? 0) + horizonProfit }
            if workspace == .live, store.horizonsStatus?.coin?.isLive == true {
                notes.append("실전 코인 포트폴리오는 코인 계좌 평가에 포함.")
            }
            if store.canOperate && (store.stocksStatus == nil || store.horizonsStatus == nil) {
                notes.append("주식·포트폴리오 확인 중 · 확인 후 합계에 반영")
            }
        }

        includesOtherEngines = parts.count > 1
        total = coinTotal == nil && parts.isEmpty ? nil : parts.reduce(0) { $0 + $1.value }
        self.profit = profit
        let sum = parts.reduce(0) { $0 + $1.value }
        if sum > 0 {
            let tints = CoinPilotAllocationBar.categoryTints
            slices = parts.enumerated().map { index, part in
                CoinPilotAllocationSlice(label: part.label, weight: part.value / sum * 100, value: part.value,
                                         tint: tints[index % tints.count])
            }
        }
    }
}

/// One row in Home's "최근 체결": coin, stock and horizon fills merged by time.
struct CoinPilotHomeFill: Identifiable {
    let id: String
    let date: Date?
    let row: AnyView

    @MainActor
    static func recent(store: CoinPilotStore, limit: Int) -> [CoinPilotHomeFill] {
        var fills: [CoinPilotHomeFill] = store.trades.prefix(limit).map { trade in
            CoinPilotHomeFill(
                id: "coin|\(trade.id)",
                date: CoinPilotMarketSnapshotMetadata.parseDate(trade.timestamp),
                row: AnyView(TradeRow(trade: trade))
            )
        }
        if !store.isBundledPreview {
            if let trader = store.stocksStatus?.trader(for: store.activeWorkspace) {
                fills += trader.recentTrades.prefix(limit).map { trade in
                    CoinPilotHomeFill(
                        id: "stock|\(trade.id)",
                        date: CoinPilotMarketSnapshotMetadata.parseDate(trade.at),
                        row: AnyView(CPListRow(
                            symbol: "chart.bar.xaxis",
                            tint: trade.action == "SELL" ? CPColor.down : CPColor.up,
                            title: "\(trade.symbol ?? "종목") \(trade.actionTitle)",
                            subtitle: "주식 · \(CoinPilotFormatting.dateTime(trade.at))",
                            value: CoinPilotFormatting.price(trade.price),
                            detail: trade.profit.map { CoinPilotFormatting.signedWon($0) },
                            detailColor: CPColor.pnl(trade.profit)
                        ))
                    )
                }
            }
            for asset in CoinPilotHorizonAsset.allCases {
                guard let runtime = store.horizonsStatus?.runtime(asset: asset, workspace: store.activeWorkspace) else { continue }
                fills += runtime.recentTrades.prefix(limit).map { trade in
                    CoinPilotHomeFill(
                        id: "horizon|\(asset.rawValue)|\(trade.id)",
                        date: CoinPilotMarketSnapshotMetadata.parseDate(trade.at),
                        row: AnyView(CPListRow(
                            symbol: "square.stack.3d.up",
                            tint: trade.action == "SELL" ? CPColor.down : CPColor.up,
                            title: "\(CoinPilotFormatting.ticker(trade.symbol)) \(trade.action == "SELL" ? "매도" : "매수")",
                            subtitle: "\(asset.title) 포트폴리오 · \(CoinPilotFormatting.dateTime(trade.at))",
                            value: CoinPilotFormatting.price(trade.price),
                            detail: trade.profit.map { CoinPilotFormatting.signedWon($0) },
                            detailColor: CPColor.pnl(trade.profit)
                        ))
                    )
                }
            }
        }
        return Array(fills.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }.prefix(limit))
    }
}

// MARK: - Home time formatting (always KST)

/// The operator's clock is Korea time regardless of the device time zone.
enum HomeTime {
    private static let kst = TimeZone(identifier: "Asia/Seoul") ?? TimeZone(secondsFromGMT: 9 * 3600) ?? .current

    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.timeZone = kst
        formatter.dateFormat = format
        return formatter
    }

    /// "15:04:58 KST"
    static func clock(_ date: Date?) -> String {
        guard let date else { return "—" }
        return "\(formatter("HH:mm:ss").string(from: date)) KST"
    }

    /// "15:04 KST", or "11월 6일 15:04 KST" when not today (KST).
    static func moment(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "—" }
        let day = formatter("yyyy-MM-dd")
        let format = day.string(from: date) == day.string(from: now) ? "HH:mm" : "M월 d일 HH:mm"
        return "\(formatter(format).string(from: date)) KST"
    }

    /// "11월 5일"
    static func day(_ date: Date?) -> String {
        guard let date else { return "—" }
        return formatter("M월 d일").string(from: date)
    }

    /// "12초 전", "3분 전", "2시간 전"
    static func ago(_ date: Date?, now: Date) -> String {
        guard let date else { return "기록 없음" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "\(seconds)초 전" }
        if seconds < 3600 { return "\(seconds / 60)분 전" }
        if seconds < 86_400 { return "\(seconds / 3600)시간 전" }
        return "\(seconds / 86_400)일 전"
    }

    /// "18분 남음", "2분 지남 · 청산 대기"
    static func remaining(until date: Date?, now: Date) -> String {
        guard let date else { return "—" }
        let seconds = Int(date.timeIntervalSince(now))
        if seconds >= 0 {
            if seconds < 60 { return "1분 이내" }
            if seconds < 3600 { return "\(seconds / 60)분 남음" }
            return "\(seconds / 3600)시간 \((seconds % 3600) / 60)분 남음"
        }
        return "\(max(1, -seconds / 60))분 지남 · 청산 대기"
    }

    static func date(_ value: String?) -> Date? { CoinPilotMarketSnapshotMetadata.parseDate(value) }
}

// MARK: - "지금 안전한가?"

/// One answer for the coin scalper's state. A stopped engine is a normal,
/// first-class state: it always carries the reason and the next step.
struct HomeEngineState {
    enum Tone { case ok, attention, danger, neutral }

    let title: String
    let detail: String
    var nextStep: String? = nil
    let tone: Tone
    /// Show a button to the automation control (never starts trading directly).
    var offersControl = false

    var color: Color {
        switch tone {
        case .ok: return CPColor.green
        case .attention: return CPColor.amber
        case .danger: return CPColor.red
        case .neutral: return CPColor.secondaryInk
        }
    }

    static let defaultStallSeconds: Double = 120

    @MainActor
    static func resolve(store: CoinPilotStore, now: Date) -> HomeEngineState {
        if store.isBundledPreview {
            return HomeEngineState(title: "예시 데이터", detail: "앱 내장 예시. 실제 엔진에 연결되지 않음.",
                                   nextStep: "설정에서 서버를 연결하면 실제 상태가 표시됩니다.", tone: .neutral)
        }
        guard let status = store.status else {
            let loaded = store.hasLoadedResource("status")
            return HomeEngineState(title: loaded ? "상태 확인 불가" : "상태 확인 중",
                                   detail: store.freshnessLabel(for: "status"),
                                   nextStep: loaded ? "아래로 당겨 새로고침하거나 서버 연결을 확인하세요." : nil,
                                   tone: .neutral)
        }
        if store.isObserverAccount {
            return HomeEngineState(title: "조회 전용", detail: "모의 장부를 읽기만 하는 연결. 이 서버는 주문하지 않음.",
                                   tone: .neutral)
        }
        let heldCount = store.scorecard?.openPositions.count ?? 0
        if status.runtimeState == "PROTECTIVE_ONLY" || status.protectiveMonitorActive == true {
            let held = heldCount > 0 ? "보유 \(heldCount)개" : "보유 포지션"
            return HomeEngineState(
                title: "보호 모드 · 신규 진입 정지",
                detail: "\(stopReasonLabel(status.stopReason)). \(held)에 손절·익절·최대 보유 청산만 실행 중.",
                nextStep: "모두 청산되면 엔진이 멈춥니다. \(recoveryStep(status))",
                tone: .attention)
        }
        if status.runtimeState == "SYNC_REQUIRED" || status.exchangeStateKnown == false {
            return HomeEngineState(
                title: "거래소 상태 확인 전 · 주문 잠금",
                detail: "잔고·미체결 주문을 확인하기 전까지 주문이 보류됩니다.",
                nextStep: "서버가 다시 확인합니다. 오래 지속되면 거래소 키와 연결을 점검하세요.",
                tone: .danger)
        }
        guard status.isRunning == true else {
            if status.isRunning == nil {
                return HomeEngineState(title: "상태 확인 중", detail: store.freshnessLabel(for: "status"), tone: .neutral)
            }
            let held = heldCount > 0 ? " 보유 \(heldCount)개는 자동 청산 감시가 없습니다." : ""
            return HomeEngineState(
                title: "정지됨",
                detail: "\(stopReasonLabel(status.stopReason)).\(held)",
                nextStep: recoveryStep(status),
                tone: heldCount > 0 ? .danger : .neutral,
                offersControl: status.autoRecoveryArmed != true && store.canOperate)
        }

        let activity = status.engineActivity
        let stallSeconds = store.scorecard?.engine?.stallAfterSeconds ?? defaultStallSeconds
        let lastCycle = activity?.lastCycleDate
        if activity != nil, lastCycle.map({ now.timeIntervalSince($0) > stallSeconds }) ?? true {
            return HomeEngineState(
                title: "응답 없음 · 분석이 멈춘 것으로 보임",
                detail: "실행 중으로 표시되지만 마지막 분석이 \(HomeTime.ago(lastCycle, now: now))입니다 (기준 \(Int(stallSeconds))초).",
                nextStep: "서버 로그와 데이터 연결을 확인하세요. 분석 공백이 길어지면 서버가 안전 정지합니다.",
                tone: .danger)
        }
        if status.entriesPaused == true {
            return HomeEngineState(title: "실행 중 · 신규 진입 일시 정지",
                                   detail: "분석은 계속되지만 새 포지션은 열지 않습니다.", tone: .attention)
        }
        if status.accountLossGuard?.blocked == true {
            return HomeEngineState(title: "실행 중 · 손실 가드가 신규 진입 차단",
                                   detail: "청산은 계속 실행됩니다.", tone: .attention)
        }
        guard let activity else {
            return HomeEngineState(title: "실행 중",
                                   detail: "서버가 분석 활동 정보를 주지 않아 실제로 돌고 있는지 확인할 수 없음.",
                                   tone: .attention)
        }
        if (activity.signalsLastHour ?? 0) == 0 {
            return HomeEngineState(title: "정상 · 조용한 시장",
                                   detail: "분석은 돌고 있지만 최근 1시간 진입 조건을 만족한 시장이 없습니다.",
                                   tone: .ok)
        }
        return HomeEngineState(title: "정상 실행 중",
                               detail: "최근 1시간 진입 신호 \(activity.signalsLastHour ?? 0)건 · 실제 진입 \(activity.entriesLastHour ?? 0)건.",
                               tone: .ok)
    }

    static func stopReasonLabel(_ reason: String?) -> String {
        guard let reason, !reason.isEmpty else { return "정지 사유 기록 없음" }
        switch reason {
        case "risk_data_gap": return "보유 포지션 시세가 30초 넘게 끊겨 안전 정지"
        case "analysis_data_gap": return "시장 분석 데이터가 끊겨 안전 정지"
        case "exchange_state_unverified": return "거래소 잔고·주문 상태를 확인하지 못해 정지"
        case "operator_stop": return "운영자가 정지"
        case "operator_shutdown": return "서버 종료로 정지"
        case "loss_circuit_breaker": return "연속 손실 한도에 걸려 정지"
        default: return "정지 사유: \(reason)"
        }
    }

    private static func recoveryStep(_ status: CoinPilotStatus) -> String {
        if status.autoRecoveryArmed == true {
            return "자동 복구 대기 중 · 데이터 경로가 정상으로 확인되면 서버가 다시 시작합니다."
        }
        switch status.stopReason ?? "" {
        case "operator_stop", "operator_shutdown", "":
            return "다시 시작하려면 코인 > 보유의 자동매매 제어에서 시작하세요."
        case "loss_circuit_breaker":
            return "쿨다운이 끝난 뒤 손실 원인을 확인하고 직접 다시 시작하세요."
        default:
            return "자동 복구가 대기 중이 아닙니다. 원인을 확인한 뒤 자동매매 제어에서 다시 시작하세요."
        }
    }
}

// MARK: - "비용 빼고도 벌고 있나?"

/// Honest one-line confidence verdict for the realized per-trade net return.
struct HomeConfidence {
    let text: String
    let color: Color

    init(scorecard: CoinPilotScorecard) {
        let count = scorecard.tradeCount ?? 0
        let minimum = scorecard.minTradesForVerdict ?? 100
        var interval: String?
        if let low = scorecard.ci95?.low, let high = scorecard.ci95?.high {
            interval = "95% 구간 \(Self.percent(low)) ~ \(Self.percent(high))"
        }
        switch scorecard.verdict {
        case "no_trades":
            text = "청산된 거래 없음 · 판단할 자료 없음"
            color = CPColor.secondaryInk
        case "indistinguishable_from_luck":
            text = "\(count)건 · \(interval ?? "95% 구간") 안에 0 포함 · 우연과 구분할 수 없음"
            color = CPColor.amber
        case "negative_edge":
            text = "\(count)건 · \(interval ?? "95% 구간") 전체가 0 미만 · 비용 뺀 손실이 우연이 아님"
            color = CPColor.red
        case "positive_edge":
            text = "\(count)건 · \(interval ?? "95% 구간") 전체가 0 초과 · 지난 성과일 뿐 앞으로를 보장하지 않음"
            color = CPColor.ink
        default:
            let suffix = interval.map { " · \($0)" } ?? ""
            text = "아직 \(count)건 · 우연과 구분할 수 없음 (\(minimum)건 이상 필요)\(suffix)"
            color = CPColor.amber
        }
    }

    /// Per-trade returns are small, so keep three decimals below 1%.
    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        let sign = value > 0 ? "+" : value < 0 ? "−" : ""
        let magnitude = abs(value)
        return "\(sign)\(String(format: magnitude < 1 ? "%.3f" : "%.2f", magnitude))%"
    }
}
