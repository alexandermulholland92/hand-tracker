// RemoteLink.swift: the iPhone and iPad app reaching remote recording on another computer (the
// page remote-client.js, shown in the app as remote-client.html?rig=… or ?bt=…, from remote.html).
//
//   RigLink: rigRequest({ rig: "pi:47821", path, method, body, key }) -> { status, type, body (base64) }
//     one of the page's requests, as plain HTTP straight over TCP (the Network framework: App
//     Transport Security, which keeps a page and URLSession off http://pi:47821, doesn't apply),
//     only remote recording's own paths: the same rules as RemotePlugin.java and remote-record.js
//     (scripts/check-android.js checks they match).
//   BtLink: Bluetooth Low Energy (CoreBluetooth), what bt-link-client.js's capacitorBluetooth()
//     uses (the same as BtLinkPlugin.java on Android):
//       scan({ service, ms }) -> { devices: [{ id, name }] }   devices near by offering the service
//       connect({ id }) -> { mtu }; read({ id, characteristic }) -> { value } (base64)
//       write({ id, characteristic, value }) (with a response); notify({ id, characteristic })
//       disconnect({ id }); events "notification" { id, characteristic, value }, "disconnected" { id }
//     One device at a time; each step waits for the one before.
//   Cluster: Cluster's own app reaching the Pis running Cluster's service (ClusterPlugin, below).
//   ClusterCall: Cluster Call's own app, its calls (ClusterCallPlugin, at the end).

import Foundation
import Network
import CoreBluetooth
import UIKit
import Capacitor

// ---------- remote recording over the network ----------
@objc(RigLinkPlugin)
public class RigLinkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RigLinkPlugin"
    public let jsName = "RigLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "rigRequest", returnType: CAPPluginReturnPromise),
    ]

    static let RIG = "^(\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*):(\\d{1,5})$"
    static let RIG_PATH = "^/api/(state|command|imu(\\?name=[A-Za-z0-9%._-]{1,60})?|wifi|takes|history\\?span=(1h|24h|7d)(&after=\\d{1,15})?|preview\\?i=[0-3](&full=1)?(&after=\\d{1,12})?|video\\?i=[0-3]&after=\\d{1,12}|take\\?f=[A-Za-z0-9%._~!*'()-]{1,800}&at=\\d{1,12}|listen(\\?after=\\d{1,12})?|talk)$"
    static let RIG_KEY = "^[A-Za-z0-9_-]{8,64}$"
    static let maxBytes = 4 * 1024 * 1024
    private let queue = DispatchQueue(label: "hand-tracker.rig-link")

    static func groups(_ pattern: String, _ text: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: text).map { String(text[$0]) } ?? "" }
    }

    @objc func rigRequest(_ call: CAPPluginCall) {
        let rig = call.getString("rig") ?? "", path = call.getString("path") ?? "", method = call.getString("method") ?? "GET"
        let body = call.getString("body") ?? "", key = call.getString("key") ?? ""
        guard let g = Self.groups(Self.RIG, rig), let port = Int(g[5]), port >= 1, port <= 65535 else {
            call.reject("That isn't a computer's name and port.")
            return
        }
        let post = method == "POST"
        guard Self.groups(Self.RIG_PATH, path) != nil, post || method == "GET", post == (path == "/api/command" || path == "/api/talk" || path.hasPrefix("/api/imu")) else {
            call.reject("Not a remote recording request.")
            return
        }
        guard body.utf8.count <= 8192 else {
            call.reject("Too long.")
            return
        }
        var head = "\(method) \(path) HTTP/1.1\r\nHost: \(g[1]):\(port)\r\nConnection: close\r\n"
        if Self.groups(Self.RIG_KEY, key) != nil { head += "X-Key: \(key)\r\n" }
        let b = Data(body.utf8)
        if post { head += "Content-Type: application/json\r\nContent-Length: \(b.count)\r\n" }
        head += "\r\n"
        var request = Data(head.utf8)
        if post { request.append(b) }
        let host = g[1].trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        // connectMs: how long to wait for it to answer at all (the local network's way, when the
        // phone may be somewhere else: given up on soon, for Tailscale's).
        let connectMs = max(500, min(10000, call.getInt("connectMs") ?? 10000))
        RigExchange(host: host, port: UInt16(port), request: request, queue: queue).run(connectMs: connectMs) { result in
            switch result {
            case .success(let a):
                call.resolve(["status": a.status, "type": a.type, "body": a.body.base64EncodedString()])
            case .failure(let e):
                call.reject(e.message)
            }
        }
    }
}

struct RigError: Error {
    let message: String
}

struct RigAnswer {
    let status: Int
    let type: String
    let body: Data
}

// One request and its answer over a TCP connection of its own (the computer closes it).
final class RigExchange {
    private let conn: NWConnection
    private let request: Data
    private let queue: DispatchQueue
    private var received = Data()
    private var connected = false
    private var done: ((Result<RigAnswer, RigError>) -> Void)?
    private let maxBytes: Int
    private let seconds: Int

    // (maxBytes and seconds: remote recording’s 4 MB and 10 s unless said; Cluster’s pieces are bigger and slower)
    init(host: String, port: UInt16, request: Data, queue: DispatchQueue, maxBytes: Int = RigLinkPlugin.maxBytes, seconds: Int = 10) {
        conn = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? 47821, using: .tcp)
        self.request = request
        self.queue = queue
        self.maxBytes = maxBytes
        self.seconds = seconds
    }

    func run(connectMs: Int = 10000, _ finish: @escaping (Result<RigAnswer, RigError>) -> Void) {
        done = finish
        conn.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                connected = true
                conn.send(content: request, completion: .contentProcessed { [self] err in
                    if let err = err { end(.failure(RigError(message: "Can't reach it: \(err.localizedDescription)"))) } else { receive() }
                })
            case .waiting(let err), .failed(let err):
                end(.failure(RigError(message: "Can't reach it: \(err.localizedDescription)")))
            default:
                break
            }
        }
        conn.start(queue: queue)
        if connectMs < 10000 {
            queue.asyncAfter(deadline: .now() + .milliseconds(connectMs)) { [self] in
                if !connected { end(.failure(RigError(message: "Can't reach it."))) }
            }
        }
        queue.asyncAfter(deadline: .now() + .seconds(seconds)) { [self] in end(.failure(RigError(message: "No answer."))) }
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] chunk, _, complete, err in
            if let chunk = chunk { received.append(chunk) }
            if received.count > maxBytes { return end(.failure(RigError(message: "The answer was too big"))) }
            if complete || err != nil { end(parse()) } else { receive() }
        }
    }

    private func end(_ result: Result<RigAnswer, RigError>) {
        guard let finish = done else { return }
        done = nil
        conn.stateUpdateHandler = nil
        conn.cancel()
        finish(result)
    }

    private func parse() -> Result<RigAnswer, RigError> {
        let all = received
        guard let split = all.range(of: Data("\r\n\r\n".utf8)) else { return .failure(RigError(message: "Not an answer from Hand Tracker.")) }
        let lines = String(decoding: all[all.startIndex..<split.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let first = lines.first?.split(separator: " ") ?? []
        guard first.count >= 2, first[0].hasPrefix("HTTP/"), let status = Int(first[1]) else { return .failure(RigError(message: "Not an answer from Hand Tracker.")) }
        var type = "", length = -1, chunked = false
        for line in lines.dropFirst() {
            guard let c = line.firstIndex(of: ":") else { continue }
            let name = line[..<c].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: c)...].trimmingCharacters(in: .whitespaces)
            if name == "content-type" { type = value }
            else if name == "content-length" { length = Int(value) ?? -1 }
            else if name == "transfer-encoding" { chunked = value.lowercased().contains("chunked") }
        }
        var rest = Data(all[split.upperBound...])
        if chunked {
            guard let d = dechunk(rest) else { return .failure(RigError(message: "A broken answer from Hand Tracker.")) }
            rest = d
        } else if length >= 0 && length < rest.count {
            rest = rest.prefix(length)
        }
        return .success(RigAnswer(status: status, type: type, body: rest))
    }

    private func dechunk(_ data: Data) -> Data? {
        var out = Data()
        var at = data.startIndex
        while true {
            guard let eol = data[at...].range(of: Data("\r\n".utf8)) else { return nil }
            let size = String(decoding: data[at..<eol.lowerBound], as: UTF8.self).split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            guard let n = Int(size, radix: 16) else { return nil }
            if n == 0 { return out }
            let start = eol.upperBound
            guard data.distance(from: start, to: data.endIndex) >= n else { return nil }
            let end = data.index(start, offsetBy: n)
            out.append(data[start..<end])
            at = data.index(end, offsetBy: 2, limitedBy: data.endIndex) ?? data.endIndex
        }
    }
}

// ---------- Cluster: the Pis running Cluster's service ----------
// ClusterPlugin, for Cluster's own app (cluster.js; the same as ClusterPlugin.java on Android):
//   request({ target: "pi" | "100.x.y.z" | "host:port", method, path, body?, data? (base64), timeoutMs?, to? })
//     to: a phone of the cluster (its Tailscale address), asked through the Pi that's target
//     -> { status, type, body (text, for JSON), data (base64, for anything else) }
//     plain HTTP over TCP to the service (port 47830), with its own header, only to its /api/ paths
//   save({ target, path, name, size }) -> { saved }
//     a file from a Pi (a job's results as one zip) fetched a piece at a time (path&at=…) into the
//     app's Documents (the Files app: On My iPhone › Cluster); "progress" { name, got, size }
@objc(ClusterPlugin)
public class ClusterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ClusterPlugin"
    public let jsName = "Cluster"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installedApps", returnType: CAPPluginReturnPromise),
    ]

    // Which of the project's apps are on this iPhone: each answers to its own link name (handtracker-<kind>: scripts/
    // ios-variant.js), which iOS lets Cluster ask about (its LSApplicationQueriesSchemes). -> { apps: { kind: true|false } }
    @objc func installedApps(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var apps: [String: Bool] = [:]
            for kind in ["full", "mouse", "remote", "converter", "cluster", "clustercall"] {
                if let url = URL(string: "handtracker-\(kind)://") { apps[kind] = UIApplication.shared.canOpenURL(url) }
            }
            call.resolve(["apps": apps])
        }
    }

    static let PORT = 47830
    static let TARGET = "^(\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)(:(\\d{1,5}))?$"
    static let PATH = "^/api/[A-Za-z0-9/_.-]{1,80}(\\?[A-Za-z0-9%._~!*'()=&+-]{0,4000})?$"
    static let NAME = "^[^/\\\\\\x00-\\x1f]{1,200}\\.zip$"
    private let queue = DispatchQueue(label: "hand-tracker.cluster")

    // A phone of the cluster, asked through the Pi that's the target (X-HT-Cluster-To; only the Pis have each phone's
    // key): its Tailscale address (the build's simulator check: the simulated phone beside it, 127.0.0.1:port).
    static let TO = "^100\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$"
    static let TO_TEST = "^127\\.0\\.0\\.1:\\d{1,5}$"

    // One request to a Pi's service: its answer, or why not.
    func exchange(_ target: String, _ method: String, _ path: String, _ payload: Data?, _ type: String?, seconds: Int, to: String? = nil,
                  _ finish: @escaping (Result<RigAnswer, RigError>) -> Void) {
        guard let g = RigLinkPlugin.groups(Self.TARGET, target) else { return finish(.failure(RigError(message: "That isn't a device's name."))) }
        let port = Int(g[6]) ?? Self.PORT
        guard port >= 1, port <= 65535, ["GET", "POST", "PUT"].contains(method), RigLinkPlugin.groups(Self.PATH, path) != nil else {
            return finish(.failure(RigError(message: "Not one of the service's requests.")))
        }
        if let t = to, RigLinkPlugin.groups(Self.TO, t) == nil,
           !(ProcessInfo.processInfo.arguments.contains("-HTSelfTest") && RigLinkPlugin.groups(Self.TO_TEST, t) != nil) {
            return finish(.failure(RigError(message: "That isn't a phone of the cluster.")))
        }
        var head = "\(method) \(path) HTTP/1.1\r\nHost: \(g[1]):\(port)\r\nX-HT-Cluster: 1\r\nConnection: close\r\n"
        if let t = to { head += "X-HT-Cluster-To: \(t)\r\n" }
        if let p = payload, let t = type {
            head += "Content-Type: \(t)\r\nContent-Length: \(p.count)\r\n"
        } else if method != "GET" {
            head += "Content-Length: 0\r\n"
        }
        head += "\r\n"
        var request = Data(head.utf8)
        if let p = payload { request.append(p) }
        let host = g[1].trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        RigExchange(host: host, port: UInt16(port), request: request, queue: queue, maxBytes: 8 * 1024 * 1024, seconds: seconds).run(connectMs: 10000, finish)
    }

    @objc func request(_ call: CAPPluginCall) {
        let method = call.getString("method") ?? "GET"
        var payload: Data? = nil
        var type: String? = nil
        if let d = call.getString("data") {
            guard let decoded = Data(base64Encoded: d) else { return call.reject("Not base64.") }
            payload = decoded
            type = "application/octet-stream"
        } else if let b = call.getString("body") {
            payload = Data(b.utf8)
            type = "application/json"
        }
        let seconds = max(2, min(180, (call.getInt("timeoutMs") ?? 20000) / 1000))
        exchange(call.getString("target") ?? "", method, call.getString("path") ?? "", payload, type, seconds: seconds, to: call.getString("to")) { result in
            switch result {
            case .success(let a):
                if a.type.hasPrefix("application/json") {
                    call.resolve(["status": a.status, "type": a.type, "body": String(decoding: a.body, as: UTF8.self)])
                } else {
                    call.resolve(["status": a.status, "type": a.type, "data": a.body.base64EncodedString()])
                }
            case .failure(let e):
                call.reject(e.message)
            }
        }
    }

    @objc func save(_ call: CAPPluginCall) {
        let target = call.getString("target") ?? "", path = call.getString("path") ?? "", name = call.getString("name") ?? ""
        let size = call.getInt("size") ?? -1
        guard RigLinkPlugin.groups(Self.NAME, name) != nil,
              let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return call.reject("Not a name it can save.")
        }
        let file = docs.appendingPathComponent(name)
        let part = docs.appendingPathComponent(name + ".part")
        FileManager.default.createFile(atPath: part.path, contents: nil)
        guard let out = try? FileHandle(forWritingTo: part) else { return call.reject("Can't write it.") }
        var got = 0
        func fail(_ message: String) {
            try? out.close()
            try? FileManager.default.removeItem(at: part)
            call.reject(message)
        }
        func next() {
            exchange(target, "GET", path + (path.contains("?") ? "&" : "?") + "at=\(got)", nil, nil, seconds: 120) { [self] result in
                switch result {
                case .failure(let e):
                    fail(e.message)
                case .success(let a):
                    if a.status != 200 { return fail("The device answered \(a.status).") }
                    if a.type.hasPrefix("application/json") { return fail(String(decoding: a.body, as: UTF8.self)) }
                    out.write(a.body)
                    got += a.body.count
                    notifyListeners("progress", data: ["name": name, "got": got, "size": size])
                    if a.body.isEmpty || (size >= 0 && got >= size) {
                        try? out.close()
                        if size >= 0 && got != size { return fail("It came out \(got) bytes, not \(size).") }
                        try? FileManager.default.removeItem(at: file)
                        do {
                            try FileManager.default.moveItem(at: part, to: file)
                            call.resolve(["saved": "Files › On My iPhone › Cluster › " + name])
                        } catch {
                            fail("Can't keep it: \(error.localizedDescription)")
                        }
                    } else {
                        next()
                    }
                }
            }
        }
        next()
    }
}

// ---------- remote recording over Bluetooth Low Energy ----------
@objc(BtLinkPlugin)
public class BtLinkPlugin: CAPPlugin, CAPBridgedPlugin, CBCentralManagerDelegate, CBPeripheralDelegate {
    public let identifier = "BtLinkPlugin"
    public let jsName = "BtLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
    ]

    private var central: CBCentralManager?
    private var ready: [(CBManagerState) -> Void] = [] // waiting for Bluetooth to say how it is
    private var seen: [UUID: (CBPeripheral, String)] = [:]
    private var peripheral: CBPeripheral?
    private var connecting: CAPPluginCall?
    private var toDiscover = 0
    // The characteristics connect was asked to find (one missing: this iPhone kept an older layout of the rig's
    // services), and whether its services are being found again (the rig said they changed: Service Changed).
    private var wanted: [CBUUID] = []
    private var rediscovering = false
    // The GATT step under way, and those waiting for it.
    private var step: CAPPluginCall?
    private var stepFor: CBCharacteristic?
    private var steps: [(CAPPluginCall, () -> Bool)] = []
    private var stepTimer: DispatchWorkItem?

    // Bluetooth, once it says whether it's on (asking for permission the first time).
    private func whenReady(_ then: @escaping (CBManagerState) -> Void) {
        if let c = central, c.state != .unknown, c.state != .resetting { return then(c.state) }
        ready.append(then)
        if central == nil { central = CBCentralManager(delegate: self, queue: .main) }
    }

    public func centralManagerDidUpdateState(_ c: CBCentralManager) {
        guard c.state != .unknown, c.state != .resetting else { return }
        let waiting = ready
        ready = []
        waiting.forEach { $0(c.state) }
        if c.state != .poweredOn, peripheral != nil { gone("Bluetooth went off.") }
    }

    private func unavailable(_ state: CBManagerState) -> String? {
        switch state {
        case .poweredOn: return nil
        case .unauthorized: return "Hand Tracker isn't allowed to use Bluetooth: allow it in Settings → Hand Tracker."
        case .unsupported: return "This device has no Bluetooth Low Energy."
        default: return "Turn Bluetooth on, then try again."
        }
    }

    // ---------- finding it ----------
    @objc func scan(_ call: CAPPluginCall) {
        let service = call.getString("service") ?? ""
        let ms = max(1000, min(15000, call.getInt("ms") ?? 4000))
        DispatchQueue.main.async { [self] in
            whenReady { [self] state in
                if let why = unavailable(state) { return call.reject(why) }
                guard let c = central else { return call.reject("Bluetooth isn't ready.") }
                seen = [:]
                c.scanForPeripherals(withServices: [CBUUID(string: service)], options: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { [self] in
                    c.stopScan()
                    call.resolve(["devices": seen.map { ["id": $0.key.uuidString, "name": $0.value.1] }])
                }
            }
        }
    }

    public func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? p.name ?? ""
        if seen[p.identifier] == nil || !name.isEmpty { seen[p.identifier] = (p, name) }
    }

    // ---------- connected ----------
    @objc func connect(_ call: CAPPluginCall) {
        let id = UUID(uuidString: call.getString("id") ?? "")
        // characteristics: the UUIDs it must have, comma separated (optional).
        let want = (call.getString("characteristics") ?? "").split(separator: ",").map { String($0) }
            .filter { UUID(uuidString: $0) != nil }.map { CBUUID(string: $0) }
        DispatchQueue.main.async { [self] in
            whenReady { [self] state in
                if let why = unavailable(state) { return call.reject(why) }
                guard let c = central, let id = id, let p = seen[id]?.0 ?? c.retrievePeripherals(withIdentifiers: [id]).first else {
                    return call.reject("That isn't a Bluetooth device near by.")
                }
                close()
                peripheral = p
                connecting = call
                wanted = want
                p.delegate = self
                c.connect(p, options: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [self] in
                    if connecting === call {
                        connecting = nil
                        call.reject("It didn't answer over Bluetooth.")
                        close()
                    }
                }
            }
        }
    }

    public func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        guard p === peripheral else { return }
        p.discoverServices(nil)
    }

    public func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        gone("It didn't connect over Bluetooth.")
    }

    public func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        gone("The Bluetooth connection ended.")
    }

    public func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard p === peripheral, connecting != nil || rediscovering else { return }
        let services = p.services ?? []
        if error != nil || services.isEmpty {
            if connecting != nil { return failConnect("Its Bluetooth services weren't found.") }
            rediscovering = false
            return gone("Its Bluetooth services changed, and weren't found again.")
        }
        toDiscover = services.count
        services.forEach { p.discoverCharacteristics(nil, for: $0) }
    }

    public func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard p === peripheral, connecting != nil || rediscovering else { return }
        toDiscover -= 1
        if toDiscover > 0 { return }
        rediscovering = false
        guard let call = connecting else { return }
        connecting = nil
        let have = Set((p.services ?? []).flatMap { $0.characteristics ?? [] }.map { $0.uuid })
        if wanted.contains(where: { !have.contains($0) }) {
            call.reject(oldLayout(p))
            return close()
        }
        call.resolve(["mtu": p.maximumWriteValueLength(for: .withResponse) + 3])
    }

    // The rig says its services changed (Service Changed: it was updated while connected): found again.
    public func peripheral(_ p: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        guard p === peripheral, connecting == nil, !rediscovering else { return }
        rediscovering = true
        p.discoverServices(nil)
    }

    // What to do when this iPhone kept an older layout of the rig's services (iOS keeps them for a device it's seen,
    // and the rig was updated since): see them anew.
    private func oldLayout(_ p: CBPeripheral) -> String {
        let said = seen[p.identifier]?.1 ?? ""
        let name = !said.isEmpty ? said : (p.name ?? "It")
        return "\(name)'s Bluetooth was updated since this iPhone last saw it: in Settings → Bluetooth, turn Bluetooth off and on (if \(name) is under My Devices there, tap ⓘ beside it and choose Forget This Device first), then connect again."
    }

    private func failConnect(_ why: String) {
        let call = connecting
        connecting = nil
        call?.reject(why)
        close()
    }

    private func characteristic(_ call: CAPPluginCall) -> CBCharacteristic? {
        guard let p = peripheral, p.identifier.uuidString == (call.getString("id") ?? ""),
              let text = call.getString("characteristic") else { return nil }
        let want = CBUUID(string: text)
        for s in p.services ?? [] {
            if let ch = s.characteristics?.first(where: { $0.uuid == want }) { return ch }
        }
        return nil
    }

    // One GATT step at a time: start() begins it (false: it couldn't), stepDone() ends it.
    private func queueStep(_ call: CAPPluginCall, _ ch: CBCharacteristic, _ start: @escaping () -> Bool) {
        DispatchQueue.main.async { [self] in
            steps.append((call, { [self] in
                stepFor = ch
                return start()
            }))
            if step == nil { next() }
        }
    }

    private func next() {
        guard !steps.isEmpty else { return }
        let (call, start) = steps.removeFirst()
        step = call
        if !start() { return stepDone(error: "Bluetooth didn't do that.", value: nil) }
        let timer = DispatchWorkItem { [self] in if step === call { stepDone(error: "No answer over Bluetooth.", value: nil) } }
        stepTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timer)
    }

    private func stepDone(error: String?, value: Data?) {
        guard let call = step else { return }
        step = nil
        stepFor = nil
        stepTimer?.cancel()
        if let error = error { call.reject(error) }
        else if let value = value { call.resolve(["value": value.base64EncodedString()]) }
        else { call.resolve() }
        next()
    }

    @objc func read(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            guard let p = peripheral, let ch = characteristic(call) else { return call.reject("Not connected.") }
            queueStep(call, ch) {
                p.readValue(for: ch)
                return true
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        let value = Data(base64Encoded: call.getString("value") ?? "") ?? Data()
        DispatchQueue.main.async { [self] in
            guard let p = peripheral, let ch = characteristic(call) else { return call.reject("Not connected.") }
            queueStep(call, ch) {
                p.writeValue(value, for: ch, type: .withResponse)
                return true
            }
        }
    }

    @objc func notify(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            guard let p = peripheral, let ch = characteristic(call) else { return call.reject("Not connected.") }
            queueStep(call, ch) {
                p.setNotifyValue(true, for: ch)
                return true
            }
        }
    }

    public func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard p === peripheral else { return }
        // A read's answer, or a notification.
        if step != nil, stepFor === ch, !ch.isNotifying {
            return stepDone(error: error.map { "Bluetooth: \($0.localizedDescription)" }, value: ch.value ?? Data())
        }
        notifyListeners("notification", data: ["id": p.identifier.uuidString, "characteristic": ch.uuid.uuidString.lowercased(), "value": (ch.value ?? Data()).base64EncodedString()])
    }

    public func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        guard p === peripheral, stepFor === ch else { return }
        stepDone(error: error.map { "Bluetooth: \($0.localizedDescription)" }, value: nil)
    }

    public func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        guard p === peripheral, stepFor === ch else { return }
        stepDone(error: error.map { "Bluetooth: \($0.localizedDescription)" }, value: nil)
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            if let p = peripheral, p.identifier.uuidString == (call.getString("id") ?? "") { gone(nil) }
            call.resolve()
        }
    }

    // The connection's over (why: for what was waiting on it).
    private func gone(_ why: String?) {
        guard let p = peripheral else { return }
        let reason = why ?? "Disconnected."
        connecting?.reject(reason)
        connecting = nil
        step?.reject(reason)
        step = nil
        stepFor = nil
        stepTimer?.cancel()
        steps.forEach { $0.0.reject(reason) }
        steps = []
        close()
        notifyListeners("disconnected", data: ["id": p.identifier.uuidString])
    }

    private func close() {
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        peripheral = nil
        rediscovering = false
    }
}

// ---------- Cluster Call (its own app: scripts/ios-variant.js clustercall) ----------
// ClusterCallPlugin: Cluster Call on an iPhone or iPad, as ClusterCallPlugin.java and ClusterCallServer.java are on Android
// and electron/cluster-call.js on a computer: its own service on port 47860 (GET /vc/hello, POST /vc/signal, POST
// /vc/announce), started when its page says hello, kept while the app is open (iOS keeps an app's server only then: an
// iPhone rings only with the app open, the user's choice, 2026-11-27), and the page's plugin:
//   hello() -> { me, waiting, settings, shown, error }; devices() -> { devices }; send({ address, signal }) -> its reply
//   settings({ ringWhenClosed }) -> { ringWhenClosed: false, canRingWhenClosed: false }; inCall({ on }) (the screen
//   kept on while a call rings or goes on); events "signal" (each call's signal), "shown" ({ on }: the app in front).
// Who may ask: anything on your Tailscale network (100.64.0.0/10, fd7a:115c:a1e0::/48; a phone can't check whose a
// device is, the user's choice), never a web page (an Origin header), a POST only as JSON, at most 256 KB.
@objc(ClusterCallPlugin)
public class ClusterCallPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ClusterCallPlugin"
    public let jsName = "ClusterCall"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "hello", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "devices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inCall", returnType: CAPPluginReturnPromise),
    ]
    static let port: UInt16 = 47860
    static let bodyBytes = 256 * 1024
    static let kinds: Set<String> = ["offer", "answer", "decline", "busy", "cancel", "hangup", "state", "join"]
    private let queue = DispatchQueue(label: "cluster-call")
    private let lock = NSLock()
    private var listener: NWListener?
    private var wanted = false
    private var waiting: [[String: Any]] = []
    private var startError = ""

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(away), name: UIApplication.willResignActiveNotification, object: nil)
    }

    @objc private func active() {
        notifyListeners("shown", data: ["on": true])
        queue.async {
            self.lock.lock()
            let again = self.wanted && self.listener == nil
            self.lock.unlock()
            if again { self.listen() }
        }
    }

    @objc private func away() {
        notifyListeners("shown", data: ["on": false])
    }

    // ---------- listening ----------
    private func listen() {
        lock.lock()
        let has = listener != nil
        lock.unlock()
        if has { return }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: Self.port), let l = try? NWListener(using: params, on: nwPort) else {
            lock.lock()
            startError = "Calls can't come in: port \(Self.port) is taken."
            lock.unlock()
            return
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.stateUpdateHandler = { [weak self, weak l] st in
            guard let self = self, let l = l else { return }
            if case .failed(let e) = st {
                self.lock.lock()
                if self.listener === l { self.listener = nil }
                self.startError = "Calls can't come in: \(e.localizedDescription)"
                self.lock.unlock()
                l.cancel()
            }
        }
        l.start(queue: queue)
        lock.lock()
        listener = l
        startError = ""
        lock.unlock()
    }

    static func onTailnet(_ ip: String) -> Bool {
        let a = ip.replacingOccurrences(of: "::ffff:", with: "")
        if a.lowercased().hasPrefix("fd7a:115c:a1e0:") { return true }
        let p = a.split(separator: ".")
        guard p.count == 4, let x = Int(p[0]), let y = Int(p[1]) else { return false }
        return x == 100 && y >= 64 && y <= 127
    }

    static func address(_ e: NWEndpoint?) -> String {
        guard let e = e, case .hostPort(let host, _) = e else { return "" }
        var s: String
        switch host {
        case .ipv4(let a): s = "\(a)"
        case .ipv6(let a): s = "\(a)"
        case .name(let n, _): s = n
        @unknown default: s = ""
        }
        if let pct = s.firstIndex(of: "%") { s = String(s[..<pct]) }
        return s
    }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        read(c, Data())
        queue.asyncAfter(deadline: .now() + 20) { c.cancel() }
    }

    private func read(_ c: NWConnection, _ got: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self = self else {
                c.cancel()
                return
            }
            var buf = got
            if let data = data { buf.append(data) }
            guard let split = buf.range(of: Data("\r\n\r\n".utf8)) else {
                if buf.count > 16384 || complete || error != nil { c.cancel() } else { self.read(c, buf) }
                return
            }
            let head = String(decoding: buf[buf.startIndex..<split.lowerBound], as: UTF8.self)
            let lines = head.components(separatedBy: "\r\n")
            let first = lines[0].split(separator: " ")
            guard first.count >= 2 else {
                c.cancel()
                return
            }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            let want = Int(headers["content-length"] ?? "0") ?? -1
            let bodyStart = split.upperBound
            let have = buf.distance(from: bodyStart, to: buf.endIndex)
            if want >= 0 && want <= Self.bodyBytes && have < want {
                if complete || error != nil { c.cancel() } else { self.read(c, buf) }
                return
            }
            let body = want >= 0 && want <= Self.bodyBytes ? Data(buf[bodyStart..<buf.index(bodyStart, offsetBy: want)]) : Data()
            var path = String(first[1])
            if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
            let (code, answer) = self.handle(method: String(first[0]), path: path, headers: headers, body: body, tooBig: want > Self.bodyBytes || want < 0, from: Self.address(c.endpoint))
            let json = (try? JSONSerialization.data(withJSONObject: answer)) ?? Data("{}".utf8)
            var out = Data("HTTP/1.1 \(code) \(code == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(json.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
            out.append(json)
            c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
        }
    }

    private func handle(method: String, path: String, headers: [String: String], body: Data, tooBig: Bool, from: String) -> (Int, [String: Any]) {
        if headers["origin"] != nil { return (403, ["ok": false, "error": "Not from a web page."]) }
        if !Self.onTailnet(from) { return (403, ["ok": false, "error": "Only devices on your Tailscale network."]) }
        if method == "GET" && path == "/vc/hello" {
            return (200, ["app": "cluster-call", "name": UIDevice.current.name, "os": "ios"])
        }
        guard method == "POST" && (path == "/vc/signal" || path == "/vc/announce") else { return (404, ["ok": false, "error": "Nothing here."]) }
        if !(headers["content-type"] ?? "").lowercased().hasPrefix("application/json") { return (415, ["ok": false, "error": "JSON only."]) }
        if tooBig { return (413, ["ok": false, "error": "Too big."]) }
        guard let j = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return (400, ["ok": false, "error": "Not JSON."]) }
        if path == "/vc/announce" {
            var devices: [[String: Any]] = []
            for case let d as [String: Any] in (j["devices"] as? [Any] ?? []) where devices.count < 64 {
                let address = String((d["address"] as? String ?? "").prefix(80))
                guard address.range(of: "^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(:\\d{1,5})?$", options: .regularExpression) != nil else { continue }
                var one: [String: Any] = ["name": String((d["name"] as? String ?? "").prefix(80)), "address": address, "os": String((d["os"] as? String ?? "").prefix(20)), "app": (d["app"] as? Bool) == true]
                // (a page of hand-tracker.com open on one of your devices, called through it: named in the offer, "to")
                if let to = d["to"] as? String, to.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil { one["to"] = to }
                devices.append(one)
            }
            if let data = try? JSONSerialization.data(withJSONObject: devices) { UserDefaults.standard.set(data, forKey: "clusterCallDevices") }
            return (200, ["ok": true])
        }
        guard let signal = Self.signal(j, from: from) else { return (400, ["ok": false, "error": "Not a call's signal."]) }
        lock.lock()
        let pageThere = wanted
        if !pageThere {
            waiting.append(signal)
            if waiting.count > 20 { waiting.removeFirst() }
        }
        lock.unlock()
        if pageThere { notifyListeners("signal", data: signal) }
        return (200, ["ok": true])
    }

    // A signal as it came, checked and kept to what a signal has (as electron/cluster-call.js and ClusterCallServer.java).
    static func signal(_ j: [String: Any], from: String) -> [String: Any]? {
        guard let kind = j["kind"] as? String, kinds.contains(kind), let call = j["call"] as? String,
              call.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil else { return nil }
        var s: [String: Any] = ["kind": kind, "call": call]
        let name = String((j["name"] as? String ?? "").prefix(80))
        s["from"] = ["address": from, "name": name.isEmpty ? from : name]
        if let sdp = j["sdp"] {
            guard let text = sdp as? String, text.count <= 200000 else { return nil }
            s["sdp"] = text
        }
        if let st = j["state"] as? [String: Any] {
            s["state"] = ["muted": (st["muted"] as? Bool) == true, "camera": (st["camera"] as? Bool) != false]
        }
        if let v = j["video"] as? Bool { s["video"] = v }
        if let members = j["members"] as? [Any] {
            s["members"] = members.prefix(16).compactMap { m -> [String: Any]? in
                guard let m = m as? [String: Any] else { return nil }
                return ["address": String((m["address"] as? String ?? "").prefix(80)), "name": String((m["name"] as? String ?? "").prefix(80))]
            }
        }
        return s
    }

    // ---------- asking another device's app (plain HTTP over TCP: RigExchange) ----------
    static func hostPort(_ address: String) -> (String, UInt16) {
        if let c = address.lastIndex(of: ":"), !address.contains("::"), let p = UInt16(address[address.index(after: c)...]) {
            return (String(address[..<c]), p)
        }
        return (address, port)
    }

    private func ask(_ address: String, method: String, path: String, json: Data?, seconds: Int, _ done: @escaping ([String: Any]?, String?) -> Void) {
        let (host, p) = Self.hostPort(address)
        var head = "\(method) \(path) HTTP/1.1\r\nHost: \(host):\(p)\r\nConnection: close\r\n"
        if let j = json { head += "Content-Type: application/json\r\nContent-Length: \(j.count)\r\n" }
        head += "\r\n"
        var request = Data(head.utf8)
        if let j = json { request.append(j) }
        RigExchange(host: host, port: p, request: request, queue: queue, maxBytes: Self.bodyBytes, seconds: seconds).run(connectMs: 3000) { result in
            switch result {
            case .success(let a):
                var reply = (try? JSONSerialization.jsonObject(with: a.body)) as? [String: Any]
                if a.status >= 400 {
                    var r = reply ?? [:]
                    r["ok"] = false
                    if r["error"] == nil { r["error"] = "It said \(a.status)." }
                    reply = r
                }
                done(reply, nil)
            case .failure(let e):
                done(nil, e.message)
            }
        }
    }

    // ---------- the page ----------
    private func tailscaleAddress() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            guard let sa = p.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let a = String(cString: host)
                if Self.onTailnet(a) { return a }
            }
        }
        return nil
    }

    @objc func hello(_ call: CAPPluginCall) {
        queue.async {
            self.lock.lock()
            self.wanted = true
            let w = self.waiting
            self.waiting = []
            self.lock.unlock()
            self.listen()
            let ip = self.tailscaleAddress()
            self.lock.lock()
            var err = self.startError
            self.lock.unlock()
            if ip == nil { err = (err.isEmpty ? "" : err + " ") + "This device isn't on Tailscale: turn Tailscale on to call and be called." }
            let me: [String: Any] = ["name": UIDevice.current.name, "ips": ip.map { [$0] } ?? []]
            call.resolve(["me": me, "waiting": w, "settings": ["ringWhenClosed": false, "canRingWhenClosed": false], "shown": true, "error": err])
        }
    }

    @objc func devices(_ call: CAPPluginCall) {
        var list: [[String: Any]] = []
        if let data = UserDefaults.standard.data(forKey: "clusterCallDevices"), let l = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] { list = l }
        if list.isEmpty {
            call.resolve(["devices": [Any]()])
            return
        }
        let group = DispatchGroup()
        var results = list
        let resultLock = NSLock()
        for (i, d) in list.enumerated() {
            group.enter()
            ask(d["address"] as? String ?? "", method: "GET", path: "/vc/hello", json: nil, seconds: 3) { reply, _ in
                let isApp = reply?["app"] as? String == "cluster-call"
                resultLock.lock()
                results[i]["app"] = isApp
                results[i]["online"] = isApp
                if isApp, results[i]["to"] == nil, let n = reply?["name"] as? String, !n.isEmpty { results[i]["name"] = n }
                resultLock.unlock()
                group.leave()
            }
        }
        group.notify(queue: queue) { call.resolve(["devices": results]) }
    }

    @objc func send(_ call: CAPPluginCall) {
        let address = call.getString("address") ?? ""
        var signal: [String: Any] = call.getObject("signal") ?? [:]
        signal["name"] = UIDevice.current.name
        guard !address.isEmpty, let json = try? JSONSerialization.data(withJSONObject: signal) else {
            call.resolve(["ok": false, "error": "Nothing to send."])
            return
        }
        ask(address, method: "POST", path: "/vc/signal", json: json, seconds: 8) { reply, error in
            if let reply = reply { call.resolve(reply) } else { call.resolve(["ok": false, "error": "That device didn't answer (\(error ?? "no answer"))."]) }
        }
    }

    @objc func settings(_ call: CAPPluginCall) {
        call.resolve(["ringWhenClosed": false, "canRingWhenClosed": false])
    }

    @objc func inCall(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
        call.resolve()
    }
}
