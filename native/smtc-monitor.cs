// smtc-monitor.exe — persistent now-playing monitor for the Music page. [MIT]
//
// Replaces the powershell.exe SMTC poll (one spawn every 2.5s while the Music page was open,
// ~24 processes/min — the churn endpoint-security tools flag). ONE long-lived helper reads the
// Windows.Media.Control WinRT API in-process on an internal 1s cadence and prints a JSON line
// to stdout ONLY when something changed: {title, artist, album, status, app, position, duration},
// or "{}" when no media session exists. While a track plays, position advances, so that's one
// line per second of trivial pipe IO — and zero process creation.
//
// Session choice matches the retired PowerShell: prefer the session that's actually PLAYING
// (GetCurrentSession() can point at a paused app while another one is the audible player),
// else fall back to the OS current session. Exits when stdin closes (parent died).
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Media.Control;

class SmtcMonitor {
    static string _last = null;
    static readonly JavaScriptSerializer _json = new JavaScriptSerializer();

    static int Main(string[] args) {
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch (Exception) {}
        Thread stdinWatch = new Thread(delegate() {
            try { while (Console.In.Read() != -1) {} } catch (Exception) {}
            Environment.Exit(0);
        });
        stdinWatch.IsBackground = true;
        stdinWatch.Start();

        GlobalSystemMediaTransportControlsSessionManager mgr = null;
        while (true) {
            try {
                if (mgr == null)
                    mgr = GlobalSystemMediaTransportControlsSessionManager.RequestAsync().GetAwaiter().GetResult();
                EmitTick(mgr).GetAwaiter().GetResult();
            } catch (Exception) { mgr = null; }   // manager can die on session-host restart; re-request next tick
            Thread.Sleep(1000);
        }
    }

    static async Task EmitTick(GlobalSystemMediaTransportControlsSessionManager mgr) {
        GlobalSystemMediaTransportControlsSession chosen = null;
        try {
            foreach (var s in mgr.GetSessions()) {
                try {
                    if (s != null && s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing) { chosen = s; break; }
                } catch (Exception) {}
            }
        } catch (Exception) {}
        if (chosen == null) chosen = mgr.GetCurrentSession();

        string line;
        if (chosen == null) {
            line = "{}";
        } else {
            var props = await chosen.TryGetMediaPropertiesAsync();
            var info = chosen.GetPlaybackInfo();
            double pos = 0, dur = 0;
            try { var tl = chosen.GetTimelineProperties(); pos = tl.Position.TotalSeconds; dur = tl.EndTime.TotalSeconds; } catch (Exception) {}
            var row = new Dictionary<string, object>();
            row["title"] = props.Title;
            row["artist"] = props.Artist;
            row["album"] = props.AlbumTitle;
            row["status"] = info.PlaybackStatus.ToString();
            row["app"] = chosen.SourceAppUserModelId;
            row["position"] = pos;
            row["duration"] = dur;
            line = _json.Serialize(row);
        }
        if (line == _last) return;
        _last = line;
        Console.WriteLine(line);
    }
}
