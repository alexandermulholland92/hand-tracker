// HandBrowser.swift: the iPhone and iPad app's hand mouse. iOS lets no app tap inside other
// apps, so the hand mouse works websites instead: a browser inside Hand Tracker (a WKWebView
// over the lower part of the app, the camera still running above it), with the hand-mouse
// pointer added to every page it opens (web-pc.js's page pointer, given by the page as
// `script`). The page drives it (mobile-bridge.js createHandBrowser):
//
//   open({ url, top, script })      shows it below `top` (a share of the screen under the status
//                                   bar: 0.4 leaves the top 40% to the app) and loads url
//   call({ method, args })          window.__htPointer[method](...args) in the page shown
//                                   (pointer, button, wheel, key, text, where), its result back
//   back(), close(), status() -> { open, url, title, loading }
//   "page" events { open, url, title, loading, error }
//
// HandTrackerViewController is the app's main screen (SceneDelegate.swift): Capacitor's own,
// with this plugin registered. Launched with -HTSelfTest <test page> (the build's simulator
// check), the page runs its self-test on that page (phone-link-ui.js).

import UIKit
import WebKit
import Capacitor

class HandTrackerViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HandBrowserPlugin())
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-HTSelfTest") {
            let page = i + 1 < args.count ? args[i + 1] : ""
            let json = (try? JSONSerialization.data(withJSONObject: [page])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            webView?.configuration.userContentController.addUserScript(
                WKUserScript(source: "window.__htSelfTest = \(json)[0] || true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
    }
}

@objc(HandBrowserPlugin)
public class HandBrowserPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate {
    public let identifier = "HandBrowserPlugin"
    public let jsName = "HandBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "back", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    private var web: WKWebView?
    private var script = ""
    private var lastError = ""

    private func state() -> [String: Any] {
        guard let w = web else { return ["open": false, "url": "", "title": "", "loading": false, "error": lastError] }
        return ["open": true, "url": w.url?.absoluteString ?? "", "title": w.title ?? "", "loading": w.isLoading, "error": lastError]
    }

    private func tell() {
        notifyListeners("page", data: state())
    }

    private func place(_ w: WKWebView, top: CGFloat) {
        guard let host = bridge?.viewController?.view else { return }
        let safe = host.safeAreaInsets.top
        let share = max(0, min(top, 0.85))
        let y = safe + share * (host.bounds.height - safe)
        w.frame = CGRect(x: 0, y: y, width: host.bounds.width, height: host.bounds.height - y)
        w.autoresizingMask = [.flexibleWidth, .flexibleTopMargin, .flexibleHeight]
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            call.reject("That isn't a web address (http:// or https://).")
            return
        }
        let top = CGFloat(call.getDouble("top") ?? 0)
        if let s = call.getString("script"), !s.isEmpty { script = s }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController?.view else {
                call.reject("The app isn't ready yet.")
                return
            }
            if self.web == nil {
                let config = WKWebViewConfiguration()
                config.allowsInlineMediaPlayback = true
                config.mediaTypesRequiringUserActionForPlayback = []
                let content = WKUserContentController()
                content.addUserScript(WKUserScript(source: self.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
                config.userContentController = content
                let w = WKWebView(frame: .zero, configuration: config)
                w.navigationDelegate = self
                w.allowsBackForwardNavigationGestures = true
                w.backgroundColor = .white
                host.addSubview(w)
                self.web = w
            }
            if let w = self.web {
                self.place(w, top: top)
                self.lastError = ""
                w.load(URLRequest(url: url))
            }
            call.resolve(self.state())
            self.tell()
        }
    }

    // The page pointer's methods, with their arguments as JSON (so nothing is pasted into code).
    @objc func call(_ call: CAPPluginCall) {
        let method = call.getString("method") ?? ""
        let allowed: Set<String> = ["pointer", "button", "wheel", "key", "text", "where"]
        guard allowed.contains(method) else {
            call.reject("Unknown pointer call.")
            return
        }
        var args: [Any] = []
        if let json = call.getString("args"), let data = json.data(using: .utf8),
           let list = try? JSONSerialization.jsonObject(with: data) as? [Any] {
            args = list
        }
        DispatchQueue.main.async {
            guard let w = self.web else {
                call.reject("Open a website in the hand browser first.")
                return
            }
            let js = "const p = window.__htPointer; if (!p) throw new Error('The page is still loading.'); return await p[method](...args);"
            w.callAsyncJavaScript(js, arguments: ["method": method, "args": args], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    if value is NSNull {
                        call.resolve([:])
                    } else {
                        call.resolve(["value": value])
                    }
                case .failure(let error):
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    @objc func back(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let w = self.web, w.canGoBack { w.goBack() }
            call.resolve(self.state())
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.web?.removeFromSuperview()
            self.web = nil
            call.resolve(self.state())
            self.tell()
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(self.state())
        }
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        tell()
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        tell()
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        lastError = error.localizedDescription
        tell()
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        lastError = error.localizedDescription
        tell()
    }
}
