#if os(macOS)
import SwiftUI

/// macOS 전용 진입점. iOS는 UIKit AppDelegate/SceneDelegate가 진입점이 된다.
@main
struct CoinPilotMacApp: App {
    var body: some Scene {
        // 창마다 별도 Store를 만들면 같은 계좌의 진행 중 작업을 공유하지 못한다.
        Window("CoinPilot", id: "coinpilot-main") {
            CoinPilotNativeRootView()
                .frame(minWidth: 880, minHeight: 640)
        }
        .defaultSize(width: 1000, height: 760)
        .windowToolbarStyle(UnifiedWindowToolbarStyle())
    }
}
#endif
