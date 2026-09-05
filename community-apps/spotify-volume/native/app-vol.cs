// app-vol.exe — read/set a single application's volume in the Windows volume mixer (per-app, NOT the
// OS master), via the Core Audio session APIs. Used by the Music page's Spotify volume buttons. [MIT]
//
// Why: Windows exposes a separate volume slider per audio session (per app) in the mixer; the SMTC
// media API carries no volume, and the knob's "System volume" moves the OS master. To set ONLY
// Spotify's level we drive its audio session's ISimpleAudioVolume directly — no admin, no Spotify
// login/Premium, no Web API. Matches the desktop app the now-playing display reads.
//
// Usage:  app-vol.exe <processName> [percent]
//   <processName>  audio-session process to target, e.g. "Spotify" (no .exe)
//   [percent]      optional 0-100; when given, set every matching session to that level
// Prints the resulting volume as an integer percent (0-100) of the first matching session, or "none"
// if the app has no audio session open. Exit 0 when a session was found, 1 otherwise.
//
// Build: csc, no special references (pure COM interop). See build-smtc.js.
using System;
using System.Globalization;
using System.Runtime.InteropServices;

namespace AppVol {
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport, ClassInterface(ClassInterfaceType.None)]
  class MMDeviceEnumerator { }
  enum EDataFlow { eRender, eCapture, eAll }
  enum ERole { eConsole, eMultimedia, eCommunications }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IAudioSessionManager2 {
    int NotImpl1(); int NotImpl2();
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IAudioSessionEnumerator {
    int GetCount(out int SessionCount);
    int GetSession(int SessionCount, out IAudioSessionControl Session);
  }
  // IAudioSessionControl: 9 own methods after IUnknown — stubbed; we only QI to its derived/sibling ifaces.
  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IAudioSessionControl {
    int M1(); int M2(); int M3(); int M4(); int M5(); int M6(); int M7(); int M8(); int M9();
  }
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface IAudioSessionControl2 {
    int M1(); int M2(); int M3(); int M4(); int M5(); int M6(); int M7(); int M8(); int M9();
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out uint pid);
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid eventContext);
    int GetMasterVolume(out float level);
    int SetMute(bool mute, ref Guid eventContext);
    int GetMute(out bool mute);
  }

  static class Program {
    static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    static int Main(string[] args) {
      try {
        if (args.Length < 1) { Console.Out.Write("none"); return 1; }
        string proc = args[0];
        float? setTo = null;
        if (args.Length > 1) {
          int pct;
          if (int.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pct)) {
            if (pct < 0) pct = 0; if (pct > 100) pct = 100;
            setTo = pct / 100f;
          }
        }
        int? result = Run(proc, setTo);
        if (result.HasValue) { Console.Out.Write(result.Value.ToString(CultureInfo.InvariantCulture)); return 0; }
        Console.Out.Write("none"); return 1;
      } catch {
        Console.Out.Write("none"); return 1;
      }
    }

    // Enumerate the default render device's sessions; for each whose process name matches `proc`,
    // optionally set the volume, and remember the first match's resulting level. Returns percent or null.
    static int? Run(string proc, float? setTo) {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice device;
      if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device) != 0 || device == null)
        return null;
      object o;
      device.Activate(ref IID_IAudioSessionManager2, /*CLSCTX_ALL*/ 23, IntPtr.Zero, out o);
      var mgr = (IAudioSessionManager2)o;
      IAudioSessionEnumerator sessions;
      mgr.GetSessionEnumerator(out sessions);
      int count;
      sessions.GetCount(out count);
      int? firstLevel = null;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl ctl;
        if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
        uint pid = 0;
        try { var ctl2 = (IAudioSessionControl2)ctl; ctl2.GetProcessId(out pid); } catch { }
        string name = ProcName(pid);
        if (!string.Equals(name, proc, StringComparison.OrdinalIgnoreCase)) continue;
        var vol = (ISimpleAudioVolume)ctl;
        if (setTo.HasValue) { Guid ctx = Guid.Empty; vol.SetMasterVolume(setTo.Value, ref ctx); }
        if (!firstLevel.HasValue) {
          float lvl; vol.GetMasterVolume(out lvl);
          firstLevel = (int)Math.Round(lvl * 100f);
        }
      }
      return firstLevel;
    }

    static string ProcName(uint pid) {
      if (pid == 0) return "";
      try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
      catch { return ""; }
    }
  }
}
