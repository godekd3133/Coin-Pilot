#if canImport(UIKit)
import SwiftUI
import UIKit

// UIKit owns this scene, so the hosted SwiftUI views need its lifecycle explicitly.
// Both the dashboard and visible detail screens use this phase to pause/resume polling.
private final class CoinPilotSceneLifecycle: ObservableObject {
    @Published var phase: ScenePhase = .inactive
}

private struct CoinPilotSceneRootView: View {
    @ObservedObject var lifecycle: CoinPilotSceneLifecycle

    var body: some View {
        CoinPilotNativeRootView()
            .environment(\.scenePhase, lifecycle.phase)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let lifecycle = CoinPilotSceneLifecycle()

    func sceneDidBecomeActive(_ scene: UIScene) {
        lifecycle.phase = .active
    }

    func sceneWillResignActive(_ scene: UIScene) {
        lifecycle.phase = .inactive
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        lifecycle.phase = .inactive
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        lifecycle.phase = .background
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        lifecycle.phase = .background
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: CoinPilotSceneRootView(lifecycle: lifecycle))
        self.window = window
        window.makeKeyAndVisible()
    }
}
#endif
