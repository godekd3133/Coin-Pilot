import SwiftUI

/// Where a feature appears in the shell.
struct CPNavSurface: OptionSet, Hashable {
    let rawValue: Int
    /// iOS bottom tab bar (keep to five entries).
    static let phoneTab = CPNavSurface(rawValue: 1 << 0)
    /// Mac sidebar primary section.
    static let sidebar = CPNavSurface(rawValue: 1 << 1)
    /// Listed inside 연구실 (iOS) and in the matching Mac sidebar section.
    /// Requires `group`.
    static let labLink = CPNavSurface(rawValue: 1 << 2)
}

/// Sections of 연구실. The same grouping drives the Mac sidebar sections.
enum CPLabGroup: String, CaseIterable, Identifiable {
    case assets
    case strategy
    case analysis
    case market

    var id: String { rawValue }
    var title: String {
        switch self {
        case .assets: return "다른 자산 운용"
        case .strategy: return "전략 설정"
        case .analysis: return "검증과 분석"
        case .market: return "시장 정보"
        }
    }
}

/// One navigable feature. Adding a screen = a folder under `Features/` plus one
/// entry in `CPFeatureRegistry.all`; the tab bar, sidebar and 연구실 list follow.
struct CPFeature: Identifiable {
    let id: String
    let label: String
    let icon: String
    let surfaces: CPNavSurface
    /// 연구실 section (only for `.labLink`).
    var group: CPLabGroup?
    /// One plain line shown under the title in 연구실.
    var detail: String
    /// Hidden from 연구실 and the sidebar while the app shows bundled example data.
    var hiddenInPreview: Bool
    /// Shows the shared refresh button in the navigation bar.
    var showsRefresh: Bool
    let makeView: (CoinPilotStore) -> AnyView

    init<Content: View>(
        id: String,
        label: String,
        icon: String,
        surfaces: CPNavSurface,
        group: CPLabGroup? = nil,
        detail: String = "",
        hiddenInPreview: Bool = false,
        showsRefresh: Bool = true,
        @ViewBuilder view: @escaping (CoinPilotStore) -> Content
    ) {
        self.id = id
        self.label = label
        self.icon = icon
        self.surfaces = surfaces
        self.group = group
        self.detail = detail
        self.hiddenInPreview = hiddenInPreview
        self.showsRefresh = showsRefresh
        self.makeView = { AnyView(view($0)) }
    }

    @MainActor
    func isVisible(in store: CoinPilotStore) -> Bool {
        if hiddenInPreview { return !store.isBundledPreview }
        return true
    }
}

enum CPFeatureRegistry {
    /// Order here is the order in the tab bar, the sidebar and each 연구실 section.
    static let all: [CPFeature] = [
        CPFeature(id: "home", label: "홈", icon: "house", surfaces: [.phoneTab, .sidebar]) { store in
            CoinPilotHomeView(store: store)
        },
        CPFeature(id: "activity", label: "기록", icon: "clock.arrow.circlepath", surfaces: [.phoneTab, .sidebar]) { store in
            CoinPilotActivityView(store: store)
        },
        CPFeature(id: "coins", label: "코인", icon: "bitcoinsign.circle", surfaces: [.phoneTab, .sidebar]) { store in
            CoinPilotCoinsView(store: store)
        },
        CPFeature(id: "lab", label: "연구실", icon: "square.grid.2x2", surfaces: [.phoneTab], showsRefresh: false) { store in
            CoinPilotLabView(store: store)
        },
        CPFeature(id: "settings", label: "설정", icon: "gearshape", surfaces: [.phoneTab, .sidebar], showsRefresh: false) { store in
            CoinPilotSettingsView(store: store)
        },

        // 연구실 · 다른 자산 운용
        CPFeature(id: "stocks", label: "주식", icon: "chart.bar.xaxis", surfaces: [.labLink],
                  group: .assets, detail: "토스증권 국내 주식 단타 자동매매의 상태와 시작·정지") { store in
            CoinPilotStocksView(store: store)
        },
        CPFeature(id: "portfolios", label: "기간별 포트폴리오", icon: "square.stack.3d.up", surfaces: [.labLink],
                  group: .assets, detail: "코인·주식을 며칠에서 몇 달 보유하는 차트 분석 포트폴리오") { store in
            CoinPilotPortfoliosView(store: store)
        },

        // 연구실 · 전략 설정
        CPFeature(id: "presets", label: "프리셋", icon: "list.bullet.rectangle", surfaces: [.labLink],
                  group: .strategy, detail: "투자 비중과 지표 기간을 한 번에 바꾸는 묶음 설정",
                  hiddenInPreview: true) { store in
            CoinPilotPresetView(store: store)
        },
        CPFeature(id: "tuning", label: "튜닝", icon: "slider.vertical.3", surfaces: [.labLink],
                  group: .strategy, detail: "손절·익절·보유 시간 같은 값을 하나씩 조정",
                  hiddenInPreview: true, showsRefresh: false) { store in
            CoinPilotTuningEntryView(store: store)
        },
        CPFeature(id: "optimization", label: "최적화", icon: "slider.horizontal.3", surfaces: [.labLink],
                  group: .strategy, detail: "과거 시세로 설정 후보를 비교한 기록과 백테스트",
                  hiddenInPreview: true) { store in
            CoinPilotOptimizationView(store: store)
        },

        // 연구실 · 검증과 분석
        CPFeature(id: "account-analytics", label: "계좌 분석", icon: "chart.pie", surfaces: [.labLink],
                  group: .analysis, detail: "코인 계좌의 자산 비중과 코인별 손익") { store in
            CoinPilotAccountAnalyticsView(store: store)
        },
        CPFeature(id: "research-desk", label: "연구 데스크", icon: "checkmark.shield", surfaces: [.labLink],
                  group: .analysis, detail: "전략 검증 결과와 주문 전에 확인하는 운용 상태",
                  hiddenInPreview: true) { store in
            CoinPilotResearchDeskView(store: store)
        },
        CPFeature(id: "offline-replay", label: "오프라인 리플레이", icon: "play.rectangle", surfaces: [.labLink],
                  group: .analysis, detail: "앱에 저장된 시세로 과거 구간을 다시 계산하는 별도 모드",
                  showsRefresh: false) { store in
            CoinPilotOfflineReplayEntryView(store: store)
        },

        // 연구실 · 시장 정보
        CPFeature(id: "news", label: "뉴스", icon: "newspaper", surfaces: [.labLink],
                  group: .market, detail: "코인별 뉴스와 시장 심리 점수", hiddenInPreview: true) { store in
            CoinPilotNewsView(store: store)
        },
        CPFeature(id: "ai-desk", label: "AI 데스크", icon: "text.bubble", surfaces: [.labLink],
                  group: .market, detail: "관심 신호에 대한 AI 의견 기록 · 주문은 하지 않음",
                  hiddenInPreview: true) { store in
            CoinPilotAIDeskView(store: store)
        }
    ]

    static var phoneTabs: [CPFeature] { all.filter { $0.surfaces.contains(.phoneTab) } }
    static var sidebarItems: [CPFeature] { all.filter { $0.surfaces.contains(.sidebar) } }
    static var labItems: [CPFeature] { all.filter { $0.surfaces.contains(.labLink) } }

    static func labItems(in group: CPLabGroup) -> [CPFeature] {
        labItems.filter { $0.group == group }
    }

    static func feature(_ id: String) -> CPFeature? { all.first { $0.id == id } }

    /// Ids that existed in earlier shells and now live elsewhere.
    static let legacyAliases: [String: String] = ["more": "lab"]
}

/// Coins tab sections (보유 · 시장 · 주문).
enum CPCoinsSegment: String, CaseIterable, Identifiable {
    case holdings
    case market
    case order

    var id: String { rawValue }
    var title: String {
        switch self {
        case .holdings: return "보유"
        case .market: return "시장"
        case .order: return "주문"
        }
    }
}

/// Programmatic navigation without threading bindings through every screen.
/// The shell observes these keys through `@AppStorage`.
enum CPNavigation {
    /// v4: tabs became 홈 · 기록 · 코인 · 연구실 · 설정 (주식/포트폴리오/더보기 left the tab bar).
    static let selectedFeatureKey = "coinpilot.native.selectedFeature.v4"
    static let legacySelectedFeatureKeys = ["coinpilot.native.selectedFeature.v3"]
    /// iOS: a 연구실 screen to push once the 연구실 tab is showing.
    static let labDestinationKey = "coinpilot.native.labDestination.v1"
    static let coinsSegmentKey = "coinpilot.native.coinsSegment.v1"

    /// Where the shell should land for a stored or requested feature id on this
    /// platform: the top-level selection plus (iOS) a 연구실 screen to push.
    static func resolve(_ featureID: String) -> (selection: String, labDestination: String?) {
        let id = CPFeatureRegistry.legacyAliases[featureID] ?? featureID
        guard let feature = CPFeatureRegistry.feature(id) else { return ("home", nil) }
        #if os(macOS)
        if feature.surfaces.contains(.sidebar) || feature.surfaces.contains(.labLink) { return (feature.id, nil) }
        return ("home", nil)
        #else
        if feature.surfaces.contains(.phoneTab) { return (feature.id, nil) }
        if feature.surfaces.contains(.labLink) { return ("lab", feature.id) }
        return ("home", nil)
        #endif
    }

    static func open(_ featureID: String) {
        let target = resolve(featureID)
        if let destination = target.labDestination {
            UserDefaults.standard.set(destination, forKey: labDestinationKey)
        }
        UserDefaults.standard.set(target.selection, forKey: selectedFeatureKey)
    }

    static func openCoins(_ segment: CPCoinsSegment) {
        UserDefaults.standard.set(segment.rawValue, forKey: coinsSegmentKey)
        open("coins")
    }

    /// Carries a selection stored by an older shell into the current key so
    /// nobody opens to a tab that no longer exists. A stored 주식/포트폴리오 tab
    /// opens 연구실 (iOS) without pushing; the person picks again from the list.
    static func migrateStoredSelection(defaults: UserDefaults = .standard) {
        defer { legacySelectedFeatureKeys.forEach { defaults.removeObject(forKey: $0) } }
        guard defaults.object(forKey: selectedFeatureKey) == nil else { return }
        guard let legacy = legacySelectedFeatureKeys.lazy.compactMap({ defaults.string(forKey: $0) }).first else { return }
        defaults.set(resolve(legacy).selection, forKey: selectedFeatureKey)
    }

    /// A valid top-level selection for the current platform.
    static func normalizedSelection(_ featureID: String) -> String {
        resolve(featureID).selection
    }
}
