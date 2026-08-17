// foreground-watch.cs — foreground-window tracking + window find/focus/list for open-quake. [MIT]
//
// Replaces the per-call powershell.exe spawns that desktopFocus.js and meetingControl.js used:
// endpoint-security tools flag continuous PowerShell process creation as malware-like behavior,
// so this one small signed helper covers all four operations natively.
//
// Modes (first argument):
//   watch            long-running: prints the foreground process name (bare, no ".exe") to stdout,
//                    one line per change, via SetWinEventHook(EVENT_SYSTEM_FOREGROUND) — purely
//                    event-driven, zero polling. Prints the current foreground app immediately on
//                    start. Exits when stdin closes (parent died) so it can never be orphaned.
//   list             one-shot: JSON array of {ProcessName, MainWindowTitle} for every process
//                    owning a real window (same shape ConvertTo-Json produced for the old PS path).
//   find <name...>   one-shot: "OK" (exit 0) if any named process owns a main window, else
//                    "NOTFOUND" (exit 1). Names may include or omit ".exe".
//   focus <name...>  one-shot: force-focus the first named process's main window ("OK"/"NOTFOUND").
//                    Uses AttachThreadInput to the current foreground thread first — the standard
//                    workaround for Windows' foreground-lock blocking background processes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

static class ForegroundWatch {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmod, WinEventDelegate proc, uint idProcess, uint idThread, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  delegate void WinEventDelegate(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  const uint WINEVENT_OUTOFCONTEXT = 0x0000;
  const int SW_RESTORE = 9;

  static WinEventDelegate _hookProc;   // held in a static so the GC can never collect the native callback
  static string _last = null;

  static int Main(string[] args) {
    try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch (Exception) {}
    string mode = args.Length > 0 ? args[0] : "watch";
    if (mode == "watch") return Watch();
    if (mode == "list") return List();
    if (mode == "find" || mode == "focus") {
      Process target = FindWindowProcess(args);
      if (target == null) { Console.WriteLine("NOTFOUND"); return 1; }
      if (mode == "find") { Console.WriteLine("OK"); return 0; }
      return Focus(target.MainWindowHandle);
    }
    Console.Error.WriteLine("usage: foreground-watch [watch|list|find <name...>|focus <name...>]");
    return 2;
  }

  static string ProcName(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return "";
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid == 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return ""; }
  }

  static void Emit(IntPtr hWnd) {
    string name = ProcName(hWnd);
    if (string.IsNullOrEmpty(name) || name == _last) return;
    _last = name;
    Console.WriteLine(name);
  }

  static int Watch() {
    // Parent-death guard: the JS side keeps our stdin open; EOF means it's gone, so exit rather
    // than linger as an orphaned hook. Read on a background thread — GetMessage blocks this one.
    Thread stdinWatch = new Thread(delegate() {
      try { while (Console.In.Read() != -1) {} } catch (Exception) {}
      Environment.Exit(0);
    });
    stdinWatch.IsBackground = true;
    stdinWatch.Start();

    Emit(GetForegroundWindow());   // seed with the current app so the consumer never starts blind
    _hookProc = delegate(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) { Emit(hwnd); };
    IntPtr h = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _hookProc, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (h == IntPtr.Zero) { Console.Error.WriteLine("SetWinEventHook failed"); return 1; }
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {}   // WINEVENT_OUTOFCONTEXT delivery needs a message pump
    return 0;
  }

  static int List() {
    List<Dictionary<string, string>> rows = new List<Dictionary<string, string>>();
    foreach (Process p in Process.GetProcesses()) {
      try {
        if (p.MainWindowHandle == IntPtr.Zero) continue;
        string title = p.MainWindowTitle;
        if (string.IsNullOrEmpty(title)) continue;
        Dictionary<string, string> row = new Dictionary<string, string>();
        row["ProcessName"] = p.ProcessName;
        row["MainWindowTitle"] = title;
        rows.Add(row);
      } catch (Exception) {}
    }
    Console.WriteLine(new JavaScriptSerializer().Serialize(rows));
    return 0;
  }

  static Process FindWindowProcess(string[] args) {
    for (int i = 1; i < args.Length; i++) {
      string n = args[i] ?? "";
      if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
      if (n.Length == 0) continue;
      foreach (Process p in Process.GetProcessesByName(n)) {
        try { if (p.MainWindowHandle != IntPtr.Zero) return p; } catch (Exception) {}
      }
    }
    return null;
  }

  static int Focus(IntPtr hWnd) {
    IntPtr fg = GetForegroundWindow();
    uint fgPid;
    uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;   // return value IS the thread id
    uint cur = GetCurrentThreadId();
    if (IsIconic(hWnd)) ShowWindowAsync(hWnd, SW_RESTORE);
    if (fgThread != 0 && fgThread != cur) AttachThreadInput(cur, fgThread, true);
    SetForegroundWindow(hWnd);
    if (fgThread != 0 && fgThread != cur) AttachThreadInput(cur, fgThread, false);
    Console.WriteLine("OK");
    return 0;
  }
}
