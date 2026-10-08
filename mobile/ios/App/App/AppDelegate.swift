#if canImport(UIKit)
import UIKit
import UserNotifications
import Combine

@MainActor
final class CoinPilotOrderNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = CoinPilotOrderNotifications()
    @Published var deviceToken: String?
    @Published var registrationError: String?
    private var requested = false
    private var authorized = false
    var deviceId: String {
        let key = "coinpilot.push.installation"
        if let saved = UserDefaults.standard.string(forKey: key) { return saved }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }
    var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
    func prepare() async -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined && !requested {
            requested = true
            authorized = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true
        } else {
            authorized = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        }
        if authorized { UIApplication.shared.registerForRemoteNotifications() }
        return authorized
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = CoinPilotOrderNotifications.shared
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        CoinPilotOrderNotifications.shared.deviceToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: Notification.Name("CoinPilotPushDeviceToken"), object: nil)
    }


    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        CoinPilotOrderNotifications.shared.registrationError = "기기 알림 등록을 완료하지 못했습니다. 다시 연결해 주세요."
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits the application.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
#endif
