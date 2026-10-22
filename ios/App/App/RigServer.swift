// RigServer.swift: remote recording on the iPhone or iPad itself (as RigServerPlugin.java on
// Android, whose rules these are, from electron/remote-record.js): while it's on, another device
// (a computer's Hand Tracker, from its Remote recording page, or any browser) starts and stops
// motion capture with this device's camera, the same way as on a computer running Hand Tracker:
// the page (remote-client.html, from the app's own files), its state, a preview of the camera
// (bigger and more often full screen), and commands, which the page (remote-record-ui.js) carries
// out and answers. Over Tailscale no code is needed (only your own devices reach it there,
// encrypted); on the local network every request carries the key (shown in the app). Without the
// key, a request must be addressed to this device by an address or name of its own (not a
// website's name), and a command must be JSON from the page itself. iOS keeps an app's server
// only while the app is open: the screen stays on while remote recording is.
//
//   start({ key }) / stop() / status() / setKey({ key }) -> { on, port, addresses, urls, viewer }
//   setState({ state: json }); setPreview({ i, jpeg: base64 }); result({ id, result: json })
//   events: "command" { id, action, details?, settings? }, "wantPreviews" { on, focus }, "status"
//   bluetooth() -> { available, on, error, password: null | "set" }; setBluetoothPassword({ password })
//       over Bluetooth Low Energy too (RigBluetooth.swift), while it's on and a Bluetooth password
//       is set (8 to 63 characters; kept as its key only, in the Keychain); "bluetooth" events
//   secretGet({ key }) -> { value? }; secretSet({ key, value }): the Keychain (the key, kept)
//   linkTest({ password }) -> { info }; linkTestWrite({ device, frame, mtu }); "linkTestFrame"
//       events { frame }: the Bluetooth link with no Bluetooth, for the build's self-test only
//       (the app launched with -HTSelfTest: the simulator has no Bluetooth)

import Foundation
import Network
import Security
import UIKit
import Capacitor

@objc(RigServerPlugin)
public class RigServerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RigServerPlugin"
    public let jsName = "RigServer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "result", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bluetooth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBluetoothPassword", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "linkTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "linkTestWrite", returnType: CAPPluginReturnPromise),
    ]

    static let firstPort = 47821, portsTried = 10
    static let previewWanted: TimeInterval = 3, previewStale: TimeInterval = 5, focusTime: TimeInterval = 1.5
    static let nextWait: TimeInterval = 0.4 // a preview request waits this long for that camera's next picture
    static let viewerGone: TimeInterval = 10, answerTime: TimeInterval = 30
    static let headBytes = 16 * 1024, bodyBytes = 8192
    static let actions: Set<String> = ["cameras", "record", "stop", "close", "details", "camera", "scan", "pick", "mode", "settings", "sentry", "timing"]
    static let roles: Set<String> = ["", "head", "chest", "wrist_left", "wrist_right", "north", "south", "east", "west"]
    static let modes: Set<String> = ["ego", "stereo", "freeform"]
    static let csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; media-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'"
    static let jsonType = "application/json; charset=utf-8"

    private let queue = DispatchQueue(label: "hand-tracker.rig-server", attributes: .concurrent)
    private let lock = NSLock()
    private var listener: NWListener?
    private var port = 0
    private var wanted = false // started and not stopped: listening again when the app comes back
    private var key = ""
    private var stateJson = "{}"
    private var previews: [Int: (jpeg: Data, at: Date)] = [:]
    private var lastSent: [Int: Date] = [:]
    private var wantUntil = Date.distantPast, focusUntil = Date.distantPast
    private var wanting = false
    private var focus: Int?
    private final class Pending {
        let done = DispatchSemaphore(value: 0)
        var result: String?
    }
    private var pending: [Int: Pending] = [:]
    private var asked = 0
    private var viewerAddress: String?
    private var viewerSeen = Date.distantPast
    private var ticker: DispatchSourceTimer?
    private var hostName = "iPhone"
    private var bluetooth: RigBluetooth?
    private var btError = ""
    private var testLink: RigLinkProtocol?
    private var kept: [String: String] = [:] // (when the Keychain won't keep it: this session only)

    override public func load() {
        hostName = UIDevice.current.name
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    private func tell(_ event: String, _ data: [String: Any]) {
        DispatchQueue.main.async { self.notifyListeners(event, data: data) }
    }

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    // ---------- from the page ----------
    @objc func start(_ call: CAPPluginCall) {
        let k = call.getString("key") ?? ""
        guard Self.matches(k, "^[A-Za-z0-9_-]{8,64}$") else {
            call.reject("A key is needed.")
            return
        }
        queue.async {
            self.lock.lock()
            self.key = k
            self.wanted = true
            let running = self.listener != nil
            self.lock.unlock()
            if !running, let why = self.listen() {
                self.lock.lock()
                self.wanted = false
                self.lock.unlock()
                call.reject(why)
                return
            }
            self.startTicker()
            self.startBluetooth()
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }
            let st = self.status()
            self.tell("status", st)
            call.resolve(st)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.async {
            self.lock.lock()
            let l = self.listener
            self.listener = nil
            self.port = 0
            self.wanted = false
            self.previews.removeAll()
            self.viewerAddress = nil
            let t = self.ticker
            self.ticker = nil
            self.lock.unlock()
            l?.cancel()
            t?.cancel()
            self.stopBluetooth()
            self.setWanting(false)
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
            let st = self.status()
            self.tell("status", st)
            call.resolve(st)
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(status())
    }

    @objc func setKey(_ call: CAPPluginCall) {
        let k = call.getString("key") ?? ""
        guard Self.matches(k, "^[A-Za-z0-9_-]{8,64}$") else {
            call.reject("That isn't a key.")
            return
        }
        lock.lock()
        key = k
        viewerAddress = nil
        lock.unlock()
        let st = status()
        tell("status", st)
        call.resolve(st)
    }

    @objc func setState(_ call: CAPPluginCall) {
        let s = call.getString("state") ?? "{}"
        if s.utf8.count < 256 * 1024 {
            lock.lock()
            stateJson = s
            lock.unlock()
        }
        call.resolve()
    }

    @objc func setPreview(_ call: CAPPluginCall) {
        let i = call.getInt("i") ?? -1
        if i >= 0, i < 16, let b64 = call.getString("jpeg"), let jpeg = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !jpeg.isEmpty {
            lock.lock()
            previews[i] = (jpeg, Date())
            lock.unlock()
        }
        call.resolve()
    }

    @objc func result(_ call: CAPPluginCall) {
        let id = call.getInt("id") ?? -1
        lock.lock()
        let p = pending.removeValue(forKey: id)
        lock.unlock()
        if let p = p {
            p.result = call.getString("result") ?? "{}"
            p.done.signal()
        }
        call.resolve()
    }

    // ---------- the key, kept (the Keychain) ----------
    private static let keychainService = "com.handtracker.app.rig"

    private static func keychainGet(_ account: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private static func keychainSet(_ account: String, _ value: String) -> Bool {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private func secret(_ account: String) -> String? {
        if let v = Self.keychainGet(account) { return v }
        lock.lock()
        defer { lock.unlock() }
        return kept[account]
    }

    private func keep(_ account: String, _ value: String) {
        let ok = Self.keychainSet(account, value)
        lock.lock()
        kept[account] = ok ? nil : value
        lock.unlock()
    }

    @objc func secretGet(_ call: CAPPluginCall) {
        let k = call.getString("key") ?? ""
        guard Self.matches(k, "^[a-z0-9-]{1,40}$") else {
            call.reject("That isn't a name.")
            return
        }
        if let v = secret("page-" + k) { call.resolve(["value": v]) } else { call.resolve([:]) }
    }

    @objc func secretSet(_ call: CAPPluginCall) {
        let k = call.getString("key") ?? "", v = call.getString("value") ?? ""
        guard Self.matches(k, "^[a-z0-9-]{1,40}$"), v.utf8.count <= 4096 else {
            call.reject("That can't be kept.")
            return
        }
        keep("page-" + k, v)
        call.resolve()
    }

    // ---------- over Bluetooth Low Energy (RigBluetooth.swift) ----------
    private func btSecret() -> RigLinkProtocol.Secret? {
        guard let s = secret("bluetooth"), let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any],
              let salt = o["salt"] as? String, let iter = o["iter"] as? Int, let k = o["key"] as? String, let key = Data(base64Encoded: k) else { return nil }
        return RigLinkProtocol.Secret(salt: salt, iter: iter, key: key)
    }

    private func btStatus() -> [String: Any] {
        lock.lock()
        let on = bluetooth?.on ?? false, error = btError
        lock.unlock()
        return ["available": true, "on": on, "error": error, "password": secret("bluetooth") != nil ? "set" as Any : NSNull() as Any]
    }

    private func startBluetooth() {
        lock.lock()
        let running = listener != nil, already = bluetooth != nil
        lock.unlock()
        guard running, !already else { return }
        guard let secret = btSecret() else {
            lock.lock()
            btError = ""
            lock.unlock()
            tell("bluetooth", btStatus())
            return
        }
        let b = RigBluetooth(name: hostName, secret: secret, relay: { [weak self] m, p, body in
            self?.relay(m, p, body) ?? RigLinkProtocol.Answer(status: 502, type: RigServerPlugin.jsonType, body: Data())
        }, changed: { [weak self] _, error in
            guard let self = self else { return }
            self.lock.lock()
            self.btError = error
            self.lock.unlock()
            self.tell("bluetooth", self.btStatus())
        })
        lock.lock()
        bluetooth = b
        lock.unlock()
        b.start()
        tell("bluetooth", btStatus())
    }

    private func stopBluetooth() {
        lock.lock()
        let b = bluetooth
        bluetooth = nil
        lock.unlock()
        b?.stop()
        tell("bluetooth", btStatus())
    }

    @objc func bluetooth(_ call: CAPPluginCall) {
        call.resolve(btStatus())
    }

    @objc func setBluetoothPassword(_ call: CAPPluginCall) {
        let pw = call.getString("password") ?? ""
        guard pw.count >= 8, pw.count <= 63 else {
            call.reject("A Bluetooth password is 8 to 63 characters.")
            return
        }
        queue.async {
            let s = RigLinkProtocol.makeSecret(pw)
            let o: [String: Any] = ["salt": s.salt, "iter": s.iter, "key": s.key.base64EncodedString()]
            guard let d = try? JSONSerialization.data(withJSONObject: o), let text = String(data: d, encoding: .utf8) else {
                call.reject("Couldn't keep it.")
                return
            }
            self.keep("bluetooth", text)
            self.stopBluetooth()
            self.startBluetooth()
            call.resolve(self.btStatus())
        }
    }

    // One request over Bluetooth, to this server as from a device it trusts (the password was the proof).
    private func relay(_ method: String, _ pathAndQuery: String, _ body: Data) -> RigLinkProtocol.Answer {
        var r = Request()
        r.method = method
        if let q = pathAndQuery.firstIndex(of: "?") {
            r.path = String(pathAndQuery[..<q])
            r.query = String(pathAndQuery[pathAndQuery.index(after: q)...])
        } else {
            r.path = pathAndQuery
        }
        r.headers["host"] = "localhost"
        if method == "POST" { r.headers["content-type"] = "application/json" }
        r.body = body
        r.local = "127.0.0.1"
        r.remote = "Bluetooth"
        r.relayed = true
        let a = handle(r)
        return RigLinkProtocol.Answer(status: a.code, type: a.type, body: a.body)
    }

    // ---------- the self-test's Bluetooth link, with no Bluetooth ----------
    private var selfTest: Bool { ProcessInfo.processInfo.arguments.contains("-HTSelfTest") }

    @objc func linkTest(_ call: CAPPluginCall) {
        guard selfTest else {
            call.reject("Only for the build's self-test.")
            return
        }
        let pw = call.getString("password") ?? ""
        queue.async {
            let link = RigLinkProtocol(name: self.hostName, secret: RigLinkProtocol.makeSecret(pw), relay: { [weak self] m, p, body in
                self?.relay(m, p, body) ?? RigLinkProtocol.Answer(status: 502, type: RigServerPlugin.jsonType, body: Data())
            }, send: { [weak self] frame in
                self?.tell("linkTestFrame", ["frame": frame.base64EncodedString()])
            })
            self.lock.lock()
            self.testLink = link
            self.lock.unlock()
            call.resolve(["info": link.info().base64EncodedString()])
        }
    }

    @objc func linkTestWrite(_ call: CAPPluginCall) {
        lock.lock()
        let link = testLink
        lock.unlock()
        guard selfTest, let link = link, let frame = Data(base64Encoded: call.getString("frame") ?? "") else {
            call.reject("No link test.")
            return
        }
        let device = call.getString("device") ?? "test", mtu = call.getInt("mtu") ?? 23
        queue.async { link.received(device: device, frame: frame, mtu: mtu) }
        call.resolve()
    }

    // ---------- listening ----------
    // On the first free port from 47821: nil, or why not.
    private func listen() -> String? {
        var last = ""
        for p in Self.firstPort..<(Self.firstPort + Self.portsTried) {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            guard let nwPort = NWEndpoint.Port(rawValue: UInt16(p)), let l = try? NWListener(using: params, on: nwPort) else { continue }
            let ready = DispatchSemaphore(value: 0)
            var ok = false
            l.stateUpdateHandler = { st in
                switch st {
                case .ready:
                    ok = true
                    ready.signal()
                case .failed(let e):
                    last = e.localizedDescription
                    ready.signal()
                default:
                    break
                }
            }
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.start(queue: queue)
            _ = ready.wait(timeout: .now() + 3)
            if ok {
                l.stateUpdateHandler = { [weak self, weak l] st in
                    if case .failed = st, let l = l { self?.lost(l) }
                }
                lock.lock()
                listener = l
                port = p
                lock.unlock()
                return nil
            }
            l.cancel()
        }
        return "No free port for remote recording" + (last.isEmpty ? "" : " (\(last))") + "."
    }

    // iOS took it away (the app was away): listening again once the app is back.
    private func lost(_ l: NWListener) {
        lock.lock()
        let mine = listener === l
        if mine {
            listener = nil
            port = 0
        }
        lock.unlock()
        l.cancel()
        if mine { tell("status", status()) }
    }

    @objc private func becameActive() {
        queue.async {
            self.lock.lock()
            let again = self.wanted && self.listener == nil
            self.lock.unlock()
            if again, self.listen() == nil {
                self.startBluetooth()
                self.tell("status", self.status())
            }
        }
    }

    private func startTicker() {
        lock.lock()
        defer { lock.unlock() }
        guard ticker == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        ticker = t
    }

    private func tick() {
        let now = Date()
        lock.lock()
        let unfocus = focus != nil && now > focusUntil
        let unwant = wanting && now > wantUntil
        let viewerLeft = viewerAddress != nil && now.timeIntervalSince(viewerSeen) > Self.viewerGone
        if viewerLeft { viewerAddress = nil }
        lock.unlock()
        if unfocus { setFocus(nil) }
        if unwant { setWanting(false) }
        if viewerLeft { tell("status", status()) }
    }

    private func setFocus(_ i: Int?) {
        lock.lock()
        if i == focus {
            lock.unlock()
            return
        }
        focus = i
        // Newly full screen: its next picture is the bigger one (not the small one already here).
        if let i = i { lastSent[i] = Date() }
        let w = wanting
        lock.unlock()
        if w { wantEvent() }
    }

    private func setWanting(_ on: Bool) {
        lock.lock()
        if wanting == on {
            lock.unlock()
            return
        }
        wanting = on
        lock.unlock()
        wantEvent()
    }

    private func wantEvent() {
        lock.lock()
        let w = wanting, f = focus
        lock.unlock()
        tell("wantPreviews", ["on": w, "focus": w && f != nil ? f! as Any : NSNull() as Any])
    }

    // ---------- status ----------
    static func isTailscale(_ a: String) -> Bool {
        let p = a.replacingOccurrences(of: "::ffff:", with: "").split(separator: ".")
        guard p.count == 4, let x = Int(p[0]), let y = Int(p[1]) else { return false }
        return x == 100 && y >= 64 && y <= 127
    }

    private static func isPrivate(_ a: String) -> Bool {
        let p = a.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return false }
        return p[0] == 10 || (p[0] == 172 && p[1] >= 16 && p[1] <= 31) || (p[0] == 192 && p[1] == 168)
    }

    // This device's addresses another device could use: (address, kind), Tailscale's last.
    static func addresses() -> [(String, String)] {
        var out: [(String, String)] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return out }
        defer { freeifaddrs(ifaddr) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = p.pointee
            let flags = Int32(ifa.ifa_flags)
            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET), flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host), name = String(cString: ifa.ifa_name)
            if ip.hasPrefix("169.254.") || out.contains(where: { $0.0 == ip }) { continue }
            let kind = isTailscale(ip) ? "Tailscale" : name == "en0" ? "Wi-Fi" : isPrivate(ip) ? "local network" : nil
            if let kind = kind { out.append((ip, kind)) }
        }
        return out.filter { $0.1 != "Tailscale" } + out.filter { $0.1 == "Tailscale" }
    }

    private func status() -> [String: Any] {
        lock.lock()
        let on = listener != nil, p = port, k = key, viewer = viewerAddress, seen = viewerSeen
        lock.unlock()
        var list: [[String: Any]] = [], urls: [[String: Any]] = []
        if on {
            for (address, kind) in Self.addresses() {
                list.append(["address": address, "kind": kind])
                let keyed = kind != "Tailscale"
                urls.append(["kind": kind, "url": "http://\(address):\(p)/" + (keyed ? "#k=\(k)" : ""), "keyed": keyed])
            }
        }
        var st: [String: Any] = ["on": on, "port": on ? p as Any : NSNull() as Any, "addresses": list, "urls": urls]
        if let v = viewer, Date().timeIntervalSince(seen) < Self.viewerGone {
            st["viewer"] = ["address": v, "seen": Int(seen.timeIntervalSince1970 * 1000)]
        } else {
            st["viewer"] = NSNull()
        }
        return st
    }

    // ---------- requests ----------
    private struct Request {
        var method = "", path = "", query = ""
        var headers: [String: String] = [:]
        var body = Data()
        var local = "", remote = ""
        var relayed = false // over Bluetooth (RigBluetooth): its password was the proof
    }

    private struct Response {
        let code: Int
        let type: String
        let body: Data
        var csp: String? = nil
    }

    private static func json(_ code: Int, _ o: [String: Any]) -> Response {
        Response(code: code, type: jsonType, body: (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8))
    }

    private static func error(_ code: Int, _ message: String) -> Response {
        json(code, ["error": message])
    }

    private static func http(_ r: Response) -> Data {
        let reasons = [200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 413: "Too Large"]
        var h = "HTTP/1.1 \(r.code) \(reasons[r.code] ?? "Error")\r\nContent-Type: \(r.type)\r\nContent-Length: \(r.body.count)\r\n"
            + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n"
        if let csp = r.csp { h += "Content-Security-Policy: \(csp)\r\n" }
        h += "\r\n"
        var d = Data(h.utf8)
        d.append(r.body)
        return d
    }

    private static func address(_ e: NWEndpoint?) -> String {
        guard let e = e, case let .hostPort(host, _) = e else { return "" }
        var s: String
        switch host {
        case .ipv4(let a): s = "\(a)"
        case .ipv6(let a): s = "\(a)"
        case .name(let n, _): s = n
        @unknown default: s = "\(host)"
        }
        if let i = s.firstIndex(of: "%") { s = String(s[..<i]) }
        return s
    }

    private static func headEnd(_ b: Data) -> Int? {
        let bytes = [UInt8](b)
        guard bytes.count >= 4 else { return nil }
        for i in 3..<bytes.count where bytes[i - 3] == 13 && bytes[i - 2] == 10 && bytes[i - 1] == 13 && bytes[i] == 10 { return i + 1 }
        return nil
    }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        read(c, Data())
        // (A request's answer takes 30 s at most: a command's.)
        queue.asyncAfter(deadline: .now() + 45) { c.cancel() }
    }

    private func read(_ c: NWConnection, _ got: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self = self else {
                c.cancel()
                return
            }
            var buf = got
            if let data = data { buf.append(data) }
            guard let end = Self.headEnd(buf) else {
                if buf.count >= Self.headBytes || complete || error != nil { c.cancel() } else { self.read(c, buf) }
                return
            }
            let head = String(data: buf.subdata(in: 0..<end), encoding: .isoLatin1) ?? ""
            let lines = head.components(separatedBy: "\r\n")
            let first = lines[0].split(separator: " ")
            guard first.count >= 3 else {
                c.cancel()
                return
            }
            var r = Request()
            r.method = String(first[0])
            let target = String(first[1])
            if let q = target.firstIndex(of: "?") {
                r.path = String(target[..<q])
                r.query = String(target[target.index(after: q)...])
            } else {
                r.path = target
            }
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":"), colon > line.startIndex else { continue }
                r.headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            guard let want = Int(r.headers["content-length"] ?? "0"), want >= 0 else {
                c.cancel()
                return
            }
            let have = buf.count - end
            if want <= Self.bodyBytes && have < want {
                if complete || error != nil { c.cancel() } else { self.read(c, buf) }
                return
            }
            r.body = want > Self.bodyBytes ? Data(count: Self.bodyBytes + 1) : buf.subdata(in: end..<(end + want))
            r.local = Self.address(c.currentPath?.localEndpoint)
            r.remote = Self.address(c.endpoint)
            let answer = Self.http(self.handle(r))
            c.send(content: answer, completion: .contentProcessed { _ in c.cancel() })
        }
    }

    private func asset(_ name: String) -> Data? {
        let dot = name.lastIndex(of: ".")!
        guard let url = Bundle.main.url(forResource: "public/" + String(name[..<dot]), withExtension: String(name[name.index(after: dot)...])) else { return nil }
        return try? Data(contentsOf: url)
    }

    // The names this device goes by: its addresses, "localhost", a bare name (as Tailscale's short
    // names are) or a Tailscale name (….ts.net). A website's own name is none of these.
    private static func ownHost(_ hostHeader: String?) -> Bool {
        var host = (hostHeader ?? "").lowercased()
        host = host.replacingOccurrences(of: ":\\d+$", with: "", options: .regularExpression)
        host = host.replacingOccurrences(of: "^\\[|\\]$", with: "", options: .regularExpression)
        if host.isEmpty { return false }
        if host == "localhost" || host.hasSuffix(".ts.net") || matches(host, "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$") { return true }
        if addresses().contains(where: { $0.0 == host }) { return true }
        return host == "127.0.0.1"
    }

    private func authorized(_ r: Request) -> Bool {
        if r.relayed { return true }
        if Self.isTailscale(r.local) && Self.isTailscale(r.remote) && Self.ownHost(r.headers["host"]) { return true }
        lock.lock()
        let k = Array(key.utf8)
        lock.unlock()
        let given = Array((r.headers["x-key"] ?? "").utf8)
        guard !k.isEmpty, given.count == k.count else { return false }
        return zip(given, k).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }

    private static func param(_ query: String, _ name: String) -> String? {
        for part in query.split(separator: "&", omittingEmptySubsequences: false) {
            let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            if kv[0] == name {
                return kv.count > 1 ? (String(kv[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "") : ""
            }
        }
        return nil
    }

    // JSON's true and false (not 1 and 0), and its whole numbers (not true or false).
    private static func isBool(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    private static func bool(_ v: Any?) -> Bool? {
        isBool(v) ? (v as! NSNumber).boolValue : nil
    }

    private static func int(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber, !isBool(n) else { return nil }
        let d = n.doubleValue
        return d == d.rounded() && abs(d) < 1e9 ? Int(d) : nil
    }

    private static func clean(_ v: Any?, _ max: Int) -> String {
        var s = v is NSNull || v == nil ? "" : (v as? String) ?? (v as? NSNumber).map { "\($0)" } ?? ""
        s = s.replacingOccurrences(of: "[\\u0000-\\u001f\\u007f]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return String(s.prefix(max))
    }

    private func handle(_ r: Request) -> Response {
        if r.method == "GET" && (r.path == "/" || r.path == "/index.html") {
            guard let page = asset("remote-client.html") else { return Self.error(404, "Not found") }
            return Response(code: 200, type: "text/html; charset=utf-8", body: page, csp: Self.csp)
        }
        if r.method == "GET" && (r.path == "/remote-client.js" || r.path == "/bt-link-client.js") {
            guard let js = asset(String(r.path.dropFirst())) else { return Self.error(404, "Not found") }
            return Response(code: 200, type: "text/javascript; charset=utf-8", body: js)
        }
        if !r.path.hasPrefix("/api/") { return Self.error(404, "Not found") }
        if !authorized(r) { return Self.error(401, "This page's key isn't the one Hand Tracker shows now.") }
        lock.lock()
        let newViewer = viewerAddress != r.remote
        viewerAddress = r.remote
        viewerSeen = Date()
        lock.unlock()
        if newViewer { tell("status", status()) }

        if r.method == "GET" && r.path == "/api/state" {
            lock.lock()
            let s = stateJson
            lock.unlock()
            var st = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
            st["host"] = hostName
            st["wifi"] = NSNull()
            return Self.json(200, st)
        }
        if r.method == "GET" && r.path == "/api/preview" {
            let i = Int(Self.param(r.query, "i") ?? "") ?? -1
            let full = Self.param(r.query, "full") == "1" && i >= 0 && i < 16
            lock.lock()
            wantUntil = Date().addingTimeInterval(Self.previewWanted)
            if full { focusUntil = Date().addingTimeInterval(Self.focusTime) }
            lock.unlock()
            if full { setFocus(i) }
            setWanting(true)
            // Each request waits for that camera's next picture (the page asks again as soon as it
            // has one, and gets each picture once).
            lock.lock()
            let since = lastSent[i] ?? Date.distantPast
            lock.unlock()
            var t: TimeInterval = 0
            while t < Self.nextWait {
                lock.lock()
                let newer = (previews[i]?.at ?? Date.distantPast) > since
                lock.unlock()
                if newer { break }
                Thread.sleep(forTimeInterval: 0.015)
                t += 0.015
            }
            lock.lock()
            let p = previews[i]
            if let p = p { lastSent[i] = p.at }
            lock.unlock()
            guard let pic = p, Date().timeIntervalSince(pic.at) <= Self.previewStale else { return Response(code: 204, type: Self.jsonType, body: Data()) }
            return Response(code: 200, type: "image/jpeg", body: pic.jpeg)
        }
        if r.method == "POST" && r.path == "/api/command" {
            return command(r)
        }
        return Self.error(404, "Not found")
    }

    private func command(_ r: Request) -> Response {
        // From the page itself: JSON, and (if the browser says where from) this address.
        let origin = r.headers["origin"]
        if !(r.headers["content-type"] ?? "").lowercased().hasPrefix("application/json") || (origin != nil && origin != "http://" + (r.headers["host"] ?? "")) {
            return Self.error(403, "Only Hand Tracker's own page can do that.")
        }
        if r.body.count > Self.bodyBytes { return Self.error(413, "Too long") }
        guard let msg = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any] else { return Self.error(400, "Not JSON") }
        let action = msg["action"] as? String ?? ""
        guard Self.actions.contains(action) else { return Self.error(400, "Unknown action: \(action)") }
        lock.lock()
        asked += 1
        let id = asked
        lock.unlock()
        var cmd: [String: Any] = ["id": id, "action": action]
        if let d = msg["details"] as? [String: Any] {
            var details: [String: Any] = [:]
            for k in ["contributor", "location", "task"] { details[k] = Self.clean(d[k], 200) }
            cmd["details"] = details
        }
        // Settings: whether the take details are needed, and each camera's video (and its sound)
        // with the take, as booleans; the video's quality, one of camera-video.js's.
        if let st = msg["settings"] as? [String: Any] {
            var settings: [String: Any] = [:]
            for k in ["detailsRequired", "video", "sound"] { if let b = Self.bool(st[k]) { settings[k] = b } }
            if let q = st["videoQuality"] as? String, Self.matches(q, "^(low|standard|high|best)$") { settings["videoQuality"] = q }
            if !settings.isEmpty { cmd["settings"] = settings }
        }
        // Sentry mode (sentry.js): checked as the computer checks it (cleanSentry in electron/remote-record.js).
        if let sentry = Self.cleanSentry(msg["sentry"] as? [String: Any]) { cmd["sentry"] = sentry }
        // The cameras to start (picked, with a role), the mode, and a running camera's role, turn
        // and flip: checked as the computer checks them (electron/remote-record.js).
        if let pk = msg["pick"] as? [String: Any], let pid = pk["id"] as? String, Self.matches(pid, "^[A-Za-z0-9:._+/=-]{1,200}$") {
            var pick: [String: Any] = ["id": pid]
            if let u = Self.bool(pk["use"]) { pick["use"] = u }
            if let t = Self.bool(pk["tracking"]) { pick["tracking"] = t }
            if let role = pk["role"] as? String, Self.roles.contains(role) { pick["role"] = role }
            cmd["pick"] = pick
        }
        if let mode = msg["mode"] as? String, Self.modes.contains(mode) { cmd["mode"] = mode }
        if let cm = msg["camera"] as? [String: Any], let index = Self.int(cm["index"]), index >= 0, index <= 3 {
            var camera: [String: Any] = ["index": index]
            if let role = cm["role"] as? String, Self.roles.contains(role) { camera["role"] = role }
            if let rot = Self.int(cm["rotation"]), [0, 90, 180, 270].contains(rot) { camera["rotation"] = rot }
            if let m = Self.bool(cm["mirror"]) { camera["mirror"] = m }
            cmd["camera"] = camera
        }
        let missingPart: String? = action == "pick" && cmd["pick"] == nil ? "Which camera?"
            : action == "camera" && cmd["camera"] == nil ? "Which camera?"
            : action == "mode" && cmd["mode"] == nil ? "Which mode?"
            : action == "settings" && cmd["settings"] == nil ? "Which setting?"
            : action == "sentry" && cmd["sentry"] == nil ? "Which Sentry setting?" : nil
        if let m = missingPart { return Self.error(400, m) }
        let p = Pending()
        lock.lock()
        pending[id] = p
        lock.unlock()
        tell("command", cmd)
        var result = "{\"ok\":false,\"message\":\"Hand Tracker didn't answer.\"}"
        if p.done.wait(timeout: .now() + Self.answerTime) == .success, let r = p.result {
            result = r
        } else {
            lock.lock()
            pending[id] = nil
            lock.unlock()
        }
        // Only what the page needs: ok, message, the take details still missing, locked.
        let a = (try? JSONSerialization.jsonObject(with: Data(result.utf8))) as? [String: Any] ?? [:]
        var o: [String: Any] = ["ok": Self.bool(a["ok"]) ?? true, "message": Self.clean(a["message"], 500)]
        if let missing = a["missing"] as? [Any] {
            o["missing"] = missing.compactMap { $0 as? String }.filter { ["contributor", "location", "task"].contains($0) }
        }
        if Self.bool(a["locked"]) == true { o["locked"] = true }
        return Self.json(200, o)
    }

    // Sentry mode from the page: shown or not, on or off, its settings, a box of a running camera
    // left out or watched again, or every box watched; ntfy's server (a web address), a new topic
    // or a test; alerts deleted (by their ids) or all of Sentry's files. Only those, each checked;
    // nil if there's nothing.
    static func cleanSentry(_ s: [String: Any]?) -> [String: Any]? {
        guard let s = s else { return nil }
        var out: [String: Any] = [:]
        for k in ["shown", "armed", "ignoreAnimals", "handTracking", "photo", "video", "sound"] { if let b = bool(s[k]) { out[k] = b } }
        if let r = int(s["rows"]), r >= 1, r <= 9 { out["rows"] = r }
        if let c = int(s["cols"]), c >= 1, c <= 16 { out["cols"] = c }
        if let sens = s["sensitivity"] as? String, ["low", "medium", "high"].contains(sens) { out["sensitivity"] = sens }
        if let n = s["ntfy"] as? [String: Any] {
            var ntfy: [String: Any] = [:]
            for k in ["on", "photo"] { if let b = bool(n[k]) { ntfy[k] = b } }
            for k in ["newTopic", "test"] where bool(n[k]) == true { ntfy[k] = true }
            if let server = n["server"] as? String, server.count <= 200 {
                let t = server.trimmingCharacters(in: .whitespaces)
                if t.range(of: "^https?://[^\\s/?#]+(/[^\\s?#]*)?$", options: [.regularExpression, .caseInsensitive]) != nil { ntfy["server"] = t }
            }
            if !ntfy.isEmpty { out["ntfy"] = ntfy }
        }
        if let b = s["box"] as? [String: Any], let cam = int(b["camera"]), let cell = int(b["cell"]), let off = bool(b["off"]),
           cam >= 0, cam < 16, cell >= 0, cell < 9 * 16 {
            out["box"] = ["camera": cam, "cell": cell, "off": off]
        }
        if bool(s["watchAll"]) == true { out["watchAll"] = true }
        // Alerts deleted, with their photos and videos; or every Sentry photo and video.
        if let ids = s["deleteAlerts"] as? [Any], ids.count >= 1, ids.count <= 50 {
            let kept = ids.compactMap { $0 as? String }.filter { matches($0, "^[0-9]{1,15}-[a-z0-9]{1,8}$") }
            if kept.count == ids.count { out["deleteAlerts"] = kept }
        }
        if bool(s["deleteAll"]) == true { out["deleteAll"] = true }
        return out.isEmpty ? nil : out
    }
}
