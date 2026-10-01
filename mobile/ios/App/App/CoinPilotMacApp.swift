#if os(macOS)
import SwiftUI

/// macOS 전용 진입점. iOS는 UIKit AppDelegate/SceneDelegate가 진입점이 된다.
@main
struct CoinPilotMacApp: App {
    var body: some Scene {
        WindowGroup {
            CoinPilotNativeRootView()
                .frame(minWidth: 880, minHeight: 640)
        }
        .windowToolbarStyle(UnifiedWindowToolbarStyle())
    }
}
#endif
