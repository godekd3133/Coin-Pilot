import SwiftUI

struct PositionRow: View {
    let position: CoinPilotPosition
    @ObservedObject var store: CoinPilotStore
    @State private var showingSellConfirmation = false

    private var marketDetailCoin: String? {
        guard !store.isBundledPreview, !store.isBundledLocalMarketData,
              let coin = position.coin,
              coin.range(of: "^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil
        else { return nil }
        return coin
    }

    var body: some View {
        Group {
            if let coin = marketDetailCoin {
                NavigationLink(destination: CoinPilotMarketDetailView(store: store, coin: coin)) {
                    rowInner(showsChevron: true)
                }
                .buttonStyle(CoinPilotPressableButtonStyle())
            } else {
                rowInner(showsChevron: false)
            }
        }
        .confirmationDialog(
            "\(CoinPilotFormatting.ticker(position.coin)) 전체 매도",
            isPresented: $showingSellConfirmation,
            titleVisibility: .visible
        ) {
            Button(store.activeWorkspace == .live ? "실거래 전체 매도" : "모의 전체 매도", role: store.activeWorkspace == .live ? .destructive : nil) {
                guard let coin = position.coin, let amount = position.amount else { return }
                Task { _ = await store.submitManualSell(coin: coin, quantity: amount) }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("\(CoinPilotFormatting.quantity(position.amount))개를 시장가로 매도합니다. \(store.activeWorkspace == .live ? "\(store.exchangeDisplayName) 실계정 주문입니다." : "모의 서버 가상 계좌에만 적용됩니다.")")
        }
    }

    private func rowInner(showsChevron: Bool) -> some View {
        HStack(alignment: .center, spacing: 12) {
            CoinAvatar(coin: position.coin)
            VStack(alignment: .leading, spacing: 5) {
                Text(CoinPilotFormatting.symbol(position.coin))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                HStack(spacing: 5) {
                    Text(CoinPilotFormatting.ticker(position.coin))
                    Spacer(minLength: 8)
                    Text("\(CoinPilotFormatting.quantity(position.amount))개")
                }
                .font(.footnote)
                .foregroundColor(CPColor.secondaryInk)
                if position.entryPrice != nil || position.currentPrice != nil {
                    MetadataLine(text: "평단 \(CoinPilotFormatting.price(position.entryPrice)) · 현재 \(CoinPilotFormatting.price(position.currentPrice))")
                        .font(.caption2.monospacedDigit())
                        .foregroundColor(CPColor.secondaryInk)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 5) {
                Text(CoinPilotFormatting.won(position.currentValue, unavailable: "평가액 미제공"))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                HStack(spacing: 5) {
                    Text(CoinPilotFormatting.signedWon(position.profit))
                    if let percent = position.profitPercent {
                        Text(CoinPilotFormatting.percent(percent))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(profitColor(position.profit).opacity(0.09))
                            .clipShape(Capsule())
                    }
                }
                .font(.caption.weight(.medium))
                .foregroundColor(profitColor(position.profit))
                if store.isBundledPreview {
                    EmptyView()
                } else if (position.coin.map { store.manualOrderBlockReason(for: $0) != nil } ?? true) || position.amount == nil {
                    Text("주문 잠김")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CPColor.secondaryInk)
                        .accessibilityLabel("매도 주문 잠김")
                } else {
                    Button("매도") { showingSellConfirmation = true }
                        .buttonStyle(CoinPilotCompactButtonStyle(tint: CPColor.red))
                }
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundColor(CPColor.secondaryInk)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 14)
    }
}

struct MarketRow: View {
    let market: CoinPilotMarketPrice
    let isBundledPreview: Bool
    let maximumAgeSeconds: TimeInterval
    var rank: Int? = nil

    private var freshnessIssue: String? {
        guard !isBundledPreview else { return nil }
        return market.freshnessIssue(at: Date(), maximumAgeSeconds: maximumAgeSeconds)
    }

    private var freshnessLabel: String {
        if isBundledPreview {
            return CoinPilotFormatting.marketTimestamp(market.sourceAsOf, label: "예시 체결")
        }
        guard let freshnessIssue else {
            return CoinPilotFormatting.marketTimestamp(market.sourceAsOf, label: "최근 체결")
        }
        let capturedAt = CoinPilotFormatting.marketTimestamp(market.fetchedAt, label: "서버 수집")
        if freshnessIssue.contains("저장된 최근 시세") {
            return "저장 시세 · \(capturedAt)"
        }
        if freshnessIssue.contains("오래됐") {
            return "오래된 시세 · \(capturedAt)"
        }
        return "시세 확인 필요 · \(capturedAt)"
    }

    var body: some View {
        HStack(spacing: 12) {
            if let rank {
                Text("\(rank)")
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundColor(rank <= 3 ? CPColor.blue : CPColor.secondaryInk)
                    .frame(width: 21, alignment: .leading)
                    .accessibilityLabel("거래대금 \(rank)위")
            }
            CoinAvatar(coin: market.coin)
            VStack(alignment: .leading, spacing: 4) {
                Text(CoinPilotFormatting.symbol(market.coin))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                HStack(spacing: 5) {
                    Text(CoinPilotFormatting.ticker(market.coin))
                    if let volume = market.volumeKrw, volume.isFinite, volume > 0 {
                        Text("24h 거래대금 \(CoinPilotFormatting.compactWon(volume))")
                    }
                }
                .font(.caption)
                .foregroundColor(CPColor.secondaryInk)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                if freshnessIssue != nil {
                    MetadataLine(text: freshnessLabel)
                        .font(.caption2)
                        .foregroundColor(CPColor.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(CoinPilotFormatting.price(market.price))
                    .font(.body.weight(.semibold))
                    .foregroundColor(CPColor.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .fixedSize(horizontal: true, vertical: false)
                HStack(spacing: 3) {
                    if let change = market.change, change != 0 {
                        Image(systemName: change > 0 ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                            .font(.system(size: 6, weight: .bold))
                            .accessibilityHidden(true)
                    }
                    Text(CoinPilotFormatting.percent(market.change))
                }
                .font(.caption.weight(.medium))
                .foregroundColor(profitColor(market.change))
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

struct TradeRow: View {
    let trade: CoinPilotTrade

    private var actionTint: Color {
        switch trade.action {
        case "매수": return CPColor.blue
        case "매도": return CPColor.red
        default: return CPColor.secondaryInk
        }
    }

    private var actionSymbol: String {
        switch trade.action {
        case "매수": return "arrow.down.left"
        case "매도": return "arrow.up.right"
        default: return "arrow.left.arrow.right"
        }
    }

    private var valueLabel: String? {
        if trade.profit != nil { return "실현 손익" }
        if trade.amount != nil { return "거래 금액" }
        if trade.quantity != nil { return "\(trade.action) 수량" }
        if trade.price != nil { return "단가" }
        return nil
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: actionSymbol)
                .font(.body.weight(.medium))
                .foregroundColor(actionTint)
                .frame(width: 34, height: 34)
                .background(actionTint.opacity(0.10))
                .clipShape(Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(trade.coin.map(CoinPilotFormatting.ticker) ?? "자산 미제공")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(CPColor.ink)
                    Text(trade.action)
                        .font(.caption.weight(.medium))
                        .foregroundColor(actionTint)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(actionTint.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                Text(CoinPilotFormatting.dateTime(trade.timestamp, unavailable: "거래 시각 미제공"))
                    .font(.caption)
                    .foregroundColor(CPColor.secondaryInk)
            }
            Spacer(minLength: 5)
            VStack(alignment: .trailing, spacing: 4) {
                Text(valueText)
                    .font(.footnote.weight(.semibold))
                    .foregroundColor(trade.profit == nil ? CPColor.ink : profitColor(trade.profit))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                if let valueLabel {
                    Text(valueLabel)
                        .font(.caption2)
                        .foregroundColor(CPColor.secondaryInk)
                }
                if (trade.profit != nil || trade.amount != nil || trade.quantity != nil), let price = trade.price {
                    Text("단가 \(CoinPilotFormatting.price(price))")
                        .font(.caption2.monospacedDigit())
                        .foregroundColor(CPColor.secondaryInk)
                }
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    private var valueText: String {
        if let profit = trade.profit { return CoinPilotFormatting.signedWon(profit) }
        if let amount = trade.amount { return CoinPilotFormatting.won(amount) }
        if let quantity = trade.quantity { return "\(CoinPilotFormatting.quantity(quantity))개" }
        if let price = trade.price { return CoinPilotFormatting.price(price) }
        return "금액 미제공"
    }
}
