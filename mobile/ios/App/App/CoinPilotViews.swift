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

private enum CoinPilotShapes {
    static let cardCornerRadius: CGFloat = 12
}

struct CoinPilotNativeRootView: View {
    @StateObject private var store = CoinPilotStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if store.isBundledLocalMarketData {
                NavigationView {
                    CoinPilotLocalMarketView(store: store)
                        .navigationTitle("시장")
                        .navigationBarTitleDisplayMode(.inline)
                }
                .navigationViewStyle(StackNavigationViewStyle())
            } else if store.phase == .dashboard && store.serverModeMatchesWorkspace {
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
            guard scenePhase == .active, !store.isBundledLocalMarketData else { return }
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

                CoinPilotWorkspaceSelector(store: store)

                VStack(alignment: .leading, spacing: 8) {
                    Text(connectionTitle)
                        .font(.title.weight(.bold))
                        .foregroundColor(CoinPilotColors.ink)
                    Text(connectionExplanation)
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
                    Text(serverAddressHelp)
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }

                if store.phase == .login {
                    VStack(alignment: .leading, spacing: 10) {
                        FieldTitle(title: "서버 토큰")
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
                            .accessibilityLabel("서버 토큰")
                        Text("조회 전용 토큰은 화면 조회만 허용합니다. 앱에서 주문과 설정을 사용하려면 서버의 모바일 운영 토큰을 입력하세요.")
                            .font(.footnote)
                            .foregroundColor(CoinPilotColors.secondaryInk)
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

                Label("Upbit API 키는 서버에만 보관합니다. 모드에 맞는 서버를 연결하세요.", systemImage: "lock.shield")
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

    private var connectionTitle: String {
        if store.workspaceModeMismatchMessage != nil { return "다른 모드의 서버가 연결됐어요" }
        if store.phase == .dashboard && !store.serverModeMatchesWorkspace { return "서버 모드를 확인할 수 없어요" }
        if store.phase == .login { return "서버에 로그인하세요" }
        return "\(store.activeWorkspace.title) 서버를 연결하세요"
    }

    private var connectionExplanation: String {
        if let message = store.workspaceModeMismatchMessage { return message }
        if store.phase == .dashboard,
           !store.serverModeMatchesWorkspace,
           let message = store.dashboardMessage {
            return message
        }
        if store.phase == .login {
            return "서버 토큰 권한에 따라 조회 또는 주문·설정 기능을 사용할 수 있습니다. 거래소 API 키는 서버에 보관합니다."
        }
        return "각 작업공간은 해당 모드 서버의 계좌와 거래 기록만 불러옵니다."
    }

    private var serverAddressHelp: String {
        let connectionType = "같은 Wi-Fi의 서버는 내부 주소로, 외부 서버는 HTTPS 주소로 연결해 주세요."
        guard store.activeWorkspace == .live else { return connectionType }
        return "\(connectionType) 같은 IP를 쓸 수 있지만, LIVE 모드 서버의 다른 포트나 주소가 필요합니다. 앱에서 서버 모드는 바뀌지 않습니다."
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

private struct CoinPilotTabBarContentInset: ViewModifier {
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear
                .frame(height: 56)
                .accessibilityHidden(true)
        }
    }
}

private struct CoinPilotTabView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage("coinpilot.native.selectedTab.v2") private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationView {
                CoinPilotHomeView(store: store)
                    .navigationTitle("홈")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { workspaceToolbar; refreshToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .modifier(CoinPilotTabBarContentInset())
            .tabItem { Label("홈", systemImage: "house") }
            .tag(0)

            NavigationView {
                CoinPilotTradingView(store: store)
                    .navigationTitle("주문")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { workspaceToolbar; refreshToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .modifier(CoinPilotTabBarContentInset())
            .tabItem { Label("주문", systemImage: "arrow.left.arrow.right") }
            .tag(1)

            NavigationView {
                CoinPilotAssetsView(store: store)
                    .navigationTitle("보유 자산")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { workspaceToolbar; refreshToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .modifier(CoinPilotTabBarContentInset())
            .tabItem { Label("자산", systemImage: "chart.pie") }
            .tag(2)

            NavigationView {
                CoinPilotDiscoverView(store: store)
                    .navigationTitle("시장")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { workspaceToolbar; refreshToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .modifier(CoinPilotTabBarContentInset())
            .tabItem { Label("탐색", systemImage: "chart.xyaxis.line") }
            .tag(3)

            NavigationView {
                CoinPilotMoreView(store: store)
                    .navigationTitle("전체 기능")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { workspaceToolbar }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .modifier(CoinPilotTabBarContentInset())
            .tabItem { Label("더보기", systemImage: "square.grid.2x2") }
            .tag(4)
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

    private var workspaceToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigationBarLeading) {
            Menu {
                ForEach(CoinPilotWorkspaceMode.allCases) { mode in
                    Button {
                        store.selectWorkspace(mode)
                    } label: {
                        if mode == store.activeWorkspace {
                            Label(mode.title, systemImage: "checkmark")
                        } else {
                            Text(mode.title)
                        }
                    }
                }
            } label: {
                Label(store.activeWorkspace.title, systemImage: "arrow.left.arrow.right")
                    .font(.caption.weight(.semibold))
            }
            .accessibilityLabel("현재 \(store.activeWorkspace.title) 작업공간. 전환")
        }
    }
}

private enum CoinPilotTradeSide: String, CaseIterable, Identifiable, Equatable {
    case buy
    case sell

    var id: String { rawValue }
    var title: String { self == .buy ? "매수" : "매도" }
}

private enum CoinPilotWalletAction: String, Identifiable, Equatable {
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

private enum CoinPilotSmartOrderSide: String, CaseIterable, Identifiable {
    case buy
    case sell

    var id: String { rawValue }
    var title: String { self == .buy ? "조건 매수" : "우선순위 매도" }
}

private struct CoinPilotTradingView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var side: CoinPilotTradeSide = .buy
    @State private var market = ""
    @State private var buyAmount = ""
    @State private var sellQuantity = ""
    @State private var showingOrderConfirmation = false
    @State private var walletAmount = ""
    @State private var resetSeedMoney = "10000000"
    @State private var walletAction: CoinPilotWalletAction?
    @State private var smartSide: CoinPilotSmartOrderSide = .buy
    @State private var smartAmount = "100000"
    @State private var smartMinimumScore = "60"
    @State private var smartMaximumCoins = "10"
    @State private var smartSellStrategy = "worst"
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

    private var currentPrice: Double? {
        store.freshMarketPrice(for: market)
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

    private var orderDraftIsValid: Bool {
        guard !market.isEmpty else { return false }
        if side == .buy {
            guard let amount = parsedBuyAmount, amount.isFinite, amount >= 5_000,
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
            ? (parsedBuyAmount.map { CoinPilotFormatting.won($0) } ?? "금액 확인 필요")
            : "\(sellQuantity)개 · 예상 \(CoinPilotFormatting.won(currentPrice.map { $0 * (parsedSellQuantity ?? 0) }, unavailable: "평가 불가"))"
        if store.activeWorkspace == .live {
            return "Upbit 실계정으로 시장가 주문을 보냅니다.\n\(amount)\n서버의 계좌 동기화·주문 안전 검사가 통과해야 접수됩니다."
        }
        return "모의 서버의 가상 계좌에서만 처리합니다.\n\(amount)\n실제 거래소로 주문을 보내지 않습니다."
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let message = store.dashboardMessage {
                    InlineNotice(text: message, color: CoinPilotColors.amber)
                }
                if let safetyMessage = store.runtimeSafetyMessage {
                    InlineNotice(text: safetyMessage, color: CoinPilotColors.amber)
                }
                CoinPilotAutomationControl(store: store)
                orderEntry
                conditionalOrderEntry
                recommendationSection
                if store.activeWorkspace == .paper { paperWallet }
                if store.pendingManualOrderLocked {
                    pendingOrderCard
                }
                if let message = store.orderMessage {
                    InlineNotice(text: message, color: store.pendingManualOrderLocked ? CoinPilotColors.amber : CoinPilotColors.secondaryInk)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 34)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
        .onChange(of: side) { _ in
            market = availableMarkets.first ?? ""
            sellQuantity = ""
        }
        .onChange(of: store.activeWorkspace) { _ in
            market = ""
            buyAmount = ""
            sellQuantity = ""
        }
        .onChange(of: store.selectedMarket) { newValue in
            if availableMarkets.contains(newValue) { market = newValue }
        }
        .onAppear {
            market = availableMarkets.contains(store.selectedMarket) ? store.selectedMarket : (availableMarkets.first ?? "")
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
                 ? "가상 잔액을 \(CoinPilotFormatting.won(Double(resetSeedMoney)))으로 바꿉니다. 현재 모의 보유량과 매매 기록이 삭제됩니다."
                 : "\(CoinPilotFormatting.won(Double(walletAmount)))을 모의 계좌에서 \(walletAction == .deposit ? "입금" : "출금")합니다. 실제 자금은 이동하지 않습니다.")
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
            Text("여러 종목에 주문할 수 있습니다. 실거래 응답이 끊기면 새 주문은 잠기며, 같은 요청으로만 결과를 확인할 수 있습니다.")
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
            Text(requestedRecommendation.map {
                "\(CoinPilotFormatting.ticker($0.coin)) \($0.action == "BUY" ? "매수" : "보유량 전체 매도") · \($0.suggestedAmount.map { CoinPilotFormatting.won($0) } ?? "금액은 서버 추천값")\n분석 결과는 참고 정보이며, 주문 전 서버의 거래 안전 검사를 다시 확인합니다."
            } ?? "")
        }
        .confirmationDialog(
            "묶음 거래를 실행할까요?",
            isPresented: Binding(get: { requestedBundle != nil }, set: { if !$0 { requestedBundle = nil } }),
            titleVisibility: .visible
        ) {
            if let bundle = requestedBundle,
               let sell = bundle["sell"] as? [String: Any],
               let buy = bundle["buy"] as? [String: Any],
               let sellCoin = sell["coin"] as? String,
               let buyCoin = buy["coin"] as? String {
                Button(store.activeWorkspace == .live ? "실거래 묶음 주문 전송" : "모의 묶음 주문 실행",
                       role: store.activeWorkspace == .live ? .destructive : nil) {
                    requestedBundle = nil
                    let sellAmount = (sell["amount"] as? NSNumber)?.doubleValue
                    let buyAmount = (buy["suggestedAmount"] as? NSNumber)?.doubleValue
                    Task { _ = await store.submitBundle(sellCoin: sellCoin, sellAmount: sellAmount, buyCoin: buyCoin, buyAmount: buyAmount) }
                }
            }
            Button("취소", role: .cancel) { requestedBundle = nil }
        } message: {
            Text("먼저 보유 종목을 매도하고 매수합니다. 실거래에서는 두 주문이 각각 처리되므로 부분 체결이나 미확정 결과가 생길 수 있습니다.")
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
                    Text(store.activeWorkspace.title)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(store.activeWorkspace == .live ? CoinPilotColors.red : CoinPilotColors.blue)
                }
                Picker("주문 방식", selection: $smartSide) {
                    ForEach(CoinPilotSmartOrderSide.allCases) { value in Text(value.title).tag(value) }
                }
                .pickerStyle(SegmentedPickerStyle())
                FieldTitle(title: smartSide == .buy ? "총 투자 금액 (원)" : "목표 매도 금액 (원)")
                TextField("금액 입력", text: $smartAmount)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(smartSide == .buy ? "조건 매수 총 투자 금액" : "조건 매도 목표 금액")
                if smartSide == .buy {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("최소 신호 점수").font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                            TextField("60", text: $smartMinimumScore).keyboardType(.numberPad).textFieldStyle(.roundedBorder)
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Text("최대 종목 수").font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                            TextField("10", text: $smartMaximumCoins).keyboardType(.numberPad).textFieldStyle(.roundedBorder)
                        }
                    }
                    Text("서버가 거래량 상위 종목을 분석해 잔액 범위 안에서 나눠 주문합니다. 조건을 충족한 종목이 없을 때는 서버 기준의 상위 후보가 사용될 수 있습니다.")
                        .font(.caption)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                } else {
                    Picker("매도 우선순위", selection: $smartSellStrategy) {
                        Text("손실이 큰 순서").tag("worst")
                        Text("수익이 큰 순서").tag("best")
                        Text("과매수 신호 우선").tag("overbought")
                    }
                    .pickerStyle(MenuPickerStyle())
                }
                Button(smartSide.title) { requestedSmartSide = smartSide }
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(store.manualOrderBlockReason != nil || store.pendingManualOrderLocked)
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
                        Button("새로 분석") { Task { await store.loadRecommendations() } }
                            .font(.caption.weight(.semibold))
                    }
                    if let message = store.featureMessages["recommendations"] {
                        EmptyMessage(text: message)
                    } else if store.buyRecommendations.isEmpty && store.sellRecommendations.isEmpty {
                        EmptyMessage(text: "분석을 실행하면 서버가 계산한 매수·매도 검토 결과가 표시됩니다.")
                    }
                    let recommendations = Array((store.buyRecommendations + store.sellRecommendations).prefix(8))
                    ForEach(recommendations) { recommendation in
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text("\(CoinPilotFormatting.ticker(recommendation.coin)) · \(recommendation.action == "BUY" ? "매수 검토" : "매도 검토")")
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                if let confidence = recommendation.confidence { Text("점수 \(Int(confidence))") }
                            }
                            if let reason = recommendation.reason {
                                Text(reason).font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                            }
                            HStack {
                                Text(CoinPilotFormatting.won(recommendation.price, unavailable: "현재가 미제공"))
                                    .font(.caption)
                                Spacer()
                                Button(recommendation.action == "BUY" ? "매수 검토" : "보유량 전체 매도") {
                                    requestedRecommendation = recommendation
                                }
                                .font(.caption.weight(.semibold))
                                .disabled(store.manualOrderBlockReason(for: recommendation.coin) != nil || store.pendingManualOrderLocked)
                            }
                        }
                        .padding(.vertical, 8)
                        if recommendation.id != recommendations.last?.id { Divider().overlay(CoinPilotColors.line) }
                    }
                }
            }
            NativeCard {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        SectionHeading(title: "종목 교체 제안")
                        Spacer()
                        Button("새로 분석") { Task { await store.loadBundleSuggestions() } }
                            .font(.caption.weight(.semibold))
                    }
                    Text("보유 종목 매도와 다른 종목 매수를 한 묶음으로 제안합니다.")
                        .font(.caption)
                        .foregroundColor(CoinPilotColors.secondaryInk)
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
                                .foregroundColor(CoinPilotColors.secondaryInk)
                            Button("묶음 주문 확인") { requestedBundle = bundle }
                                .font(.caption.weight(.semibold))
                                .disabled(store.manualOrderBlockReason(forMarkets: [sellCoin, buyCoin]) != nil || store.pendingManualOrderLocked)
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
                    Text(orderReviewPresentation.accountTitle)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(!store.isBundledPreview && store.activeWorkspace == .live
                                         ? CoinPilotColors.red
                                         : CoinPilotColors.blue)
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
                    Picker("종목", selection: $market) {
                        ForEach(availableMarkets, id: \.self) { coin in
                            Text("\(CoinPilotFormatting.symbol(coin)) · \(CoinPilotFormatting.ticker(coin))").tag(coin)
                        }
                    }
                    .pickerStyle(MenuPickerStyle())
                    .accessibilityLabel("주문 종목")

                    HStack {
                        Text("현재가")
                            .font(.subheadline)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                        Spacer()
                        Text(CoinPilotFormatting.won(currentPrice, unavailable: "시세 확인 불가"))
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(CoinPilotColors.ink)
                    }

                    if side == .buy {
                        FieldTitle(title: "매수 금액 (KRW)")
                        TextField("최소 5,000원", text: $buyAmount)
                            .keyboardType(.numberPad)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .background(CoinPilotColors.paper)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                            .accessibilityLabel("매수 금액 원화")
                        HStack(spacing: 8) {
                            ForEach([10_000.0, 50_000.0, 100_000.0, 500_000.0], id: \.self) { amount in
                                Button(CoinPilotFormatting.won(amount)) { buyAmount = String(Int(amount)) }
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(CoinPilotColors.blue)
                            }
                        }
                        Text("사용 가능 잔액 · \(CoinPilotFormatting.won(store.account?.krwBalance, unavailable: "확인 불가"))")
                            .font(.caption)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                    } else {
                        FieldTitle(title: "매도 수량")
                        TextField("보유 수량", text: $sellQuantity)
                            .keyboardType(.decimalPad)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .background(CoinPilotColors.paper)
                            .clipShape(RoundedRectangle(cornerRadius: 11))
                            .accessibilityLabel("매도 수량")
                        HStack(spacing: 14) {
                            Text("보유 \(CoinPilotFormatting.quantity(selectedPosition?.amount))")
                                .font(.caption)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                            Spacer()
                            ForEach([25.0, 50.0, 100.0], id: \.self) { percent in
                                Button("\(Int(percent))%") {
                                    guard let amount = selectedPosition?.amount else { return }
                                    sellQuantity = String(format: "%.8f", amount * percent / 100)
                                }
                                .font(.caption.weight(.semibold))
                                .foregroundColor(CoinPilotColors.blue)
                            }
                        }
                    }

                    if store.isBundledPreview {
                        InlineNotice(
                            text: "이 예시 계좌는 주문을 저장하지 않습니다. 실제 모의주문은 DRY_RUN 서버에 연결하세요.",
                            color: CoinPilotColors.amber
                        )
                    } else if let blockReason = store.manualOrderBlockReason(for: market) {
                        InlineNotice(text: blockReason, color: CoinPilotColors.amber)
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
                        .frame(minHeight: 52)
                        .foregroundColor(orderReviewPresentation.isEnabled
                                         ? .white
                                         : CoinPilotColors.secondaryInk)
                        .background(orderReviewPresentation.isEnabled
                                    ? (store.activeWorkspace == .live ? CoinPilotColors.red : CoinPilotColors.blue)
                                    : CoinPilotColors.line)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .disabled(!orderReviewPresentation.isEnabled)
                    Text(store.isBundledPreview
                         ? "앱에 포함된 예시 계좌는 화면 표시용이며 주문·입금·출금되지 않습니다."
                         : store.activeWorkspace == .live
                         ? "주문 전 종목·금액을 다시 확인합니다. 거래소 API 키는 서버에만 보관됩니다."
                         : "모의 주문은 선택한 DRY_RUN 서버의 가상 자산만 바꿉니다.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
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
                        .foregroundColor(CoinPilotColors.ink)
                }
                Text(store.isBundledPreview
                     ? "앱에 포함된 예시 잔액이며 변경되지 않습니다."
                     : "모의투자 서버의 가상 잔액만 변경됩니다. 현재 연결된 실거래 계좌에는 영향을 주지 않습니다.")
                    .font(.footnote)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                if !store.isBundledPreview {
                    TextField("입금·출금 금액 (원)", text: $walletAmount)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 46)
                        .background(CoinPilotColors.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .accessibilityLabel("모의 계좌 입금·출금 금액")
                    HStack(spacing: 10) {
                        Button("입금") { walletAction = .deposit }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                            .disabled(store.paperWalletBlockReason != nil || (Double(walletAmount) ?? 0) < 1_000)
                        Button("출금") { walletAction = .withdraw }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                            .disabled(store.paperWalletBlockReason != nil || (Double(walletAmount) ?? 0) < 1_000)
                    }
                    Divider().overlay(CoinPilotColors.line)
                    TextField("초기 잔액 (원)", text: $resetSeedMoney)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 46)
                        .background(CoinPilotColors.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .accessibilityLabel("모의 계좌 초기 잔액")
                    Button("모의 계좌 초기화", role: .destructive) { walletAction = .reset }
                        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                        .disabled(store.paperWalletBlockReason != nil || (Double(resetSeedMoney) ?? 0) < 100_000)
                    if let reason = store.paperWalletBlockReason {
                        Text(reason)
                            .font(.caption)
                            .foregroundColor(CoinPilotColors.amber)
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
                    Text("\(pending.mode == "LIVE" ? "실거래" : "모의투자") · \(CoinPilotFormatting.ticker(pending.market)) \(pending.side) · \(pending.displayAmount)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(CoinPilotColors.ink)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("기기에 저장된 주문 확인 기록을 읽지 못했습니다. 새 주문을 보내지 말고 서버 주문 기록을 먼저 확인하세요.")
                        .font(.subheadline)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
                if store.pendingManualOrder != nil, store.canOperate {
                    Button {
                        Task { _ = await store.retryPendingManualOrder() }
                    } label: {
                        HStack {
                            Spacer()
                            Text(store.isSubmittingManualOrder ? "같은 요청 확인 중" : "같은 요청으로 결과 확인")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                        }
                        .frame(minHeight: 46)
                    }
                    .disabled(store.isSubmittingManualOrder)
                }
            }
        }
    }
}

private struct CoinPilotAutomationControl: View {
    @ObservedObject var store: CoinPilotStore
    @State private var requestedStart: Bool?

    private var presentation: CoinPilotAutomationPresentation {
        CoinPilotAutomationPresentation(
            isBundledPreview: store.isBundledPreview,
            isRunning: store.status?.isRunning
        )
    }

    private var isRunning: Bool? { store.isBundledPreview ? nil : store.status?.isRunning }

    private var isEnabled: Bool {
        guard !store.isBundledPreview, store.canOperate, store.status?.mode == store.activeWorkspace.serverMode,
              let isRunning else { return false }
        return isRunning || store.status?.runtimeState != "PROTECTIVE_ONLY"
    }

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        SectionHeading(title: presentation.sectionTitle)
                        Text(presentation.explanation)
                            .font(.footnote)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                    }
                    Spacer()
                    Text(presentation.stateLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(!store.isBundledPreview && isRunning == true
                                         ? CoinPilotColors.green
                                         : CoinPilotColors.secondaryInk)
                }
                if store.isBundledPreview {
                    EmptyView()
                } else if store.activeWorkspace == .live {
                    Text("실거래 시작 후 서버의 검증을 통과하면 자동 주문이 나갈 수 있습니다. 중지 요청 후에도 보유 포지션의 위험 감시는 계속될 수 있습니다.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                    if store.status?.liveManualPrepareOnBoot == true {
                        if store.status?.liveManualPrepared == true {
                            Label("실거래 계좌 확인 완료 · 자동매매 중지", systemImage: "checkmark.circle.fill")
                                .font(.footnote.weight(.semibold))
                                .foregroundColor(CoinPilotColors.green)
                        } else {
                            Text("서버는 자동매매를 시작하지 않은 상태로 계좌와 대상 주문을 확인하고 있습니다. 확인이 끝날 때까지 주문이 잠겨 있습니다.")
                                .font(.footnote)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Text("모의투자 서버의 가상 계좌만 사용합니다. 실거래 서버의 상태와 자산은 이 작업공간에 섞이지 않습니다.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if presentation.showsControls {
                    Button(isRunning == true ? "자동매매 중지" : "자동매매 시작") {
                        requestedStart = isRunning != true
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .foregroundColor(.white)
                    .background(isRunning == true ? CoinPilotColors.red : CoinPilotColors.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 11))
                    .disabled(!isEnabled || store.isWorking)
                }
            }
        }
        .confirmationDialog(
            requestedStart == true ? "자동매매를 시작할까요?" : "자동매매 중지를 요청할까요?",
            isPresented: Binding(get: { requestedStart != nil }, set: { if !$0 { requestedStart = nil } }),
            titleVisibility: .visible
        ) {
            if let startRequest = requestedStart {
                Button(startRequest
                       ? (store.activeWorkspace == .live ? "실거래 자동매매 시작" : "모의투자 시작")
                       : "자동매매 중지 요청",
                       role: startRequest && store.activeWorkspace == .live ? .destructive : nil) {
                    let shouldStart = startRequest
                    requestedStart = nil
                    Task { _ = await store.setAutomationRunning(shouldStart) }
                }
            }
            Button("취소", role: .cancel) { requestedStart = nil }
        } message: {
            Text(requestedStart == true && store.activeWorkspace == .live
                 ? "실거래 서버의 gate가 시작을 거부할 수 있습니다. 시작이 승인되면 서버에서 실제 주문이 발생할 수 있습니다."
                 : requestedStart == false && store.activeWorkspace == .live
                    ? "신규 자동 진입을 중지합니다. 보유 포지션 위험 감시는 서버 상태에 따라 계속될 수 있습니다."
                    : "모의투자 서버의 가상 계좌에만 영향을 줍니다.")
        }
    }
}

private struct CoinPilotWorkspaceSelector: View {
    @ObservedObject var store: CoinPilotStore

    private var selection: Binding<CoinPilotWorkspaceMode> {
        Binding(
            get: { store.activeWorkspace },
            set: { store.selectWorkspace($0) }
        )
    }

    var body: some View {
        Picker("작업공간", selection: selection) {
            ForEach(CoinPilotWorkspaceMode.allCases) { mode in
                Text(mode.title).tag(mode)
            }
        }
        .pickerStyle(SegmentedPickerStyle())
        .accessibilityLabel("실거래 또는 모의투자 작업공간")
    }
}

private struct CoinPilotLiveCredentialSetupView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 13) {
                SectionHeading(title: "Upbit API 키 등록")
                Text("Upbit PC 웹의 Open API 관리에서 Access Key와 Secret Key를 만드세요. 앱 안에서 Upbit 비밀번호나 OTP 로그인을 하지 않습니다.")
                    .font(.footnote)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text("권한은 자산 조회와 주문만 허용하고 출금 권한은 켜지 마세요. 허용 IP에는 Lightsail 고정 IP 52.78.156.161을 등록하세요.")
                    .font(.footnote.weight(.medium))
                    .foregroundColor(CoinPilotColors.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("키는 HTTPS로 LIVE 서버에 한 번 전송됩니다. 이 앱은 키를 저장하지 않고 등록 시도 뒤 입력란을 비웁니다.")
                    .font(.footnote)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(alignment: .leading, spacing: 7) {
                    FieldTitle(title: "Access Key")
                    SecureField("Access Key 입력", text: $store.liveAccessKeyDraft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 50)
                        .background(CoinPilotColors.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11).stroke(CoinPilotColors.line, lineWidth: 1))
                        .accessibilityLabel("Upbit Access Key")
                }

                VStack(alignment: .leading, spacing: 7) {
                    FieldTitle(title: "Secret Key")
                    SecureField("Secret Key 입력", text: $store.liveSecretKeyDraft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 50)
                        .background(CoinPilotColors.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11).stroke(CoinPilotColors.line, lineWidth: 1))
                        .accessibilityLabel("Upbit Secret Key")
                }

                if store.currentLiveCredentialTransportIsSecure == false {
                    Text("키 등록은 HTTPS로 연결한 LIVE 서버에서만 할 수 있습니다.")
                        .font(.footnote.weight(.medium))
                        .foregroundColor(CoinPilotColors.amber)
                } else if !store.canUseLiveCredentialRegistration {
                    Text("이 기능을 사용하려면 모바일 운영 권한이 있는 서버 토큰으로 로그인해야 합니다.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }

                Button {
                    Task { _ = await store.submitLiveCredentials() }
                } label: {
                    HStack(spacing: 8) {
                        if store.isSubmittingLiveCredentials { ProgressView().tint(.white) }
                        Text(store.isSubmittingLiveCredentials ? "키 등록 중" : "LIVE 서버에 키 등록")
                            .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 48)
                    .foregroundColor(.white)
                    .background(CoinPilotColors.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 11))
                }
                .disabled(!store.canSubmitLiveCredentials)
            }
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
                        Text(store.isBundledPreview ? "예시 데이터" : !store.authenticationScope.canOperate ? "조회 전용" : store.activeWorkspace.title)
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
                if store.showsLiveCredentialSetup {
                    CoinPilotLiveCredentialSetupView(store: store)
                } else if store.showsLiveCredentialSyncPending {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeading(title: "실거래 계좌 확인 중")
                            Text("Upbit 키가 등록됐어요. 서버가 잔고와 미체결 주문을 확인할 때까지 실거래 주문은 잠겨 있습니다.")
                                .font(.footnote)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if let message = store.liveCredentialMessage {
                    InlineNotice(text: message, color: store.isLiveCredentialSetupReady
                                 ? CoinPilotColors.green
                                 : CoinPilotColors.amber)
                }
                CoinPilotAutomationControl(store: store)
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
                                    PositionRow(position: position, store: store)
                                    if position.id != store.account?.positions.last?.id {
                                        Divider().overlay(CoinPilotColors.line)
                                    }
                                }
                            }
                        }
                    }
                }
                if !store.isBundledPreview {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "자산 기록")
                            Text("현재 계좌 평가를 기록해 자산 흐름에 추가합니다.")
                                .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                            Button(store.isRecordingSnapshot ? "기록 저장 중" : "현재 자산 기록 저장") {
                                Task { _ = await store.recordPortfolioSnapshot() }
                            }
                            .buttonStyle(CoinPilotSecondaryButtonStyle())
                            .disabled(!store.canOperate || store.isRecordingSnapshot)
                            if let message = store.featureMessages["snapshot"] {
                                Text(message).font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                            }
                        }
                    }
                }
                NavigationLink(destination: CoinPilotAccountAnalyticsView(store: store)) {
                    FeatureMenuRow(title: "포트폴리오 분석", detail: "보유 비중과 거래 통계를 확인합니다.", symbol: "chart.pie")
                        .padding(.horizontal, 4)
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
    @State private var showingTokenEditor = false
    @State private var showingLogoutConfirmation = false
    @State private var showingTuningEditor = false

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
                            Button("서버 토큰 입력 또는 변경") { showingTokenEditor = true }
                                .font(.body.weight(.semibold))
                                .foregroundColor(CoinPilotColors.blue)
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
                        SettingsRow(title: "앱 권한", value: accessScope, symbol: store.authenticationScope.canOperate ? "slider.horizontal.3" : "eye")
                        SettingsRow(title: store.isObserverAccount || !store.authenticationScope.canOperate ? "권한 상태" : "실행 상태", value: engineState, symbol: store.isObserverAccount || !store.authenticationScope.canOperate ? "eye" : "antenna.radiowaves.left.and.right")
                        Text(engineExplanation)
                            .font(.subheadline)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "전략·위험 튜닝")
                        Text(store.tuningBlockReason ?? "현재 작업공간 서버의 투자 비율과 위험 보호값을 불러와 조정합니다.")
                            .font(.subheadline)
                            .foregroundColor(store.tuningBlockReason == nil ? CoinPilotColors.secondaryInk : CoinPilotColors.amber)
                            .fixedSize(horizontal: false, vertical: true)
                        Button {
                            showingTuningEditor = true
                        } label: {
                            HStack {
                                Text("튜닝값 설정")
                                Spacer()
                                Image(systemName: "chevron.right")
                            }
                            .font(.body.weight(.semibold))
                            .foregroundColor(CoinPilotColors.blue)
                            .frame(minHeight: 40)
                            .contentShape(Rectangle())
                        }
                        .disabled(!store.canViewTuning)
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
        .sheet(isPresented: $showingTokenEditor) {
            CoinPilotTokenEditor(store: store)
        }
        .sheet(isPresented: $showingTuningEditor) {
            CoinPilotTuningEditor(store: store)
        }
        .confirmationDialog("이 기기에서 로그아웃할까요?", isPresented: $showingLogoutConfirmation, titleVisibility: .visible) {
            Button("로그아웃", role: .destructive) { store.logOut() }
            Button("취소", role: .cancel) {}
        } message: {
            Text("이 기기에 저장된 서버 토큰을 삭제합니다. 서버 주소는 유지됩니다.")
        }
    }

    private var engineState: String {
        if !store.authenticationScope.canOperate { return "조회 전용" }
        if !store.serverModeMatchesWorkspace { return "서버 모드 불일치" }
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
        if !store.authenticationScope.canOperate {
            return "현재 토큰은 계좌 조회만 허용합니다. 서버에서 발급한 모바일 운영 토큰으로 로그인하면 튜닝·매매·자동매매 제어를 사용할 수 있습니다. 거래소 키는 서버에만 보관합니다."
        }
        if let mismatch = store.workspaceModeMismatchMessage { return mismatch }
        if let safetyMessage = store.runtimeSafetyMessage { return safetyMessage }
        if store.isObserverAccount { return "이 계좌는 조회 전용입니다. 앱에서는 주문을 실행하지 않습니다." }
        switch store.status?.isRunning {
        case true: return "자동매매가 실행 중입니다. 앱을 닫아도 서버에서 계속 실행됩니다."
        case false: return "자동매매가 중지되어 있습니다. 앱을 닫아도 다시 시작되지 않습니다."
        case nil: return "자동매매 상태를 확인하지 못했습니다."
        }
    }

    private var accessScope: String {
        switch store.authenticationScope {
        case .operatorFull: return "전체 대시보드"
        case .mobileOperator: return "모바일 운영"
        case .readOnly: return "조회 전용"
        case .unauthenticated: return "인증되지 않음"
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

private struct CoinPilotDiscoverView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var search = ""

    private var visibleMarkets: [CoinPilotMarketPrice] {
        let source = store.markets.filter { market in
            guard let coin = market.coin else { return false }
            return search.isEmpty || coin.localizedCaseInsensitiveContains(search)
        }
        return source.sorted { ($0.volumeKrw ?? 0) > ($1.volumeKrw ?? 0) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !store.canOperate {
                    InlineNotice(text: "시장 분석·뉴스·AI 자문은 모바일 운영 토큰으로 로그인하면 사용할 수 있습니다.", color: CoinPilotColors.amber)
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .firstTextBaseline) {
                            SectionHeading(title: "시장 관찰")
                            Spacer()
                            Text(store.freshnessLabel(for: "market-prices"))
                                .font(.caption2)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                        }
                        TextField("종목 검색 · BTC, ETH", text: $search)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled(true)
                            .textFieldStyle(.roundedBorder)
                        if visibleMarkets.isEmpty {
                            EmptyMessage(text: store.emptyResourceMessage(for: "market-prices", whenLoadedEmpty: "표시할 종목이 없습니다."))
                        } else {
                            VStack(spacing: 0) {
                                ForEach(visibleMarkets.prefix(30)) { market in
                                    if let coin = market.coin {
                                        NavigationLink(destination: CoinPilotMarketDetailView(store: store, coin: coin)) {
                                            MarketRow(market: market, isBundledPreview: store.isBundledPreview)
                                        }
                                        .buttonStyle(PlainButtonStyle())
                                        Divider().overlay(CoinPilotColors.line)
                                    }
                                }
                            }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "분석 도구")
                        NavigationLink(destination: CoinPilotAnalysisView(store: store)) {
                            FeatureMenuRow(title: "전략 분석", detail: "RSI·MACD·변동률 점수와 매수·매도 판정", symbol: "waveform.path.ecg")
                        }
                        Divider().overlay(CoinPilotColors.line)
                        NavigationLink(destination: CoinPilotNewsView(store: store)) {
                            FeatureMenuRow(title: "뉴스", detail: "기사 분위기와 원문 확인", symbol: "newspaper")
                        }
                        Divider().overlay(CoinPilotColors.line)
                        NavigationLink(destination: CoinPilotAIDeskView(store: store)) {
                            FeatureMenuRow(title: "AI 자문", detail: "시장 신호 관찰·의견 요청·세션 관리", symbol: "sparkles")
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

private struct CoinPilotLocalMarketView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var search = ""

    private var visibleMarkets: [CoinPilotBundledMarketData.Market] {
        (store.localMarketData?.markets ?? []).filter { market in
            search.isEmpty || market.market.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("로컬 공개 시세 · 조회 전용", systemImage: "internaldrive")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(CoinPilotColors.blue)
                        Text("앱에 저장된 공개 원화 시장과 캔들 자료를 보여줍니다. 계좌·거래 기록·주문 기능은 제공하지 않습니다.")
                            .font(.subheadline)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(store.freshnessLabel(for: "market-prices"))
                            .font(.caption)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                            .textSelection(.enabled)
                    }
                }

                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "원화 시장")
                        if let error = store.localMarketDataError {
                            EmptyMessage(text: error)
                        } else if store.localMarketData == nil {
                            ProgressView("로컬 공개 시세 자료 불러오는 중")
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            TextField("시장 검색 · BTC, ETH", text: $search)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled(true)
                                .textFieldStyle(.roundedBorder)
                            if visibleMarkets.isEmpty {
                                EmptyMessage(text: "검색 결과가 없습니다.")
                            } else {
                                VStack(spacing: 0) {
                                    ForEach(visibleMarkets) { market in
                                        NavigationLink(destination: CoinPilotLocalMarketDetailView(store: store, marketCode: market.market)) {
                                            localMarketRow(market)
                                        }
                                        .buttonStyle(PlainButtonStyle())
                                        Divider().overlay(CoinPilotColors.line)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
    }

    private func localMarketRow(_ market: CoinPilotBundledMarketData.Market) -> some View {
        let latest = store.localMarketLatestCandle(for: market.market)
        return VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(CoinPilotFormatting.symbol(market.market))
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(CoinPilotColors.ink)
                    Text("\(market.market) · \(latest.map { "\($0.intervalMinutes)분 캔들" } ?? "캔들 자료 없음")")
                        .font(.caption)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
                Spacer(minLength: 8)
                Text(CoinPilotFormatting.price(latest?.close))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundColor(CoinPilotColors.ink)
            }
            if let latest {
                Text(store.localMarketTimestampLabel(for: market.market, interval: latest.intervalMinutes))
                    .font(.caption2)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 10)
    }
}

private struct CoinPilotLocalMarketDetailView: View {
    @ObservedObject var store: CoinPilotStore
    let marketCode: String

    private var intervals: [Int] { store.localMarketIntervals(for: marketCode) }

    private var selectedInterval: Int {
        intervals.contains(store.selectedCandleInterval) ? store.selectedCandleInterval : (intervals.first ?? 5)
    }

    private var latestCandle: CoinPilotBundledMarketData.Candle? {
        store.localMarketLatestCandle(for: marketCode, interval: selectedInterval)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let error = store.localMarketDataError {
                    NativeCard { EmptyMessage(text: error) }
                } else {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(CoinPilotFormatting.symbol(marketCode))
                                        .font(.title2.weight(.bold))
                                        .foregroundColor(CoinPilotColors.ink)
                                    Text("\(marketCode) · 로컬 공개 시장 자료")
                                        .font(.caption)
                                        .foregroundColor(CoinPilotColors.secondaryInk)
                                }
                                Spacer()
                                Text(CoinPilotFormatting.price(latestCandle?.close))
                                    .font(.title3.weight(.bold))
                                    .monospacedDigit()
                            }
                            Text(store.localMarketTimestampLabel(for: marketCode, interval: selectedInterval))
                                .font(.caption2)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                .textSelection(.enabled)
                        }
                    }

                    NativeCard {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                SectionHeading(title: "캔들 기록")
                                Spacer()
                                Text("원본 시각은 UTC")
                                    .font(.caption)
                                    .foregroundColor(CoinPilotColors.secondaryInk)
                            }
                            if !intervals.isEmpty {
                                Picker("캔들 간격", selection: Binding(
                                    get: { selectedInterval },
                                    set: { value in Task { await store.loadMarketDetail(coin: marketCode, interval: value) } }
                                )) {
                                    ForEach(intervals, id: \.self) { interval in
                                        Text(interval == 60 ? "1시간" : "\(interval)분").tag(interval)
                                    }
                                }
                                .pickerStyle(SegmentedPickerStyle())
                            }
                            if let message = store.featureMessages["market"] {
                                EmptyMessage(text: message)
                            } else if store.candles.count < 2 {
                                EmptyMessage(text: "차트를 표시할 가격 기록이 충분하지 않습니다.")
                            } else {
                                CoinPilotCandleChart(candles: store.candles)
                                    .frame(height: 190)
                                if let windowLabel = store.localMarketChartWindowLabel(for: marketCode, interval: selectedInterval) {
                                    Text(windowLabel)
                                        .font(.caption2)
                                        .foregroundColor(CoinPilotColors.secondaryInk)
                                        .textSelection(.enabled)
                                }
                            }
                            CoinPilotCandleDataDisclosure(candles: store.candles)
                            Text(store.localMarketTimestampLabel(for: marketCode, interval: selectedInterval))
                                .font(.caption2)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                .textSelection(.enabled)
                            if let generatedAt = store.localMarketData?.generatedAt {
                                Text("자료 생성 시각 · \(CoinPilotFormatting.utcMarketTimestamp(generatedAt))")
                                    .font(.caption2)
                                    .foregroundColor(CoinPilotColors.secondaryInk)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle(CoinPilotFormatting.ticker(marketCode))
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.loadMarketDetail(coin: marketCode, interval: selectedInterval) }
    }
}

private struct CoinPilotMarketDetailView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage("coinpilot.native.selectedTab.v2") private var selectedTab = 0
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
                            VStack(alignment: .leading, spacing: 4) {
                                Text(CoinPilotFormatting.symbol(coin)).font(.title2.weight(.bold)).foregroundColor(CoinPilotColors.ink)
                                Text("Upbit 원화 시장").font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 5) {
                                Text(CoinPilotFormatting.price(market?.price)).font(.title3.weight(.bold)).monospacedDigit()
                                Text(CoinPilotFormatting.percent(market?.change)).font(.caption.weight(.semibold)).foregroundColor(profitColor(market?.change))
                            }
                        }
                        Divider().overlay(CoinPilotColors.line)
                        HStack(spacing: 10) {
                            marketMetric("24시간 고가", market?.high)
                            marketMetric("24시간 저가", market?.low)
                        }
                        Text(CoinPilotFormatting.marketTimestamp(market?.sourceAsOf, label: "최근 체결"))
                            .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                        HStack(spacing: 6) {
                            Image(systemName: isExampleData
                                  ? "info.circle"
                                  : quoteIssue == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                .accessibilityHidden(true)
                            Text(store.marketQuoteFreshnessMessage(for: coin))
                        }
                        .font(.caption2)
                        .foregroundColor(isExampleData
                                         ? CoinPilotColors.secondaryInk
                                         : quoteIssue == nil ? CoinPilotColors.green : CoinPilotColors.amber)
                        if !isExampleData {
                            Text(CoinPilotFormatting.marketTimestamp(market?.fetchedAt, label: "서버 수집"))
                                .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            SectionHeading(title: "가격 흐름")
                            Spacer()
                            Text("완료된 분봉").font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
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
                                .foregroundColor(CoinPilotColors.blue)
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
                                .frame(height: 190)
                            Text(store.marketCandleOriginLabel(candleCount: store.candles.count))
                                .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                            if store.loadingFeatures.contains("market") {
                                Text("가격 흐름을 새로 확인하고 있어요.")
                                    .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                            }
                        }
                        CoinPilotCandleDataDisclosure(candles: store.candles)
                        Button {
                            store.selectedMarket = coin
                            selectedTab = 1
                        } label: {
                            Label("이 종목 주문 열기", systemImage: "arrow.left.arrow.right")
                                .frame(maxWidth: .infinity, minHeight: 45)
                        }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                        .disabled(store.manualOrderBlockReason != nil)
                    }
                }
                if store.canOperate {
                    NativeCard {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeading(title: "종목별 뉴스")
                            Text("전체 뉴스 화면에서 코인별 기사와 원문을 확인할 수 있습니다.")
                                .font(.subheadline).foregroundColor(CoinPilotColors.secondaryInk)
                            NavigationLink(destination: CoinPilotNewsView(store: store)) {
                                FeatureMenuRow(title: "뉴스 보기", detail: "기사 검색은 전체 뉴스에서 제공", symbol: "newspaper")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle(CoinPilotFormatting.ticker(coin))
        .navigationBarTitleDisplayMode(.inline)
                        .task { await store.loadMarketDetail(coin: coin) }
    }

    private func marketMetric(_ title: String, _ value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
            Text(CoinPilotFormatting.price(value)).font(.subheadline.weight(.semibold)).foregroundColor(CoinPilotColors.ink)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct CoinPilotCandleChart: View {
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

    var body: some View {
        Canvas { context, size in
            let valid = validCandles
            guard valid.count > 1 else { return }
            let minimum = valid.compactMap(\.low).min() ?? 0
            let maximum = valid.compactMap(\.high).max() ?? 1
            let span = max(maximum - minimum, max(abs(maximum) * 0.0001, 0.000001))
            let step = size.width / CGFloat(valid.count)
            let bodyWidth = max(2, step * 0.55)
            func y(_ value: Double) -> CGFloat {
                size.height - CGFloat((value - minimum) / span) * size.height
            }
            for (index, candle) in valid.enumerated() {
                guard let open = candle.open, let high = candle.high, let low = candle.low, let close = candle.close else { continue }
                let x = CGFloat(index) * step + step / 2
                let tint = close >= open ? CoinPilotColors.green : CoinPilotColors.red
                var wick = Path()
                wick.move(to: CGPoint(x: x, y: y(high)))
                wick.addLine(to: CGPoint(x: x, y: y(low)))
                context.stroke(wick, with: .color(tint.opacity(0.8)), lineWidth: 1)
                let top = min(y(open), y(close))
                let height = max(2, abs(y(close) - y(open)))
                let rect = CGRect(x: x - bodyWidth / 2, y: top, width: bodyWidth, height: height)
                context.fill(Path(rect), with: .color(tint))
            }
        }
        .padding(10)
        .background(CoinPilotColors.paper)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(validCandles.count)개 완료 분봉 가격 차트")
        .accessibilityValue(accessibilitySummary)
        .accessibilityHint("상세 화면의 최근 OHLCV 값 표에서 개별 가격 기록을 확인할 수 있습니다.")
    }
}

private struct CoinPilotCandleDataDisclosure: View {
    let candles: [CoinPilotCandle]

    private var recentCandles: [CoinPilotCandle] {
        Array(candles.suffix(20).reversed())
    }

    var body: some View {
        if !recentCandles.isEmpty {
            DisclosureGroup("최근 OHLCV 값 · 최대 \(recentCandles.count)개") {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(recentCandles) { candle in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(candle.time.map(CoinPilotFormatting.utcMarketTimestamp) ?? "시각 미제공")
                                    .foregroundColor(CoinPilotColors.secondaryInk)
                                Spacer(minLength: 8)
                                Text("종가 \(CoinPilotFormatting.price(candle.close))")
                                    .foregroundColor(CoinPilotColors.ink)
                            }
                            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 5) {
                                Text("시가 \(CoinPilotFormatting.price(candle.open))")
                                Text("고가 \(CoinPilotFormatting.price(candle.high))")
                                Text("저가 \(CoinPilotFormatting.price(candle.low))")
                                Text("거래량 \(candle.volume.map { String(format: "%.8f", $0) } ?? "—")")
                            }
                            .foregroundColor(CoinPilotColors.secondaryInk)
                        }
                        .font(.caption2.monospacedDigit())
                        if candle.id != recentCandles.last?.id {
                            Divider().overlay(CoinPilotColors.line)
                        }
                    }
                }
                .padding(.top, 8)
            }
            .font(.subheadline.weight(.medium))
            .foregroundColor(CoinPilotColors.ink)
        }
    }
}

private struct CoinPilotAnalysisView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage("coinpilot.native.selectedTab.v2") private var selectedTab = 0
    @State private var filter = "전체"
    @State private var sort = "종합 점수"

    private var results: [CoinPilotAnalysisResult] {
        let filtered = store.analysisResults.filter { result in
            switch filter {
            case "매수": return result.recommendation == "BUY"
            case "매도": return result.recommendation == "SELL"
            case "관망": return result.recommendation == "HOLD"
            default: return true
            }
        }
        return filtered.sorted { left, right in
            switch sort {
            case "매수 점수": return (left.buyScore ?? -1) > (right.buyScore ?? -1)
            case "매도 점수": return (left.sellScore ?? -1) > (right.sellScore ?? -1)
            case "변동률": return (left.change24h ?? -Double.infinity) > (right.change24h ?? -Double.infinity)
            default: return (left.totalScore ?? -1) > (right.totalScore ?? -1)
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            SectionHeading(title: "시장 신호")
                            Spacer()
                            Button(store.loadingFeatures.contains("analysis") ? "분석 중" : "분석 실행") {
                                Task { await store.loadAnalysisFeatures() }
                            }
                            .font(.subheadline.weight(.semibold))
                            .disabled(store.loadingFeatures.contains("analysis") || !store.canOperate)
                        }
                        HStack(spacing: 12) {
                            analysisCount("분석", store.analysisSummary["totalAnalyzed"])
                            analysisCount("매수", store.analysisResults.filter { $0.recommendation == "BUY" }.count)
                            analysisCount("매도", store.analysisResults.filter { $0.recommendation == "SELL" }.count)
                            analysisCount("관망", store.analysisResults.filter { $0.recommendation == "HOLD" }.count)
                        }
                        Picker("결과 필터", selection: $filter) {
                            Text("전체").tag("전체")
                            Text("매수").tag("매수")
                            Text("매도").tag("매도")
                            Text("관망").tag("관망")
                        }
                        .pickerStyle(SegmentedPickerStyle())
                        Picker("정렬", selection: $sort) {
                            Text("종합 점수").tag("종합 점수")
                            Text("매수 점수").tag("매수 점수")
                            Text("매도 점수").tag("매도 점수")
                            Text("변동률").tag("변동률")
                        }
                        .pickerStyle(MenuPickerStyle())
                    }
                }
                if let message = store.featureMessages["analysis"] {
                    InlineNotice(text: message, color: CoinPilotColors.amber)
                } else if results.isEmpty {
                    NativeCard { EmptyMessage(text: "분석 실행을 누르면 서버가 확인한 시장 신호가 표시됩니다. 판정은 참고 정보이며 수익을 보장하지 않습니다.") }
                } else {
                    ForEach(results) { result in
                        NativeCard {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack(alignment: .firstTextBaseline) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(CoinPilotFormatting.ticker(result.coin)).font(.headline.weight(.semibold))
                                        Text(CoinPilotFormatting.price(result.currentPrice)).font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                                    }
                                    Spacer()
                                    Text(analysisAction(result.recommendation))
                                        .font(.caption.weight(.bold))
                                        .foregroundColor(analysisTint(result.recommendation))
                                }
                                HStack {
                                    Text("24시간 \(CoinPilotFormatting.percent(result.change24h))")
                                    Spacer()
                                    Text("RSI \(result.rsi.map { String(format: "%.1f", $0) } ?? "—")")
                                    Spacer()
                                    Text("종합 \(result.totalScore.map { String(Int($0)) } ?? "—")/100")
                                }
                                .font(.caption)
                                .foregroundColor(CoinPilotColors.secondaryInk)
                                if !result.signals.isEmpty {
                                    Text(result.signals.joined(separator: " · "))
                                        .font(.caption)
                                        .foregroundColor(CoinPilotColors.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Button {
                                    store.selectedMarket = result.coin
                                    selectedTab = 1
                                } label: {
                                    Label("거래 화면에서 종목 열기", systemImage: "arrow.left.arrow.right")
                                        .frame(maxWidth: .infinity, minHeight: 40)
                                }
                                .buttonStyle(CoinPilotSecondaryButtonStyle())
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle("전략 분석")
        .navigationBarTitleDisplayMode(.inline)
        .task { if store.analysisResults.isEmpty { await store.loadAnalysisFeatures() } }
    }

    private func analysisCount(_ label: String, _ value: Any?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value.map { String(describing: $0) } ?? "—").font(.headline.monospacedDigit()).foregroundColor(CoinPilotColors.ink)
            Text(label).font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func analysisAction(_ value: String?) -> String {
        switch value {
        case "BUY": return "매수 검토"
        case "SELL": return "매도 검토"
        case "HOLD": return "관망"
        default: return "미판정"
        }
    }

    private func analysisTint(_ value: String?) -> Color {
        switch value {
        case "BUY": return CoinPilotColors.green
        case "SELL": return CoinPilotColors.red
        default: return CoinPilotColors.secondaryInk
        }
    }
}

private struct FeatureMenuRow: View {
    let title: String
    let detail: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundColor(CoinPilotColors.blue)
                .frame(width: 38, height: 38)
                .background(CoinPilotColors.blue.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundColor(CoinPilotColors.ink)
                Text(detail).font(.caption).foregroundColor(CoinPilotColors.secondaryInk).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.secondaryInk)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 7)
    }
}

private struct CoinPilotMoreView: View {
    @ObservedObject var store: CoinPilotStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "기록과 자산")
                        NavigationLink(destination: CoinPilotActivityView(store: store).navigationTitle("거래 내역").navigationBarTitleDisplayMode(.inline)) {
                            FeatureMenuRow(title: "거래 내역", detail: "서버에 저장된 자동·수동 거래", symbol: "clock.arrow.circlepath")
                        }
                        Divider().overlay(CoinPilotColors.line)
                        NavigationLink(destination: CoinPilotAccountAnalyticsView(store: store)) {
                            FeatureMenuRow(title: "포트폴리오 분석", detail: "보유 비중·손익·거래 통계", symbol: "chart.pie")
                        }
                        Divider().overlay(CoinPilotColors.line)
                        NavigationLink(destination: CoinPilotResearchDeskView(store: store)) {
                            FeatureMenuRow(title: "주문 전 점검", detail: "검증 결과·실행 상태·모의투자 연속성", symbol: "checkmark.shield")
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "전략 관리")
                        NavigationLink(destination: CoinPilotOptimizationView(store: store)) {
                            FeatureMenuRow(title: "설정 후보 비교", detail: "자동 비교·비교 간격·결과 기록", symbol: "slider.horizontal.3")
                        }
                        Divider().overlay(CoinPilotColors.line)
                        NavigationLink(destination: CoinPilotPresetView(store: store)) {
                            FeatureMenuRow(title: "전략 프리셋", detail: "서버에 저장된 투자 설정 적용", symbol: "square.stack.3d.up")
                        }
                        Divider().overlay(CoinPilotColors.line)
                        NavigationLink(destination: CoinPilotSettingsView(store: store).navigationTitle("설정").navigationBarTitleDisplayMode(.inline)) {
                            FeatureMenuRow(title: "설정", detail: "실거래·모의투자 서버, 튜닝, 앱 권한", symbol: "gearshape")
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeading(title: "시장 의견")
                        NavigationLink(destination: CoinPilotNewsView(store: store)) {
                            FeatureMenuRow(title: "뉴스", detail: "기사 분위기와 출처 확인", symbol: "newspaper")
                        }
                        Divider().overlay(CoinPilotColors.line)
                        NavigationLink(destination: CoinPilotAIDeskView(store: store)) {
                            FeatureMenuRow(title: "AI 자문", detail: "신호 모니터링과 자문 세션", symbol: "sparkles")
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
    }
}

private struct CoinPilotNewsView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var filter = "전체"

    private var visibleNews: [CoinPilotNewsArticle] {
        store.newsArticles.filter { article in
            guard filter != "전체" else { return true }
            guard let sentiment = article.sentiment?.lowercased() else { return false }
            if filter == "긍정" { return sentiment.contains("positive") || sentiment.contains("bull") || sentiment.contains("긍정") }
            if filter == "부정" { return sentiment.contains("negative") || sentiment.contains("bear") || sentiment.contains("부정") }
            return sentiment.contains("neutral") || sentiment.contains("중립")
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !store.canOperate {
                    InlineNotice(text: "뉴스 조회 권한이 없습니다. 모바일 운영 토큰으로 로그인해 주세요.", color: CoinPilotColors.amber)
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            SectionHeading(title: "기사 분위기")
                            Spacer()
                            Button(store.loadingFeatures.contains("news") ? "불러오는 중" : "새로고침") {
                                Task { await store.loadNews() }
                            }
                            .font(.subheadline.weight(.semibold))
                            .disabled(store.loadingFeatures.contains("news") || !store.canOperate)
                        }
                        Text(sentimentSummary)
                            .font(.subheadline.weight(.medium))
                            .foregroundColor(CoinPilotColors.ink)
                        Text("기사 감성 분류는 참고 자료입니다. 매매 신호나 수익 예측으로 사용하지 않습니다.")
                            .font(.caption)
                            .foregroundColor(CoinPilotColors.secondaryInk)
                        Picker("기사 감성", selection: $filter) {
                            Text("전체").tag("전체")
                            Text("긍정").tag("긍정")
                            Text("부정").tag("부정")
                            Text("중립").tag("중립")
                        }
                        .pickerStyle(SegmentedPickerStyle())
                    }
                }
                if let message = store.featureMessages["news"] {
                    NativeCard { EmptyMessage(text: message) }
                } else if visibleNews.isEmpty {
                    NativeCard { EmptyMessage(text: store.newsArticles.isEmpty ? "뉴스를 새로고침하면 최신 기사를 확인합니다." : "선택한 감성의 기사가 없습니다.") }
                } else {
                    ForEach(visibleNews) { article in
                        NativeCard {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text(article.source ?? "출처 미상").font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.blue)
                                    Spacer()
                                    Text(CoinPilotFormatting.dateTime(article.timestamp, unavailable: "시각 미제공"))
                                        .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                                }
                                Text(article.title).font(.subheadline.weight(.semibold)).foregroundColor(CoinPilotColors.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let summary = article.summary, !summary.isEmpty {
                                    Text(summary).font(.caption).foregroundColor(CoinPilotColors.secondaryInk).lineLimit(4)
                                }
                                HStack {
                                    Text(sentimentLabel(article.sentiment)).font(.caption2.weight(.semibold)).foregroundColor(CoinPilotColors.secondaryInk)
                                    Spacer()
                                    if let url = article.url {
                                        Link(destination: url) { Label("원문", systemImage: "arrow.up.right.square").font(.caption.weight(.semibold)) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle("뉴스")
        .navigationBarTitleDisplayMode(.inline)
        .task { if store.newsArticles.isEmpty { await store.loadNews() } }
    }

    private var sentimentSummary: String {
        let overall = store.newsSentiment["overall"] as? String ?? store.newsSentiment["label"] as? String
        let count = store.newsSentiment["analyzedCount"] as? Int ?? store.newsSentiment["count"] as? Int ?? store.newsArticles.count
        guard count > 0 else { return store.newsArticles.isEmpty ? "아직 분석한 기사가 없습니다." : "기사 감성 분류가 제공되지 않았습니다." }
        return "\(overall.map { sentimentLabel($0) } ?? "기사 분석 결과") · 기사 \(count)건"
    }

    private func sentimentLabel(_ value: String?) -> String {
        let normalized = (value ?? "").lowercased()
        if normalized.contains("positive") || normalized.contains("bull") || normalized.contains("긍정") { return "긍정 기사" }
        if normalized.contains("negative") || normalized.contains("bear") || normalized.contains("부정") { return "부정 기사" }
        if normalized.contains("neutral") || normalized.contains("중립") { return "중립 기사" }
        return "감성 분류 없음"
    }
}

private struct CoinPilotAIDeskView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var sessionName = "시장 신호 알림"
    @State private var providers: Set<String> = ["gpt", "claude"]
    @State private var eventTypes: Set<String> = ["BUY_SIGNAL", "SELL_SIGNAL"]
    @State private var autoConsultEventTypes: Set<String> = ["BUY_SIGNAL", "SELL_SIGNAL"]
    @State private var autoConsult = false
    @State private var cooldownMinutes = 5
    @State private var evaluationMinutes = 5
    @State private var coins = ""
    @State private var consultationProvider = "both"

    private let eventOptions: [(String, String)] = [
        ("BUY_SIGNAL", "매수 신호"), ("SELL_SIGNAL", "매도 신호"),
        ("REBOUND_CANDIDATE", "반등 후보"), ("BREAKING_NEWS", "속보"),
        ("BUNDLE_SUGGESTION", "종목 교체 제안"), ("TRADE_EXECUTED", "거래 완료")
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !store.canOperate {
                    InlineNotice(text: "AI 서비스 상태와 신호 세션을 사용하려면 모바일 운영 토큰이 필요합니다.", color: CoinPilotColors.amber)
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            SectionHeading(title: "서비스 상태")
                            Spacer()
                            Button("새로고침") { Task { await store.loadAIDesk() } }
                                .font(.caption.weight(.semibold))
                                .disabled(!store.canOperate)
                        }
                        providerStatus
                        if let message = store.featureMessages["ai"] { Text(message).font(.caption).foregroundColor(CoinPilotColors.amber) }
                        Text("AI 의견은 참고 정보입니다. 주문은 이 화면에서 따로 확인해야 하며 자동으로 실행되지 않습니다.")
                            .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "관심 신호 세션 만들기")
                        TextField("세션 이름", text: $sessionName).textFieldStyle(.roundedBorder)
                        Text("의견을 받을 서비스")
                            .font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.secondaryInk)
                        Toggle("OpenAI", isOn: providerBinding("gpt"))
                            .font(.subheadline).tint(CoinPilotColors.blue)
                        Toggle("Claude", isOn: providerBinding("claude"))
                            .font(.subheadline).tint(CoinPilotColors.blue)
                        TextField("종목 제한 · BTC, ETH · 비우면 전체", text: $coins)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled(true)
                            .textFieldStyle(.roundedBorder)
                        ForEach(Array(eventOptions.enumerated()), id: \.offset) { item in
                            let value = item.element.0
                            let label = item.element.1
                            Toggle(label, isOn: Binding(
                                get: { eventTypes.contains(value) },
                                set: { enabled in
                                    if enabled { eventTypes.insert(value) } else { eventTypes.remove(value) }
                                }
                            ))
                            .font(.subheadline)
                            .tint(CoinPilotColors.blue)
                        }
                        Toggle("새 신호가 오면 AI 의견 자동 요청", isOn: $autoConsult)
                            .font(.subheadline)
                            .tint(CoinPilotColors.blue)
                        if autoConsult {
                            Text("AI 의견을 자동 요청할 신호")
                                .font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.secondaryInk)
                            ForEach(Array(eventOptions.enumerated()), id: \.offset) { item in
                                let value = item.element.0
                                let label = item.element.1
                                Toggle(label, isOn: Binding(
                                    get: { autoConsultEventTypes.contains(value) },
                                    set: { enabled in
                                        if enabled { autoConsultEventTypes.insert(value) } else { autoConsultEventTypes.remove(value) }
                                    }
                                ))
                                .font(.caption)
                                .tint(CoinPilotColors.blue)
                                .disabled(!eventTypes.contains(value))
                            }
                        }
                        Picker("같은 신호 다시 요청 간격", selection: $cooldownMinutes) {
                            Text("5분").tag(5)
                            Text("15분").tag(15)
                            Text("1시간").tag(60)
                            Text("6시간").tag(360)
                            Text("24시간").tag(1440)
                        }
                        .pickerStyle(MenuPickerStyle())
                        Picker("의견 뒤 가격 확인", selection: $evaluationMinutes) {
                            Text("1분").tag(1)
                            Text("5분").tag(5)
                            Text("15분").tag(15)
                            Text("1시간").tag(60)
                            Text("4시간").tag(240)
                            Text("24시간").tag(1440)
                        }
                        .pickerStyle(MenuPickerStyle())
                        Button(store.isRunningFeatureAction ? "저장 중" : "세션 만들기") {
                            Task {
                                _ = await store.createAISession(
                                    name: sessionName,
                                    providers: Array(providers),
                                    eventTypes: Array(eventTypes),
                                    autoConsultEventTypes: autoConsult ? Array(autoConsultEventTypes.intersection(eventTypes)) : [],
                                    autoConsult: autoConsult,
                                    coins: coins,
                                    cooldownSeconds: cooldownMinutes * 60,
                                    evaluationMinutes: evaluationMinutes
                                )
                            }
                        }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                        .disabled(!store.canOperate || store.isRunningFeatureAction || eventTypes.isEmpty || providers.isEmpty)
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "세션 관리")
                        if store.aiSessions.isEmpty {
                            EmptyMessage(text: "만든 신호 세션이 없습니다.")
                        }
                        ForEach(store.aiSessions) { session in
                            VStack(alignment: .leading, spacing: 7) {
                                HStack {
                                    Text(session.name).font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text(sessionStatus(session.status)).font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.secondaryInk)
                                }
                                Text("\(session.providers.map(providerLabel).joined(separator: " + ")) · \(session.eventTypes.map(eventLabel).joined(separator: " · "))")
                                    .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                                Text("\(session.coins.isEmpty ? "전체 종목" : session.coins.map(CoinPilotFormatting.ticker).joined(separator: ", ")) · 신호 \(session.eventCount ?? 0)건 · 의견 \(session.consultationCount ?? 0)회 · \(session.evaluationMinutes ?? 5)분 뒤 가격 확인")
                                    .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                                HStack {
                                    if session.status == "RUNNING" {
                                        sessionButton("일시 정지", id: session.id, action: "pause")
                                    } else if session.status == "PAUSED" {
                                        sessionButton("다시 시작", id: session.id, action: "resume")
                                    }
                                    if session.status != "STOPPED" {
                                        sessionButton("종료", id: session.id, action: "stop")
                                    }
                                }
                            }
                            .padding(.vertical, 8)
                            Divider().overlay(CoinPilotColors.line)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "최근 신호와 자문")
                        Picker("의견을 받을 서비스", selection: $consultationProvider) {
                            Text("OpenAI + Claude").tag("both")
                            Text("OpenAI").tag("gpt")
                            Text("Claude").tag("claude")
                        }
                        .pickerStyle(SegmentedPickerStyle())
                        if store.aiEvents.isEmpty {
                            EmptyMessage(text: "최근 도착한 신호가 없습니다.")
                        }
                        ForEach(store.aiEvents.prefix(20)) { event in
                            VStack(alignment: .leading, spacing: 5) {
                                HStack {
                                    Text(event.coin.map(CoinPilotFormatting.ticker) ?? eventTypeLabel(event.type))
                                        .font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text(CoinPilotFormatting.dateTime(event.timestamp, unavailable: "시각 미제공"))
                                        .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                                }
                                HStack(spacing: 8) {
                                    Text(event.action.map(actionLabel) ?? eventTypeLabel(event.type))
                                    if let price = event.price { Text("· \(CoinPilotFormatting.price(price))") }
                                    if let strength = event.signalStrength { Text("· \(strength)") }
                                }
                                .font(.caption.weight(.medium)).foregroundColor(CoinPilotColors.secondaryInk)
                                Text(event.title).font(.caption).foregroundColor(CoinPilotColors.ink).lineLimit(3)
                                if let detail = event.detail { Text(detail).font(.caption2).foregroundColor(CoinPilotColors.secondaryInk).lineLimit(3) }
                                Button("이 신호에 의견 요청") { Task { _ = await store.requestAIConsultation(eventId: event.id, provider: consultationProvider) } }
                                    .font(.caption.weight(.semibold))
                                    .disabled(!store.canOperate || store.isRunningFeatureAction)
                            }
                            .padding(.vertical, 7)
                            Divider().overlay(CoinPilotColors.line)
                        }
                        if let message = store.aiConsultationMessage {
                            InlineNotice(text: message, color: CoinPilotColors.blue)
                        }
                        ForEach(Array(store.aiConsultations.prefix(5).enumerated()), id: \.offset) { item in
                            let value = item.element
                            VStack(alignment: .leading, spacing: 5) {
                                let event = value["event"] as? [String: Any] ?? [:]
                                Text("\(CoinPilotFormatting.ticker(event["coin"] as? String)) · \(value["status"] as? String ?? "의견")")
                                    .font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.secondaryInk)
                                if let results = value["results"] as? [[String: Any]], !results.isEmpty {
                                    ForEach(Array(results.enumerated()), id: \.offset) { resultRow in
                                        let result = resultRow.element
                                        let advice = result["advice"] as? [String: Any] ?? [:]
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack {
                                                Text(providerLabel(result["provider"] as? String ?? ""))
                                                Spacer()
                                                Text(actionLabel(advice["action"] as? String ?? "확인"))
                                                    .fontWeight(.semibold)
                                            }
                                            .font(.caption2).foregroundColor(CoinPilotColors.blue)
                                            Text(advice["rationale"] as? String ?? result["error"] as? String ?? "의견 내용을 제공하지 않았습니다.")
                                                .font(.caption).foregroundColor(CoinPilotColors.ink).lineLimit(5)
                                            if let risks = advice["risks"] as? [String], !risks.isEmpty {
                                                Text("확인할 위험: " + risks.joined(separator: " · "))
                                                    .font(.caption2).foregroundColor(CoinPilotColors.amber).lineLimit(3)
                                            }
                                            if let invalidation = advice["invalidation"] as? String {
                                                Text("다시 확인할 조건: \(invalidation)")
                                                    .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk).lineLimit(2)
                                            }
                                        }
                                    }
                                } else {
                                    Text(value["error"] as? String ?? "아직 받은 서비스 의견이 없습니다.")
                                        .font(.caption).foregroundColor(CoinPilotColors.ink).lineLimit(4)
                                }
                                consultationEvaluation(value["evaluation"] as? [String: Any] ?? [:])
                            }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 9) {
                        SectionHeading(title: "가격 비교 기록")
                        let effectiveness = store.aiEffectiveness
                        if effectiveness.isEmpty {
                            EmptyMessage(text: "AI 의견 뒤의 가격 비교 자료가 없습니다.")
                        } else {
                            AnalyticsMetric(title: "의견 완료", value: "\(effectiveness["actualProviderCompletions"] as? Int ?? 0)회")
                            AnalyticsMetric(title: "가격 확인", value: "\(effectiveness["evaluatedConsultations"] as? Int ?? 0)건")
                            AnalyticsMetric(title: "충분한 비교 자료", value: effectiveness["sufficientEvidence"] as? Bool == true ? "예" : "아직 부족")
                            let coverage = number(effectiveness["evaluationCoverageRate"])
                            AnalyticsMetric(title: "가격 확인 비율", value: coverage.map { CoinPilotFormatting.percent($0 * 100) } ?? "미제공")
                            Text("가격 방향 비교는 실제 매매 수익률이 아니며, 실제 체결이나 수익을 증명하지 않습니다.")
                                .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle("AI 자문")
        .navigationBarTitleDisplayMode(.inline)
        .task { if store.aiProviderStatus.isEmpty { await store.loadAIDesk() } }
    }

    @ViewBuilder
    private var providerStatus: some View {
        if let providers = store.aiProviderStatus["providers"] as? [[String: Any]], !providers.isEmpty {
            ForEach(Array(providers.enumerated()), id: \.offset) { item in
                let provider = item.element
                let ready = provider["ready"] as? Bool ?? provider["available"] as? Bool ?? false
                HStack {
                    Text(provider["name"] as? String ?? provider["provider"] as? String ?? "AI 서비스")
                    Spacer()
                    Text(providerState(provider["status"] as? String, ready: ready))
                        .font(.caption.weight(.semibold))
                        .foregroundColor(ready ? CoinPilotColors.green : CoinPilotColors.amber)
                }
                .font(.subheadline)
            }
        } else if store.aiProviderStatus["enabled"] as? Bool == true {
            Text("AI 자문을 사용할 수 있습니다.").font(.subheadline).foregroundColor(CoinPilotColors.green)
        } else {
            Text("서비스 제공 상태를 확인할 수 없습니다.").font(.subheadline).foregroundColor(CoinPilotColors.secondaryInk)
        }
    }

    private func sessionButton(_ title: String, id: String, action: String) -> some View {
        Button(title) { Task { _ = await store.updateAISession(id: id, action: action) } }
            .font(.caption.weight(.semibold))
            .disabled(!store.canOperate || store.isRunningFeatureAction)
    }

    private func sessionStatus(_ value: String) -> String {
        switch value {
        case "RUNNING": return "실행 중"
        case "PAUSED": return "일시 정지"
        case "STOPPED": return "종료"
        default: return "상태 확인 필요"
        }
    }

    private func eventLabel(_ value: String) -> String {
        eventOptions.first(where: { $0.0 == value })?.1 ?? value
    }

    private func eventTypeLabel(_ value: String) -> String { eventLabel(value) }

    private func providerBinding(_ provider: String) -> Binding<Bool> {
        Binding(
            get: { providers.contains(provider) },
            set: { enabled in
                if enabled { providers.insert(provider) } else { providers.remove(provider) }
            }
        )
    }

    private func providerLabel(_ value: String) -> String {
        switch value.lowercased() {
        case "gpt", "openai", "chatgpt", "codex": return "OpenAI"
        case "claude", "anthropic": return "Claude"
        default: return value.isEmpty ? "AI 의견" : value
        }
    }

    private func providerState(_ status: String?, ready: Bool) -> String {
        if ready { return "사용 가능" }
        switch status {
        case "NOT_AUTHENTICATED": return "계정 로그인 필요"
        case "NOT_INSTALLED": return "연결 프로그램 없음"
        case "DISABLED": return "현재 사용 안 함"
        default: return "연결 확인 필요"
        }
    }

    private func actionLabel(_ value: String) -> String {
        switch value.uppercased() {
        case "BUY": return "매수 의견"
        case "SELL": return "매도 의견"
        case "WAIT", "HOLD": return "관망 의견"
        default: return value
        }
    }

    @ViewBuilder
    private func consultationEvaluation(_ evaluation: [String: Any]) -> some View {
        if !evaluation.isEmpty {
            let status = evaluation["status"] as? String ?? ""
            if status == "COMPLETED" {
                let minutes = evaluation["horizonMinutes"] as? Int ?? 5
                let change = (evaluation["priceChangePercent"] as? NSNumber)?.doubleValue
                Text("\(minutes)분 뒤 가격 변화 · \(CoinPilotFormatting.percent(change))")
                    .font(.caption2.weight(.semibold)).foregroundColor(CoinPilotColors.secondaryInk)
            } else if status == "PENDING" {
                Text("가격 확인 시점 대기 중").font(.caption2).foregroundColor(CoinPilotColors.amber)
            } else if status == "NOT_EVALUABLE" {
                Text(evaluation["reason"] as? String ?? "기준 가격을 비교할 수 없습니다.")
                    .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
            }
        }
    }

    private func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

private struct CoinPilotAccountAnalyticsView: View {
    @ObservedObject var store: CoinPilotStore

    private var summary: [String: Any] { store.portfolioAnalysis["summary"] as? [String: Any] ?? [:] }
    private var holdings: [[String: Any]] { store.portfolioAnalysis["holdings"] as? [[String: Any]] ?? [] }
    private var gainers: [[String: Any]] { store.portfolioAnalysis["topGainers"] as? [[String: Any]] ?? [] }
    private var losers: [[String: Any]] { store.portfolioAnalysis["topLosers"] as? [[String: Any]] ?? [] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            SectionHeading(title: "포트폴리오 구성")
                            Spacer()
                            Button("새로고침") { Task { await store.loadAccountAnalytics() } }
                                .font(.caption.weight(.semibold))
                                .disabled(!store.canOperate)
                        }
                        if let message = store.featureMessages["portfolio-analysis"] {
                            EmptyMessage(text: message)
                        } else if summary.isEmpty {
                            EmptyMessage(text: "포트폴리오 분석 자료가 아직 없습니다.")
                        } else {
                            AnalyticsMetric(title: "총 자산", value: CoinPilotFormatting.won(number(summary["totalAssets"])))
                            AnalyticsMetric(title: "보유 자산 평가", value: CoinPilotFormatting.won(number(summary["totalValue"])))
                            AnalyticsMetric(title: "매입 원가", value: CoinPilotFormatting.won(number(summary["totalCost"])))
                            AnalyticsMetric(title: "현금 잔액", value: CoinPilotFormatting.won(number(summary["krwBalance"])))
                            AnalyticsMetric(title: "누적 손익", value: CoinPilotFormatting.signedWon(number(summary["totalProfit"])))
                            if let percent = number(summary["totalProfitPercent"]) {
                                AnalyticsMetric(title: "수익률", value: CoinPilotFormatting.percent(percent))
                            }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "보유 비중")
                        if holdings.isEmpty {
                            EmptyMessage(text: "현재 보유한 코인이 없습니다.")
                        }
                        ForEach(Array(holdings.enumerated()), id: \.offset) { item in
                            let holding = item.element
                            let coin = holding["coin"] as? String ?? "자산"
                            let weight = number(holding["weight"]) ?? 0
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(CoinPilotFormatting.ticker(coin)).font(.subheadline.weight(.semibold))
                                    Text("비중 \(CoinPilotFormatting.percent(weight))")
                                        .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 4) {
                                    Text(CoinPilotFormatting.won(number(holding["currentValue"])))
                                        .font(.subheadline.weight(.semibold))
                                    Text(CoinPilotFormatting.signedWon(number(holding["profit"])))
                                        .font(.caption).foregroundColor(profitColor(number(holding["profit"])))
                                }
                            }
                            ProgressView(value: max(0, min(weight, 100)), total: 100)
                                .tint(CoinPilotColors.blue)
                            if item.offset != holdings.count - 1 { Divider().overlay(CoinPilotColors.line) }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "수익 변동이 큰 종목")
                        if gainers.isEmpty && losers.isEmpty { EmptyMessage(text: "비교할 보유 종목이 없습니다.") }
                        ForEach(Array(gainers.enumerated()), id: \.offset) { item in
                            AnalyticsMarketRow(title: "수익 상위", value: item.element)
                        }
                        ForEach(Array(losers.enumerated()), id: \.offset) { item in
                            AnalyticsMarketRow(title: "손실 하위", value: item.element)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "거래 통계")
                        if store.statistics.isEmpty {
                            EmptyMessage(text: "아직 집계된 거래 통계가 없습니다.")
                        }
                        ForEach(Array(store.statistics.enumerated()), id: \.offset) { item in
                            let value = item.element
                            Text(CoinPilotFormatting.ticker(value["coin"] as? String ?? "전략"))
                                .font(.subheadline.weight(.semibold))
                            AnalyticsMetric(title: "청산 거래", value: "\(number(value["totalTrades"]).map { Int($0) } ?? 0)회")
                            AnalyticsMetric(title: "승률", value: value["winRate"] as? String ?? "미제공")
                            AnalyticsMetric(title: "실현 손익", value: value["totalProfit"] as? String ?? "미제공")
                            if let average = value["avgProfit"] as? String { AnalyticsMetric(title: "거래당 평균", value: average) }
                            if item.offset != store.statistics.count - 1 { Divider().overlay(CoinPilotColors.line) }
                        }
                    }
                }
                Text("실거래 분석은 거래소 잔고를 기준으로 계산합니다. 시세를 확인하지 못한 값은 서버 응답 상태를 확인해 주세요.")
                    .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle("포트폴리오 분석")
        .navigationBarTitleDisplayMode(.inline)
        .task { if summary.isEmpty { await store.loadAccountAnalytics() } }
    }

    private func number(_ value: Any?) -> Double? {
        guard let value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

private struct AnalyticsMetric: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title).font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
            Spacer()
            Text(value).font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.ink).multilineTextAlignment(.trailing)
        }
    }
}

private struct AnalyticsMarketRow: View {
    let title: String
    let value: [String: Any]

    var body: some View {
        HStack {
            Text("\(title) · \(CoinPilotFormatting.ticker(value["coin"] as? String))")
                .font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.ink)
            Spacer()
            Text(value["profitPercent"] as? String ?? "변동률 미제공")
                .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
        }
    }
}

private struct CoinPilotResearchDeskView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var requestedPaperAction: Bool?

    private var paperIsActive: Bool {
        (store.paperValidationState["active"] as? Bool) ??
        ((store.paperValidationState["status"] as? [String: Any])?["active"] as? Bool) ?? false
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            SectionHeading(title: "전략 준비 상태")
                            Spacer()
                            Button("다시 확인") { Task { await store.loadResearchDesk() } }
                                .font(.caption.weight(.semibold)).disabled(!store.canOperate)
                        }
                        if store.strategyReadiness.isEmpty {
                            EmptyMessage(text: store.featureMessages["strategy-readiness"] ?? "서버의 검증 자료를 불러오지 않았습니다.")
                        } else {
                            let gate = store.strategyReadiness["liveGate"] as? [String: Any] ?? [:]
                            AnalyticsMetric(title: "준비 상태", value: store.strategyReadiness["status"] as? String ?? "확인 필요")
                            AnalyticsMetric(title: "현재 근거", value: store.strategyReadiness["currentEvidence"] as? Bool == true ? "현재 자료" : "확인 필요")
                            AnalyticsMetric(title: "실거래 진입", value: gate["passed"] as? Bool == true ? "서버 조건 통과" : "잠금")
                            Text("검증 자료가 있다고 실거래 주문이 자동 승인되지는 않습니다. 실제 주문은 서버의 계좌 동기화와 안전 조건을 별도로 통과해야 합니다.")
                                .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "전략 검증")
                        if store.scalpingValidation.isEmpty {
                            EmptyMessage(text: store.featureMessages["validation"] ?? "검증 보고서가 없습니다.")
                        } else {
                            AnalyticsMetric(title: "보고서", value: store.scalpingValidation["available"] as? Bool == true ? "사용 가능" : "자료 없음")
                            AnalyticsMetric(title: "최근 검증 상태", value: store.scalpingValidation["promoted"] as? Bool == true ? "서버에서 별도 승인됨" : "승인 상태 아님")
                            AnalyticsMetric(title: "보고서 생성", value: store.scalpingValidation["generatedAt"] as? String ?? "시각 미제공")
                            if let results = store.scalpingValidation["results"] as? [[String: Any]] {
                                ForEach(Array(results.prefix(8).enumerated()), id: \.offset) { item in
                                    let result = item.element
                                    AnalyticsMetric(
                                        title: result["coin"] as? String ?? result["market"] as? String ?? "종목",
                                        value: result["status"] as? String ?? result["decision"] as? String ?? "결과 확인 필요"
                                    )
                                }
                            }
                        }
                        Text("과거 검증은 실제 체결이나 수익을 보장하지 않습니다.")
                            .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "전략 연구 자료")
                        if store.strategyResearch.isEmpty {
                            EmptyMessage(text: store.featureMessages["strategy-research"] ?? "전략 연구 자료를 불러오지 않았습니다.")
                        } else {
                            let freshness = store.strategyResearch["reportFreshness"] as? [String: Any] ?? [:]
                            AnalyticsMetric(title: "자료 상태", value: store.strategyResearch["available"] as? Bool == true ? "자료 있음" : "자료 없음")
                            AnalyticsMetric(title: "생성 시각", value: store.strategyResearch["generatedAt"] as? String ?? "시각 미제공")
                            AnalyticsMetric(title: "자료 최신성", value: freshness["fresh"] as? Bool == true ? "최신" : "확인 필요")
                            AnalyticsMetric(title: "적용 승인", value: store.strategyResearch["promoted"] as? Bool == true ? "서버 승인" : "승인 자료 없음")
                            if let results = store.strategyResearch["results"] as? [[String: Any]] {
                                ForEach(Array(results.prefix(8).enumerated()), id: \.offset) { item in
                                    let value = item.element
                                    AnalyticsMetric(
                                        title: value["coin"] as? String ?? value["market"] as? String ?? "연구 후보",
                                        value: value["status"] as? String ?? value["reason"] as? String ?? "자료 확인 필요"
                                    )
                                }
                            }
                        }
                        Text("연구 후보와 과거 결과는 진단 자료입니다. 서버 주문 조건을 대신 승인하지 않습니다.")
                            .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "모멘텀 후보 점검")
                        if store.momentumShadow.isEmpty {
                            EmptyMessage(text: store.featureMessages["momentum-shadow"] ?? "후보 점검 자료가 없습니다.")
                        } else {
                            AnalyticsMetric(title: "자료 상태", value: store.momentumShadow["available"] as? Bool == true ? "조회 가능" : "자료 없음")
                            AnalyticsMetric(title: "실거래 승인", value: store.momentumShadow["promoted"] as? Bool == true ? "서버 승인" : "승인하지 않음")
                            let readiness = store.momentumShadow["candidateReadiness"] as? [String: Any] ?? [:]
                            AnalyticsMetric(title: "후보 판정", value: readiness["status"] as? String ?? readiness["state"] as? String ?? "확인 필요")
                            if let variants = store.momentumShadow["candidateReadinessVariants"] as? [[String: Any]] {
                                ForEach(Array(variants.prefix(8).enumerated()), id: \.offset) { item in
                                    let value = item.element
                                    let result = value["readiness"] as? [String: Any] ?? [:]
                                    AnalyticsMetric(
                                        title: value["label"] as? String ?? "후보",
                                        value: result["status"] as? String ?? result["decision"] as? String ?? "참고 자료"
                                    )
                                }
                            }
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "실거래 실행 기록")
                        if store.liveExecutionEvidence.isEmpty {
                            EmptyMessage(text: store.featureMessages["live-execution-evidence"] ?? "서버 실행 기록을 불러오지 않았습니다.")
                        } else {
                            AnalyticsMetric(title: "기록 상태", value: store.liveExecutionEvidence["available"] as? Bool == true ? "조회 가능" : "조회 자료 없음")
                            AnalyticsMetric(title: "저장 오류", value: store.liveExecutionEvidence["writeError"] as? String ?? "없음")
                            AnalyticsMetric(title: "자료 오류", value: store.liveExecutionEvidence["dataError"] as? String ?? "없음")
                            Text("이 기록은 실거래 체결이 관찰됐다는 사실을 확인하는 용도입니다. 모의 검증과는 별도 자료입니다.")
                                .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "모의투자 점검 세션")
                        AnalyticsMetric(title: "상태", value: paperIsActive ? "실행 중" : (store.paperValidationState["available"] as? Bool == true ? "중지" : "사용할 수 없음"))
                        AnalyticsMetric(title: "연속성", value: store.paperValidationState["continuityEligible"] as? Bool == true ? "자료 연속" : "검증 필요")
                        if let reason = store.paperValidationState["reason"] as? String {
                            Text(reason).font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                        }
                        if let message = store.featureMessages["paper-validation"] {
                            InlineNotice(text: message, color: CoinPilotColors.amber)
                        }
                        if store.activeWorkspace == .paper && store.canOperate {
                            Button(paperIsActive ? "모의 점검 중지" : "모의 점검 시작") { requestedPaperAction = !paperIsActive }
                                .buttonStyle(CoinPilotSecondaryButtonStyle())
                            if !paperIsActive {
                                Button("모의투자 기록을 초기화하고 시작") { requestedPaperAction = true }
                                    .font(.caption.weight(.semibold)).foregroundColor(CoinPilotColors.red)
                            }
                        } else {
                            Text("모의 점검 세션은 모의투자 서버에서만 제어할 수 있습니다.")
                                .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                        }
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle("주문 전 점검")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            requestedPaperAction == true ? "모의투자 점검을 시작할까요?" : "모의투자 점검을 중지할까요?",
            isPresented: Binding(get: { requestedPaperAction != nil }, set: { if !$0 { requestedPaperAction = nil } }),
            titleVisibility: .visible
        ) {
            if let shouldStart = requestedPaperAction {
                if shouldStart {
                    Button("기록 유지하고 시작") {
                        requestedPaperAction = nil
                        Task { _ = await store.startPaperValidation(reset: false) }
                    }
                    Button("기록 지우고 새로 시작", role: .destructive) {
                        requestedPaperAction = nil
                        Task { _ = await store.startPaperValidation(reset: true) }
                    }
                } else {
                    Button("점검 중지", role: .destructive) {
                        requestedPaperAction = nil
                        Task { _ = await store.stopPaperValidation() }
                    }
                }
            }
            Button("취소", role: .cancel) { requestedPaperAction = nil }
        } message: {
            Text(requestedPaperAction == true
                 ? "모의투자 점검 기록은 전략 검토 자료입니다. 실거래 체결이나 수익을 증명하지 않습니다."
                 : "현재 모의 점검 세션을 중지합니다.")
        }
        .task { if store.strategyReadiness.isEmpty { await store.loadResearchDesk() } }
    }
}

private struct CoinPilotOptimizationView: View {
    @ObservedObject var store: CoinPilotStore

    private let intervals: [(String, Int)] = [
        ("1시간", 3_600_000), ("2시간", 7_200_000), ("3시간", 10_800_000),
        ("6시간", 21_600_000), ("12시간", 43_200_000), ("24시간", 86_400_000)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let reason = store.optimizationBlockReason { InlineNotice(text: reason, color: CoinPilotColors.amber) }
                NativeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            SectionHeading(title: "자동 후보 비교")
                            Spacer()
                            Button("새로고침") { Task { _ = await store.loadOptimization() } }
                                .font(.caption.weight(.semibold)).disabled(!store.canOperate)
                        }
                        Toggle("정한 간격으로 후보 비교", isOn: Binding(
                            get: { store.optimizationSettings["enabled"] as? Bool ?? false },
                            set: { value in Task { _ = await store.setOptimizationEnabled(value) } }
                        ))
                        .tint(CoinPilotColors.blue)
                        .disabled(store.optimizationBlockReason != nil)
                        Text("비교 결과는 자동으로 적용되지 않습니다. 검증 자료를 확인한 뒤 설정을 직접 적용해 주세요.")
                            .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                        Picker("비교 간격", selection: Binding(
                            get: { store.optimizationSettings["interval"] as? Int ?? 21_600_000 },
                            set: { value in Task { _ = await store.setOptimizationInterval(value) } }
                        )) {
                            ForEach(Array(intervals.enumerated()), id: \.offset) { item in
                                Text(item.element.0).tag(item.element.1)
                            }
                        }
                        .pickerStyle(MenuPickerStyle())
                        .disabled(store.optimizationBlockReason != nil)
                        if let nextRun = store.optimizationSettings["nextRun"] as? String {
                            AnalyticsMetric(title: "다음 비교", value: CoinPilotFormatting.dateTime(nextRun))
                        }
                        Button(store.isRunningFeatureAction ? "처리 중" : "지금 후보 비교") {
                            Task { _ = await store.runOptimizationNow() }
                        }
                        .buttonStyle(CoinPilotSecondaryButtonStyle())
                        .disabled(!store.canOperate || store.isRunningFeatureAction || store.optimizationBlockReason != nil)
                        if let message = store.featureMessages["optimization"] {
                            InlineNotice(text: message, color: CoinPilotColors.amber)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "최근 후보 비교")
                        if store.optimizationHistory.isEmpty {
                            EmptyMessage(text: "저장된 비교 기록이 없습니다.")
                        }
                        ForEach(Array(store.optimizationHistory.prefix(12).enumerated()), id: \.offset) { item in
                            let value = item.element
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(value["type"] as? String ?? value["strategy"] as? String ?? "설정 비교")
                                        .font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text(String(describing: value["fitness"] ?? value["score"] ?? "—"))
                                        .font(.caption.monospacedDigit()).foregroundColor(CoinPilotColors.secondaryInk)
                                }
                                Text(value["description"] as? String ?? value["message"] as? String ?? "비교 기록")
                                    .font(.caption).foregroundColor(CoinPilotColors.secondaryInk).lineLimit(3)
                                Text(CoinPilotFormatting.dateTime(value["timestamp"] as? String ?? value["date"] as? String, unavailable: "시각 미제공"))
                                    .font(.caption2).foregroundColor(CoinPilotColors.secondaryInk)
                            }
                            .padding(.vertical, 7)
                            Divider().overlay(CoinPilotColors.line)
                        }
                    }
                }
                NativeCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeading(title: "과거 데이터 비교")
                        let rows = store.backtestResults["results"] as? [[String: Any]] ?? store.backtestResults["entries"] as? [[String: Any]] ?? []
                        if rows.isEmpty {
                            EmptyMessage(text: store.backtestResults["message"] as? String ?? "과거 데이터 비교 결과가 없습니다.")
                        }
                        ForEach(Array(rows.prefix(10).enumerated()), id: \.offset) { item in
                            let value = item.element
                            AnalyticsMetric(
                                title: value["coin"] as? String ?? value["strategy"] as? String ?? "후보",
                                value: value["totalReturnPercent"].map { "\($0) %" } ?? value["returnPercent"].map { "\($0) %" } ?? "결과 미제공"
                            )
                        }
                        Text("과거 비교만으로 후보가 실제 주문에 적용되지는 않습니다.")
                            .font(.caption).foregroundColor(CoinPilotColors.secondaryInk)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle("설정 후보 비교")
        .navigationBarTitleDisplayMode(.inline)
        .task { if store.optimizationSettings.isEmpty { _ = await store.loadOptimization() } }
    }
}

private struct CoinPilotPresetView: View {
    @ObservedObject var store: CoinPilotStore
    @State private var requestedPreset: [String: Any]?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let reason = store.tuningBlockReason { InlineNotice(text: reason, color: CoinPilotColors.amber) }
                Text("프리셋은 현재 작업공간 서버의 전략 설정을 바꿉니다. 위험 수준은 설정 성향을 나타내며 손실 한도나 수익 보장이 아닙니다.")
                    .font(.subheadline).foregroundColor(CoinPilotColors.secondaryInk)
                if let message = store.tuningMessage { InlineNotice(text: message, color: CoinPilotColors.blue) }
                if store.investmentPresets.isEmpty {
                    NativeCard {
                        EmptyMessage(text: store.featureMessages["investment-presets"] ?? "서버 프리셋을 불러오는 중입니다.")
                    }
                }
                ForEach(Array(store.investmentPresets.enumerated()), id: \.offset) { item in
                    let preset = item.element
                    CoinPilotPresetCard(preset: preset, store: store) {
                        requestedPreset = preset
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 30)
        }
        .background(CoinPilotColors.paper.ignoresSafeArea())
        .navigationTitle("전략 프리셋")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            requestedPreset?["name"] as? String ?? "프리셋 적용",
            isPresented: Binding(get: { requestedPreset != nil }, set: { if !$0 { requestedPreset = nil } }),
            titleVisibility: .visible
        ) {
            if let preset = requestedPreset, let id = preset["id"] as? String {
                Button("현재 전략 설정 바꾸기", role: .destructive) {
                    requestedPreset = nil
                    Task { _ = await store.applyInvestmentPreset(id: id) }
                }
            }
            Button("취소", role: .cancel) { requestedPreset = nil }
        } message: {
            Text("프리셋은 선택한 모의투자 또는 실거래 서버의 전략 설정을 덮어씁니다. 현재 보유 자산이나 주문 기록은 변경하지 않습니다.")
        }
        .task { if store.investmentPresets.isEmpty { _ = await store.loadOptimization() } }
    }
}

private struct CoinPilotPresetCard: View {
    let preset: [String: Any]
    @ObservedObject var store: CoinPilotStore
    let onApply: () -> Void

    private var name: String { preset["name"] as? String ?? "전략 프리셋" }
    private var description: String { preset["description"] as? String ?? "설정 설명이 없습니다." }
    private var riskLevel: Int? { preset["riskLevel"] as? Int }

    private var investmentRatioText: String? {
        guard let config = preset["config"] as? [String: Any],
              let value = (config["investmentRatio"] as? NSNumber)?.doubleValue,
              value.isFinite else { return nil }
        return "1회 투자 비율 \(CoinPilotFormatting.percent(value * 100))"
    }

    var body: some View {
        NativeCard {
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    Text(name).font(.headline.weight(.semibold))
                    Spacer()
                    if let riskLevel {
                        Text("위험 성향 \(riskLevel)/5")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(CoinPilotColors.amber)
                    }
                }
                Text(description)
                    .font(.caption)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
                if let investmentRatioText {
                    Text(investmentRatioText)
                        .font(.caption2)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
                Button("이 설정 적용", action: onApply)
                    .buttonStyle(CoinPilotSecondaryButtonStyle())
                    .disabled(!store.canOperate || store.tuningBlockReason != nil || store.isRunningFeatureAction)
            }
        }
    }
}

private struct CoinPilotTuningEditor: View {
    @ObservedObject var store: CoinPilotStore
    @Environment(\.dismiss) private var dismiss
    @State private var numericDrafts: [String: String] = [:]
    @State private var booleanDrafts: [String: Bool] = [:]
    @State private var validationMessage: String?
    @State private var didLoadDrafts = false

    private var categories: [String] {
        Array(Set(store.tuningFields.map(\.category))).sorted()
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let blockReason = store.tuningBlockReason {
                        InlineNotice(text: blockReason, color: CoinPilotColors.amber)
                    }
                    if let message = validationMessage ?? store.tuningMessage {
                        InlineNotice(text: message, color: CoinPilotColors.amber)
                    }
                    if store.isLoadingTuning && store.tuningFields.isEmpty {
                        NativeCard {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("서버 설정을 불러오고 있습니다.")
                                    .font(.subheadline)
                                    .foregroundColor(CoinPilotColors.secondaryInk)
                            }
                        }
                    } else if store.tuningFields.isEmpty {
                        NativeCard {
                            EmptyMessage(text: store.tuningMessage ?? "이 서버에서 조정할 수 있는 튜닝값을 확인하지 못했습니다.")
                        }
                    } else {
                        ForEach(categories, id: \.self) { category in
                            NativeCard {
                                VStack(alignment: .leading, spacing: 13) {
                                    SectionHeading(title: categoryTitle(category))
                                    ForEach(store.tuningFields.filter { $0.category == category }) { field in
                                        tuningRow(field)
                                        if field.id != store.tuningFields.filter({ $0.category == category }).last?.id {
                                            Divider().overlay(CoinPilotColors.line)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Text("설정은 \(store.activeWorkspace.title) 서버에만 적용됩니다. 자동매매 실행 중이거나 성과 점검이 잠긴 동안에는 저장할 수 없습니다.")
                        .font(.footnote)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .background(CoinPilotColors.paper.ignoresSafeArea())
            .navigationTitle("튜닝값 설정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("닫기") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(store.isSavingTuning ? "저장 중" : "저장") {
                        save()
                    }
                    .disabled(store.isSavingTuning || store.isLoadingTuning || store.tuningBlockReason != nil || store.tuningFields.isEmpty)
                }
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
        .task {
            if await store.loadTuning() { hydrateDrafts() }
        }
    }

    @ViewBuilder
    private func tuningRow(_ field: CoinPilotTuningField) -> some View {
        if let booleanValue = field.booleanValue {
            Toggle(field.label, isOn: booleanBinding(for: field, fallback: booleanValue))
                .font(.body.weight(.medium))
                .tint(CoinPilotColors.blue)
            if !field.description.isEmpty {
                Text(field.description)
                    .font(.caption)
                    .foregroundColor(CoinPilotColors.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 12) {
                    Text(field.label)
                        .font(.body.weight(.medium))
                        .foregroundColor(CoinPilotColors.ink)
                    Spacer(minLength: 4)
                    TextField("값", text: numericBinding(for: field))
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(.plain)
                        .frame(width: 106)
                        .frame(minHeight: 38)
                        .padding(.horizontal, 8)
                        .background(CoinPilotColors.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .accessibilityLabel(field.label)
                }
                if !field.description.isEmpty {
                    Text(field.description)
                        .font(.caption)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let minimum = field.minimum, let maximum = field.maximum {
                    let multiplier = field.displayMultiplier
                    Text("허용 범위 \(numberText(minimum * multiplier))~\(numberText(maximum * multiplier)) · 간격 \(numberText((field.step ?? 0) * multiplier))")
                        .font(.caption2)
                        .foregroundColor(CoinPilotColors.secondaryInk)
                }
            }
        }
    }

    private func numericBinding(for field: CoinPilotTuningField) -> Binding<String> {
        Binding(
            get: { self.numericDrafts[field.key] ?? field.displayValue.map(self.numberText) ?? "" },
            set: { self.numericDrafts[field.key] = $0; self.validationMessage = nil }
        )
    }

    private func booleanBinding(for field: CoinPilotTuningField, fallback: Bool) -> Binding<Bool> {
        Binding(
            get: { self.booleanDrafts[field.key] ?? fallback },
            set: { self.booleanDrafts[field.key] = $0; self.validationMessage = nil }
        )
    }

    private func hydrateDrafts() {
        var numeric: [String: String] = [:]
        var boolean: [String: Bool] = [:]
        for field in store.tuningFields {
            if let value = field.booleanValue { boolean[field.key] = value }
            if let value = field.displayValue { numeric[field.key] = numberText(value) }
        }
        numericDrafts = numeric
        booleanDrafts = boolean
        didLoadDrafts = true
    }

    private func save() {
        guard didLoadDrafts else { return }
        var updates: [String: Any] = [:]
        for field in store.tuningFields {
            if field.booleanValue != nil {
                updates[field.key] = booleanDrafts[field.key] ?? field.booleanValue
                continue
            }
            guard let raw = numericDrafts[field.key], let displayed = Double(raw), displayed.isFinite else {
                validationMessage = "\(field.label) 값을 숫자로 입력해 주세요."
                return
            }
            let multiplier = field.displayMultiplier == 0 ? 1 : field.displayMultiplier
            let value = displayed / multiplier
            guard value.isFinite,
                  field.minimum.map({ value >= $0 }) ?? true,
                  field.maximum.map({ value <= $0 }) ?? true else {
                validationMessage = "\(field.label) 값이 허용 범위를 벗어났습니다."
                return
            }
            updates[field.key] = value
        }
        validationMessage = nil
        Task {
            if await store.saveTuning(updates) { hydrateDrafts() }
        }
    }

    private func categoryTitle(_ value: String) -> String {
        switch value.lowercased() {
        case "investment": return "투자 금액"
        case "risk": return "위험 관리"
        case "scalping": return "전략 진입·보유"
        default: return value
        }
    }

    private func numberText(_ value: Double) -> String {
        String(value).replacingOccurrences(of: ".0", with: "")
    }
}

private struct CoinPilotSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundColor(isEnabled ? CoinPilotColors.blue : CoinPilotColors.secondaryInk)
            .background(isEnabled
                        ? CoinPilotColors.blue.opacity(configuration.isPressed ? 0.16 : 0.08)
                        : CoinPilotColors.line)
            .clipShape(RoundedRectangle(cornerRadius: 10))
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

private struct CoinPilotTokenEditor: View {
    @ObservedObject var store: CoinPilotStore
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var message: String?

    var body: some View {
        NavigationView {
            Form {
                Section {
                    SecureField("서버 토큰 입력", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                } header: {
                    Text("서버 토큰")
                } footer: {
                    Text("\(store.serverAddress) 서버의 모바일 운영 토큰을 입력해 주세요. 기존 토큰은 새 토큰이 확인된 뒤 교체됩니다. 거래소 API 키는 서버에만 보관합니다.")
                }
                if let message {
                    Text(message).foregroundColor(CoinPilotColors.red)
                }
                Section {
                    Button {
                        Task {
                            if let error = await store.updateServerToken(token) {
                                message = error
                            } else {
                                token = ""
                                dismiss()
                            }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if store.isWorking { ProgressView().padding(.trailing, 6) }
                            Text(store.isWorking ? "토큰 확인 중" : "토큰 확인 후 저장")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .disabled(store.isWorking || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .background(CoinPilotColors.paper)
            .navigationTitle("서버 토큰 입력")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("취소") {
                        token = ""
                        dismiss()
                    }
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
    @ObservedObject var store: CoinPilotStore
    @State private var showingSellConfirmation = false

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
                if store.isBundledPreview {
                    Text("예시")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .accessibilityLabel("예시 보유 자산")
                } else if (position.coin.map { store.manualOrderBlockReason(for: $0) != nil } ?? true) || position.amount == nil {
                    Text("주문 잠김")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CoinPilotColors.secondaryInk)
                        .accessibilityLabel("매도 주문 잠김")
                } else {
                    Button("매도") { showingSellConfirmation = true }
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CoinPilotColors.red)
                }
            }
        }
        .padding(.vertical, 14)
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
            Text("\(CoinPilotFormatting.quantity(position.amount))개를 시장가로 매도합니다. \(store.activeWorkspace == .live ? "Upbit 실계정 주문입니다." : "모의 서버 가상 계좌에만 적용됩니다.")")
        }
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
            .clipShape(RoundedRectangle(cornerRadius: CoinPilotShapes.cardCornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: CoinPilotShapes.cardCornerRadius, style: .continuous)
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
