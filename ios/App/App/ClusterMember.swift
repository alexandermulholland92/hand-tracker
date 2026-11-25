import Capacitor
import Darwin
import Foundation
import UIKit

// ---------- this iPhone in the cluster (the Cluster app: its own switch, at the top of its page) ----------
// While the switch is on and the app is open (an iPhone gives an app no time of its own in the background), the app
// runs the cluster's own service (cluster/node/ht_cluster.py, the same as on the Pis and in the Android app) in its
// own Python: BeeWare's Python 3.13 for iOS, which only the Cluster app has (scripts/ios-variant.js cluster puts
// Python.framework, its standard library and the service's code in it), loaded when it's first needed. So this
// iPhone is one of the cluster's members, with its health and jobs (its Python scripts), listed with the Pis
// (the user, 2026-11-23: "Have phone's able to join the cluster as a member too").
//
// MemberPlugin (cluster.js: window.Capacitor.Plugins.Member, as on Android):
//   start({ seeds: ["pi", ...], name? }) -> status     its switch on (kept: on again when the app opens)
//   stop() -> status
//   status() -> { available, on, running, name, address, port, error }
//   allowTakes() -> status                              (Android's All files access: nothing to allow here)
// The service asks the app for what only the app can tell (its readings: battery, memory, storage, ...) with
// ht_native_call (phonesys.py), a C function whose address it's given.

// The app's answers to the service (phonesys.call): JSON in, JSON out.
enum ClusterNative {
    private static let lock = NSLock()
    private static var device: [String: Any] = [:] // (UIKit's readings, from the main thread's last look)

    // UIKit's readings, kept for the service's thread (which mustn't wait on the main thread: that one may be
    // waiting on Python). Called on the main thread.
    static func lookOnMain() {
        let d = UIDevice.current
        d.isBatteryMonitoringEnabled = true
        var state = "unknown"
        switch d.batteryState {
        case .charging: state = "charging"
        case .full: state = "full"
        case .unplugged: state = "unplugged"
        default: break
        }
        let snapshot: [String: Any] = ["level": d.batteryLevel, "state": state, "system": d.systemName + " " + d.systemVersion, "kind": d.model]
        lock.lock()
        device = snapshot
        lock.unlock()
    }

    static func call(_ name: String, _ args: String) -> String {
        let answer: [String: Any]
        switch name {
        case "readings":
            answer = readings()
        default:
            answer = ["ok": false, "error": "This iPhone can't do that yet (\(name))."]
        }
        let data = (try? JSONSerialization.data(withJSONObject: answer)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    // Its model, memory, battery, storage, how long it's been on and its cores (phonesys.readings): what Android
    // gives too, but its temperature and Wi-Fi strength, which an iPhone doesn't tell an app.
    static func readings() -> [String: Any] {
        lock.lock()
        let d = device
        lock.unlock()
        var r: [String: Any] = [:]
        var u = utsname()
        uname(&u)
        let machine = withUnsafePointer(to: &u.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
        r["model"] = "\(d["kind"] as? String ?? "iPhone") \(machine) (\(d["system"] as? String ?? "iOS"))"
        r["cores"] = ProcessInfo.processInfo.activeProcessorCount
        r["memory"] = ["total": ProcessInfo.processInfo.physicalMemory, "available": availableMemory()]
        if let level = d["level"] as? Float, level >= 0 {
            let state = d["state"] as? String ?? "unknown"
            r["battery"] = ["level": Int((level * 100).rounded()), "plugged": state == "charging" || state == "full", "charging": state == "charging"]
        }
        r["thermal"] = ProcessInfo.processInfo.thermalState.rawValue
        if let fs = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()),
           let total = (fs[.systemSize] as? NSNumber)?.int64Value, let free = (fs[.systemFreeSize] as? NSNumber)?.int64Value {
            r["drives"] = [["mount": "phone", "total": total, "free": free]]
        }
        r["uptime"] = Int(ProcessInfo.processInfo.systemUptime)
        return r
    }

    // The memory free or freeable now (free and inactive pages), as the Pis' health counts it.
    private static func availableMemory() -> UInt64 {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return (UInt64(stats.free_count) + UInt64(stats.inactive_count)) * UInt64(getpagesize())
    }

    // This iPhone's Tailscale address (100.64.0.0/10, on the VPN's interface), or "" without Tailscale on.
    static func tailscaleAddress() -> String {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return "" }
        defer { freeifaddrs(list) }
        var found = ""
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let a = p {
            if let sa = a.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    let ip = String(cString: host)
                    let parts = ip.split(separator: ".").compactMap { Int($0) }
                    if parts.count == 4, parts[0] == 100, (64...127).contains(parts[1]) {
                        found = ip
                        break
                    }
                }
            }
            p = a.pointee.ifa_next
        }
        return found
    }
}

// The service's way in (phonesys.py, by ctypes, at the addresses it's given): an answer as a C string it frees.
let htNativeCall: @convention(c) (UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? = { name, args in
    let n = name.map { String(cString: $0) } ?? ""
    let a = args.map { String(cString: $0) } ?? "{}"
    return strdup(ClusterNative.call(n, a))
}
let htNativeFree: @convention(c) (UnsafeMutableRawPointer?) -> Void = { p in
    free(p)
}

// The app's Python (Python.framework, loaded once it's needed), on a thread of its own that runs the service each
// time the switch is turned on (htmember.run, which returns once htmember.stop is called).
final class ClusterPython {
    static let shared = ClusterPython()
    private typealias VoidFn = @convention(c) () -> Void
    private typealias RunFn = @convention(c) (UnsafePointer<CChar>) -> Int32
    private typealias SaveFn = @convention(c) () -> OpaquePointer?
    private typealias EnsureFn = @convention(c) () -> Int32
    private typealias ReleaseFn = @convention(c) (Int32) -> Void

    private var handle: UnsafeMutableRawPointer?
    private var runString: RunFn?
    private var gilEnsure: EnsureFn?
    private var gilRelease: ReleaseFn?
    private let lock = NSLock()
    private let wake = DispatchSemaphore(value: 0)
    private var thread: Thread?
    private var wanted = false
    private(set) var running = false
    private(set) var lastError = ""

    var bundle: String { Bundle.main.bundlePath }
    var available: Bool { FileManager.default.fileExists(atPath: bundle + "/Frameworks/Python.framework/Python") && FileManager.default.fileExists(atPath: bundle + "/cluster-node/htmember.py") }
    static var settingsFile: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("cluster-member.json")
    }

    private func load() throws -> () -> Void {
        guard let h = dlopen(bundle + "/Frameworks/Python.framework/Python", RTLD_NOW | RTLD_GLOBAL) else {
            throw NSError(domain: "Cluster", code: 1, userInfo: [NSLocalizedDescriptionKey: "Python didn't load: " + (dlerror().map { String(cString: $0) } ?? "?")])
        }
        func symbol(_ name: String) throws -> UnsafeMutableRawPointer {
            guard let s = dlsym(h, name) else {
                throw NSError(domain: "Cluster", code: 2, userInfo: [NSLocalizedDescriptionKey: "Python has no \(name)."])
            }
            return s
        }
        let initialize = unsafeBitCast(try symbol("Py_Initialize"), to: VoidFn.self)
        let save = unsafeBitCast(try symbol("PyEval_SaveThread"), to: SaveFn.self)
        runString = unsafeBitCast(try symbol("PyRun_SimpleString"), to: RunFn.self)
        gilEnsure = unsafeBitCast(try symbol("PyGILState_Ensure"), to: EnsureFn.self)
        gilRelease = unsafeBitCast(try symbol("PyGILState_Release"), to: ReleaseFn.self)
        handle = h
        // (Py_Initialize, then the lock on Python let go: each run, and each stop, takes it as it needs it)
        return { initialize(); _ = save() }
    }

    // The service started with these settings (written for htmember to read: Python's environment is only read
    // once, as it starts).
    func start(_ settings: [String: Any]) throws {
        lock.lock()
        defer { lock.unlock() }
        let data = try JSONSerialization.data(withJSONObject: settings)
        try data.write(to: Self.settingsFile, options: .atomic)
        if thread == nil {
            let begin = try load()
            setenv("PYTHONHOME", bundle + "/python", 1)
            setenv("PYTHONPATH", bundle + "/cluster-node", 1)
            setenv("PYTHONDONTWRITEBYTECODE", "1", 1)
            setenv("PYTHONUNBUFFERED", "1", 1)
            setenv("PYTHONUTF8", "1", 1)
            setenv("NO_COLOR", "1", 1)
            let t = Thread { [weak self] in
                begin()
                self?.loop()
            }
            t.name = "cluster-python"
            t.stackSize = 16 << 20
            thread = t
            t.start()
        }
        wanted = true
        lastError = ""
        wake.signal()
    }

    private func loop() {
        let code = """
        import json, os, sys
        c = json.load(open(os.path.join(os.environ["HOME"], "Library", "Application Support", "cluster-member.json"), encoding="utf-8"))
        if c["code"] not in sys.path:
            sys.path.insert(0, c["code"])
        import htmember
        htmember.run(c["code"], json.dumps(c["env"]))
        """
        while true {
            wake.wait()
            lock.lock()
            let go = wanted && !running
            if go { running = true }
            lock.unlock()
            if !go { continue }
            guard let ensure = gilEnsure, let release = gilRelease, let run = runString else { break }
            let g = ensure()
            let rc = code.withCString { run($0) }
            release(g)
            lock.lock()
            running = false
            wanted = false
            if rc != 0 { lastError = "The cluster's service stopped with an error (the app's log says why)." }
            lock.unlock()
        }
    }

    func stop() {
        lock.lock()
        wanted = false
        let on = running
        lock.unlock()
        guard on, let ensure = gilEnsure, let release = gilRelease, let run = runString else { return }
        DispatchQueue.global().async {
            let g = ensure()
            _ = "import htmember\nhtmember.stop()\n".withCString { run($0) }
            release(g)
        }
    }
}

@objc(MemberPlugin)
public class MemberPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MemberPlugin"
    public let jsName = "Member"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "allowTakes", returnType: CAPPluginReturnPromise),
    ]
    static let PORT = 47830
    static let NAME = "^[A-Za-z0-9][A-Za-z0-9 _.+'-]{0,39}$"
    static let SEED = "^[A-Za-z0-9.:\\[\\]-]{1,100}$"
    private let saved = UserDefaults.standard
    private var timer: Timer?
    private var port = PORT
    private var selfTest: Bool { ProcessInfo.processInfo.arguments.contains("-HTSelfTest") }

    override public func load() {
        // (on again as the app opens, if it was on)
        if saved.bool(forKey: "member.on"), ClusterPython.shared.available, !selfTest {
            DispatchQueue.main.async { try? self.begin(seeds: self.saved.stringArray(forKey: "member.seeds") ?? [], test: nil) }
        }
    }

    private var name: String { saved.string(forKey: "member.name") ?? "iPhone" }

    private func status() -> [String: Any] {
        let py = ClusterPython.shared
        return ["available": py.available, "on": saved.bool(forKey: "member.on") || py.running, "running": py.running, "name": name,
                "address": ClusterNative.tailscaleAddress(), "port": port, "error": py.lastError, "platform": "ios"]
    }

    private func begin(seeds: [String], test: [String: Any]?) throws {
        guard ClusterPython.shared.available else {
            throw NSError(domain: "Cluster", code: 3, userInfo: [NSLocalizedDescriptionKey: "This app has no Python of its own (only the Cluster app has it)."])
        }
        // (UIKit's readings on the main thread, now and every 10 s while it's on: Capacitor calls plugins on its own)
        DispatchQueue.main.async {
            ClusterNative.lookOnMain()
            if self.timer == nil {
                self.timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in ClusterNative.lookOnMain() }
            }
        }
        let state = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("cluster-state")
        try? FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        port = (test?["port"] as? NSNumber)?.intValue ?? Self.PORT
        var env: [String: String] = [
            "HT_CLUSTER_PLATFORM": "ios", "HT_CLUSTER_NAME": name, "HT_CLUSTER_TS_IP": ClusterNative.tailscaleAddress(),
            "HT_CLUSTER_SEEDS": seeds.joined(separator: ","), "HT_CLUSTER_STATE": state.path, "HT_CLUSTER_PORT": String(port),
            "HT_CLUSTER_NATIVE_CALL": String(UInt(bitPattern: unsafeBitCast(htNativeCall, to: Int.self))),
            "HT_CLUSTER_NATIVE_FREE": String(UInt(bitPattern: unsafeBitCast(htNativeFree, to: Int.self))),
        ]
        if test != nil { env["HT_CLUSTER_SIMULATE"] = "1" } // (the build's simulator check only: see start)
        try ClusterPython.shared.start(["code": Bundle.main.bundlePath + "/cluster-node", "env": env])
    }

    @objc func start(_ call: CAPPluginCall) {
        if let n = call.getString("name"), n.range(of: Self.NAME, options: .regularExpression) != nil { saved.set(n, forKey: "member.name") }
        var seeds = (call.getArray("seeds") ?? []).compactMap { $0 as? String }.filter { $0.range(of: Self.SEED, options: .regularExpression) != nil }
        seeds = Array(seeds.prefix(32))
        // (the build's simulator check, launched with -HTSelfTest: its own port beside the simulated Pi's, and the
        // service simulating its Tailscale, as the checks' phones do; never otherwise)
        let test: [String: Any]? = selfTest ? call.getObject("selfTest").map { o in o.mapValues { $0 as Any } } : nil
        if test == nil {
            if !seeds.isEmpty { saved.set(seeds, forKey: "member.seeds") }
            saved.set(true, forKey: "member.on")
        }
        do {
            try begin(seeds: seeds.isEmpty ? (saved.stringArray(forKey: "member.seeds") ?? []) : seeds, test: test)
            call.resolve(status())
        } catch {
            call.reject("This iPhone couldn't join: " + error.localizedDescription)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        saved.set(false, forKey: "member.on")
        ClusterPython.shared.stop()
        DispatchQueue.main.async {
            self.timer?.invalidate()
            self.timer = nil
        }
        call.resolve(status())
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(status())
    }

    @objc func allowTakes(_ call: CAPPluginCall) {
        call.resolve(status())
    }
}
