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
final class CoinPilotViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private let serverKey = "coinpilot.dashboardUrl"
    private var webView: WKWebView!
    private var configuredServer: URL? {
        guard let value = UserDefaults.standard.string(forKey: serverKey) else { return nil }
        return URL(string: value)
    }

    private var setupPage: URL? {
        Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "public")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 16 / 255, green: 22 / 255, blue: 19 / 255, alpha: 1)
        title = "CoinPilot"
        navigationController?.navigationBar.tintColor = UIColor(red: 197 / 255, green: 239 / 255, blue: 112 / 255, alpha: 1)
        navigationController?.navigationBar.isTranslucent = false
        navigationController?.navigationBar.barStyle = .black
        navigationController?.navigationBar.backgroundColor = UIColor(red: 16 / 255, green: 22 / 255, blue: 19 / 255, alpha: 1)
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

        let contentController = WKUserContentController()
        contentController.add(self, name: "coinpilotConnect")
        contentController.add(self, name: "coinpilotForget")
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

        if let server = configuredServer {
            loadDashboard(server)
        } else {
            loadServerSettings()
        }
    }

    @objc private func showServerSettings() {
        loadServerSettings()
    }

    @objc private func reloadDashboard() {
        if webView.url?.isFileURL == true {
            webView.reload()
        } else if webView.url != nil {
            webView.reload()
        } else if let server = configuredServer {
            loadDashboard(server)
        } else {
            loadServerSettings()
        }
    }

    private func loadServerSettings() {
        guard let page = setupPage else {
            showError("앱에 서버 설정 화면이 없습니다. 빌드 자산을 다시 동기화하세요.")
            return
        }
        let folder = page.deletingLastPathComponent()
        webView.loadFileURL(page, allowingReadAccessTo: folder)
    }

    private func loadDashboard(_ url: URL) {
        guard isAllowedServerURL(url) else {
            showError("저장된 서버 주소가 올바르지 않습니다. 서버 설정에서 다시 입력하세요.")
            loadServerSettings()
            return
        }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    private func isAllowedServerURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              url.user == nil,
              url.password == nil,
              url.path.isEmpty || url.path == "/",
              url.query == nil,
              url.fragment == nil else { return false }
        if scheme == "https" { return true }
        guard scheme == "http" else { return false }
        return host.hasSuffix(".local") || isPrivateIPv4(host)
    }

    private func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { UInt8($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 || parts[0] == 127 ||
            (parts[0] == 192 && parts[1] == 168) ||
            (parts[0] == 172 && (16...31).contains(parts[1])) ||
            (parts[0] == 169 && parts[1] == 254)
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
            UserDefaults.standard.removeObject(forKey: serverKey)
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let isConfiguredServer = url.scheme?.lowercased() == configuredServer?.scheme?.lowercased() &&
            url.host?.lowercased() == configuredServer?.host?.lowercased() &&
            url.port == configuredServer?.port
        if url.isFileURL || isConfiguredServer {
            decisionHandler(.allow)
            return
        }
        if ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        guard nsError.code != NSURLErrorCancelled else { return }
        showError("서버에 연결할 수 없습니다. 서버 주소, 실행 상태, 같은 Wi-Fi 연결을 확인하세요.")
    }

    private func showError(_ message: String) {
        let alert = UIAlertController(title: "CoinPilot", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default))
        present(alert, animated: true)
    }
}
