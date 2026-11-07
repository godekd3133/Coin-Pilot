import SwiftUI

// MARK: - Formatting

private enum ReceiptFormat {
    static let missing = "기록 없음"

    private static let kst = TimeZone(identifier: "Asia/Seoul") ?? TimeZone(secondsFromGMT: 9 * 3600)!

    /// Server timestamps are ISO-8601 with a zone; Upbit candle times have
    /// no suffix and are UTC.
    static func date(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        if let date = CoinPilotMarketSnapshotMetadata.parseDate(value) { return date }
        let hasZone = value.range(of: #"(?:Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) != nil
        return hasZone ? nil : CoinPilotMarketSnapshotMetadata.parseDate("\(value)Z")
    }

    static func kstTime(_ value: String?, seconds: Bool = true) -> String {
        guard let date = date(value) else { return missing }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.timeZone = kst
        formatter.dateFormat = seconds ? "M월 d일 HH:mm:ss" : "M월 d일 HH:mm"
        return formatter.string(from: date)
    }

    static func duration(_ ms: Double?) -> String {
        guard let ms, ms.isFinite, ms >= 0 else { return missing }
        let total = Int((ms / 1000).rounded())
        if total < 60 { return "\(total)초" }
        let hours = total / 3600, minutes = (total % 3600) / 60, seconds = total % 60
        if hours > 0 { return "\(hours)시간 \(minutes)분" }
        return seconds == 0 ? "\(minutes)분" : "\(minutes)분 \(seconds)초"
    }

    static func seconds(_ ms: Double?) -> String {
        guard let ms, ms.isFinite, ms >= 0 else { return missing }
        let value = ms / 1000
        return value < 10 ? String(format: "%.1f초", value) : "\(Int(value.rounded()))초"
    }

    static func price(_ value: Double?) -> String {
        value == nil ? missing : CoinPilotFormatting.price(value)
    }

    static func rsi(_ value: Double?) -> String {
        CoinPilotFormatting.indicator(value, fractionDigits: 1, unavailable: missing)
    }

    static func percent(_ value: Double?, signed: Bool = true) -> String {
        CoinPilotFormatting.percent(value, signed: signed, unavailable: missing)
    }

    /// A cost as "0.05% · ₩10". Costs are shown as positive magnitudes.
    static func cost(_ line: CoinPilotTradeReceipt.Line?) -> String {
        guard let line else { return missing }
        let percent = line.percent.map { CoinPilotFormatting.percent($0, signed: false) }
        let krw = line.krw.map { CoinPilotFormatting.won($0) }
        return [percent, krw].compactMap { $0 }.joined(separator: " · ")
    }

    static func exitTitle(_ type: String?, maxHoldMinutes: Double?) -> String {
        switch type {
        case "MAX_HOLD":
            if let minutes = maxHoldMinutes { return "최대 보유 \(Int(minutes.rounded()))분 도달" }
            return "최대 보유시간 도달"
        case "TAKE_PROFIT": return "익절"
        case "STOP_LOSS": return "손절"
        case "MAX_LOSING_HOLD": return "손실 포지션 조기 청산"
        case "BREAK_EVEN_STOP": return "본전 보호 청산"
        case "TRAILING_STOP": return "추적 손절"
        case "EXCHANGE_SYNC": return "거래소 동기화 정리"
        case "MANUAL": return "수동 매도"
        case "REBALANCE": return "리밸런싱 매도"
        case "OTHER": return "기타"
        default: return missing
        }
    }

    static func exitExplanation(_ type: String?) -> String? {
        switch type {
        case "MAX_HOLD": return "보유 시간 안에 익절선과 손절선 어느 쪽에도 닿지 않아 시간 한도로 청산했습니다."
        case "TAKE_PROFIT": return "가격이 익절선에 닿아 청산했습니다."
        case "STOP_LOSS": return "가격이 손절선에 닿아 청산했습니다."
        case "EXCHANGE_SYNC": return "거래소에 보유량이 없어 내부 기록을 정리했습니다. 실제 체결가가 아닌 추정가로 기록됐습니다."
        default: return nil
        }
    }

    static func signalTitle(_ profile: String?, unit: Double?) -> String {
        let unitLabel = unit.map { "\(Int($0.rounded()))분봉" }
        let name: String
        switch profile {
        case "momentum_breakout": name = "모멘텀 돌파"
        case "rsi_rebound", nil: name = "RSI 과매도 반등"
        default: name = profile ?? "RSI 과매도 반등"
        }
        return [name, unitLabel].compactMap { $0 }.joined(separator: " · ")
    }

    static func confirmation(_ value: CoinPilotTradeReceipt.Confirmation?) -> String {
        guard let value else { return missing }
        let outcome = value.outcome == "confirmed" ? "통과" : (value.outcome ?? "결과 미상")
        guard let delay = value.delayMs else { return outcome }
        return "\(outcome) · \(seconds(delay)) 후 재확인"
    }

    static func feeSourceNote(_ source: String?, rate: Double?) -> String {
        switch source {
        case "exchange_paid_fee": return "업비트가 청구한 실제 수수료"
        case "model":
            let rateText = rate.map { CoinPilotFormatting.percent($0 * 100, signed: false) } ?? "0.05%"
            return "매수·매도 각 \(rateText) 기준"
        default: return "수수료 출처 기록 없음"
        }
    }

    static func slippageSourceNote(_ source: String?, rate: Double?) -> String {
        switch source {
        case "exchange_fill": return "주문 직전 시세 대비 업비트 평균 체결가"
        case "paper_model":
            let rateText = rate.map { CoinPilotFormatting.percent($0 * 100, signed: false) } ?? "설정값"
            return "모의 체결에 불리한 방향 \(rateText) 적용"
        case "none": return "모의 체결가에 슬리피지를 적용하지 않음"
        default: return "체결 전 시세가 기록되지 않음"
        }
    }
}

// MARK: - View

struct CoinPilotTradeReceiptView: View {
    let trade: CoinPilotTrade
    let receipt: CoinPilotTradeReceipt

    private var mode: String? { receipt.mode ?? trade.mode }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: CPSpace.md) {
                header
                if receipt.estimated {
                    InlineNotice(text: estimatedNotice, color: CPColor.amber)
                }
                resultCard
                entryCard
                exitCard
                costCard
                Text("시각은 한국 시간(KST) 기준입니다. 기록 없음은 당시 서버가 그 값을 저장하지 않았다는 뜻입니다.")
                    .font(.caption2)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .cpPage()
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle("거래 영수증")
        .cpInlineTitle()
    }

    private var estimatedNotice: String {
        switch receipt.estimateBasis {
        case "recent_risk_price": return "추정 청산: 거래소 동기화가 최근 시세로 기록한 거래입니다."
        case "entry_price": return "추정 청산: 거래소 동기화가 매수가로 기록한 거래입니다. 실제 손익과 다를 수 있습니다."
        default: return "추정 청산: 거래소 동기화로 기록된 거래입니다. 실제 체결 내역과 다를 수 있습니다."
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: CPSpace.xs) {
            Text(trade.coin.map(CoinPilotFormatting.ticker) ?? "자산 미제공")
                .font(CPFont.title)
                .foregroundColor(CPColor.ink)
            if mode == "live" {
                CPLiveIndicator(compact: true)
            } else if mode == "paper" {
                CPBadge(text: "모의", tone: .info)
            } else {
                CPBadge(text: "모드 기록 없음", tone: .neutral)
            }
            if receipt.estimated { CPBadge(text: "추정", tone: .warning) }
            if receipt.partial { CPBadge(text: "부분 매도", tone: .neutral) }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private var resultCard: some View {
        CPCard("결과") {
            VStack(alignment: .leading, spacing: CPSpace.xxs) {
                Text(CoinPilotFormatting.signedWon(receipt.netProfit, unavailable: ReceiptFormat.missing))
                    .font(CPFont.display)
                    .monospacedDigit()
                    .foregroundColor(CPColor.pnl(receipt.netProfit))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text("순손익 \(ReceiptFormat.percent(receipt.netProfitPercent))")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundColor(CPColor.pnl(receipt.netProfit ?? receipt.netProfitPercent))
            }
            VStack(spacing: 0) {
                ReceiptRow(label: "가격 차익 (수수료 전)",
                           value: CoinPilotFormatting.signedWon(receipt.grossProfit, unavailable: ReceiptFormat.missing),
                           detail: receipt.grossProfitPercent.map { CoinPilotFormatting.percent($0) },
                           tint: CPColor.pnl(receipt.grossProfit))
                CPDivider()
                ReceiptRow(label: "수수료 합계",
                           value: receipt.totalFee?.krw.map { CoinPilotFormatting.signedWon(-$0) } ?? ReceiptFormat.missing,
                           detail: receipt.totalFee?.percent.map { CoinPilotFormatting.percent(-$0) })
                CPDivider()
                ReceiptRow(label: "순손익",
                           value: CoinPilotFormatting.signedWon(receipt.netProfit, unavailable: ReceiptFormat.missing),
                           detail: receipt.netProfitPercent.map { CoinPilotFormatting.percent($0) },
                           tint: CPColor.pnl(receipt.netProfit))
                if let paid = receipt.netProfitWithPaidFees {
                    CPDivider()
                    ReceiptRow(label: "실제 청구 수수료 기준",
                               value: CoinPilotFormatting.signedWon(paid),
                               tint: CPColor.pnl(paid))
                }
            }
            Text("가격 차익은 실제(모의) 체결가 기준이라 슬리피지가 이미 반영돼 있습니다.")
                .font(.caption2)
                .foregroundColor(CPColor.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var entryCard: some View {
        let signal = receipt.signal
        return CPCard("진입 이유") {
            VStack(spacing: 0) {
                ReceiptRow(label: "신호", value: signal.map { ReceiptFormat.signalTitle($0.profile, unit: $0.candleUnit) } ?? ReceiptFormat.missing)
                CPDivider()
                ReceiptRow(label: "신호 캔들", value: ReceiptFormat.kstTime(signal?.candleTime, seconds: false))
                CPDivider()
                ReceiptRow(label: "과매도 RSI", value: ReceiptFormat.rsi(signal?.oversoldRsi))
                CPDivider()
                ReceiptRow(label: "반등 캔들 RSI", value: ReceiptFormat.rsi(signal?.rsi),
                           detail: signal?.rsiRecovery.map { "회복 \(CoinPilotFormatting.indicator($0, fractionDigits: 1))" })
                CPDivider()
                ReceiptRow(label: "반등폭", value: ReceiptFormat.percent(signal?.reboundPercent))
                CPDivider()
                ReceiptRow(label: "주문 전 재검증", value: ReceiptFormat.confirmation(receipt.confirmation))
                CPDivider()
                ReceiptRow(label: "매수 체결가", value: ReceiptFormat.price(receipt.entryPrice),
                           detail: receipt.entryExpectedPrice.map { "주문 직전 \(CoinPilotFormatting.price($0))" })
                CPDivider()
                ReceiptRow(label: "매수 시각", value: ReceiptFormat.kstTime(receipt.entryTime))
            }
        }
    }

    private var exitCard: some View {
        CPCard("청산 이유") {
            VStack(alignment: .leading, spacing: CPSpace.xxs) {
                Text(ReceiptFormat.exitTitle(receipt.exitType, maxHoldMinutes: receipt.maxHoldMinutes))
                    .font(CPFont.headline)
                    .foregroundColor(receipt.exitType == nil ? CPColor.secondaryInk : CPColor.ink)
                if let explanation = ReceiptFormat.exitExplanation(receipt.exitType) {
                    Text(explanation)
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(spacing: 0) {
                ReceiptRow(label: "서버 기록 사유", value: receipt.exitReason ?? ReceiptFormat.missing, wraps: true)
                CPDivider()
                ReceiptRow(label: "보유 시간", value: ReceiptFormat.duration(receipt.holdMs))
                CPDivider()
                ReceiptRow(label: "매도 체결가", value: ReceiptFormat.price(receipt.exitPrice),
                           detail: receipt.exitExpectedPrice.map { "주문 직전 \(CoinPilotFormatting.price($0))" })
                CPDivider()
                ReceiptRow(label: "매도 시각", value: ReceiptFormat.kstTime(receipt.exitTime))
            }
        }
    }

    private var costCard: some View {
        CPCard("비용") {
            VStack(spacing: 0) {
                ReceiptRow(label: "매수 수수료", value: ReceiptFormat.cost(receipt.entryFee))
                CPDivider()
                ReceiptRow(label: "매도 수수료", value: ReceiptFormat.cost(receipt.exitFee))
                CPDivider()
                ReceiptRow(label: "매수 슬리피지", value: ReceiptFormat.cost(receipt.entrySlippage))
                CPDivider()
                ReceiptRow(label: "매도 슬리피지", value: ReceiptFormat.cost(receipt.exitSlippage))
                CPDivider()
                ReceiptRow(label: "스프레드 + 1호가",
                           value: ReceiptFormat.percent(receipt.entryCost?.costPercent, signed: false),
                           detail: receipt.entryCost.flatMap(entryCostDetail))
                CPDivider()
                ReceiptRow(label: "신호 캔들 마감 → 주문", value: ReceiptFormat.seconds(receipt.signalToOrderMs))
            }
            VStack(alignment: .leading, spacing: CPSpace.xxs) {
                Text("수수료: \(ReceiptFormat.feeSourceNote(receipt.feeSource, rate: receipt.feeRate))")
                Text("슬리피지: \(ReceiptFormat.slippageSourceNote(receipt.slippageSource, rate: receipt.slippageRate)). 양수는 불리한 방향입니다.")
                if receipt.entryCost != nil {
                    Text("스프레드와 호가 단위는 재검증 때 호가창에서 측정한 값으로, 손익에 따로 더하지 않습니다.")
                }
            }
            .font(.caption2)
            .foregroundColor(CPColor.secondaryInk)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func entryCostDetail(_ cost: CoinPilotTradeReceipt.EntryCost) -> String? {
        let parts = [
            cost.spreadPercent.map { "스프레드 \(CoinPilotFormatting.percent($0, signed: false))" },
            cost.tickPercent.map { "호가 \(CoinPilotFormatting.percent($0, signed: false))" }
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " + ")
    }
}

/// A closed trade in the activity list: the normal row plus the exit reason,
/// mode and estimate marker, so a max-hold exit is visible without opening it.
struct ReceiptTradeRow: View {
    let trade: CoinPilotTrade
    let receipt: CoinPilotTradeReceipt

    private var tags: String {
        let mode = (receipt.mode ?? trade.mode).map { $0 == "live" ? "실전" : $0 == "paper" ? "모의" : $0 }
        let exit = receipt.exitType == nil ? nil : ReceiptFormat.exitTitle(receipt.exitType, maxHoldMinutes: receipt.maxHoldMinutes)
        return [mode, exit, receipt.holdMs.map { "보유 \(ReceiptFormat.duration($0))" }, receipt.estimated ? "추정" : nil]
            .compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: CPSpace.xs) {
            VStack(alignment: .leading, spacing: 0) {
                TradeRow(trade: trade)
                if !tags.isEmpty {
                    Text(tags)
                        .font(.caption2.monospacedDigit())
                        .foregroundColor(receipt.estimated ? CPColor.amber : CPColor.secondaryInk)
                        .lineLimit(1)
                        .padding(.top, -6)
                        .padding(.bottom, 8)
                }
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundColor(CPColor.secondaryInk)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
    }
}

private struct ReceiptRow: View {
    let label: String
    let value: String
    var detail: String? = nil
    var tint: Color = CPColor.ink
    var wraps = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: CPSpace.sm) {
            Text(label)
                .font(.subheadline)
                .foregroundColor(CPColor.secondaryInk)
                .lineLimit(1)
            Spacer(minLength: CPSpace.xs)
            VStack(alignment: .trailing, spacing: 2) {
                Text(value)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundColor(value == ReceiptFormat.missing ? CPColor.secondaryInk : tint)
                    .multilineTextAlignment(.trailing)
                    .lineLimit(wraps ? 3 : 1)
                    .minimumScaleFactor(0.7)
                if let detail {
                    Text(detail)
                        .font(.caption.monospacedDigit())
                        .foregroundColor(CPColor.secondaryInk)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}
