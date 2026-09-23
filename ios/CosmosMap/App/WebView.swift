import SwiftUI
import UIKit
@preconcurrency import WebKit

/// Full-screen WKWebView hosting the bundled CosmosMap web app from the loopback server.
struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.suppressesIncrementalRendering = false
        // Consistent iPad (touch-first) user agent and viewport handling in every window size,
        // instead of .recommended flipping between desktop and mobile across multitasking sizes.
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.nativeBridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false

        let background = UIColor(named: "LaunchBackground") ?? UIColor(red: 6 / 255, green: 6 / 255, blue: 15 / 255, alpha: 1)
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.underPageBackgroundColor = background

        let scrollView = webView.scrollView
        scrollView.backgroundColor = background
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false

        #if DEBUG
        webView.isInspectable = true
        #endif

        context.coordinator.load(url, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // The server may have moved to another port after a restart; follow it.
        if context.coordinator.origin != Coordinator.origin(of: url) {
            context.coordinator.load(url, in: webView)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    /// `window.CosmosMapNative`, available before any page script runs.
    static var nativeBridgeScript: String {
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] as? String ?? "0") (\(info?["CFBundleVersion"] as? String ?? "0"))"
        let payload: [String: String] = ["platform": "ipad", "version": version]
        let json = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? #"{"platform":"ipad"}"#
        return "window.CosmosMapNative = Object.freeze(\(json));"
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private(set) var origin: String?
        private var homeURL: URL?

        static func origin(of url: URL) -> String? {
            guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
            return "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
        }

        func load(_ url: URL, in webView: WKWebView) {
            homeURL = url
            origin = Self.origin(of: url)
            webView.load(URLRequest(url: url))
        }

        private func isLocal(_ url: URL) -> Bool {
            guard let origin else { return false }
            return Self.origin(of: url) == origin
        }

        private func openExternally(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
            UIApplication.shared.open(url)
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
                decisionHandler(.cancel)
                return
            }
            switch scheme {
            case "http", "https":
                if isLocal(url) {
                    if navigationAction.targetFrame == nil {
                        // target=_blank to our own origin: keep it in this web view.
                        webView.load(navigationAction.request)
                        decisionHandler(.cancel)
                    } else {
                        decisionHandler(.allow)
                    }
                } else {
                    openExternally(url)
                    decisionHandler(.cancel)
                }
            case "about":
                decisionHandler(.allow)
            case "blob", "data":
                // Allowed for subframes the app creates itself, never as a top-level navigation.
                decisionHandler(navigationAction.targetFrame?.isMainFrame == false ? .allow : .cancel)
            case "mailto":
                openExternally(url)
                decisionHandler(.cancel)
            default:
                decisionHandler(.cancel)
            }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // The WebContent process was killed (usually memory pressure from GPU buffers).
            if let homeURL { webView.load(URLRequest(url: homeURL)) } else { webView.reload() }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            logNavigationError(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            logNavigationError(error)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            #if DEBUG
            let probe = "JSON.stringify({href: location.href, secure: window.isSecureContext, gpu: 'gpu' in navigator, native: window.CosmosMapNative, coi: window.crossOriginIsolated})"
            webView.evaluateJavaScript(probe) { result, _ in
                print("[CosmosMap] page loaded: \(result ?? "nil")")
            }
            #endif
        }

        private func logNavigationError(_ error: Error) {
            #if DEBUG
            print("[CosmosMap] navigation failed: \(error)")
            #endif
        }

        // MARK: WKUIDelegate

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // window.open / target=_blank: external links go to Safari, local ones stay here.
            if let url = navigationAction.request.url {
                if isLocal(url) { webView.load(navigationAction.request) } else { openExternally(url) }
            }
            return nil
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(message: message, in: webView, actions: [("OK", .default, completionHandler)], fallback: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(message: message, in: webView,
                    actions: [("Cancel", .cancel, { completionHandler(false) }), ("OK", .default, { completionHandler(true) })],
                    fallback: { completionHandler(false) })
        }

        private func present(message: String, in webView: WKWebView,
                             actions: [(String, UIAlertAction.Style, () -> Void)], fallback: @escaping () -> Void) {
            guard var presenter = webView.window?.rootViewController else { fallback(); return }
            while let next = presenter.presentedViewController { presenter = next }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            for (title, style, handler) in actions {
                alert.addAction(UIAlertAction(title: title, style: style) { _ in handler() })
            }
            presenter.present(alert, animated: true)
        }
    }
}
