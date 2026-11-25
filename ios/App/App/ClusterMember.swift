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
// The service asks the app for what only the app can tell (its readings: battery, memory, storage, ...), and has it run
// its ffmpeg for a job's conversions (ClusterFFmpeg.framework), with ht_native_call (phonesys.py), a C function whose
// address it's given.

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
        let a = (try? JSONSerialization.jsonObject(with: Data(args.utf8))) as? [String: Any] ?? [:]
        var answer: [String: Any]
        do {
            switch name {
            case "readings":
                answer = readings()
            // a job's ffmpeg (phonetools.py), as on Android: no ffprobe here (the jobs ask ffmpeg -i instead)
            case "ffmpeg-start", "ffmpeg-run":
                if a["probe"] as? Bool == true { return json(["ok": false, "error": "No ffprobe on an iPhone."]) }
                let args = (a["args"] as? [Any] ?? []).map { "\($0)" }
                if name == "ffmpeg-start" {
                    let id = try ClusterFFmpeg.shared.start(args)
                    answer = ["id": id]
                } else {
                    answer = try ClusterFFmpeg.shared.runToEnd(args, timeout: (a["timeout"] as? NSNumber)?.doubleValue ?? 60)
                }
            case "ffmpeg-poll":
                answer = ClusterFFmpeg.shared.poll((a["id"] as? NSNumber)?.intValue ?? -1)
            case "ffmpeg-cancel":
                ClusterFFmpeg.shared.cancel((a["id"] as? NSNumber)?.intValue ?? -1)
                answer = ["ok": true]
            default:
                answer = ["ok": false, "error": "This iPhone can't do that yet (\(name))."]
            }
        } catch {
            answer = ["ok": false, "error": error.localizedDescription]
        }
        return json(answer)
    }

    static func json(_ answer: [String: Any]) -> String {
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

// The app's ffmpeg (ClusterFFmpeg.framework: FFmpeg 8.0 with x264, scripts/build-ffmpeg-ios.sh; only the Cluster app
// has it), loaded once it's first needed: one run at a time, in order (its tool keeps its state in globals: each run
// starts afresh, ios/ffmpeg/ht_ffmpeg.c). Each run's log and progress (ffmpeg's own -progress) go into files of its
// own, read as it's asked how it's doing.
final class ClusterFFmpeg {
    static let shared = ClusterFFmpeg()
    private typealias InitFn = @convention(c) () -> Int32
    private typealias RunFn = @convention(c) (Int32, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?, UnsafePointer<CChar>?) -> Int32
    private typealias CancelFn = @convention(c) () -> Void

    final class Run {
        let log: URL
        let progress: URL
        var logAt: UInt64 = 0
        var done = false
        var code = -1
        var cancelled = false
        let finished = DispatchSemaphore(value: 0)
        init(_ id: Int) {
            let tmp = FileManager.default.temporaryDirectory
            log = tmp.appendingPathComponent("ffmpeg-\(id).log")
            progress = tmp.appendingPathComponent("ffmpeg-\(id).progress")
        }
    }

    private var runFn: RunFn?
    private var cancelFn: CancelFn?
    private let queue = DispatchQueue(label: "cluster-ffmpeg")
    private let lock = NSLock()
    private var nextId = 1
    private var runs: [Int: Run] = [:]
    private var current = 0

    var path: String { Bundle.main.bundlePath + "/Frameworks/ClusterFFmpeg.framework/ClusterFFmpeg" }
    var available: Bool { FileManager.default.fileExists(atPath: path) }

    private func load() throws {
        if runFn != nil { return }
        guard let h = dlopen(path, RTLD_NOW) else {
            throw NSError(domain: "Cluster", code: 4, userInfo: [NSLocalizedDescriptionKey: "This app's ffmpeg didn't load: " + (dlerror().map { String(cString: $0) } ?? "?")])
        }
        guard let i = dlsym(h, "ht_ffmpeg_init"), let r = dlsym(h, "ht_ffmpeg_run"), let c = dlsym(h, "ht_ffmpeg_cancel"),
              unsafeBitCast(i, to: InitFn.self)() >= 0 else {
            throw NSError(domain: "Cluster", code: 5, userInfo: [NSLocalizedDescriptionKey: "This app's ffmpeg isn't as expected."])
        }
        runFn = unsafeBitCast(r, to: RunFn.self)
        cancelFn = unsafeBitCast(c, to: CancelFn.self)
    }

    func start(_ args: [String]) throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        try load()
        guard let run = runFn else { throw NSError(domain: "Cluster", code: 6, userInfo: [NSLocalizedDescriptionKey: "No ffmpeg."]) }
        let id = nextId
        nextId += 1
        let r = Run(id)
        FileManager.default.createFile(atPath: r.log.path, contents: nil)
        runs[id] = r
        // (its progress for the jobs' watch, phonetools.FfmpegProc: never asks anything of stdin)
        let argv = ["ffmpeg", "-nostdin", "-progress", "file:" + r.progress.path, "-nostats"] + args
        queue.async { [self] in
            lock.lock()
            let go = !r.cancelled
            if go { current = id }
            lock.unlock()
            var code: Int32 = 255
            if go {
                var cargs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
                cargs.append(nil)
                code = r.log.path.withCString { logPath in
                    cargs.withUnsafeMutableBufferPointer { run(Int32(argv.count), $0.baseAddress, logPath) }
                }
                for p in cargs { free(p) }
            }
            lock.lock()
            r.done = true
            r.code = Int(code)
            if current == id { current = 0 }
            lock.unlock()
            r.finished.signal()
        }
        return id
    }

    // Its log since the last ask, its progress (time: ms of the output done) and, once it's done, its exit code.
    func poll(_ id: Int) -> [String: Any] {
        lock.lock()
        let found = runs[id]
        let done = found?.done ?? false
        let code = found?.code ?? -1
        lock.unlock()
        guard let r = found else { return ["ok": false, "error": "No such ffmpeg run."] }
        var out: [String: Any] = [:]
        if let h = try? FileHandle(forReadingFrom: r.log) {
            try? h.seek(toOffset: r.logAt)
            if let data = try? h.readToEnd(), !data.isEmpty {
                r.logAt += UInt64(data.count)
                out["log"] = String(decoding: data, as: UTF8.self)
            }
            try? h.close()
        }
        if let text = try? String(contentsOf: r.progress, encoding: .utf8),
           let line = text.split(separator: "\n").last(where: { $0.hasPrefix("out_time_us=") }),
           let us = Int64(line.dropFirst("out_time_us=".count)), us >= 0 {
            out["time"] = us / 1000
        }
        if done {
            out["done"] = true
            out["code"] = code
            lock.lock()
            runs[id] = nil
            lock.unlock()
            try? FileManager.default.removeItem(at: r.log)
            try? FileManager.default.removeItem(at: r.progress)
        }
        return out
    }

    func cancel(_ id: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard let r = runs[id] else { return }
        r.cancelled = true
        if current == id { cancelFn?() }
    }

    // A run to its end (phonetools.run: ffmpeg -i, say): its exit code and all it said.
    func runToEnd(_ args: [String], timeout: Double) throws -> [String: Any] {
        let id = try start(args)
        lock.lock()
        let r = runs[id]
        lock.unlock()
        guard let run = r else { return ["ok": false, "error": "No such ffmpeg run."] }
        if run.finished.wait(timeout: .now() + timeout) == .timedOut {
            cancel(id)
            _ = run.finished.wait(timeout: .now() + 15)
        }
        let a = poll(id)
        return ["code": a["code"] as? Int ?? 255, "log": a["log"] as? String ?? "", "output": ""]
    }

    // The build's simulator check only: x264 twice in a row (the second run starting afresh), the result read back,
    // and a run's progress as the jobs ask for it.
    static func selfTest() -> [String: Any] {
        guard shared.available else { return ["available": false] }
        var out: [String: Any] = ["available": true]
        let tmp = FileManager.default.temporaryDirectory
        let raw = tmp.appendingPathComponent("selftest.gray"), one = tmp.appendingPathComponent("selftest-1.mp4")
        let two = tmp.appendingPathComponent("selftest-2.mp4"), three = tmp.appendingPathComponent("selftest-3.mp4")
        var frames = Data(count: 64 * 64 * 30)
        for i in 0..<frames.count { frames[i] = UInt8((i * 7 + i / 4096 * 13) & 0xff) }
        try? frames.write(to: raw)
        func size(_ u: URL) -> Int { ((try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? NSNumber)?.intValue ?? 0 }
        func run(_ args: [String]) -> [String: Any] {
            let a = (try? JSONSerialization.jsonObject(with: Data(ClusterNative.call("ffmpeg-run", ClusterNative.json(["args": args, "timeout": 120])).utf8))) as? [String: Any] ?? [:]
            return a
        }
        let r1 = run(["-f", "rawvideo", "-pix_fmt", "gray", "-s", "64x64", "-r", "10", "-i", raw.path, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", one.path])
        let r2 = run(["-i", one.path, "-vf", "scale=32:32", "-c:v", "libx264", "-crf", "30", "-y", two.path])
        let r3 = run(["-i", two.path])
        out["runs"] = [["code": r1["code"] ?? -1, "bytes": size(one)], ["code": r2["code"] ?? -1, "bytes": size(two)],
                       ["code": r3["code"] ?? -1, "said": String((r3["log"] as? String ?? "").suffix(300))]]
        if (r1["code"] as? Int) != 0 { out["log1"] = String((r1["log"] as? String ?? "").suffix(1500)) }
        // (its progress, as the jobs follow a run)
        var polled = -1, code = -1
        if let id = try? shared.start(["-i", one.path, "-c:v", "libx264", "-preset", "veryfast", "-y", three.path]) {
            for _ in 0..<600 {
                let a = shared.poll(id)
                if let t = a["time"] as? Int64 { polled = max(polled, Int(t)) }
                if a["done"] as? Bool == true {
                    code = a["code"] as? Int ?? -1
                    break
                }
                Thread.sleep(forTimeInterval: 0.2)
            }
        }
        out["polled"] = ["time": polled, "code": code, "bytes": size(three)]
        let said = r3["log"] as? String ?? ""
        out["ok"] = (r1["code"] as? Int) == 0 && size(one) > 0 && (r2["code"] as? Int) == 0 && size(two) > 0
            && said.contains("Duration:") && said.contains("h264") && code == 0 && size(three) > 0 && polled > 0
        return out
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
        CAPPluginMethod(name: "selfTestFfmpeg", returnType: CAPPluginReturnPromise),
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

    // The build's simulator check only (launched with -HTSelfTest): the app's ffmpeg, as a job's conversions use it.
    @objc func selfTestFfmpeg(_ call: CAPPluginCall) {
        guard selfTest else { return call.reject("Only in the build's check.") }
        DispatchQueue.global().async {
            call.resolve(ClusterFFmpeg.selfTest())
        }
    }
}
