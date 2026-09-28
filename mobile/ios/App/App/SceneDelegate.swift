import Foundation
import Security
import UIKit
import WebKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        let navigationController = UINavigationController(rootViewController: CoinPilotViewController())
        window?.rootViewController = navigationController
        window?.makeKeyAndVisible()
    }
}

@MainActor
final class CoinPilotViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    private let serverKey = "coinpilot.dashboardUrl"
    private let defaultServerURL = URL(string: "https://52.78.156.161")!
    private let keychainService = Bundle.main.bundleIdentifier ?? "com.godekd3133.coinpilot"
    private var webView: WKWebView!
    private var configuredServer: URL {
        guard let value = UserDefaults.standard.string(forKey: serverKey),
              let url = URL(string: value),
              ServerAddressPolicy.allows(url) else {
            return defaultServerURL
        }
        return url
    }

    private var setupPage: URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "public")
    }

    private var appPage: URL? {
        Bundle.main.url(forResource: "app", withExtension: "html", subdirectory: "public")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 16 / 255, green: 22 / 255, blue: 19 / 255, alpha: 1)
        title = "CoinPilot"
        navigationController?.navigationBar.tintColor = UIColor(red: 197 / 255, green: 239 / 255, blue: 112 / 255, alpha: 1)
        navigationController?.navigationBar.isTranslucent = false
        navigationController?.navigationBar.barStyle = .black
        navigationController?.navigationBar.backgroundColor = UIColor(red: 16 / 255, green: 22 / 255, blue: 19 / 255, alpha: 1)
        configureAppNavigation()

        let contentController = WKUserContentController()
        contentController.add(self, name: "coinpilotConnect")
        contentController.add(self, name: "coinpilotForget")
        contentController.add(self, name: "coinpilotShowServerSettings")
        contentController.add(self, name: "coinpilotBackToApp")
        contentController.addScriptMessageHandler(self, contentWorld: .page, name: "coinpilotApi")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        let server = configuredServer
        if UserDefaults.standard.string(forKey: serverKey) != server.absoluteString {
            UserDefaults.standard.set(server.absoluteString, forKey: serverKey)
        }
        loadDashboard(server)
    }

    @objc private func showServerSettings() {
        loadServerSettings()
    }

    @objc private func returnToApp() {
        loadDashboard(configuredServer)
    }

    @objc private func reloadDashboard() {
        if webView.url?.lastPathComponent == "app.html" {
            webView.evaluateJavaScript("window.coinPilotRefresh && window.coinPilotRefresh();")
        } else {
            loadDashboard(configuredServer)
        }
    }

    private func loadServerSettings() {
        guard let page = setupPage else {
            showError("앱에 서버 설정 화면이 없습니다. 빌드 자산을 다시 동기화하세요.")
            return
        }
        title = "서버 설정"
        navigationItem.leftBarButtonItem = nil
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "완료",
            style: .done,
            target: self,
            action: #selector(returnToApp)
        )
        let folder = page.deletingLastPathComponent()
        webView.loadFileURL(page, allowingReadAccessTo: folder)
    }

    private func loadDashboard(_ url: URL) {
        guard isAllowedServerURL(url) else {
            showError("저장된 서버 주소가 올바르지 않습니다. 서버 설정에서 다시 입력하세요.")
            loadServerSettings()
            return
        }
        guard let page = appPage else {
            showError("앱에 iOS 화면이 없습니다. 앱 자산을 다시 동기화하세요.")
            return
        }
        configureAppNavigation()
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    private func configureAppNavigation() {
        title = "CoinPilot"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "서버",
            style: .plain,
            target: self,
            action: #selector(showServerSettings)
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .refresh,
            target: self,
            action: #selector(reloadDashboard)
        )
    }

    private func isAllowedServerURL(_ url: URL) -> Bool {
        ServerAddressPolicy.allows(url)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the bundled setup page may change the saved backend address.
        guard message.frameInfo.request.url?.isFileURL == true else { return }

        switch message.name {
        case "coinpilotConnect":
            guard let rawURL = message.body as? String,
                  let url = URL(string: rawURL),
                  isAllowedServerURL(url) else {
                showError("주소를 확인하세요. 로컬 네트워크는 내부 IP와 HTTP를 사용할 수 있고, 외부 주소는 HTTPS가 필요합니다.")
                return
            }
            UserDefaults.standard.set(url.absoluteString, forKey: serverKey)
            loadDashboard(url)
        case "coinpilotForget":
            let previousServer = configuredServer
            UserDefaults.standard.removeObject(forKey: serverKey)
            deleteToken(for: previousServer)
        case "coinpilotShowServerSettings":
            loadServerSettings()
        case "coinpilotBackToApp":
            loadDashboard(configuredServer)
        default:
            break
        }
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.request.url?.isFileURL == true,
              let payload = message.body as? [String: Any],
              let action = payload["action"] as? String else {
            replyHandler(["ok": false, "status": 0, "error": "요청을 확인할 수 없습니다."], nil)
            return
        }

        Task { @MainActor in
            switch action {
            case "server-config":
                let hasSavedServer = UserDefaults.standard.object(forKey: serverKey) != nil
                replyHandler([
                    "ok": true,
                    "status": 200,
                    "hasSavedServer": hasSavedServer,
                    "url": configuredServer.absoluteString
                ], nil)
            case "auth-status":
                var result = await performRequest(path: "/api/auth/status", method: "GET", body: nil, includeToken: false)
                result["hasToken"] = token(for: configuredServer) != nil
                replyHandler(result, nil)
            case "login":
                guard let rawToken = payload["token"] as? String else {
                    replyHandler(["ok": false, "status": 400, "error": "서버 토큰을 입력해 주세요."], nil)
                    return
                }
                let value = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty, value.utf8.count <= 4096 else {
                    replyHandler(["ok": false, "status": 400, "error": "서버 토큰을 확인해 주세요."], nil)
                    return
                }
                var result = await performRequest(
                    path: "/api/auth/login",
                    method: "POST",
                    body: ["token": value],
                    includeToken: false
                )
                if result["ok"] as? Bool == true {
                    if saveToken(value, for: configuredServer) {
                        result["hasToken"] = true
                    } else {
                        result["ok"] = false
                        result["error"] = "토큰을 iPhone 키체인에 저장하지 못했습니다."
                    }
                } else if result["status"] as? Int == 401 {
                    result["error"] = "토큰이 올바르지 않습니다. 서버의 DASHBOARD_TOKEN을 확인해 주세요."
                }
                replyHandler(result, nil)
            case "read":
                guard let path = payload["path"] as? String, isAllowedReadOnlyPath(path) else {
                    replyHandler(["ok": false, "status": 403, "error": "이 화면에서 요청할 수 없는 경로입니다."], nil)
                    return
                }
                let result = await performRequest(path: path, method: "GET", body: nil, includeToken: true)
                replyHandler(result, nil)
            case "logout":
                deleteToken(for: configuredServer)
                replyHandler(["ok": true, "status": 200], nil)
            default:
                replyHandler(["ok": false, "status": 400, "error": "지원하지 않는 요청입니다."], nil)
            }
        }
    }

    private func isAllowedReadOnlyPath(_ rawPath: String) -> Bool {
        guard let components = URLComponents(string: "https://coinpilot.invalid" + rawPath),
              components.host == "coinpilot.invalid",
              components.fragment == nil else {
            return false
        }

        let queryItems = components.queryItems ?? []
        switch components.path {
        case "/api/status", "/api/account", "/api/cumulative-pnl", "/api/today-summary", "/api/market/prices":
            return queryItems.isEmpty
        case "/api/portfolio/history":
            return queryItems.count == 1 && queryItems.first?.name == "period" &&
                ["24h", "7d", "30d"].contains(queryItems.first?.value ?? "")
        case "/api/trades":
            guard queryItems.count == 1, queryItems.first?.name == "limit",
                  let value = Int(queryItems.first?.value ?? ""), (1...50).contains(value) else { return false }
            return true
        default:
            return false
        }
    }

    private func performRequest(
        path: String,
        method: String,
        body: [String: Any]?,
        includeToken: Bool
    ) async -> [String: Any] {
        guard let url = apiURL(for: path) else {
            return ["ok": false, "status": 0, "error": "서버 주소를 확인해 주세요."]
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if includeToken, let value = token(for: configuredServer) {
            request.setValue("Bearer \(value)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            guard let data = try? JSONSerialization.data(withJSONObject: body) else {
                return ["ok": false, "status": 0, "error": "요청을 준비하지 못했습니다."]
            }
            request.httpBody = data
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return ["ok": false, "status": 0, "error": "서버 응답을 확인할 수 없습니다."]
            }
            let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
            var result: [String: Any] = ["ok": (200..<300).contains(http.statusCode), "status": http.statusCode]
            if let parsed { result["data"] = parsed }
            if !(200..<300).contains(http.statusCode) {
                let message = (parsed as? [String: Any])?["error"] as? String
                result["error"] = message ?? (http.statusCode == 401 ? "인증이 필요합니다." : "서버 요청이 완료되지 않았습니다.")
            }
            return result
        } catch {
            return ["ok": false, "status": 0, "error": "서버에 연결할 수 없습니다. 인터넷 연결과 서버 주소를 확인해 주세요."]
        }
    }

    private func apiURL(for path: String) -> URL? {
        guard let requestComponents = URLComponents(string: "https://coinpilot.invalid" + path),
              requestComponents.host == "coinpilot.invalid",
              requestComponents.path.hasPrefix("/api/"),
              requestComponents.fragment == nil,
              var serverComponents = URLComponents(url: configuredServer, resolvingAgainstBaseURL: false) else {
            return nil
        }
        serverComponents.path = requestComponents.path
        serverComponents.query = requestComponents.query
        serverComponents.fragment = nil
        return serverComponents.url
    }

    private func tokenAccount(for server: URL) -> String {
        server.absoluteString
    }

    private func token(for server: URL) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenAccount(for: server),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    private func saveToken(_ value: String, for server: URL) -> Bool {
        deleteToken(for: server)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenAccount(for: server),
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    private func deleteToken(for server: URL) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: tokenAccount(for: server)
        ]
        SecItemDelete(query as CFDictionary)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.isFileURL {
            decisionHandler(.allow)
            return
        }
        if ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.isFileURL == true else { return }
        if webView.url?.lastPathComponent == "app.html" {
            configureAppNavigation()
            let host = configuredServer.host.map { $0 + (configuredServer.port.map { ":\($0)" } ?? "") } ?? configuredServer.absoluteString
            let detail: [String: Any] = ["url": host]
            dispatchJavaScriptEvent("coinpilot-server-config", detail: detail)
            return
        }

        title = "서버 설정"
        navigationItem.leftBarButtonItem = nil
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "완료",
            style: .done,
            target: self,
            action: #selector(returnToApp)
        )
        guard UserDefaults.standard.object(forKey: serverKey) != nil else { return }
        let detail: [String: Any] = ["hasSavedServer": true, "url": configuredServer.absoluteString]
        dispatchJavaScriptEvent("coinpilot-native-server-config", detail: detail)
    }

    private func dispatchJavaScriptEvent(_ name: String, detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail, options: [.fragmentsAllowed, .sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(name)', { detail: \(json) }));")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        guard nsError.code != NSURLErrorCancelled else { return }
        showError("CoinPilot 서버에 연결할 수 없습니다. 인터넷 연결과 서버 상태를 확인하세요. 주소 변경은 상단의 서버 메뉴에서 할 수 있습니다.")
    }

    private func showError(_ message: String) {
        let alert = UIAlertController(title: "CoinPilot", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default))
        present(alert, animated: true)
    }
}
