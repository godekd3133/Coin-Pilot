import SwiftUI

struct CoinPilotMarketDetailView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var showsOrderSheet = false
    let coin: String

    private var market: CoinPilotMarketPrice? { store.markets.first(where: { $0.coin == coin }) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        let quoteIssue = store.marketQuoteFreshnessIssue(for: coin)
                        let isExampleData = store.isBundledLocalMarketData || store.isBundledPreview
                        HStack(alignment: .top) {
                            CoinAvatar(coin: coin, size: 44)
                                .padding(.top, 2)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(CoinPilotFormatting.symbol(coin)).font(.title2.weight(.bold)).foregroundColor(CPColor.ink)
                                Text(isExampleData ? "예시·로컬 시세" : "\(store.exchangeDisplayName) \(store.quoteCurrency) 시장")
                                    .font(.caption).foregroundColor(CPColor.secondaryInk)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 5) {
                                Text(CoinPilotFormatting.price(market?.price)).font(.title3.weight(.bold)).monospacedDigit()
                                Text(CoinPilotFormatting.percent(market?.change)).font(.caption.weight(.semibold)).foregroundColor(profitColor(market?.change))
                            }
                        }
                        Divider().overlay(CPColor.line)
                        if let low = market?.low, let high = market?.high, let price = market?.price,
                           low.isFinite, high.isFinite, price.isFinite, high > low {
                            CoinPilotPriceRangeBar(low: low, high: high, price: price)
                        } else {
                            HStack(spacing: 10) {
                                marketMetric("24시간 고가", market?.high)
                                marketMetric("24시간 저가", market?.low)
                            }
                        }
                        Text(CoinPilotFormatting.marketTimestamp(market?.sourceAsOf, label: "최근 체결"))
                            .font(.caption2).foregroundColor(CPColor.secondaryInk)
                        if isExampleData || quoteIssue != nil {
                            HStack(spacing: 6) {
                                Image(systemName: isExampleData
                                      ? "info.circle"
                                      : quoteIssue == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                    .accessibilityHidden(true)
                                Text(store.marketQuoteFreshnessMessage(for: coin))
                            }
                            .font(.caption2)
                            .foregroundColor(isExampleData
                                             ? CPColor.secondaryInk
                                             : quoteIssue == nil ? CPColor.green : CPColor.amber)
                        }
                        if !isExampleData {
                            Text(CoinPilotFormatting.marketTimestamp(market?.fetchedAt, label: "서버 수집"))
                                .font(.caption2).foregroundColor(CPColor.secondaryInk)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        let orderBlockReason = store.manualOrderBlockReason(for: coin)
                        HStack {
                            SectionHeading(title: "가격 흐름")
                            Spacer()
                            Text("완료된 분봉").font(.caption).foregroundColor(CPColor.secondaryInk)
                        }
                        Picker("캔들 간격", selection: Binding(
                            get: { store.selectedCandleInterval },
                            set: { value in Task { await store.loadMarketDetail(coin: coin, interval: value) } }
                        )) {
                            Text("1분").tag(1)
                            Text("5분").tag(5)
                            Text("15분").tag(15)
                            Text("1시간").tag(60)
                        }
                        .pickerStyle(SegmentedPickerStyle())
                        if let message = store.featureMessages["market"] {
                            EmptyMessage(text: message)
                            if store.canOperate {
                                Button("다시 불러오기") {
                                    Task { await store.loadMarketDetail(coin: coin, interval: store.selectedCandleInterval) }
                                }
                                .font(.body.weight(.semibold))
                                .foregroundColor(CPColor.blue)
                                .frame(minHeight: 44)
                                .accessibilityHint("선택한 종목과 캔들 간격의 가격 흐름을 다시 요청합니다.")
                            }
                        } else if store.loadingFeatures.contains("market") && store.candles.isEmpty {
                            ProgressView("캔들 자료를 불러오는 중")
                                .frame(maxWidth: .infinity, minHeight: 190)
                        } else if store.candles.count < 2 {
                            EmptyMessage(text: "차트를 표시할 가격 기록이 충분하지 않습니다.")
                        } else {
                            CoinPilotCandleChart(candles: store.candles)
                                .frame(height: 228)
                            MetadataLine(text: store.marketCandleOriginLabel(candleCount: store.candles.count))
                                .font(.caption2).foregroundColor(CPColor.secondaryInk)
                            if store.loadingFeatures.contains("market") {
                                Text("가격 흐름 갱신 중")
                                    .font(.caption2).foregroundColor(CPColor.secondaryInk)
                            }
                        }
                        CoinPilotCandleDataDisclosure(candles: store.candles)
                        Button {
                            store.selectedMarket = coin
                            showsOrderSheet = true
                        } label: {
                            Text("이 종목 주문 열기")
                                .frame(maxWidth: .infinity, minHeight: 45)
                        }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                        .disabled(orderBlockReason != nil)
                        if let orderBlockReason {
                            InlineNotice(text: orderBlockReason, color: CPColor.amber)
                        }
                    }
                }
                if let detail = store.marketCoinDetail, detail.coin == coin,
                   !store.isBundledPreview, !store.isBundledLocalMarketData {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                SectionHeading(title: "종목과 주문 정보")
                                Spacer()
                                Button {
                                    Task { await store.loadMarketDetail(coin: coin) }
                                } label: {
                                    Image(systemName: "arrow.clockwise")
                                        .font(.callout.weight(.semibold))
                                        .foregroundColor(CPColor.blue)
                                        .frame(minWidth: 44, minHeight: 30)
                                        .contentShape(Rectangle())
                                }
                                .accessibilityLabel("종목 상세 다시 불러오기")
                            }
                            HStack(spacing: 12) {
                                detailRow("현재가", CoinPilotFormatting.price(detail.currentPrice))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("24시간 등락")
                                        .font(.caption2)
                                        .foregroundColor(CPColor.secondaryInk)
                                    Text(CoinPilotFormatting.percent(detail.change24hPercent))
                                        .font(.subheadline.weight(.semibold))
                                        .monospacedDigit()
                                        .foregroundColor(profitColor(detail.change24hPercent))
                                }
                            }
                            HStack(spacing: 12) {
                                detailRow("24시간 고가", CoinPilotFormatting.price(detail.high24h))
                                detailRow("24시간 저가", CoinPilotFormatting.price(detail.low24h))
                                detailRow("24시간 거래대금", CoinPilotFormatting.compactWon(detail.volume24h))
                            }
                            Divider().overlay(CPColor.line)
                            if detail.hasHolding {
                                detailRow("보유 수량", CoinPilotFormatting.quantity(detail.holdingAmount))
                                detailRow("평균 매입가", CoinPilotFormatting.price(detail.holdingAvgPrice))
                                HStack {
                                    detailRow("평가 금액", CoinPilotFormatting.won(detail.holdingValue))
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 2) {
                                        Text("평가 손익").font(.caption2).foregroundColor(CPColor.secondaryInk)
                                        Text("\(CoinPilotFormatting.signedWon(detail.holdingProfit)) (\(CoinPilotFormatting.percent(detail.holdingProfitPercent)))")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundColor(profitColor(detail.holdingProfitPercent))
                                    }
                                }
                            } else {
                                Text("이 종목은 보유하고 있지 않습니다.")
                                    .font(.subheadline).foregroundColor(CPColor.secondaryInk)
                            }
                            Divider().overlay(CPColor.line)
                            HStack(spacing: 12) {
                                detailRow("RSI", CoinPilotFormatting.indicator(detail.rsi, fractionDigits: 1))
                                detailRow("MACD", CoinPilotFormatting.indicator(detail.macdHistogram))
                                detailRow("BB %B", CoinPilotFormatting.indicator(detail.bollingerPercentB))
                            }
                            Divider().overlay(CPColor.line)
                            detailRow("\(store.quoteAssetLabel) 잔고", CoinPilotFormatting.won(detail.krwBalance))
                            HStack(spacing: 12) {
                                detailRow("최대 매수 가능", CoinPilotFormatting.won(detail.maxBuyAmount))
                                detailRow("최대 매도 평가", CoinPilotFormatting.won(detail.maxSellAmount))
                            }
                            if let message = store.featureMessages["market-detail"] {
                                InlineNotice(text: message, color: CPColor.amber)
                            }
                        }
                    }
                }
                if store.canOperate {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "종목별 뉴스")
                            Text("전체 뉴스 화면에서 코인별 기사와 원문을 확인할 수 있습니다.")
                                .font(.subheadline).foregroundColor(CPColor.secondaryInk)
                            NavigationLink(destination: CoinPilotNewsView(store: store)) {
                                FeatureMenuRow(title: "뉴스 보기", detail: "", symbol: "newspaper")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .navigationTitle(CoinPilotFormatting.ticker(coin))
        .coinOrderSheet(store: store, isPresented: $showsOrderSheet)
        .cpInlineTitle()
                        .task { await store.loadMarketDetail(coin: coin) }
    }

    private func detailRow(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption2).foregroundColor(CPColor.secondaryInk)
            Text(value).font(.subheadline.weight(.semibold)).foregroundColor(CPColor.ink)
        }
    }

    private func marketMetric(_ title: String, _ value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption2).foregroundColor(CPColor.secondaryInk)
            Text(CoinPilotFormatting.price(value)).font(.subheadline.weight(.semibold)).foregroundColor(CPColor.ink)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 저가~고가 범위에서 현재가의 위치를 보여주는 가로 막대입니다.
struct CoinPilotPriceRangeBar: View {
    let low: Double
    let high: Double
    let price: Double
    var lowLabel: String = "저가"
    var highLabel: String = "고가"

    private var ratio: Double {
        guard high > low else { return 0.5 }
        return min(max((price - low) / (high - low), 0), 1)
    }

    var body: some View {
        VStack(spacing: 5) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(CPColor.line)
                        .frame(height: 2)
                        .frame(maxHeight: .infinity, alignment: .center)
                    Circle()
                        .fill(CPColor.blue)
                        .frame(width: 9, height: 9)
                        .overlay(Circle().stroke(CPColor.surface, lineWidth: 2))
                        .position(
                            x: 5 + (geometry.size.width - 10) * CGFloat(ratio),
                            y: geometry.size.height / 2
                        )
                }
            }
            .frame(height: 12)
            HStack {
                Text("\(lowLabel) \(CoinPilotFormatting.price(low))")
                Spacer()
                Text("\(highLabel) \(CoinPilotFormatting.price(high))")
            }
            .font(.caption2.monospacedDigit())
            .foregroundColor(CPColor.secondaryInk)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("가격 범위")
        .accessibilityValue("\(lowLabel) \(CoinPilotFormatting.price(low))부터 \(highLabel) \(CoinPilotFormatting.price(high))까지, 현재가 \(CoinPilotFormatting.price(price))")
    }
}

struct CoinPilotCandleChart: View {
    let candles: [CoinPilotCandle]

    private var validCandles: [CoinPilotCandle] {
        candles.filter { $0.open != nil && $0.high != nil && $0.low != nil && $0.close != nil }
    }

    private var accessibilitySummary: String {
        guard let first = validCandles.first, let last = validCandles.last else {
            return "읽을 수 있는 캔들 자료가 없습니다."
        }
        let low = validCandles.compactMap(\.low).min()
        let high = validCandles.compactMap(\.high).max()
        return "최근 종가 \(CoinPilotFormatting.price(last.close)), " +
            "기간 최저가 \(CoinPilotFormatting.price(low)), 최고가 \(CoinPilotFormatting.price(high)), " +
            "\(first.time.map(CoinPilotFormatting.utcMarketTimestamp) ?? "시각 미제공")부터 " +
            "\(last.time.map(CoinPilotFormatting.utcMarketTimestamp) ?? "시각 미제공")까지"
    }

    private func axisLabel(_ value: Double) -> String {
        let formatted = CoinPilotFormatting.compactWon(value)
        return formatted.hasSuffix("원") ? String(formatted.dropLast()) : formatted
    }

    private func candleIndex(x: CGFloat, width: CGFloat) -> Int? {
        let count = validCandles.count
        guard count > 1, width > 90 else { return nil }
        let plotWidth = width - 56
        guard x <= plotWidth else { return count - 1 }
        let step = plotWidth / CGFloat(count)
        let index = Int((x / step).rounded(.down))
        return min(max(index, 0), count - 1)
    }

    var body: some View {
        VStack(spacing: 6) {
            GeometryReader { geometry in
                Canvas { context, size in
                    let valid = validCandles
                    guard valid.count > 1, size.width > 90 else { return }
                    let labelWidth: CGFloat = 56
                    let plotWidth = size.width - labelWidth
                    let showsVolume = valid.contains { ($0.volume ?? 0) > 0 }
                    let volumeHeight = showsVolume ? size.height * 0.17 : 0
                    let volumeGap: CGFloat = showsVolume ? 6 : 0
                    let priceHeight = size.height - volumeHeight - volumeGap
                    let inset: CGFloat = 5

                    let minimum = valid.compactMap(\.low).min() ?? 0
                    let maximum = valid.compactMap(\.high).max() ?? 1
                    let span = max(maximum - minimum, max(abs(maximum) * 0.0001, 0.000001))
                    let step = plotWidth / CGFloat(valid.count)
                    let bodyWidth = max(2, step * 0.55)
                    func y(_ value: Double) -> CGFloat {
                        inset + (priceHeight - inset * 2) * CGFloat(1 - (value - minimum) / span)
                    }

                    if showsVolume, let maxVolume = valid.compactMap(\.volume).max(), maxVolume > 0 {
                        let volumeTop = priceHeight + volumeGap
                        for (index, candle) in valid.enumerated() {
                            guard let volume = candle.volume, volume > 0,
                                  let open = candle.open, let close = candle.close else { continue }
                            let x = CGFloat(index) * step + step / 2
                            let barHeight = max(1.5, CGFloat(volume / maxVolume) * volumeHeight)
                            let tint = close >= open ? CPColor.green : CPColor.red
                            let rect = CGRect(
                                x: x - bodyWidth / 2,
                                y: volumeTop + volumeHeight - barHeight,
                                width: bodyWidth,
                                height: barHeight
                            )
                            context.fill(Path(rect), with: .color(tint.opacity(0.28)))
                        }
                    }

                    if let inspectedIndex, valid.indices.contains(inspectedIndex) {
                        let highlight = CGRect(x: CGFloat(inspectedIndex) * step, y: 0, width: step, height: size.height)
                        context.fill(Path(highlight), with: .color(CPColor.ink.opacity(0.05)))
                    }

                    for (index, candle) in valid.enumerated() {
                        guard let open = candle.open, let high = candle.high, let low = candle.low, let close = candle.close else { continue }
                        let x = CGFloat(index) * step + step / 2
                        let tint = close >= open ? CPColor.green : CPColor.red
                        var wick = Path()
                        wick.move(to: CGPoint(x: x, y: y(high)))
                        wick.addLine(to: CGPoint(x: x, y: y(low)))
                        context.stroke(wick, with: .color(tint.opacity(0.8)), lineWidth: 1)
                        let top = min(y(open), y(close))
                        let height = max(2, abs(y(close) - y(open)))
                        let rect = CGRect(x: x - bodyWidth / 2, y: top, width: bodyWidth, height: height)
                        context.fill(Path(rect), with: .color(tint))
                    }

                    let labelX = plotWidth + 5
                    let labelFont = Font.caption2.monospacedDigit()
                    context.draw(
                        Text(axisLabel(maximum)).font(labelFont).foregroundColor(CPColor.secondaryInk),
                        at: CGPoint(x: labelX, y: inset),
                        anchor: .topLeading
                    )
                    context.draw(
                        Text(axisLabel(minimum)).font(labelFont).foregroundColor(CPColor.secondaryInk),
                        at: CGPoint(x: labelX, y: priceHeight - inset),
                        anchor: .bottomLeading
                    )
                    if let lastClose = valid.last?.close, lastClose.isFinite {
                        let lastY = y(lastClose)
                        let lastTint = (valid.last?.close ?? 0) >= (valid.last?.open ?? 0)
                            ? CPColor.green : CPColor.red
                        var reference = Path()
                        reference.move(to: CGPoint(x: 0, y: lastY))
                        reference.addLine(to: CGPoint(x: plotWidth, y: lastY))
                        context.stroke(
                            reference,
                            with: .color(lastTint.opacity(0.65)),
                            style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                        )
                        if lastY > inset + 12, lastY < priceHeight - inset - 12 {
                            context.draw(
                                Text(axisLabel(lastClose)).font(labelFont.weight(.semibold)).foregroundColor(lastTint),
                                at: CGPoint(x: labelX, y: lastY),
                                anchor: .leading
                            )
                        }
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    LongPressGesture(minimumDuration: 0.25)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            if case .second(true, let drag) = value, let location = drag?.location {
                                inspectedIndex = candleIndex(x: location.x, width: geometry.size.width)
                            }
                        }
                        .onEnded { _ in inspectedIndex = nil }
                )
                .overlay(alignment: .topLeading) {
                    if let inspectedIndex, validCandles.indices.contains(inspectedIndex) {
                        let candle = validCandles[inspectedIndex]
                        VStack(alignment: .leading, spacing: 2) {
                            MetadataLine(text: "\(CoinPilotFormatting.shortUtcTimestamp(candle.time)) UTC · 종가 \(CoinPilotFormatting.price(candle.close))")
                                .foregroundColor((candle.close ?? 0) >= (candle.open ?? 0) ? CPColor.green : CPColor.red)
                            Text("시 \(CoinPilotFormatting.price(candle.open)) 고 \(CoinPilotFormatting.price(candle.high)) 저 \(CoinPilotFormatting.price(candle.low))")
                                .foregroundColor(CPColor.ink)
                        }
                        .font(.caption2.monospacedDigit())
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(CPColor.surface.opacity(0.92))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(CPColor.line, lineWidth: 1))
                        .padding(6)
                        .allowsHitTesting(false)
                    }
                }
            }
            HStack {
                Text(CoinPilotFormatting.shortUtcTimestamp(validCandles.first?.time))
                Spacer()
                Text("\(CoinPilotFormatting.shortUtcTimestamp(validCandles.last?.time)) UTC")
            }
            .font(.caption2)
            .foregroundColor(CPColor.secondaryInk)
        }
        .padding(10)
        .background(CPColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(validCandles.count)개 완료 분봉 가격 차트")
        .accessibilityValue(accessibilitySummary)
        .accessibilityHint("길게 누른 뒤 좌우로 움직이면 각 캔들의 시가·고가·저가·종가를 확인할 수 있습니다.")
    }

    @State private var inspectedIndex: Int?
}

struct CoinPilotCandleDataDisclosure: View {
    let candles: [CoinPilotCandle]

    private var recentCandles: [CoinPilotCandle] {
        Array(candles.suffix(20).reversed())
    }

    var body: some View {
        if !recentCandles.isEmpty {
            DisclosureGroup("최근 캔들 값 (\(recentCandles.count)개)") {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(recentCandles) { candle in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(candle.time.map(CoinPilotFormatting.utcMarketTimestamp) ?? "시각 미제공")
                                    .foregroundColor(CPColor.secondaryInk)
                                Spacer(minLength: 8)
                                Text("종가 \(CoinPilotFormatting.price(candle.close))")
                                    .foregroundColor(CPColor.ink)
                            }
                            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 5) {
                                Text("시가 \(CoinPilotFormatting.price(candle.open))")
                                Text("고가 \(CoinPilotFormatting.price(candle.high))")
                                Text("저가 \(CoinPilotFormatting.price(candle.low))")
                                Text("거래량 \(candle.volume.map { String(format: "%.8f", $0) } ?? "—")")
                            }
                            .foregroundColor(CPColor.secondaryInk)
                        }
                        .font(.caption2.monospacedDigit())
                        if candle.id != recentCandles.last?.id {
                            Divider().overlay(CPColor.line)
                        }
                    }
                }
                .padding(.top, 8)
            }
            .font(.subheadline.weight(.medium))
            .foregroundColor(CPColor.ink)
        }
    }
}

/// RSI 0-100 척도에서 과매도(30 이하)·과매수(70 이상) 구간과 현재 위치를 보여줍니다.
struct CoinPilotRsiGauge: View {
    let value: Double?

    private var zone: (title: String, tint: Color) {
        guard let value, value.isFinite else { return ("RSI 미제공", CPColor.secondaryInk) }
        if value <= 30 { return ("과매도 구간", CPColor.blue) }
        if value >= 70 { return ("과매수 구간", CPColor.red) }
        return ("중립 구간", CPColor.secondaryInk)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("RSI \(value.map { String(format: "%.1f", $0) } ?? "미제공")")
                    .foregroundColor(CPColor.secondaryInk)
                Spacer()
                Text(zone.title)
                    .foregroundColor(zone.tint)
            }
            .font(.caption)
            GeometryReader { geometry in
                ZStack {
                    HStack(spacing: 0) {
                        Rectangle().fill(CPColor.blue.opacity(0.18)).frame(width: geometry.size.width * 0.3, height: 4)
                        Rectangle().fill(CPColor.line).frame(width: geometry.size.width * 0.4, height: 4)
                        Rectangle().fill(CPColor.red.opacity(0.18)).frame(width: geometry.size.width * 0.3, height: 4)
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                    if let value, value.isFinite {
                        Circle()
                            .fill(zone.tint)
                            .frame(width: 9, height: 9)
                            .overlay(Circle().stroke(CPColor.surface, lineWidth: 2))
                            .position(
                                x: 5 + (geometry.size.width - 10) * CGFloat(min(max(value, 0), 100) / 100),
                                y: geometry.size.height / 2
                            )
                    }
                }
            }
            .frame(height: 12)
            HStack {
                Text("과매도 30")
                Spacer()
                Text("과매수 70")
            }
            .font(.caption2)
            .foregroundColor(CPColor.secondaryInk.opacity(0.8))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("RSI 지표")
        .accessibilityValue(value.map { "\(String(format: "%.1f", $0)), \(zone.title)" } ?? "미제공")
    }
}
