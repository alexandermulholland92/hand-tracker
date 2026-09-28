# input-helper.ps1 — moves the mouse pointer, clicks, scrolls and presses keys for Hand
# Tracker's hand mouse, floating keyboard and gesture actions (Windows). Started by
# electron/input.js; reads one command per line on stdin:
#   move X Y            pointer to X,Y (physical screen pixels, all monitors)
#   pos                 answers "pos X Y"
#   down|up|click|double left|right|middle
#   wheel N             N notches, positive = up
#   keydown|keyup|tap VK   a virtual-key code (decimal)
#   text BASE64         types the text (UTF-8, base64), any language, as Unicode keystrokes
#   ping                answers "pong"
# It only sends input the way a real mouse and keyboard do (SendInput); it doesn't read
# anything, and it stops when Hand Tracker closes its stdin.

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class HtInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1;

  public static void Init() {
    // Physical pixels on every monitor, whatever its scaling (per-monitor DPI aware v2).
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
  }

  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new Exception("Windows didn't accept the input (error " + Marshal.GetLastWin32Error() + ")");
  }
  static INPUT Mouse(uint flags, uint data) {
    var i = new INPUT { type = INPUT_MOUSE };
    i.u.mi.dwFlags = flags;
    i.u.mi.mouseData = data;
    return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.u.ki.wVk = vk;
    i.u.ki.wScan = scan;
    i.u.ki.dwFlags = flags;
    return i;
  }
  static bool IsExtended(int vk) {
    // Arrows, Insert/Delete, Home/End, Page Up/Down, right Ctrl/Alt, Windows keys, Num Lock, divide.
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0xA3 || vk == 0xA5 || vk == 0x90 || vk == 0x6F;
  }
  static uint[] ButtonFlags(string b) {
    if (b == "right") return new uint[] { 0x0008, 0x0010 };
    if (b == "middle") return new uint[] { 0x0020, 0x0040 };
    return new uint[] { 0x0002, 0x0004 };
  }

  public static string Run(string line) {
    var p = line.Trim().Split(' ');
    if (p.Length == 0 || p[0] == "") return null;
    switch (p[0]) {
      case "ping": return "pong";
      case "move": SetCursorPos(int.Parse(p[1]), int.Parse(p[2])); return null;
      case "pos": { POINT pt; GetCursorPos(out pt); return "pos " + pt.X + " " + pt.Y; }
      case "down": Send(Mouse(ButtonFlags(p[1])[0], 0)); return null;
      case "up": Send(Mouse(ButtonFlags(p[1])[1], 0)); return null;
      case "click": { var f = ButtonFlags(p[1]); Send(Mouse(f[0], 0), Mouse(f[1], 0)); return null; }
      case "double": { var f = ButtonFlags(p[1]); Send(Mouse(f[0], 0), Mouse(f[1], 0), Mouse(f[0], 0), Mouse(f[1], 0)); return null; }
      case "wheel": Send(Mouse(0x0800, unchecked((uint)(int.Parse(p[1]) * 120)))); return null;
      case "keydown":
      case "keyup":
      case "tap": {
        int vk = int.Parse(p[1]);
        uint ext = IsExtended(vk) ? EXTENDED : 0;
        if (p[0] == "keydown") Send(Key((ushort)vk, 0, ext));
        else if (p[0] == "keyup") Send(Key((ushort)vk, 0, ext | KEYUP));
        else Send(Key((ushort)vk, 0, ext), Key((ushort)vk, 0, ext | KEYUP));
        return null;
      }
      case "text": {
        string text = Encoding.UTF8.GetString(Convert.FromBase64String(p[1]));
        foreach (char c in text) {
          if (c == '\n') { Send(Key(0x0D, 0, 0), Key(0x0D, 0, KEYUP)); continue; }
          if (c == '\r') continue;
          Send(Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP));
        }
        return null;
      }
    }
    return "error unknown command " + p[0];
  }
}
"@

[HtInput]::Init()
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $out = [HtInput]::Run($line)
    if ($out) { [Console]::Out.WriteLine($out); [Console]::Out.Flush() }
  } catch {
    [Console]::Out.WriteLine("error " + $_.Exception.Message)
    [Console]::Out.Flush()
  }
}
