// HandBrowser.swift: the iPhone and iPad app's hand mouse. iOS lets no app tap inside other
// apps, so the hand mouse works websites instead: a browser inside Hand Tracker (a WKWebView
// filling the screen, the app shrunk to a small picture-in-picture window in a corner showing
// the camera), with the hand-mouse pointer added to every page it opens (web-pc.js's page
// pointer, given by the page as `script`). The page drives it (mobile-bridge.js createHandBrowser):
//
//   open({ url, aspect, script })   shows it full screen and loads url, the app in its corner
//                                   (aspect: the camera picture's width / height, its shape)
//   show({ app })                   the app full screen over the website (true), or back (false)
//   call({ method, args })          window.__htPointer[method](...args) in the page shown
//                                   (pointer, button, wheel, swipe, key, text, where), its result back
//   back(), close(), status() -> { open, app, url, title, loading }
//   layout() -> { screen, browser, app }   where each is on the screen (for the self-test)
//   "page" events { open, app, url, title, loading, error }
//
// HandTrackerHost is the app's main screen (SceneDelegate.swift): Capacitor's own screen
// (HandTrackerViewController, with this plugin registered) and the browser behind it. Launched
// with -HTSelfTest <test page> (the build's simulator check), the page runs its self-test on
// that page (phone-link-ui.js).

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

// The app's screen: the app (Capacitor's page) on top, the hand browser behind it while a
// website is open. With one open the browser fills the screen and the app is a small window in
// a corner, the camera picture's shape, which moves to the other side when the hand-mouse
// pointer comes near it (as the iPhone's own picture in picture does) and can be dragged to
// another corner.
class HandTrackerHost: UIViewController, UIGestureRecognizerDelegate {
    let app = HandTrackerViewController()
    private(set) var browser: WKWebView?
    private(set) var appFull = true // the app fills the screen (no website open, or the app shown over it)
    var aspect: CGFloat = 0.75 // the camera picture's width / height
    private var right = true, bottom = false // the small window's corner
    private var dragging = false
    private lazy var drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))

    override func loadView() {
        view = UIView()
        view.backgroundColor = .black
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(app)
        view.addSubview(app.view)
        app.didMove(toParent: self)
        drag.delegate = self
        drag.isEnabled = false
        app.view.addGestureRecognizer(drag)
    }

    override var childForStatusBarStyle: UIViewController? { app }
    override var childForStatusBarHidden: UIViewController? { app }
    override var childForHomeIndicatorAutoHidden: UIViewController? { app }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { app.supportedInterfaceOrientations }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if !dragging { place() }
    }

    // The website: below the status bar, to the bottom of the screen.
    private func browserFrame() -> CGRect {
        let top = view.safeAreaInsets.top
        return CGRect(x: 0, y: top, width: view.bounds.width, height: view.bounds.height - top)
    }

    // The app's small window: about a tenth of the screen, in its corner.
    private func pipFrame() -> CGRect {
        let b = view.bounds, safe = view.safeAreaInsets, gap: CGFloat = 10
        let a = max(0.45, min(aspect, 2.2))
        let w = max(120, (b.width * b.height * 0.09 * a).squareRoot())
        let h = w / a
        let x = right ? b.width - safe.right - gap - w : safe.left + gap
        let y = bottom ? b.height - safe.bottom - gap - h : safe.top + gap
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private func place() {
        if let w = browser {
            w.frame = browserFrame()
            w.isHidden = appFull
        }
        let pip = browser != nil && !appFull
        app.view.frame = pip ? pipFrame() : view.bounds
        app.view.layer.cornerRadius = pip ? 12 : 0
        app.view.layer.borderWidth = pip ? 1 : 0
        app.view.layer.borderColor = UIColor(white: 1, alpha: 0.6).cgColor
        app.view.clipsToBounds = pip
        drag.isEnabled = pip
    }

    private func animate(_ seconds: TimeInterval = 0.25) {
        UIView.animate(withDuration: seconds, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut]) { self.place() }
    }

    // A website shown full screen, the app in its corner.
    func show(_ web: WKWebView) {
        if browser !== web {
            browser?.removeFromSuperview()
            browser = web
            view.insertSubview(web, belowSubview: app.view)
            web.frame = browserFrame()
        }
        appFull = false
        animate()
    }

    // The app full screen over the website (kept behind it), or back in its corner.
    func showApp(_ full: Bool) {
        appFull = full || browser == nil
        animate()
    }

    func closeBrowser() {
        browser?.removeFromSuperview()
        browser = nil
        appFull = true
        animate()
    }

    // The hand-mouse pointer (a share of the website's width and height): near the small
    // window, the window goes to the other side.
    func pointer(nx: CGFloat, ny: CGFloat) {
        guard let w = browser, !appFull, !dragging else { return }
        let p = CGPoint(x: w.frame.minX + nx * w.frame.width, y: w.frame.minY + ny * w.frame.height)
        if pipFrame().insetBy(dx: -24, dy: -24).contains(p) {
            right.toggle()
            animate(0.2)
        }
    }

    // Dragged with a finger: it goes to the corner nearest where it's let go.
    @objc private func dragged(_ g: UIPanGestureRecognizer) {
        let v: UIView = app.view
        switch g.state {
        case .began:
            dragging = true
        case .changed:
            let t = g.translation(in: view)
            v.center = CGPoint(x: v.center.x + t.x, y: v.center.y + t.y)
            g.setTranslation(.zero, in: view)
        default:
            dragging = false
            right = v.center.x > view.bounds.midX
            bottom = v.center.y > view.bounds.midY
            animate()
        }
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        return true
    }

    func layout() -> [String: Any] {
        let r = { (f: CGRect) -> [Double] in [f.minX, f.minY, f.width, f.height].map { Double($0) } }
        var out: [String: Any] = ["screen": [Double(view.bounds.width), Double(view.bounds.height)], "app": r(app.view.frame)]
        if let w = browser, !w.isHidden { out["browser"] = r(w.frame) } else { out["browser"] = NSNull() }
        return out
    }
}

@objc(HandBrowserPlugin)
public class HandBrowserPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate {
    public let identifier = "HandBrowserPlugin"
    public let jsName = "HandBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "back", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "layout", returnType: CAPPluginReturnPromise),
    ]

    private var web: WKWebView?
    private var script = ""
    private var lastError = ""

    private var host: HandTrackerHost? {
        return bridge?.viewController?.parent as? HandTrackerHost
    }

    private func state() -> [String: Any] {
        let app = host?.appFull ?? true
        guard let w = web else { return ["open": false, "app": true, "url": "", "title": "", "loading": false, "error": lastError] }
        return ["open": true, "app": app, "url": w.url?.absoluteString ?? "", "title": w.title ?? "", "loading": w.isLoading, "error": lastError]
    }

    private func tell() {
        notifyListeners("page", data: state())
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            call.reject("That isn't a web address (http:// or https://).")
            return
        }
        let aspect = call.getDouble("aspect") ?? 0
        if let s = call.getString("script"), !s.isEmpty { script = s }
        DispatchQueue.main.async {
            guard let host = self.host else {
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
                // A box the hand mouse clicks into brings up the keyboard, as a tap does.
                w.capacitor.setKeyboardShouldRequireUserInteraction(false)
                self.web = w
            }
            if let w = self.web {
                if aspect > 0 { host.aspect = CGFloat(aspect) }
                host.show(w)
                self.lastError = ""
                w.load(URLRequest(url: url))
            }
            call.resolve(self.state())
            self.tell()
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        let app = call.getBool("app") ?? false
        DispatchQueue.main.async {
            self.host?.showApp(app)
            call.resolve(self.state())
            self.tell()
        }
    }

    // The page pointer's methods, with their arguments as JSON (so nothing is pasted into code).
    @objc func call(_ call: CAPPluginCall) {
        let method = call.getString("method") ?? ""
        let allowed: Set<String> = ["pointer", "button", "wheel", "swipe", "key", "text", "where"]
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
            if method == "pointer", args.count >= 2, let nx = args[0] as? NSNumber, let ny = args[1] as? NSNumber {
                self.host?.pointer(nx: CGFloat(nx.doubleValue), ny: CGFloat(ny.doubleValue))
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
            self.host?.closeBrowser()
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

    @objc func layout(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.host else {
                call.reject("The app isn't ready yet.")
                return
            }
            call.resolve(host.layout())
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
