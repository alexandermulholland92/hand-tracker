import Capacitor
import Darwin
import Foundation
import UIKit
import UniformTypeIdentifiers

// ---------- the FTP link to a Pi's shared folders (the Cluster app's page: a Pi's "Shared folders") ----------
// As the Android app's FtpPlugin.java (the user: phones "mount them as an ftp link built into the app"; the Pi's side is
// cluster/node/modules/ftp.py). It logs in as this iPhone of the cluster: its name and its own key (the one its member
// service gave the Pis: cluster-state/phone-key), so this iPhone must have been in the cluster.
//   list({ host, path }) -> { path, entries: [{ name, dir, size, time }] }
//   download({ host, path, name, size }) -> { saved, file, size }  into the app's own files (the Files app: On My iPhone,
//                                                                  Cluster), "progress" { name, got, size } as it goes
//   upload({ host, dir }) -> { name, size }  a file picked on the iPhone, sent into that folder
//   mkdir({ host, path }) -> {}
// Only over Tailscale (the Pi takes nothing else); passive FTP, binary. Written here (an iPhone has no FTP of its own).

// A small FTP client: its control connection, passive data connections (EPSV, else PASV), on the calling thread.
final class FtpClient {
    struct Failure: LocalizedError {
        let text: String
        var errorDescription: String? { text }
    }

    private let host: String
    private let seconds: Int
    private var control: Int32 = -1
    private var buffer = Data()

    init(host: String, port: Int, user: String, key: String, seconds: Int = 30) throws {
        self.host = host
        self.seconds = seconds
        control = try FtpClient.open(host, port, 10, seconds)
        let (code, _) = try reply()
        guard code == 220 else {
            close()
            throw Failure(text: "The device's FTP link didn't answer (is Get the FTP server done on it?).")
        }
        do {
            let (u, _) = try ask("USER " + user)
            if u == 331 {
                let (p, _) = try ask("PASS " + key)
                guard p == 230 else { throw Failure(text: "") }
            } else if u != 230 {
                throw Failure(text: "")
            }
        } catch {
            close()
            throw Failure(text: "The device didn't take this iPhone (has it seen it in the cluster yet? a minute after it joins).")
        }
        try expect("TYPE I", 200 ... 299)
    }

    deinit { close() }

    func close() {
        if control >= 0 {
            _ = try? write("QUIT\r\n")
            Darwin.close(control)
            control = -1
        }
    }

    // (a connection within `wait` seconds, then each read and write within `seconds`; no SIGPIPE when it's gone)
    private static func open(_ host: String, _ port: Int, _ wait: Int, _ seconds: Int) throws -> Int32 {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var found: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &found) == 0, let first = found else {
            throw Failure(text: "\(host) wasn't found.")
        }
        defer { freeaddrinfo(found) }
        var p: UnsafeMutablePointer<addrinfo>? = first
        while let a = p {
            p = a.pointee.ai_next
            let fd = socket(a.pointee.ai_family, a.pointee.ai_socktype, a.pointee.ai_protocol)
            if fd < 0 { continue }
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            let flags = fcntl(fd, F_GETFL, 0)
            _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
            var ok = Darwin.connect(fd, a.pointee.ai_addr, a.pointee.ai_addrlen) == 0
            if !ok && errno == EINPROGRESS {
                var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                if poll(&pfd, 1, Int32(wait * 1000)) == 1 {
                    var err: Int32 = 0
                    var len = socklen_t(MemoryLayout<Int32>.size)
                    ok = getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err == 0
                }
            }
            _ = fcntl(fd, F_SETFL, flags)
            if ok {
                var tv = timeval(tv_sec: seconds, tv_usec: 0)
                setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                return fd
            }
            Darwin.close(fd)
        }
        throw Failure(text: "\(host) didn't answer.")
    }

    private static func send(_ fd: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var at = 0
            while at < raw.count {
                let n = Darwin.send(fd, base + at, raw.count - at, 0)
                if n <= 0 { throw Failure(text: "The device's FTP link stopped answering.") }
                at += n
            }
        }
    }

    private func write(_ text: String) throws {
        try FtpClient.send(control, Data(text.utf8))
    }

    private func line() throws -> String {
        while true {
            if let end = buffer.firstIndex(of: 10) {
                var bytes = buffer[buffer.startIndex..<end]
                if bytes.last == 13 { bytes = bytes.dropLast() }
                let text = String(decoding: bytes, as: UTF8.self)
                buffer.removeSubrange(buffer.startIndex...end)
                return text
            }
            var chunk = [UInt8](repeating: 0, count: 4096)
            let size = chunk.count
            let n = recv(control, &chunk, size, 0)
            if n <= 0 { throw Failure(text: "The device's FTP link stopped answering.") }
            buffer.append(contentsOf: chunk[0..<n])
        }
    }

    // A reply: its code, and its text (its lines, for one of several).
    private func reply() throws -> (Int, String) {
        let first = try line()
        guard first.count >= 3, let code = Int(first.prefix(3)) else { throw Failure(text: "The device's FTP link said something unexpected.") }
        var text = String(first.dropFirst(4))
        if first.dropFirst(3).first == "-" {
            let end = String(first.prefix(3)) + " "
            while true {
                let more = try line()
                if more.hasPrefix(end) {
                    text += "\n" + more.dropFirst(4)
                    break
                }
                text += "\n" + more
            }
        }
        return (code, text)
    }

    private func ask(_ command: String) throws -> (Int, String) {
        try write(command + "\r\n")
        return try reply()
    }

    @discardableResult
    private func expect(_ command: String, _ ok: ClosedRange<Int>) throws -> String {
        let (code, text) = try ask(command)
        guard ok.contains(code) else { throw Failure(text: text.isEmpty ? "The device said no (\(code))." : text) }
        return text
    }

    // A data connection, the Pi's port for it as it says (its own address: the control connection's).
    private func passive() throws -> Int32 {
        var port = 0
        let (code, text) = try ask("EPSV")
        if code == 229, let a = text.range(of: "(|||"), let b = text[a.upperBound...].firstIndex(of: "|") {
            port = Int(text[a.upperBound..<b]) ?? 0
        } else {
            let (c2, t2) = try ask("PASV")
            if c2 == 227, let open = t2.firstIndex(of: "("), let shut = t2[open...].firstIndex(of: ")") {
                let n = t2[t2.index(after: open)..<shut].split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
                if n.count == 6 { port = n[4] * 256 + n[5] }
            }
        }
        guard port > 0 && port < 65536 else { throw Failure(text: "The device's FTP link gave no way to send data.") }
        return try FtpClient.open(host, port, 10, seconds)
    }

    // A transfer: its data connection opened, the command sent (150 or 125: it goes), then `move` with it, then its end.
    private func transfer(_ command: String, _ move: (Int32) throws -> Void) throws {
        let data = try passive()
        var open = true
        defer { if open { Darwin.close(data) } }
        let (code, text) = try ask(command)
        guard code == 150 || code == 125 else { throw Failure(text: text.isEmpty ? "The device said no (\(code))." : text) }
        try move(data)
        Darwin.close(data)
        open = false
        let (done, said) = try reply()
        guard done == 226 || done == 250 else { throw Failure(text: said.isEmpty ? "It didn't finish (\(done))." : said) }
    }

    private static func receive(_ fd: Int32, _ each: (Data) throws -> Void) throws {
        var chunk = [UInt8](repeating: 0, count: 256 << 10)
        let size = chunk.count
        while true {
            let n = recv(fd, &chunk, size, 0)
            if n < 0 { throw Failure(text: "It stopped coming (nothing for a while).") }
            if n == 0 { return }
            try each(Data(chunk[0..<n]))
        }
    }

    // A folder's files and folders (MLSD: pyftpdlib's, its links to folders followed, as folders). Its lines split as
    // bytes, as line() does: in a Swift string "\r\n" is one character, neither "\r" nor "\n" (split on those, each name
    // kept its line's end; found in the simulator check, 2026-11-25).
    func list(_ path: String) throws -> [[String: Any]] {
        var all = Data()
        try transfer("MLSD " + path) { fd in try FtpClient.receive(fd) { all.append($0) } }
        var out: [[String: Any]] = []
        for piece in all.split(separator: 10) {
            let raw = String(decoding: piece.last == 13 ? piece.dropLast() : piece, as: UTF8.self)
            guard let space = raw.firstIndex(of: " ") else { continue }
            let name = String(raw[raw.index(after: space)...])
            var facts: [String: String] = [:]
            for f in raw[..<space].split(separator: ";") {
                let kv = f.split(separator: "=", maxSplits: 1)
                if kv.count == 2 { facts[kv[0].lowercased()] = String(kv[1]) }
            }
            let type = (facts["type"] ?? "").lowercased()
            if type == "cdir" || type == "pdir" || name == "." || name == ".." { continue }
            var time: Int64 = 0
            if let m = facts["modify"], m.count >= 14 {
                var c = DateComponents()
                c.timeZone = TimeZone(identifier: "UTC")
                let d = Array(m)
                let num = { (a: Int, b: Int) in Int(String(d[a..<b])) ?? 0 }
                c.year = num(0, 4)
                c.month = num(4, 6)
                c.day = num(6, 8)
                c.hour = num(8, 10)
                c.minute = num(10, 12)
                c.second = num(12, 14)
                if let date = Calendar(identifier: .gregorian).date(from: c) { time = Int64(date.timeIntervalSince1970 * 1000) }
            }
            out.append(["name": name, "dir": type == "dir", "size": Int64(facts["size"] ?? "") ?? 0, "time": time])
        }
        return out
    }

    func retrieve(_ path: String, to file: URL, progress: (Int64) -> Void) throws -> Int64 {
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw Failure(text: "It couldn't be saved here.") }
        let out = try FileHandle(forWritingTo: file)
        defer { try? out.close() }
        var got: Int64 = 0
        var said = Date()
        try transfer("RETR " + path) { fd in
            try FtpClient.receive(fd) { chunk in
                try out.write(contentsOf: chunk)
                got += Int64(chunk.count)
                if Date().timeIntervalSince(said) > 0.5 {
                    said = Date()
                    progress(got)
                }
            }
        }
        progress(got)
        return got
    }

    func store(_ path: String, from file: URL) throws -> Int64 {
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        var sent: Int64 = 0
        try transfer("STOR " + path) { fd in
            while let chunk = try input.read(upToCount: 256 << 10), !chunk.isEmpty {
                try FtpClient.send(fd, chunk)
                sent += Int64(chunk.count)
            }
        }
        return sent
    }

    func mkdir(_ path: String) throws {
        try expect("MKD " + path, 250 ... 257)
    }
}

@objc(FtpPlugin)
public class FtpPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "FtpPlugin"
    public let jsName = "Ftp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "upload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
    ]
    static let PORT = 2121
    static let HOST = "^(100\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)$"
    static let PATH = "^/[^\\x00-\\x1f]{0,1000}$"
    static let NAME = "^[^/\\\\\\x00-\\x1f]{1,200}$"
    private let queue = DispatchQueue(label: "cluster-ftp", attributes: .concurrent)
    private var picking: (call: CAPPluginCall, host: String, dir: String)?
    // (the build's simulator check only, launched with -HTSelfTest: the simulated Pi's FTP link, on this computer)
    private var selfTest: Bool { ProcessInfo.processInfo.arguments.contains("-HTSelfTest") }

    private func client(_ host: String) throws -> FtpClient {
        guard host.range(of: Self.HOST, options: .regularExpression) != nil || (selfTest && host == "127.0.0.1") else {
            throw FtpClient.Failure(text: "That isn't a device of the cluster.")
        }
        let state = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("cluster-state")
        guard let key = (try? String(contentsOf: state.appendingPathComponent("phone-key"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else {
            throw FtpClient.Failure(text: "Turn on This iPhone in the cluster first: the devices know this iPhone by its key.")
        }
        let name = UserDefaults.standard.string(forKey: "member.name") ?? "iPhone"
        return try FtpClient(host: host, port: Self.PORT, user: name, key: key)
    }

    private func path(_ call: CAPPluginCall, _ key: String) throws -> String {
        let p = call.getString(key) ?? "/"
        guard p.range(of: Self.PATH, options: .regularExpression) != nil else { throw FtpClient.Failure(text: "Not a folder there.") }
        return p
    }

    // (each on its own thread: a transfer takes as long as it takes)
    private func work(_ call: CAPPluginCall, _ body: @escaping () throws -> [String: Any]) {
        queue.async {
            do {
                call.resolve(try body())
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        work(call) {
            let p = try self.path(call, "path")
            let f = try self.client(call.getString("host") ?? "")
            defer { f.close() }
            let entries = try f.list(p)
            return ["path": p, "entries": entries]
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        work(call) {
            let p = try self.path(call, "path")
            let f = try self.client(call.getString("host") ?? "")
            defer { f.close() }
            try f.mkdir(p)
            return [:]
        }
    }

    // Into the app's own files (Documents: the Files app shows them, On My iPhone, Cluster), by its name (one there
    // already kept: "name (2)"); what came only partly, not kept.
    @objc func download(_ call: CAPPluginCall) {
        work(call) {
            let p = try self.path(call, "path")
            let name = call.getString("name") ?? ""
            guard name.range(of: Self.NAME, options: .regularExpression) != nil, name != ".", name != ".." else { throw FtpClient.Failure(text: "Not a file there.") }
            let size = Int64(call.getDouble("size") ?? -1)
            let f = try self.client(call.getString("host") ?? "")
            defer { f.close() }
            let file = FtpPlugin.unique(name)
            do {
                let got = try f.retrieve(p, to: file) { got in
                    self.notifyListeners("progress", data: ["name": name, "got": got, "size": size])
                }
                return ["saved": "Files: On My iPhone, Cluster", "file": file.lastPathComponent, "size": got]
            } catch {
                try? FileManager.default.removeItem(at: file)
                throw error
            }
        }
    }

    static func unique(_ name: String) -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var url = docs.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = docs.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
            n += 1
        }
        return url
    }

    // A file picked on the iPhone (a copy of it, the picker's), sent into that folder by its own name.
    @objc func upload(_ call: CAPPluginCall) {
        let host = call.getString("host") ?? ""
        let dir: String
        do {
            dir = try path(call, "dir")
        } catch {
            return call.reject(error.localizedDescription)
        }
        // (the build's simulator check: a file of the app's own, as it'd be picked, sent by the name it's given)
        if selfTest, let file = call.getString("testFile"), let name = call.getString("testAs") {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            return send(call, host, dir, docs.appendingPathComponent(file), name, keep: true)
        }
        DispatchQueue.main.async {
            guard self.picking == nil, let top = self.bridge?.viewController else { return call.reject("Another file is being picked.") }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.item], asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.picking = (call, host, dir)
            top.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let p = picking else { return }
        picking = nil
        guard let url = urls.first else { return p.call.reject("No file picked.") }
        send(p.call, p.host, p.dir, url, url.lastPathComponent, keep: false)
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        picking?.call.reject("No file picked.")
        picking = nil
    }

    private func send(_ call: CAPPluginCall, _ host: String, _ dir: String, _ file: URL, _ name: String, keep: Bool) {
        work(call) {
            defer { if !keep { try? FileManager.default.removeItem(at: file) } }
            guard name.range(of: Self.NAME, options: .regularExpression) != nil, name != ".", name != ".." else { throw FtpClient.Failure(text: "That file's name can't be used there.") }
            let f = try self.client(host)
            defer { f.close() }
            let sent = try f.store(dir.replacingOccurrences(of: "/+$", with: "", options: .regularExpression) + "/" + name, from: file)
            return ["name": name, "size": sent]
        }
    }
}
