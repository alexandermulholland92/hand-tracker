"""
winsys.py - what Cluster's service needs from Windows itself when it runs on a Windows PC (the user,
2026-11-22: "this PC joins as a member"), through ctypes and Windows' own commands (no packages): the
processor's use and name, memory, power (wall or battery), uptime, the fixed drives, the Wi-Fi (netsh),
a job's priority, and pausing or stopping a job's programs (each with the programs it started).

Only used on Windows (os.name == "nt"). The service's modules import it when they run there.
"""

import ctypes
import os
import re
import shutil
import subprocess
from ctypes import wintypes

NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW: a console program the service (pythonw) runs opens no window of its own
# A job's priority (the PC's own choice, jobs.py's "priority" setting): Windows' priority classes.
PRIORITIES = [["low", "Low"], ["belowNormal", "Below normal"], ["normal", "Normal"], ["aboveNormal", "Above normal"], ["high", "High"]]
CLASSES = {"low": 0x40, "belowNormal": 0x4000, "normal": 0x20, "aboveNormal": 0x8000, "high": 0x80}
DEFAULT_PRIORITY = "belowNormal"

PROCESS_SET_INFORMATION = 0x0200
PROCESS_SUSPEND_RESUME = 0x0800
TH32CS_SNAPPROCESS = 0x2
DRIVE_FIXED = 3

_k32 = ctypes.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None
_ntdll = ctypes.WinDLL("ntdll") if os.name == "nt" else None


class FILETIME(ctypes.Structure):
    _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD), ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


class SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [("ACLineStatus", ctypes.c_ubyte), ("BatteryFlag", ctypes.c_ubyte), ("BatteryLifePercent", ctypes.c_ubyte),
                ("SystemStatusFlag", ctypes.c_ubyte), ("BatteryLifeTime", wintypes.DWORD), ("BatteryFullLifeTime", wintypes.DWORD)]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


if _k32:
    _k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    _k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _k32.GetTickCount64.restype = ctypes.c_ulonglong
    _k32.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
    _ntdll.NtSuspendProcess.argtypes = [wintypes.HANDLE]
    _ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]


def creationflags(priority):
    """How the service starts a job's program: no window of its own, at the PC's chosen priority."""
    return NO_WINDOW | CLASSES.get(priority, CLASSES[DEFAULT_PRIORITY])


def cpu_times():
    """(idle, total) since Windows started, in 100 ns (health.py's cpu_percent takes two of them)."""
    idle, kernel, user = FILETIME(), FILETIME(), FILETIME()
    if not _k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
        return None
    ft = lambda f: (f.hi << 32) | f.lo
    return ft(idle), ft(kernel) + ft(user)  # (kernel time counts the idle time too)


def memory():
    m = MEMORYSTATUSEX()
    m.dwLength = ctypes.sizeof(m)
    if not _k32.GlobalMemoryStatusEx(ctypes.byref(m)):
        return None
    return {"total": int(m.ullTotalPhys), "available": int(m.ullAvailPhys)}


def power():
    """{plugged (on wall power), battery (has one), level, charging}, or None."""
    s = SYSTEM_POWER_STATUS()
    if not _k32.GetSystemPowerStatus(ctypes.byref(s)):
        return None
    has_battery = s.BatteryFlag != 255 and not (s.BatteryFlag & 128)
    out = {"plugged": None if s.ACLineStatus == 255 else s.ACLineStatus == 1, "battery": has_battery, "charging": bool(s.BatteryFlag & 8)}
    if has_battery and s.BatteryLifePercent != 255:
        out["level"] = int(s.BatteryLifePercent)
    return out


def uptime():
    return int(_k32.GetTickCount64() // 1000)


def cpu_name():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
            return " ".join(str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).split())
    except OSError:
        return None


def drives():
    """The fixed drives: [{mount, total, free}]."""
    out = []
    mask = _k32.GetLogicalDrives()
    for i in range(26):
        if mask & (1 << i):
            root = "%s:\\" % chr(65 + i)
            if _k32.GetDriveTypeW(root) == DRIVE_FIXED:
                try:
                    u = shutil.disk_usage(root)
                    out.append({"mount": root, "total": u.total, "free": u.free})
                except OSError:
                    pass
    return out


def parse_netsh_wifi(text):
    """`netsh wlan show interfaces` -> {iface, ssid, mhz, signal (%), dbm (from it)} of the connected one, or None."""
    for block in re.split(r"\r?\n\s*\r?\n", text or ""):
        f = {}
        for line in block.splitlines():
            m = re.match(r"\s*([A-Za-z][A-Za-z ]*?)\s+:\s?(.*)$", line)
            if m:
                f.setdefault(m.group(1).strip().lower(), m.group(2).strip())
        if f.get("state", "").lower() != "connected":
            continue
        signal = re.match(r"(\d+)", f.get("signal", ""))
        ch = re.match(r"(\d+)", f.get("channel", ""))
        mhz = None
        if ch:
            c = int(ch.group(1))
            mhz = (2484 if c == 14 else 2407 + 5 * c) if c <= 14 else 5000 + 5 * c
        out = {"iface": f.get("name") or "Wi-Fi", "ssid": f.get("ssid"), "mhz": mhz}
        if signal:
            out["signal"] = int(signal.group(1))
            out["dbm"] = int(round(out["signal"] / 2.0 - 100))
        return out
    return None


def wifi():
    try:
        p = subprocess.run(["netsh", "wlan", "show", "interfaces"], capture_output=True, text=True, timeout=8, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return parse_netsh_wifi(p.stdout) if p.returncode == 0 else None


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]


class MIB_IF_ROW2(ctypes.Structure):  # (netioapi.h: one network adapter's counters, 1352 bytes)
    _fields_ = [("InterfaceLuid", ctypes.c_ulonglong), ("InterfaceIndex", wintypes.ULONG), ("InterfaceGuid", GUID),
                ("Alias", ctypes.c_wchar * 257), ("Description", ctypes.c_wchar * 257), ("PhysicalAddressLength", wintypes.ULONG),
                ("PhysicalAddress", ctypes.c_ubyte * 32), ("PermanentPhysicalAddress", ctypes.c_ubyte * 32), ("Mtu", wintypes.ULONG),
                ("Type", wintypes.ULONG), ("TunnelType", ctypes.c_int), ("MediaType", ctypes.c_int), ("PhysicalMediumType", ctypes.c_int),
                ("AccessType", ctypes.c_int), ("DirectionType", ctypes.c_int), ("Flags", ctypes.c_ubyte), ("OperStatus", ctypes.c_int),
                ("AdminStatus", ctypes.c_int), ("MediaConnectState", ctypes.c_int), ("NetworkGuid", GUID), ("ConnectionType", ctypes.c_int),
                ("TransmitLinkSpeed", ctypes.c_ulonglong), ("ReceiveLinkSpeed", ctypes.c_ulonglong), ("InOctets", ctypes.c_ulonglong),
                ("InUcastPkts", ctypes.c_ulonglong), ("InNUcastPkts", ctypes.c_ulonglong), ("InDiscards", ctypes.c_ulonglong),
                ("InErrors", ctypes.c_ulonglong), ("InUnknownProtos", ctypes.c_ulonglong), ("InUcastOctets", ctypes.c_ulonglong),
                ("InMulticastOctets", ctypes.c_ulonglong), ("InBroadcastOctets", ctypes.c_ulonglong), ("OutOctets", ctypes.c_ulonglong),
                ("OutUcastPkts", ctypes.c_ulonglong), ("OutNUcastPkts", ctypes.c_ulonglong), ("OutDiscards", ctypes.c_ulonglong),
                ("OutErrors", ctypes.c_ulonglong), ("OutUcastOctets", ctypes.c_ulonglong), ("OutMulticastOctets", ctypes.c_ulonglong),
                ("OutBroadcastOctets", ctypes.c_ulonglong), ("OutQLen", ctypes.c_ulonglong)]


def net_bytes():
    """What this PC's own network adapters (its Wi-Fi and Ethernet: not Tailscale, WSL's or other made-up ones) have
    received and sent since Windows started: {"rx", "tx", "names", "mbit" (the fastest one's link, Mbit/s)}, or None."""
    iphlp = ctypes.WinDLL("iphlpapi")
    table = ctypes.c_void_p()
    if iphlp.GetIfTable2(ctypes.byref(table)) != 0 or not table.value:
        return None
    try:
        n = ctypes.cast(table, ctypes.POINTER(wintypes.ULONG))[0]
        rows = ctypes.cast(table.value + 8, ctypes.POINTER(MIB_IF_ROW2))  # (the rows start 8 bytes in: their alignment)
        out = {"rx": 0, "tx": 0, "names": [], "mbit": 0}
        for i in range(n):
            r = rows[i]
            hardware, filtering = r.Flags & 1, r.Flags & 2
            if not hardware or filtering or r.OperStatus != 1 or r.Type not in (6, 71):  # (Ethernet, Wi-Fi; up)
                continue
            out["rx"] += r.InOctets
            out["tx"] += r.OutOctets
            out["names"].append(r.Alias)
            out["mbit"] = max(out["mbit"], int(min(r.ReceiveLinkSpeed, r.TransmitLinkSpeed) // 1000000))
        return out
    finally:
        iphlp.FreeMibTable(table)


def tree(pid):
    """pid and every process it started (and they started), as Windows lists them now."""
    snap = _k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return [pid]
    children = {}
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = _k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            children.setdefault(e.th32ParentProcessID, []).append(e.th32ProcessID)
            ok = _k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        _k32.CloseHandle(snap)
    out, todo = [], [pid]
    while todo:
        p = todo.pop()
        if p in out:
            continue
        out.append(p)
        todo.extend(c for c in children.get(p, []) if c != p)
    return out


def exe_of(pid):
    """A running process's program ("wsl.exe"), or None if no process has that id now."""
    snap = _k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return None
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = _k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            if e.th32ProcessID == pid:
                return e.szExeFile
            ok = _k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        _k32.CloseHandle(snap)
    return None


def wsl_distros():
    """The names of WSL's Linuxes for this account, from the registry (WSL isn't started to ask it)."""
    import winreg
    out = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Lxss") as k:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(k, i)
                except OSError:
                    break
                i += 1
                try:
                    with winreg.OpenKey(k, sub) as s:
                        out.append(str(winreg.QueryValueEx(s, "DistributionName")[0]))
                except OSError:
                    continue
    except OSError:
        pass
    return out


def _each(pid, access, fn):
    done = 0
    for p in tree(pid):
        h = _k32.OpenProcess(access, False, p)
        if h:
            try:
                fn(h)
                done += 1
            finally:
                _k32.CloseHandle(h)
    return done


def pause(pid, on):
    """A job's programs held still (on) or carried on (off)."""
    return _each(pid, PROCESS_SUSPEND_RESUME, _ntdll.NtSuspendProcess if on else _ntdll.NtResumeProcess)


def set_priority(pid, priority):
    """A running job's programs at the PC's chosen priority now (it changed while they ran)."""
    cls = CLASSES.get(priority, CLASSES[DEFAULT_PRIORITY])
    return _each(pid, PROCESS_SET_INFORMATION, lambda h: _k32.SetPriorityClass(h, cls))


def stop(pid):
    """A job's programs stopped, each with the ones it started (taskkill /T): True if they were."""
    try:
        p = subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=10, creationflags=NO_WINDOW)
        return p.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False
