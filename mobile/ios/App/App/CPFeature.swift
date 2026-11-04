import SwiftUI

/// Where a feature appears in the shell.
struct CPNavSurface: OptionSet, Hashable {
    let rawValue: Int
    /// iOS bottom tab bar (keep to five entries).
    static let phoneTab = CPNavSurface(rawValue: 1 << 0)
    /// Mac sidebar primary section.
    static let sidebar = CPNavSurface(rawValue: 1 << 1)
    /// Listed inside the 더보기 screen (iOS; on Mac only when not in the sidebar).
    static let moreLink = CPNavSurface(rawValue: 1 << 2)
}

/// One navigable feature. Adding a screen = a folder under `Features/` plus one
/// entry in `CPFeatureRegistry.all`; the tab bar, sidebar and 더보기 list follow.
struct CPFeature: Identifiable {
    let id: String
    let label: String
    let icon: String
    let surfaces: CPNavSurface
    /// Shows the shared refresh button in the navigation bar.
    var showsRefresh = true
    let makeView: (CoinPilotStore) -> AnyView

    init<Content: View>(
        id: String,
        label: String,
        icon: String,
        surfaces: CPNavSurface,
        showsRefresh: Bool = true,
        @ViewBuilder view: @escaping (CoinPilotStore) -> Content
    ) {
        self.id = id
        self.label = label
        self.icon = icon
        self.surfaces = surfaces
        self.showsRefresh = showsRefresh
        self.makeView = { AnyView(view($0)) }
    }
}

enum CPFeatureRegistry {
    /// Order here is the order in the tab bar and the sidebar.
    static let all: [CPFeature] = [
        CPFeature(id: "home", label: "홈", icon: "house", surfaces: [.phoneTab, .sidebar]) { store in
            CoinPilotHomeView(store: store)
        },
        CPFeature(id: "coins", label: "코인", icon: "bitcoinsign.circle", surfaces: [.phoneTab, .sidebar]) { store in
            CoinPilotCoinsView(store: store)
        },
        CPFeature(id: "stocks", label: "주식", icon: "chart.bar.xaxis", surfaces: [.phoneTab, .sidebar]) { store in
            CoinPilotStocksView(store: store)
        },
        CPFeature(id: "portfolios", label: "포트폴리오", icon: "square.stack.3d.up", surfaces: [.phoneTab, .sidebar]) { store in
            CoinPilotPortfoliosView(store: store)
        },
        CPFeature(id: "activity", label: "활동", icon: "clock.arrow.circlepath", surfaces: [.sidebar, .moreLink]) { store in
            CoinPilotActivityView(store: store)
        },
        CPFeature(id: "settings", label: "설정", icon: "gearshape", surfaces: [.sidebar, .moreLink], showsRefresh: false) { store in
            CoinPilotSettingsView(store: store)
        },
        CPFeature(id: "more", label: "더보기", icon: "square.grid.2x2", surfaces: [.phoneTab, .sidebar], showsRefresh: false) { store in
            CoinPilotMoreView(store: store)
        }
    ]

    static var phoneTabs: [CPFeature] { all.filter { $0.surfaces.contains(.phoneTab) } }
    static var sidebarItems: [CPFeature] { all.filter { $0.surfaces.contains(.sidebar) } }

    /// Primary features listed at the top of 더보기 on the current platform.
    static var moreLinks: [CPFeature] {
        #if os(macOS)
        return all.filter { $0.surfaces.contains(.moreLink) && !$0.surfaces.contains(.sidebar) }
        #else
        return all.filter { $0.surfaces.contains(.moreLink) && !$0.surfaces.contains(.phoneTab) }
        #endif
    }

    static func feature(_ id: String) -> CPFeature? { all.first { $0.id == id } }
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
    static let selectedFeatureKey = "coinpilot.native.selectedFeature.v3"
    static let coinsSegmentKey = "coinpilot.native.coinsSegment.v1"

    static func open(_ featureID: String) {
        guard let feature = CPFeatureRegistry.feature(featureID) else { return }
        #if os(macOS)
        let target = feature.surfaces.contains(.sidebar) ? feature.id : "more"
        #else
        let target = feature.surfaces.contains(.phoneTab) ? feature.id : "more"
        #endif
        UserDefaults.standard.set(target, forKey: selectedFeatureKey)
    }

    static func openCoins(_ segment: CPCoinsSegment) {
        UserDefaults.standard.set(segment.rawValue, forKey: coinsSegmentKey)
        open("coins")
    }
}
