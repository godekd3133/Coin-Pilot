import SwiftUI

enum CoinPilotTradeSide: String, CaseIterable, Identifiable, Equatable {
    case buy
    case sell

    var id: String { rawValue }
    var title: String { self == .buy ? "매수" : "매도" }
}

enum CoinPilotWalletAction: String, Identifiable, Equatable {
    case deposit
    case withdraw
    case reset

    var id: String { rawValue }
    var title: String {
        switch self {
        case .deposit: return "모의 지갑 입금"
        case .withdraw: return "모의 지갑 출금"
        case .reset: return "모의 계좌 초기화"
        }
    }
}

enum CoinPilotSmartOrderSide: String, CaseIterable, Identifiable {
    case buy
    case sell

    var id: String { rawValue }
    var title: String { self == .buy ? "조건 매수" : "우선순위 매도" }
}

struct CoinPilotTradingView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var side: CoinPilotTradeSide = .buy
    @State private var usesConditionalOrder = false
    @State private var market = ""
    @State private var buyAmount = ""
    @State private var sellQuantity = ""
    @State private var showingOrderConfirmation = false
    @State private var walletAmount = ""
    @State private var resetSeedMoney = ""
    @State private var walletAction: CoinPilotWalletAction?
    @State private var smartSide: CoinPilotSmartOrderSide = .buy
    @State private var smartAmount = ""
    @State private var smartMinimumScore = "60"
    @State private var smartMaximumCoins = "10"
    @State private var smartSellStrategy = "worst"
    @State private var showingMarketPicker = false
    @State private var requestedSmartSide: CoinPilotSmartOrderSide?
    @State private var requestedRecommendation: CoinPilotRecommendation?
    @State private var requestedBundle: [String: Any]?

    private var availableMarkets: [String] {
        let values = side == .buy
            ? store.markets.compactMap(\.coin)
            : (store.account?.positions.compactMap(\.coin) ?? [])
        return Array(Set(values)).sorted()
    }

    private var selectedPosition: CoinPilotPosition? {
        store.account?.positions.first(where: { $0.coin == market })
    }

    private func restoreAvailableMarket() {
        guard !availableMarkets.contains(market) else { return }
        market = availableMarkets.contains(store.selectedMarket)
            ? store.selectedMarket : (availableMarkets.first ?? "")
    }

    private var currentPrice: Double? {
        if store.isBundledPreview { return store.markets.first { $0.coin == market }?.price }
        return store.freshMarketPrice(for: market)
    }

    private var orderReviewPresentation: CoinPilotOrderReviewPresentation {
        CoinPilotOrderReviewPresentation(
            isBundledPreview: store.isBundledPreview,
            workspace: store.activeWorkspace,
            draftIsValid: orderDraftIsValid,
            blockReason: store.manualOrderBlockReason(for: market),
            isSubmitting: store.isSubmittingManualOrder
        )
    }

    private var parsedBuyAmount: Double? {
        Double(buyAmount.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var parsedSellQuantity: Double? {
        Double(sellQuantity.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func quoteInputText(_ amount: Double) -> String {
        store.quoteCurrency == "KRW" ? String(format: "%.0f", amount.rounded(.down)) : String(amount)
    }

    private func confirmationQuoteAmountText(_ amount: Double?, unavailable: String = "금액 미제공") -> String {
        guard let amount, amount.isFinite else { return unavailable }
        let submittedAmount = store.quoteCurrency == "KRW" ? amount.rounded(.down) : amount
        return CoinPilotFormatting.won(submittedAmount, unavailable: unavailable)
    }

    private func resetCurrencyDrafts() {
        buyAmount = ""
        walletAmount = ""
        smartAmount = quoteInputText(store.quoteCurrency == "KRW" ? 100_000 : 100)
        resetSeedMoney = quoteInputText(store.quoteCurrency == "KRW" ? 10_000_000 : 1_000)
    }

    private var conditionalOrderDraftIsValid: Bool {
        guard let amount = Double(smartAmount), amount.isFinite,
              amount >= (smartSide == .buy ? store.minimumOrderAmount : store.minimumSmartSellAmount) else { return false }
        guard smartSide == .buy else { return true }
        guard let score = Int(smartMinimumScore), (0...100).contains(score),
              let count = Int(smartMaximumCoins), (1...30).contains(count),
              let balance = store.account?.krwBalance, balance.isFinite, amount <= balance else { return false }
        return true
    }

    private var conditionalOrderConfirmationMessage: String {
        let requestedSide = requestedSmartSide ?? smartSide
        let amount = confirmationQuoteAmountText(Double(smartAmount))
        var lines = ["\(store.activeWorkspace.title) \(requestedSide.title)"]
        if requestedSide == .buy {
            lines.append("총 투자 금액 \(amount)")
            lines.append("신호 점수 기준 \(smartMinimumScore)점\n최대 \(smartMaximumCoins)종목")
            lines.append("기준에 맞는 종목이 없으면 점수가 낮은 상위 후보를 주문할 수 있습니다.")
        } else {
            let priority: String
            switch smartSellStrategy {
            case "worst": priority = "손실이 큰 순서"
            case "best": priority = "수익이 큰 순서"
            case "overbought": priority = "과매수 신호 우선"
            default: priority = "선택한 우선순위"
            }
            lines.append("목표 매도 금액 \(amount)")
            lines.append("매도 우선순위: \(priority)")
        }
        if store.activeWorkspace == .live {
            lines.append("여러 종목에 실제 주문이 전송될 수 있습니다. 응답이 끊기면 새 주문은 잠기며, 같은 요청으로만 결과를 확인할 수 있습니다.")
        } else {
            lines.append("모의 계좌에만 반영되며 실제 자금은 이동하지 않습니다.")
        }
        return lines.joined(separator: "\n")
    }

    private var bundleConfirmationMessage: String {
        guard let bundle = requestedBundle,
              let sell = bundle["sell"] as? [String: Any],
              let buy = bundle["buy"] as? [String: Any],
              let sellCoin = sell["coin"] as? String,
              let buyCoin = buy["coin"] as? String else { return "" }
        let quantity = (sell["amount"] as? NSNumber)?.doubleValue
        let amount = (buy["suggestedAmount"] as? NSNumber)?.doubleValue
        let sellDetail = quantity.map { "\(CoinPilotFormatting.quantity($0))개" } ?? "보유량 전체"
        let buyDetail = amount.map { confirmationQuoteAmountText($0) }
            ?? "수수료를 뺀 매도 대금의 95%"
        var lines = ["\(store.activeWorkspace.title) 종목 교체",
                     "매도  \(CoinPilotFormatting.ticker(sellCoin)) \(sellDetail)",
                     "매수  \(CoinPilotFormatting.ticker(buyCoin)) \(buyDetail)"]
        if store.activeWorkspace == .live {
            lines.append("매도와 매수는 각각 처리되므로 일부 주문만 체결될 수 있습니다.")
        }
        return lines.joined(separator: "\n")
    }

    private var conditionalOrderValidationMessages: [String] {
        var messages: [String] = []
        if !smartAmount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let minimum = smartSide == .buy ? store.minimumOrderAmount : store.minimumSmartSellAmount
            if let amount = Double(smartAmount), amount.isFinite {
                if amount < minimum {
                    messages.append("\(smartSide == .buy ? "총 투자 금액" : "목표 매도 금액")은 \(CoinPilotFormatting.won(minimum)) 이상 입력해 주세요.")
                } else if smartSide == .buy {
                    if let balance = store.account?.krwBalance, balance.isFinite {
                        if amount > balance {
                            messages.append("총 투자 금액이 주문 가능 잔액 \(CoinPilotFormatting.won(balance))을 넘었습니다.")
                        }
                    } else {
                        messages.append("주문 가능 잔액을 확인하지 못했습니다. 계좌 정보를 새로고침해 주세요.")
                    }
                }
            } else {
                messages.append("금액을 올바른 숫자로 입력해 주세요.")
            }
        }
        if smartSide == .buy {
            if !smartMinimumScore.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               Int(smartMinimumScore).map({ !(0...100).contains($0) }) ?? true {
                messages.append("신호 점수 기준은 0~100 사이의 정수로 입력해 주세요.")
            }
            if !smartMaximumCoins.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               Int(smartMaximumCoins).map({ !(1...30).contains($0) }) ?? true {
                messages.append("최대 매수 종목 수는 1~30 사이의 정수로 입력해 주세요.")
            }
        }
        return messages
    }

    private var walletDraftIsValid: Bool {
        guard let amount = Double(walletAmount), amount.isFinite else { return false }
        return amount >= store.minimumWalletAmount
    }

    private var withdrawalDraftIsValid: Bool {
        guard walletDraftIsValid, let amount = Double(walletAmount),
              let balance = store.account?.krwBalance, balance.isFinite else { return false }
        return amount <= balance
    }

    private var seedDraftIsValid: Bool {
        guard let amount = Double(resetSeedMoney), amount.isFinite else { return false }
        return amount >= store.minimumSeedAmount
    }

    /// 매도 시 보유 포지션의 평단·평가액·손익을 한 줄로 요약합니다. 값이 없는 항목은 생략합니다.
    private func sellPositionSummary(_ position: CoinPilotPosition) -> String {
        var parts: [String] = []
        if position.entryPrice != nil {
            parts.append("평단 \(CoinPilotFormatting.price(position.entryPrice))")
        }
        if position.currentValue != nil {
            parts.append("평가 \(CoinPilotFormatting.won(position.currentValue))")
        }
        if position.profit != nil {
            parts.append("손익 \(CoinPilotFormatting.signedWon(position.profit)) (\(CoinPilotFormatting.percent(position.profitPercent)))")
        }
        return parts.joined(separator: " · ")
    }

    private var orderDraftIsValid: Bool {
        guard !market.isEmpty else { return false }
        if side == .buy {
            guard let amount = parsedBuyAmount, amount.isFinite, amount >= store.minimumOrderAmount,
                  let balance = store.account?.krwBalance, balance.isFinite, amount <= balance else { return false }
            return true
        }
        guard let quantity = parsedSellQuantity, quantity.isFinite, quantity > 0,
              let held = selectedPosition?.amount, held.isFinite, quantity <= held else { return false }
        return true
    }

    private var confirmationTitle: String {
        "\(store.activeWorkspace.title) \(CoinPilotFormatting.symbol(market)) \(side.title)"
    }

    private var confirmationDetail: String {
        let amount = side == .buy
            ? confirmationQuoteAmountText(parsedBuyAmount, unavailable: "금액 확인 필요")
            : "\(sellQuantity)개\n예상 \(CoinPilotFormatting.won(currentPrice.map { $0 * (parsedSellQuantity ?? 0) }, unavailable: "평가 불가"))"
        if store.activeWorkspace == .live {
            return "\(store.exchangeDisplayName) 실계정으로 시장가 주문을 보냅니다.\n\(amount)\n서버의 계좌 동기화·주문 안전 검사가 통과해야 접수됩니다."
        }
        return "모의 서버의 가상 계좌에서만 처리합니다.\n\(amount)\n실제 거래소로 주문을 보내지 않습니다."
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let message = store.dashboardMessage {
                    InlineNotice(text: message, color: CPColor.amber)
                }
                if let safetyMessage = store.runtimeSafetyMessage {
                    InlineNotice(text: safetyMessage, color: CPColor.amber)
                }
                if store.pendingManualOrderLocked { pendingOrderCard }
                if let message = store.orderMessage {
                    InlineNotice(text: message, color: store.pendingManualOrderLocked ? CPColor.amber : CPColor.secondaryInk)
                }
                if store.supportsAmountCurrency {
                    if store.isBundledPreview {
                        InlineNotice(text: "예시 주문 화면입니다. 주문은 실행되지 않습니다.", color: CPColor.blue, symbol: "info.circle.fill")
                    }
                    Picker("주문 방법", selection: $usesConditionalOrder) {
                        Text("직접 주문").tag(false)
                        Text("조건 주문").tag(true)
                    }
                    .pickerStyle(SegmentedPickerStyle())
                    if usesConditionalOrder { conditionalOrderEntry }
                    else { orderEntry }
                    if !store.isBundledPreview {
                        NativeDisclosureCard(title: "분석과 종목 교체") { recommendationSection }
                        CoinPilotAutomationControl(store: store)
                        if store.activeWorkspace == .paper {
                            NativeDisclosureCard(title: "모의 자금 관리") { paperWallet }
                        }
                    }
                } else {
                    InlineNotice(text: store.manualOrderBlockReason ?? "\(store.quoteCurrency) 기준 통화는 조회만 지원합니다.", color: CPColor.amber)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 34)
        }
        .cpReadableWidth()
        .background(CPColor.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
        .cpScrollDismissesKeyboard()
        .cpKeyboardDoneToolbar()
        .cpOnChange(of: side) { _ in
            market = availableMarkets.first ?? ""
            sellQuantity = ""
        }
        .cpOnChange(of: store.activeWorkspace) { _ in
            market = ""
            buyAmount = ""
            sellQuantity = ""
        }
        .cpOnChange(of: store.selectedMarket) { newValue in
            if availableMarkets.contains(newValue) { market = newValue }
        }
        .cpOnChange(of: availableMarkets) { _ in restoreAvailableMarket() }
        .cpOnChange(of: store.quoteCurrency) { _ in resetCurrencyDrafts() }
        .onAppear {
            restoreAvailableMarket()
            if smartAmount.isEmpty && resetSeedMoney.isEmpty { resetCurrencyDrafts() }
        }
        .confirmationDialog(confirmationTitle, isPresented: $showingOrderConfirmation, titleVisibility: .visible) {
            if side == .buy {
                Button(store.activeWorkspace == .live ? "실거래 매수 전송" : "모의 매수 실행", role: store.activeWorkspace == .live ? .destructive : nil) {
                    Task { _ = await store.submitManualBuy(coin: market, amount: parsedBuyAmount ?? 0) }
                }
            } else {
                Button(store.activeWorkspace == .live ? "실거래 매도 전송" : "모의 매도 실행", role: store.activeWorkspace == .live ? .destructive : nil) {
                    Task { _ = await store.submitManualSell(coin: market, quantity: parsedSellQuantity ?? 0) }
                }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text(confirmationDetail)
        }
        .confirmationDialog(walletAction?.title ?? "모의 지갑", isPresented: Binding(
            get: { walletAction != nil },
            set: { if !$0 { walletAction = nil } }
        ), titleVisibility: .visible) {
            if let walletAction {
                Button(walletAction == .reset ? "초기화하고 다시 시작" : walletAction.title,
                       role: walletAction == .reset ? .destructive : nil) {
                    let action = walletAction
                    self.walletAction = nil
                    Task {
                        switch action {
                        case .deposit:
                            _ = await store.updatePaperWallet(amount: Double(walletAmount) ?? 0, deposit: true)
                            walletAmount = ""
                        case .withdraw:
                            _ = await store.updatePaperWallet(amount: Double(walletAmount) ?? 0, deposit: false)
                            walletAmount = ""
                        case .reset:
                            _ = await store.resetPaperWallet(seedMoney: Double(resetSeedMoney) ?? 0)
                        }
                    }
                }
            }
            Button("취소", role: .cancel) { walletAction = nil }
        } message: {
            Text(walletAction == .reset
                 ? "가상 잔액을 \(confirmationQuoteAmountText(Double(resetSeedMoney)))으로 바꿉니다. 현재 모의 보유량과 매매 기록이 삭제됩니다."
                 : "\(confirmationQuoteAmountText(Double(walletAmount)))을 모의 계좌에서 \(walletAction == .deposit ? "입금" : "출금")합니다. 실제 자금은 이동하지 않습니다.")
        }
        .confirmationDialog(
            requestedSmartSide?.title ?? "조건 주문",
            isPresented: Binding(get: { requestedSmartSide != nil }, set: { if !$0 { requestedSmartSide = nil } }),
            titleVisibility: .visible
        ) {
            if let requestedSmartSide {
                Button(store.activeWorkspace == .live ? "실거래 조건 주문 전송" : "모의 조건 주문 실행",
                       role: store.activeWorkspace == .live ? .destructive : nil) {
                    self.requestedSmartSide = nil
                    Task {
                        if requestedSmartSide == .buy {
                            _ = await store.submitSmartBuy(
                                totalAmount: Double(smartAmount) ?? 0,
                                minimumScore: Int(smartMinimumScore) ?? 60,
                                maximumCoins: Int(smartMaximumCoins) ?? 10
                            )
                        } else {
                            _ = await store.submitSmartSell(
                                targetAmount: Double(smartAmount) ?? 0,
                                strategy: smartSellStrategy
                            )
                        }
                    }
                }
            }
            Button("취소", role: .cancel) { requestedSmartSide = nil }
        } message: {
            Text(conditionalOrderConfirmationMessage)
        }
        .confirmationDialog(
            "추천 주문을 확인해 주세요",
            isPresented: Binding(get: { requestedRecommendation != nil }, set: { if !$0 { requestedRecommendation = nil } }),
            titleVisibility: .visible
        ) {
            if let recommendation = requestedRecommendation {
                Button(store.activeWorkspace == .live ? "실거래 추천 주문 전송" : "모의 추천 주문 실행",
                       role: store.activeWorkspace == .live ? .destructive : nil) {
                    requestedRecommendation = nil
                    Task { _ = await store.submitRecommendation(recommendation) }
                }
            }
            Button("취소", role: .cancel) { requestedRecommendation = nil }
        } message: {
            Text(requestedRecommendation.map { recommendation in
                let detail = recommendation.action == "BUY"
                    ? "매수 \(confirmationQuoteAmountText(recommendation.suggestedAmount ?? store.buyAmountPresets[1]))"
                    : "보유량 전체 매도"
                return "\(CoinPilotFormatting.ticker(recommendation.coin)) \(detail)\n분석 결과는 참고 정보이며, 주문 전 서버의 거래 안전 검사를 다시 확인합니다."
            } ?? "")
        }
        .confirmationDialog(
            "종목 교체",
            isPresented: Binding(get: { requestedBundle != nil }, set: { if !$0 { requestedBundle = nil } }),
            titleVisibility: .visible
        ) {
            if let bundle = requestedBundle,
               let sell = bundle["sell"] as? [String: Any],
               let buy = bundle["buy"] as? [String: Any],
               let sellCoin = sell["coin"] as? String,
               let buyCoin = buy["coin"] as? String {
                Button(store.activeWorkspace == .live ? "실거래 종목 교체 전송" : "모의 종목 교체 실행",
                       role: store.activeWorkspace == .live ? .destructive : nil) {
                    requestedBundle = nil
                    let sellAmount = (sell["amount"] as? NSNumber)?.doubleValue
                    let buyAmount = (buy["suggestedAmount"] as? NSNumber)?.doubleValue
                    Task { _ = await store.submitBundle(sellCoin: sellCoin, sellAmount: sellAmount, buyCoin: buyCoin, buyAmount: buyAmount) }
                }
            }
            Button("취소", role: .cancel) { requestedBundle = nil }
        } message: {
            Text(bundleConfirmationMessage)
        }
        .sheet(isPresented: $showingMarketPicker) {
            CoinPilotMarketPickerSheet(
                store: store,
                side: side,
                availableMarkets: availableMarkets,
                selected: market
            ) { selected in
                market = selected
                showingMarketPicker = false
            }
        }
        .task {
            if store.buyRecommendations.isEmpty && store.sellRecommendations.isEmpty { await store.loadRecommendations() }
            if store.bundleSuggestions.isEmpty { await store.loadBundleSuggestions() }
        }
    }

    private var conditionalOrderEntry: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SectionHeading(title: "조건 주문")
                    Spacer()
                    Text(store.isBundledPreview ? "예시 계좌" : store.activeWorkspace.title)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(store.activeWorkspace == .live ? CPColor.red : CPColor.blue)
                }
                Picker("주문 방식", selection: $smartSide) {
                    ForEach(CoinPilotSmartOrderSide.allCases) { value in Text(value.title).tag(value) }
                }
                .pickerStyle(SegmentedPickerStyle())
                FieldTitle(title: smartSide == .buy ? "총 투자 금액 (\(store.quoteCurrency))" : "목표 매도 금액 (\(store.quoteCurrency))")
                TextField("금액 입력", text: $smartAmount)
                    .cpKeyboardDecimalPad()
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(smartSide == .buy ? "조건 매수 총 투자 금액" : "조건 매도 목표 금액")
                if smartSide == .buy {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("신호 점수 기준").font(.caption).foregroundColor(CPColor.secondaryInk)
                            TextField("60", text: $smartMinimumScore)
                                .cpKeyboardNumberPad().textFieldStyle(.roundedBorder)
                                .accessibilityLabel("신호 점수 기준")
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text("최대 종목 수").font(.caption).foregroundColor(CPColor.secondaryInk)
                            TextField("10", text: $smartMaximumCoins)
                                .cpKeyboardNumberPad().textFieldStyle(.roundedBorder)
                                .accessibilityLabel("최대 매수 종목 수")
                        }
                    }
                    Text("서버가 거래량 상위 종목을 분석해 잔액 범위 안에서 나눠 주문합니다. 조건을 충족한 종목이 없을 때는 서버 기준의 상위 후보가 사용될 수 있습니다.")
                        .font(.caption)
                        .foregroundColor(CPColor.secondaryInk)
                } else {
                    Picker("매도 우선순위", selection: $smartSellStrategy) {
                        Text("손실이 큰 순서").tag("worst")
                        Text("수익이 큰 순서").tag("best")
                        Text("과매수 신호 우선").tag("overbought")
                    }
                    .pickerStyle(MenuPickerStyle())
                }
                if !conditionalOrderValidationMessages.isEmpty {
                    InlineNotice(text: conditionalOrderValidationMessages.joined(separator: "\n"), color: CPColor.amber)
                }
                Button(smartSide.title) { requestedSmartSide = smartSide }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(!conditionalOrderDraftIsValid || store.manualOrderBlockReason != nil || store.pendingManualOrderLocked)
            }
        }
    }

    private var recommendationSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            NativeCard {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        SectionHeading(title: "매수·매도 검토")
                        Spacer()
                        Button(store.loadingFeatures.contains("recommendations") ? "분석 중" : "새로 분석") { Task { await store.loadRecommendations() } }
                            .font(.caption.weight(.semibold))
                            .disabled(store.loadingFeatures.contains("recommendations"))
                    }
                    if let message = store.featureMessages["recommendations"] {
                        EmptyMessage(text: message)
                    } else if store.buyRecommendations.isEmpty && store.sellRecommendations.isEmpty {
                        EmptyMessage(text: store.loadingFeatures.contains("recommendations") ? "분석 중" : "현재 검토할 종목이 없습니다.")
                    }
                    let recommendations = Array((store.buyRecommendations + store.sellRecommendations).prefix(8))
                    ForEach(recommendations) { recommendation in
                        let actionTint: Color = recommendation.action == "BUY" ? CPColor.blue : CPColor.red
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(spacing: 7) {
                                Text(CoinPilotFormatting.ticker(recommendation.coin))
                                    .font(.subheadline.weight(.semibold))
                                Text(recommendation.action == "BUY" ? "매수 검토" : "매도 검토")
                                    .font(.caption2.weight(.bold))
                                    .foregroundColor(actionTint)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 3)
                                    .background(actionTint.opacity(0.10))
                                    .clipShape(Capsule())
                                Spacer()
                                if let confidence = recommendation.confidence {
                                    Text("점수 \(Int(confidence))")
                                        .font(.caption.weight(.semibold))
                                        .monospacedDigit()
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                            }
                            if let reason = recommendation.reason {
                                Text(reason).font(.caption).foregroundColor(CPColor.secondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack {
                                Text(CoinPilotFormatting.won(recommendation.price, unavailable: "현재가 미제공"))
                                    .font(.caption)
                                    .monospacedDigit()
                                Spacer()
                                Button(recommendation.action == "BUY" ? "매수 검토" : "보유량 전체 매도") {
                                    requestedRecommendation = recommendation
                                }
                                .buttonStyle(CoinPilotCompactButtonStyle(tint: actionTint))
                                .disabled(store.manualOrderBlockReason(for: recommendation.coin) != nil || store.pendingManualOrderLocked)
                            }
                        }
                        .padding(.vertical, 8)
                        if recommendation.id != recommendations.last?.id { Divider().overlay(CPColor.line) }
                    }
                }
            }
            NativeCard {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        SectionHeading(title: "종목 교체 제안")
                        Spacer()
                        Button(store.loadingFeatures.contains("bundles") ? "분석 중" : "새로 분석") { Task { await store.loadBundleSuggestions() } }
                            .font(.caption.weight(.semibold))
                            .disabled(store.loadingFeatures.contains("bundles"))
                    }
                    if let message = store.featureMessages["bundles"] {
                        EmptyMessage(text: message)
                    } else if store.bundleSuggestions.isEmpty {
                        EmptyMessage(text: "현재 표시할 종목 교체 제안이 없습니다.")
                    }
                    ForEach(Array(store.bundleSuggestions.prefix(5).enumerated()), id: \.offset) { entry in
                        let bundle = entry.element
                        let sell = bundle["sell"] as? [String: Any] ?? [:]
                        let buy = bundle["buy"] as? [String: Any] ?? [:]
                        let sellCoin = sell["coin"] as? String ?? "보유 종목"
                        let buyCoin = buy["coin"] as? String ?? "매수 종목"
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(CoinPilotFormatting.ticker(sellCoin)) → \(CoinPilotFormatting.ticker(buyCoin))")
                                .font(.subheadline.weight(.semibold))
                            Text(bundle["rationale"] as? String ?? bundle["summary"] as? String ?? "종목 교체 제안")
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack {
                                Spacer()
                                Button("종목 교체 검토") { requestedBundle = bundle }
                                    .buttonStyle(CoinPilotCompactButtonStyle(tint: CPColor.blue))
                                    .disabled(store.manualOrderBlockReason(forMarkets: [sellCoin, buyCoin]) != nil || store.pendingManualOrderLocked)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }
            }
        }
    }

    private var orderEntry: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    SectionHeading(title: orderReviewPresentation.sectionTitle)
                    Spacer()
                    MetadataLine(text: orderReviewPresentation.accountTitle)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(!store.isBundledPreview && store.activeWorkspace == .live
                                         ? CPColor.red
                                         : CPColor.blue)
                }
                Picker("매수 또는 매도", selection: $side) {
                    ForEach(CoinPilotTradeSide.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(SegmentedPickerStyle())
                if availableMarkets.isEmpty {
                    EmptyMessage(text: side == .buy ? "시세 종목을 불러오면 매수할 수 있습니다." : "매도할 보유 자산이 없습니다.")
                } else {
                    HStack {
                        Button {
                            showingMarketPicker = true
                        } label: {
                            HStack(spacing: 6) {
                                if !market.isEmpty {
                                    CoinAvatar(coin: market, size: 24)
                                }
                                Text(market.isEmpty ? "종목 선택" : CoinPilotFormatting.symbol(market))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundColor(CPColor.ink)
                                if !market.isEmpty {
                                    Text(CoinPilotFormatting.ticker(market))
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                                Image(systemName: "chevron.down")
                                    .font(.caption2.weight(.bold))
                                    .foregroundColor(CPColor.secondaryInk)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(CPColor.paper)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                        }
                        .buttonStyle(CoinPilotPressableButtonStyle())
                        .accessibilityLabel("주문 종목 선택")
                        if !store.isBundledPreview && !store.isBundledLocalMarketData,
                           market.range(of: "^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$", options: .regularExpression) != nil {
                            NavigationLink(destination: CoinPilotMarketDetailView(store: store, coin: market)) {
                                Label("시세", systemImage: "chart.line.uptrend.xyaxis")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(CPColor.blue)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(CPColor.blue.opacity(0.08))
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(CoinPilotPressableButtonStyle())
                        }
                    }

                    HStack {
                        Text(store.isBundledPreview ? "예시 가격" : "현재가")
                            .font(.subheadline)
                            .foregroundColor(CPColor.secondaryInk)
                        Spacer()
                        Text(CoinPilotFormatting.won(currentPrice, unavailable: "시세 확인 불가"))
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(CPColor.ink)
                    }

                    if side == .buy {
                        FieldTitle(title: "매수 금액 (\(store.quoteCurrency))")
                        TextField("최소 \(CoinPilotFormatting.won(store.minimumOrderAmount))", text: $buyAmount)
                            .cpKeyboardDecimalPad()
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .background(CPColor.paper)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                            .accessibilityLabel("매수 금액 \(store.quoteCurrency)")
                        HStack(spacing: 8) {
                            ForEach(store.buyAmountPresets, id: \.self) { amount in
                                Button(CoinPilotFormatting.won(amount)) { buyAmount = quoteInputText(amount) }
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(CPColor.blue)
                            }
                        }
                        if let balance = store.account?.krwBalance, balance >= store.minimumOrderAmount {
                            HStack(spacing: 8) {
                                Text("잔고")
                                    .font(.caption)
                                    .foregroundColor(CPColor.secondaryInk)
                                ForEach([25.0, 50.0, 100.0], id: \.self) { percent in
                                    Button("\(Int(percent))%") {
                                        buyAmount = quoteInputText(percent == 100 ? balance : balance * percent / 100)
                                    }
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(CPColor.blue)
                                }
                            }
                        }
                        MetadataLine(text: "사용 가능 잔액 · \(CoinPilotFormatting.won(store.account?.krwBalance, unavailable: "확인 불가"))")
                            .font(.caption)
                            .foregroundColor(CPColor.secondaryInk)
                        if let amount = parsedBuyAmount, amount.isFinite, amount >= store.minimumOrderAmount,
                           let price = currentPrice, price.isFinite, price > 0 {
                            MetadataLine(text: "수수료 전 예상 수량 약 \(CoinPilotFormatting.quantity(amount / price))개 · 실제 체결가와 수수료에 따라 달라집니다.")
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                        }
                    } else {
                        FieldTitle(title: "매도 수량")
                        TextField("보유 수량", text: $sellQuantity)
                            .cpKeyboardDecimalPad()
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .background(CPColor.paper)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                            .accessibilityLabel("매도 수량")
                        HStack(spacing: 14) {
                            Text("보유 \(CoinPilotFormatting.quantity(selectedPosition?.amount))")
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                            Spacer()
                            ForEach([25.0, 50.0, 100.0], id: \.self) { percent in
                                Button("\(Int(percent))%") {
                                    guard let amount = selectedPosition?.amount else { return }
                                    sellQuantity = CoinPilotFormatting.editableNumber(percent == 100 ? amount : amount * percent / 100)
                                }
                                .font(.caption.weight(.semibold))
                                .foregroundColor(CPColor.blue)
                            }
                        }
                        if let position = selectedPosition, !sellPositionSummary(position).isEmpty {
                            MetadataLine(text: sellPositionSummary(position))
                                .font(.caption)
                                .foregroundColor(CPColor.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    if !store.isBundledPreview, !store.isRefreshing, let blockReason = store.manualOrderBlockReason(for: market) {
                        InlineNotice(text: blockReason, color: CPColor.amber)
                    }
                    Button {
                        showingOrderConfirmation = true
                    } label: {
                        HStack {
                            Spacer()
                            if store.isSubmittingManualOrder { ProgressView().tint(.white) }
                            Text(orderReviewPresentation.buttonTitle)
                                .font(.headline.weight(.semibold))
                            Spacer()
                        }
                        .frame(minHeight: 56)
                        .foregroundColor(orderReviewPresentation.isEnabled
                                         ? .white
                                         : CPColor.secondaryInk)
                        .background(orderReviewPresentation.isEnabled
                                    ? (store.activeWorkspace == .live ? CPColor.redFill : CPColor.blueFill)
                                    : CPColor.line)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                    .disabled(!orderReviewPresentation.isEnabled)
                    if !store.isBundledPreview {
                        Text(store.activeWorkspace == .live
                             ? "주문 전 종목·금액을 다시 확인합니다. 거래소 API 키는 서버에만 보관됩니다."
                             : "모의 주문은 선택한 모의투자 서버의 가상 자산만 바꿉니다.")
                            .font(.footnote)
                            .foregroundColor(CPColor.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private var paperWallet: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SectionHeading(title: store.isBundledPreview ? "예시 계좌" : "모의 계좌")
                    Spacer()
                    Text(CoinPilotFormatting.won(store.account?.krwBalance, unavailable: "잔액 확인 중"))
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CPColor.ink)
                }
                Text(store.isBundledPreview
                     ? "앱에 포함된 예시 잔액이며 변경되지 않습니다."
                     : "모의투자 서버의 가상 잔액만 변경됩니다. 현재 연결된 실거래 계좌에는 영향을 주지 않습니다.")
                    .font(.footnote)
                    .foregroundColor(CPColor.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                if !store.isBundledPreview {
                    TextField("입금·출금 금액 (\(store.quoteCurrency))", text: $walletAmount)
                        .cpKeyboardDecimalPad()
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 46)
                        .background(CPColor.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .accessibilityLabel("모의 계좌 입금·출금 금액")
                    HStack(spacing: 10) {
                        Button("입금") { walletAction = .deposit }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                            .disabled(store.paperWalletBlockReason != nil || !walletDraftIsValid)
                        Button("출금") { walletAction = .withdraw }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                            .disabled(store.paperWalletBlockReason != nil || !withdrawalDraftIsValid)
                    }
                    Divider().overlay(CPColor.line)
                    TextField("초기 잔액 (\(store.quoteCurrency))", text: $resetSeedMoney)
                        .cpKeyboardDecimalPad()
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 46)
                        .background(CPColor.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .accessibilityLabel("모의 계좌 초기 잔액")
                    Button("모의 계좌 초기화", role: .destructive) { walletAction = .reset }
                        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                        .disabled(store.paperWalletBlockReason != nil || !seedDraftIsValid)
                    if let reason = store.paperWalletBlockReason {
                        Text(reason)
                            .font(.caption)
                            .foregroundColor(CPColor.amber)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private var pendingOrderCard: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading(title: "미확정 주문")
                if let pending = store.pendingManualOrder {
                    MetadataLine(text: "\(pending.mode == "LIVE" ? "실거래" : "모의투자") · \(CoinPilotFormatting.ticker(pending.market)) \(pending.side) · \(pending.displayAmount)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(CPColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("기기에 저장된 주문 확인 기록을 읽지 못했습니다. 새 주문을 보내지 말고 서버 주문 기록을 먼저 확인하세요.")
                        .font(.subheadline)
                        .foregroundColor(CPColor.secondaryInk)
                }
                if store.pendingManualOrder != nil, store.canOperate {
                    Button {
                        Task { _ = await store.retryPendingManualOrder() }
                    } label: {
                        Text(store.isSubmittingManualOrder ? "같은 요청 확인 중" : "같은 요청으로 결과 확인")
                            .frame(maxWidth: .infinity, minHeight: 46)
                    }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(store.isSubmittingManualOrder)
                }
            }
        }
    }
}

/// 주문 종목 선택 시트 — 검색과 시세/보유량을 함께 보여주는 전체 화면 목록.
/// MenuPickerStyle 드롭다운보다 수백 개 시장을 고르기 쉽다.
struct CoinPilotMarketPickerSheet: View {
    @ObservedObject var store: CoinPilotStore
    let side: CoinPilotTradeSide
    let availableMarkets: [String]
    let selected: String
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var rows: [String] {
        let base = availableMarkets.filter { coin in
            search.isEmpty ||
              coin.localizedCaseInsensitiveContains(search) ||
              CoinPilotFormatting.symbol(coin).localizedCaseInsensitiveContains(search) ||
              CoinPilotFormatting.ticker(coin).localizedCaseInsensitiveContains(search)
        }
        if side == .buy {
            // 매수는 거래대금 순으로 — 유동성이 높은 종목이 먼저 보인다.
            var volumeByCoin: [String: Double] = [:]
            for marketRow in store.markets {
                if let coin = marketRow.coin {
                    volumeByCoin[coin] = marketRow.volumeKrw ?? 0
                }
            }
            return base.sorted { (volumeByCoin[$0] ?? 0) > (volumeByCoin[$1] ?? 0) }
        }
        return base
    }

    private func position(for coin: String) -> CoinPilotPosition? {
        store.account?.positions.first(where: { $0.coin == coin })
    }

    private func marketPrice(for coin: String) -> CoinPilotMarketPrice? {
        store.markets.first(where: { $0.coin == coin })
    }

    var body: some View {
        CoinPilotNavigationHost {
            List {
                ForEach(rows, id: \.self) { coin in
                    Button {
                        onSelect(coin)
                    } label: {
                        HStack {
                            CoinAvatar(coin: coin, size: 34)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(CoinPilotFormatting.symbol(coin))
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundColor(CPColor.ink)
                                    Text(CoinPilotFormatting.ticker(coin))
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                    if coin == selected {
                                        Image(systemName: "checkmark.circle.fill")
                                            .font(.caption)
                                            .foregroundColor(CPColor.blue)
                                    }
                                }
                                if side == .sell, let position = position(for: coin) {
                                    MetadataLine(text: "보유 \(CoinPilotFormatting.quantity(position.amount))개 · 평단 \(CoinPilotFormatting.price(position.entryPrice))")
                                        .font(.caption)
                                        .foregroundColor(CPColor.secondaryInk)
                                }
                            }
                            Spacer()
                            if let price = marketPrice(for: coin) {
                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(CoinPilotFormatting.won(price.price, unavailable: "-"))
                                        .font(.subheadline.weight(.medium))
                                        .foregroundColor(CPColor.ink)
                                    if let change = price.change {
                                        Text(CoinPilotFormatting.percent(change))
                                            .font(.caption)
                                            .foregroundColor(profitColor(change))
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(CoinPilotPressableButtonStyle())
                }
            }
            .listStyle(PlainListStyle())
            .navigationTitle(side == .buy ? "매수 종목 선택" : "매도 종목 선택")
            .cpInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }.keyboardShortcut(.cancelAction)
                }
            }
            .cpSearchableSheet(text: $search, prompt: "종목 검색")
        }
        .cpEditorSheetFrame()
    }
}
