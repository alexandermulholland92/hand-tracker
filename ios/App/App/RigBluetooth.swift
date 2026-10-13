// RigBluetooth.swift: remote recording on the iPhone or iPad over Bluetooth Low Energy (the rig's
// side): a phone, the website or a computer that can't reach it over a network reaches its remote
// recording page (RigServer.swift) over Bluetooth instead. The link is electron/bluetooth-link.js's,
// word for word (as BtRigProtocol.java on Android): read that file for what goes over it.
//
//   RigLinkProtocol(name, secret, relay, send)  the link itself, whatever carries its frames
//     relay(method, path, body) -> Answer: the request, to the remote recording server here (called
//     off the main thread); send(frame): a notification to every device
//     info(); received(device, frame, mtu); gone(device); clear()
//   RigBluetooth(name, secret, relay, changed)  the link over CoreBluetooth: a GATT service of its
//     own (INFO / RX / TX), advertised by name while the app is open; start(); stop()
//     changed(on, error) when that changes

import Foundation
import CoreBluetooth
import CryptoKit
import CommonCrypto
import Compression

final class RigLinkProtocol {
    static let SERVICE = CBUUID(string: "48540001-6c69-6e6b-8000-68616e647472")
    static let INFO = CBUUID(string: "48540002-6c69-6e6b-8000-68616e647472")
    static let RX = CBUUID(string: "48540003-6c69-6e6b-8000-68616e647472")
    static let TX = CBUUID(string: "48540004-6c69-6e6b-8000-68616e647472")
    static let HELLO: UInt8 = 1, WELCOME: UInt8 = 2, DATA: UInt8 = 3, ERROR: UInt8 = 4, FIRST: UInt8 = 1, LAST: UInt8 = 2
    static let HEAD = 6
    static let sessionIdle: TimeInterval = 10 * 60
    static let maxMessage = 64 * 1024
    static let iterations = 100000

    struct Secret {
        let salt: String // base64, as INFO gives it
        let iter: Int
        let key: Data
    }

    struct Answer {
        let status: Int
        let type: String
        let body: Data
    }

    typealias Relay = (_ method: String, _ path: String, _ body: Data) -> Answer

    private final class Session {
        let device: String
        let key: SymmetricKey
        var at = Date()
        var mtu: Int
        var parts: [Int: [UInt8]] = [:]

        init(device: String, key: SymmetricKey, mtu: Int) {
            self.device = device
            self.key = key
            self.mtu = mtu
        }
    }

    private let name: String
    private let secret: Secret
    private let relay: Relay
    private let send: (Data) -> Void
    private let lock = NSLock()
    private var sessions: [Int: Session] = [:]
    private var next = Int.random(in: 1...60000)
    private let work = DispatchQueue(label: "hand-tracker.rig-link", attributes: .concurrent)

    init(name: String, secret: Secret, relay: @escaping Relay, send: @escaping (Data) -> Void) {
        self.name = name
        self.secret = secret
        self.relay = relay
        self.send = send
    }

    // ---------- the password's key (as bluetooth-link.js makeSecret) ----------
    static func random(_ n: Int) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: n)
        _ = SecRandomCopyBytes(kSecRandomDefault, n, &b)
        return b
    }

    static func pbkdf2(_ password: String, _ salt: [UInt8], _ iter: Int) -> Data {
        let pw = Array(password.utf8).map { Int8(bitPattern: $0) }
        var out = [UInt8](repeating: 0, count: 32)
        _ = CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw, pw.count, salt, salt.count,
                                 CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iter), &out, 32)
        return Data(out)
    }

    static func makeSecret(_ password: String) -> Secret {
        let salt = random(16)
        return Secret(salt: Data(salt).base64EncodedString(), iter: iterations, key: pbkdf2(password, salt, iterations))
    }

    func info() -> Data {
        let o: [String: Any] = ["v": 1, "name": name, "salt": secret.salt, "iter": secret.iter]
        return (try? JSONSerialization.data(withJSONObject: o)) ?? Data()
    }

    // ---------- the link ----------
    private static func aad(_ session: Int, _ message: Int) -> Data {
        Data([UInt8(session & 255), UInt8((session >> 8) & 255), UInt8(message & 255), UInt8((message >> 8) & 255)])
    }

    static func sessionKey(_ k: Data, _ cn: [UInt8], _ sn: [UInt8]) -> SymmetricKey {
        var m = Data("HT1".utf8)
        m.append(contentsOf: cn)
        m.append(contentsOf: sn)
        return SymmetricKey(data: Data(HMAC<SHA256>.authenticationCode(for: m, using: SymmetricKey(data: k))))
    }

    // iv (12) + ciphertext + tag (16): CryptoKit's combined form is exactly the link's.
    static func seal(_ s: SymmetricKey, _ session: Int, _ message: Int, _ plain: Data) -> Data? {
        (try? AES.GCM.seal(plain, using: s, nonce: AES.GCM.Nonce(), authenticating: aad(session, message)))?.combined
    }

    static func open(_ s: SymmetricKey, _ session: Int, _ message: Int, _ sealed: [UInt8]) -> Data? {
        guard sealed.count >= 28, let box = try? AES.GCM.SealedBox(combined: Data(sealed)) else { return nil }
        return try? AES.GCM.open(box, using: s, authenticating: aad(session, message))
    }

    static func pack(_ head: [String: Any], _ body: Data) -> Data {
        let h = (try? JSONSerialization.data(withJSONObject: head)) ?? Data("{}".utf8)
        var out = Data([UInt8(h.count & 255), UInt8((h.count >> 8) & 255), UInt8((h.count >> 16) & 255), UInt8((h.count >> 24) & 255)])
        out.append(h)
        out.append(body)
        return out
    }

    // Raw deflate (RFC 1951: Compression's ZLIB is that, without zlib's header).
    static func deflateRaw(_ data: Data) -> Data? {
        let cap = data.count + 1024
        var out = [UInt8](repeating: 0, count: cap)
        let n = data.withUnsafeBytes { src -> Int in
            guard let p = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return compression_encode_buffer(&out, cap, p, data.count, nil, COMPRESSION_ZLIB)
        }
        return n > 0 ? Data(out[0..<n]) : nil
    }

    // A notification's most bytes: at most mtu - 3, and filling Bluetooth's 251-byte radio packets
    // (with its 7 bytes of headers, 495 is two and 244 one), as electron/bluetooth-link.js.
    static func frameSize(_ mtu: Int) -> Int {
        let most = min(509, (mtu > 0 ? mtu : 23) - 3)
        return most >= 495 ? 495 : most >= 244 ? 244 : max(20, most)
    }

    // A message as frames that fit the link (each frameSize(mtu) bytes at most).
    static func frames(_ type: UInt8, _ session: Int, _ message: Int, _ data: [UInt8], _ mtu: Int) -> [Data] {
        let room = frameSize(mtu) - HEAD
        var out: [Data] = []
        var at = 0
        repeat {
            let n = min(room, data.count - at)
            var f = [type, UInt8(session & 255), UInt8((session >> 8) & 255), UInt8(message & 255), UInt8((message >> 8) & 255),
                     (at == 0 ? FIRST : 0) | (at + room >= data.count ? LAST : 0)]
            f.append(contentsOf: data[at..<at + n])
            out.append(Data(f))
            at += room
        } while at < data.count
        return out
    }

    private func notifyAll(_ type: UInt8, _ session: Int, _ message: Int, _ data: [UInt8], _ mtu: Int) {
        for f in Self.frames(type, session, message, data, mtu) { send(f) }
    }

    func gone(_ device: String) {
        lock.lock()
        sessions = sessions.filter { $0.value.device != device }
        lock.unlock()
    }

    func clear() {
        lock.lock()
        sessions.removeAll()
        lock.unlock()
    }

    func received(device: String, frame data: Data, mtu: Int) {
        let frame = [UInt8](data)
        guard frame.count >= Self.HEAD else { return }
        let type = frame[0], session = Int(frame[1]) | Int(frame[2]) << 8, message = Int(frame[3]) | Int(frame[4]) << 8, flags = frame[5]
        let part = Array(frame[Self.HEAD...])
        let now = Date()
        lock.lock()
        sessions = sessions.filter { now.timeIntervalSince($0.value.at) <= Self.sessionIdle }
        if type == Self.HELLO {
            guard part.count == 16 else { lock.unlock(); return }
            sessions = sessions.filter { $0.value.device != device } // (one session a device: a new hello starts afresh)
            let id = next
            next = (next % 65000) + 1
            let sn = Self.random(16)
            sessions[id] = Session(device: device, key: Self.sessionKey(secret.key, part, sn), mtu: mtu)
            lock.unlock()
            notifyAll(Self.WELCOME, id, message, sn, mtu)
            return
        }
        guard type == Self.DATA else { lock.unlock(); return }
        guard let s = sessions[session], s.device == device else {
            lock.unlock()
            notifyAll(Self.ERROR, session, message, Array("session".utf8), mtu)
            return
        }
        s.at = now
        if mtu > 0 { s.mtu = mtu }
        if flags & Self.FIRST != 0 { s.parts[message] = [] }
        guard var parts = s.parts[message] else { lock.unlock(); return }
        parts.append(contentsOf: part)
        if parts.count > Self.maxMessage + 64 {
            s.parts[message] = nil
            lock.unlock()
            notifyAll(Self.ERROR, session, message, Array("too long".utf8), s.mtu)
            return
        }
        if flags & Self.LAST == 0 {
            s.parts[message] = parts
            lock.unlock()
            return
        }
        s.parts[message] = nil
        lock.unlock()
        guard let plain = Self.open(s.key, session, message, parts) else {
            lock.lock()
            sessions[session] = nil
            lock.unlock()
            notifyAll(Self.ERROR, session, message, Array("password".utf8), s.mtu)
            return
        }
        work.async { self.answer(s, session, message, plain) }
    }

    private func answer(_ s: Session, _ session: Int, _ message: Int, _ plain: Data) {
        var status = 502
        var type = "application/json; charset=utf-8"
        var body = Data("{\"error\":\"Not a request\"}".utf8)
        let p = [UInt8](plain)
        if p.count >= 4 {
            let n = Int(p[0]) | Int(p[1]) << 8 | Int(p[2]) << 16 | Int(p[3]) << 24
            if n >= 0, n <= p.count - 4, let head = try? JSONSerialization.jsonObject(with: Data(p[4..<4 + n])) as? [String: Any] {
                let path = head["p"] as? String ?? ""
                if path.range(of: "^/api/[a-z]", options: .regularExpression) == nil {
                    status = 400
                    body = Data("{\"error\":\"Not found\"}".utf8)
                } else {
                    let method = (head["m"] as? String) == "POST" ? "POST" : "GET"
                    let a = relay(method, String(path.prefix(512)), method == "POST" ? Data(p[(4 + n)...]) : Data())
                    status = a.status
                    type = a.type
                    body = a.body
                }
            }
        }
        lock.lock()
        let still = sessions[session] === s
        lock.unlock()
        guard still else { return }
        let small = body.count > 200 && !type.hasPrefix("image/") ? Self.deflateRaw(body) : nil
        var head: [String: Any] = ["s": status, "t": type]
        let z = small != nil && small!.count < body.count
        if z { head["z"] = 1 }
        guard let sealed = Self.seal(s.key, session, message, Self.pack(head, z ? small! : body)) else { return }
        notifyAll(Self.DATA, session, message, [UInt8](sealed), s.mtu)
    }
}

// ---------- over CoreBluetooth ----------
final class RigBluetooth: NSObject, CBPeripheralManagerDelegate {
    private let name: String
    private var link: RigLinkProtocol!
    private let changed: (Bool, String) -> Void
    private let queue = DispatchQueue(label: "hand-tracker.rig-bluetooth")
    private var manager: CBPeripheralManager?
    private var tx: CBMutableCharacteristic?
    private var waiting: [Data] = []
    private(set) var on = false

    init(name: String, secret: RigLinkProtocol.Secret, relay: @escaping RigLinkProtocol.Relay, changed: @escaping (Bool, String) -> Void) {
        self.name = name
        self.changed = changed
        super.init()
        link = RigLinkProtocol(name: name, secret: secret, relay: relay) { [weak self] frame in
            guard let self = self else { return }
            self.queue.async {
                self.waiting.append(frame)
                self.flush()
            }
        }
    }

    func start() {
        queue.async {
            if self.manager == nil { self.manager = CBPeripheralManager(delegate: self, queue: self.queue) }
        }
    }

    func stop() {
        queue.async {
            self.manager?.stopAdvertising()
            self.manager?.removeAllServices()
            self.manager?.delegate = nil
            self.manager = nil
            self.tx = nil
            self.waiting.removeAll()
            self.link.clear()
            self.on = false
        }
    }

    private func flush() {
        guard let m = manager, let tx = tx else {
            waiting.removeAll()
            return
        }
        while let f = waiting.first {
            if !m.updateValue(f, for: tx, onSubscribedCentrals: nil) { return } // (sent once it's ready again)
            waiting.removeFirst()
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        flush()
    }

    func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
        switch p.state {
        case .poweredOn:
            guard tx == nil else { return }
            let service = CBMutableService(type: RigLinkProtocol.SERVICE, primary: true)
            let info = CBMutableCharacteristic(type: RigLinkProtocol.INFO, properties: [.read], value: nil, permissions: [.readable])
            let rx = CBMutableCharacteristic(type: RigLinkProtocol.RX, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
            let t = CBMutableCharacteristic(type: RigLinkProtocol.TX, properties: [.notify], value: nil, permissions: [.readable])
            service.characteristics = [info, rx, t]
            tx = t
            p.add(service)
        case .unauthorized:
            setOn(false, "Hand Tracker isn't allowed to use Bluetooth: allow it in Settings → Hand Tracker.")
        case .poweredOff:
            setOn(false, "Bluetooth is off: turn it on.")
        case .unsupported:
            setOn(false, "This device can't offer Bluetooth Low Energy.")
        default:
            break
        }
    }

    func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error {
            setOn(false, "Bluetooth's service didn't start: \(error.localizedDescription)")
            return
        }
        p.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [RigLinkProtocol.SERVICE], CBAdvertisementDataLocalNameKey: name])
    }

    func peripheralManagerDidStartAdvertising(_ p: CBPeripheralManager, error: Error?) {
        if let error = error { setOn(false, "Bluetooth advertising: \(error.localizedDescription)") } else { setOn(true, "") }
    }

    private func setOn(_ value: Bool, _ error: String) {
        on = value
        changed(value, error)
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        let value = link.info()
        guard request.offset <= value.count else {
            p.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = value.subdata(in: request.offset..<value.count)
        p.respond(to: request, withResult: .success)
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for r in requests where r.characteristic.uuid == RigLinkProtocol.RX {
            link.received(device: r.central.identifier.uuidString, frame: r.value ?? Data(), mtu: r.central.maximumUpdateValueLength + 3)
        }
        if let first = requests.first { p.respond(to: first, withResult: .success) }
    }

    func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        link.gone(central.identifier.uuidString)
    }
}
