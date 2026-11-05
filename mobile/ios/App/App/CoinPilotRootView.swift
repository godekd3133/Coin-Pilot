import SwiftUI

struct CoinPilotNativeRootView: View {
    @StateObject private var store = CoinPilotStore()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(CPAppearance.storageKey) private var appearance = CPAppearance.system.rawValue

    /// Connection ⇄ dashboard: a plain short fade.
    private var phaseTransition: AnyTransition { .opacity }

    var body: some View {
        Group {
            if store.isBundledLocalMarketData {
                CoinPilotNavigationHost {
                    CoinPilotLocalMarketView(store: store)
                        .navigationTitle("시장")
                        .cpInlineTitle()
                }
            } else if store.phase == .dashboard && store.serverModeMatchesWorkspace {
                CoinPilotShellView(store: store)
                    .transition(phaseTransition)
            } else if !store.didFinishInitialConnect {
                CoinPilotStartupView()
                    .transition(.opacity)
            } else {
                CoinPilotConnectionView(store: store)
                    .transition(phaseTransition)
            }
        }
        .background(CPColor.paper.ignoresSafeArea())
        .tint(CPColor.blue)
        .preferredColorScheme(CPAppearance(rawValue: appearance)?.colorScheme)
        .animation(CPMotion.resolved(CPMotion.spring, reduceMotion: reduceMotion), value: store.phase)
        .task { await store.bootstrap() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("CoinPilotPushDeviceToken"))) { _ in
            Task { await store.syncOrderNotifications() }
        }
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

struct CoinPilotVisibleFeatureRefreshModifier: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase

    let enabled: Bool
    let refresh: () async -> Void

    func body(content: Content) -> some View {
        content.task(id: enabled && scenePhase == .active) {
            guard enabled, scenePhase == .active else { return }
            while !Task.isCancelled {
                await refresh()
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                } catch {
                    return
                }
            }
        }
    }
}

extension View {
    func refreshFeatureWhenVisible(
        enabled: Bool = true,
        _ refresh: @escaping () async -> Void
    ) -> some View {
        modifier(CoinPilotVisibleFeatureRefreshModifier(enabled: enabled, refresh: refresh))
    }
}

struct CoinPilotFeatureFreshnessLine: View {
    let lastSuccessfulAt: Date?
    let error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MetadataLine(text: lastSuccessfulAt.map {
                "확인 \(CoinPilotFormatting.localDateTime($0))"
            } ?? "자료 확인 전")
                .font(.caption2)
                .foregroundColor(CPColor.secondaryInk)
            if let error, !error.isEmpty {
                Text(error)
                    .font(.caption2)
                    .foregroundColor(CPColor.amber)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct CoinPilotStartupView: View {
    var body: some View {
        VStack(spacing: 14) {
            Text("CoinPilot")
                .font(.title2.weight(.bold))
                .foregroundColor(CPColor.blue)
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: CPColor.blue))
            Text("계좌 불러오는 중")
                .font(.body.weight(.medium))
                .foregroundColor(CPColor.secondaryInk)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CPColor.paper.ignoresSafeArea())
    }
}

// MARK: - Appearance

enum CPAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "coinpilot.native.appearance"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: return "시스템"
        case .light: return "라이트"
        case .dark: return "다크"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

// MARK: - Shell

/// Keeps scroll content clear of the translucent iOS tab bar.
struct CoinPilotTabBarContentInset: ViewModifier {
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear
                .frame(height: 56)
                .accessibilityHidden(true)
        }
    }
}

/// Persistent red strip while the LIVE workspace is active, on every screen.
struct CoinPilotLiveWorkspaceBanner: ViewModifier {
    @ObservedObject var store: CoinPilotStore

    private var isLive: Bool { store.activeWorkspace == .live && !store.isBundledPreview }

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            if isLive {
                HStack(spacing: 8) {
                    CPLiveIndicator(compact: true)
                    Text("실전 작업공간 · 주문과 자동매매에 실제 자금이 사용됩니다")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(CPColor.red)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, CPSpace.page)
                .padding(.vertical, 7)
                .background(CPColor.paper)
                .overlay(Rectangle().fill(CPColor.red).frame(height: 1), alignment: .bottom)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// iOS: bottom tabs from the registry. Mac: sidebar from the registry.
struct CoinPilotShellView: View {
    @ObservedObject var store: CoinPilotStore
    @AppStorage(CPNavigation.selectedFeatureKey) private var selectedFeature = "home"

    var body: some View {
        #if os(macOS)
        CoinPilotSidebarShell(store: store, selectedFeature: $selectedFeature)
        #else
        TabView(selection: $selectedFeature) {
            ForEach(CPFeatureRegistry.phoneTabs) { feature in
                CoinPilotNavigationHost {
                    CoinPilotFeatureScreen(store: store, feature: feature)
                }
                .modifier(CoinPilotTabBarContentInset())
                .tabItem { Label(feature.label, systemImage: feature.icon) }
                .tag(feature.id)
            }
        }
        .onAppear {
            if CPFeatureRegistry.phoneTabs.contains(where: { $0.id == selectedFeature }) == false {
                selectedFeature = "home"
            }
        }
        #endif
    }
}

/// A feature's root view with the shared title, refresh button and live banner.
struct CoinPilotFeatureScreen: View {
    @ObservedObject var store: CoinPilotStore
    let feature: CPFeature

    var body: some View {
        feature.makeView(store)
            .modifier(CoinPilotLiveWorkspaceBanner(store: store))
            .navigationTitle(feature.label)
            .cpInlineTitle()
            .toolbar {
                #if !os(macOS)
                CoinPilotWorkspaceToolbar(store: store)
                #endif
                ToolbarItemGroup(placement: .cpTrailing) {
                    if feature.showsRefresh {
                        Button {
                            Task {
                                await store.refresh()
                                await store.loadStocksStatus(force: true)
                                await store.loadHorizonsStatus(force: true)
                            }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .disabled(store.isRefreshing)
                        .accessibilityLabel("새로고침")
                    }
                }
            }
    }
}

struct CoinPilotWorkspaceToolbar: ToolbarContent {
    @ObservedObject var store: CoinPilotStore

    var body: some ToolbarContent {
        ToolbarItem(placement: .cpLeading) {
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
                let exchangeSuffix = store.isBundledPreview || store.isBundledLocalMarketData
                    ? "" : " (\(store.exchangeDisplayName))"
                let isLive = store.activeWorkspace == .live && !store.isBundledPreview
                Label("\(store.isBundledPreview ? "예시 데이터" : store.activeWorkspace.title)\(exchangeSuffix)",
                      systemImage: isLive ? "exclamationmark.circle.fill" : "arrow.left.arrow.right")
                    .labelStyle(.titleAndIcon)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(isLive ? CPColor.red : CPColor.blue)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .accessibilityLabel("현재 \(store.activeWorkspace.title) 작업공간. 전환")
        }
    }
}

#if os(macOS)
struct CoinPilotSidebarShell: View {
    @ObservedObject var store: CoinPilotStore
    @Binding var selectedFeature: String

    private var selection: Binding<String?> {
        Binding(get: { selectedFeature }, set: { if let value = $0 { selectedFeature = value } })
    }

    private var current: CPFeature {
        CPFeatureRegistry.feature(selectedFeature) ?? CPFeatureRegistry.all[0]
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                Section {
                    ForEach(CPFeatureRegistry.sidebarItems.filter { $0.id != "more" }) { feature in
                        Label(feature.label, systemImage: feature.icon).tag(feature.id)
                    }
                }
                if let more = CPFeatureRegistry.feature("more") {
                    Section("고급 도구") {
                        Label(more.label, systemImage: more.icon).tag(more.id)
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
            .safeAreaInset(edge: .bottom, spacing: 0) { workspaceFooter }
        } detail: {
            CoinPilotNavigationHost {
                CoinPilotFeatureScreen(store: store, feature: current)
            }
            .id(current.id)
        }
    }

    private var workspaceFooter: some View {
        let isLive = store.activeWorkspace == .live && !store.isBundledPreview
        return VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("작업공간")
                .font(.caption2.weight(.semibold))
                .foregroundColor(CPColor.secondaryInk)
            CoinPilotWorkspaceSelector(store: store)
            if isLive {
                CPLiveIndicator()
            } else {
                CPBadge(text: store.isBundledPreview ? "예시 데이터" : "모의 · 가상 자금", tone: .info)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
    }
}
#endif
