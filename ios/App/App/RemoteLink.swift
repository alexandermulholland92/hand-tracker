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

import Foundation
import Network
import CoreBluetooth
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
    static let RIG_PATH = "^/api/(state|command|wifi|takes|preview\\?i=[0-3](&full=1)?|take\\?f=[A-Za-z0-9%._~!*'()-]{1,800}&at=\\d{1,12})$"
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
        guard Self.groups(Self.RIG_PATH, path) != nil, post || method == "GET", post == (path == "/api/command") else {
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
        RigExchange(host: host, port: UInt16(port), request: request, queue: queue).run { result in
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
    private var done: ((Result<RigAnswer, RigError>) -> Void)?

    init(host: String, port: UInt16, request: Data, queue: DispatchQueue) {
        conn = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? 47821, using: .tcp)
        self.request = request
        self.queue = queue
    }

    func run(_ finish: @escaping (Result<RigAnswer, RigError>) -> Void) {
        done = finish
        conn.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
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
        queue.asyncAfter(deadline: .now() + 10) { [self] in end(.failure(RigError(message: "No answer."))) }
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] chunk, _, complete, err in
            if let chunk = chunk { received.append(chunk) }
            if received.count > RigLinkPlugin.maxBytes { return end(.failure(RigError(message: "The answer was too big"))) }
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
        DispatchQueue.main.async { [self] in
            whenReady { [self] state in
                if let why = unavailable(state) { return call.reject(why) }
                guard let c = central, let id = id, let p = seen[id]?.0 ?? c.retrievePeripherals(withIdentifiers: [id]).first else {
                    return call.reject("That isn't a Bluetooth device near by.")
                }
                close()
                peripheral = p
                connecting = call
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
        guard p === peripheral, connecting != nil else { return }
        let services = p.services ?? []
        if error != nil || services.isEmpty { return failConnect("Its Bluetooth services weren't found.") }
        toDiscover = services.count
        services.forEach { p.discoverCharacteristics(nil, for: $0) }
    }

    public func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard p === peripheral, let call = connecting else { return }
        toDiscover -= 1
        if toDiscover > 0 { return }
        connecting = nil
        call.resolve(["mtu": p.maximumWriteValueLength(for: .withResponse) + 3])
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
    }
}
