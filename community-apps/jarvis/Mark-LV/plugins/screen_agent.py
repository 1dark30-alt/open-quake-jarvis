"""
JARVIS plugin — Screen Agent: looks at the screen and works it, step by step.

The rest of the app can already take ONE screenshot and answer ONE question
about it (`screen_process`), and it can click ONE coordinate it was told about
(`computer_control`). What was missing is the thing in between: a loop that
looks, acts, LOOKS AGAIN to see whether the act worked, and keeps going until
the user's goal is actually on the screen.

That loop is what this plugin is.

    look -> decide one action -> do it -> look again -> verify -> next

HOW IT STAYS OUT OF THE WAY
    A run takes tens of seconds, and a plugin's run() blocks the executor
    thread that answers the Live turn. So run() starts a worker thread and
    returns instantly; the worker narrates through player.request_say (the same
    thread-safe channel pomodoro uses) and paints progress into the HUD panel.
    The conversation stays alive the whole time — you can talk to JARVIS, or
    tell it to stop, while it is clicking.

HOW IT AIMS
    Two locators, cheapest first:
      1. the accessibility tree (Windows UI Automation) — exact control
         rectangles, no model call, no guessing. Tried first, on a strict time
         budget, and skipped silently on macOS/Linux where there is no
         dependency-free equivalent.
      2. the vision model — normalized 0-1000 "point": [y, x] coordinates,
         which is the coordinate space Gemini's spatial understanding is
         actually trained on. Asking for raw pixels is what makes naive screen
         agents miss.
    Normalized points are then mapped through the CAPTURED monitor's rectangle
    and a measured physical->logical scale factor, so 150% Windows scaling,
    macOS Retina (where the screenshot is 2x the click space) and second
    monitors all land on the right pixel.

FOR EVERY LANGUAGE, EVERYWHERE
    There is not one language keyword in this file. The model reads whatever is
    on the screen — Turkish, Japanese, Arabic, Portuguese — and hands back the
    button's text verbatim; matching against the accessibility tree is done on
    Unicode-folded text, so "Gönder" matches "GÖNDER" and "Ändern" matches
    "ANDERN". Typing is clipboard-based whenever the text is not plain ASCII,
    because pyautogui's key-by-key typing cannot produce ş, ü, я, 漢 or ñ.

SAFETY
    * every irreversible act (send, post, buy, delete, install, confirm) pauses
      and asks the user out loud, in their language, before it happens;
    * a step limit, a stuck detector and a stop command;
    * slamming the mouse into the top-left corner aborts instantly
      (pyautogui's own failsafe), which needs no software to be listening;
    * it will never type a password, a card number or any credential — it stops
      and hands the keyboard back to you.

Cross-OS (Windows / macOS / Linux). No new dependency: pyautogui, mss, pillow,
pyperclip, pywinauto and google-genai are already in requirements.txt.
"""
from __future__ import annotations

import concurrent.futures
import io
import json
import platform
import re
import threading
import time
import unicodedata

from memory.config_manager import get_plugin_config

_NS = "screen_agent"


# ---------------------------------------------------------------------------
# Optional dependencies — the plugin loads either way and explains what is
# missing instead of exploding at import time.
# ---------------------------------------------------------------------------
try:
    import pyautogui
    pyautogui.FAILSAFE = True       # mouse to the top-left corner = hard abort
    pyautogui.PAUSE    = 0.0        # we do our own settling
    _PYAUTOGUI = True
except Exception:
    _PYAUTOGUI = False

try:
    import mss
    _MSS = True
except Exception:
    _MSS = False

try:
    import PIL.Image
    _PIL = True
except Exception:
    _PIL = False

try:
    import pyperclip
    _PYPERCLIP = True
except Exception:
    _PYPERCLIP = False


def _os_name() -> str:
    return {"Windows": "windows", "Darwin": "mac"}.get(platform.system(), "linux")


_OS = _os_name()


# ---------------------------------------------------------------------------
# Tool declaration
# ---------------------------------------------------------------------------
PLUGIN = {
    "name": "screen_agent",
    "description": (
        "Autonomously OPERATES the computer by looking at the screen in a loop: "
        "finds things visually, clicks, types, scrolls and verifies, one step at "
        "a time, until a multi-step goal is done. Use for requests like 'do this "
        "for me on the screen', 'fill in this form', 'find the X button and turn "
        "it on', 'change that setting for me', 'go through these steps in this "
        "program' — anything where the steps are only knowable by LOOKING and "
        "where more than one click is needed. "
        "Do NOT use it for: answering a question about what is on screen (use "
        "'screen_process'), a single known click or keystroke (use "
        "'computer_control'), launching a program (use 'open_app'), opening a URL "
        "or driving a web page (use 'browser_control'), or writing code and "
        "projects (use 'dev_agent'). "
        "Call with action='stop' to abort a run, action='status' to report "
        "progress, and action='confirm' the moment the user approves a step it "
        "asked permission for (any form of yes, in any language)."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": (
                    "'start' to begin working on a goal (default), 'stop' to abort, "
                    "'status' for progress, 'confirm' when the user approves the "
                    "step it just asked about."
                ),
            },
            "goal": {
                "type": "STRING",
                "description": (
                    "What should be true on the screen when it is finished, written "
                    "in ENGLISH and as concretely as possible. Include the program "
                    "or window if the user named one, and any value to enter. "
                    "Example: 'In the open Settings window, turn Bluetooth off.'"
                ),
            },
            "max_steps": {
                "type": "INTEGER",
                "description": "Safety limit on look-and-act cycles (default from settings, hard cap 40).",
            },
            "dry_run": {
                "type": "BOOLEAN",
                "description": (
                    "True = look and report what it WOULD do without touching the "
                    "mouse or keyboard. Use when the user asks it to check or plan first."
                ),
            },
        },
        "required": [],
    },
}


# ---------------------------------------------------------------------------
# Settings (gear -> plugin settings tab) — every value has a working default,
# so the plugin is usable the second it is dropped in.
# ---------------------------------------------------------------------------
_DEFAULTS = {
    "model":        "gemini-2.5-flash-lite",
    "max_steps":    "12",
    "confirm_mode": "irreversible",
    "monitor":      "auto",
    "use_uia":      True,
    "narrate":      False,
    "settle_ms":    "600",
}

_HARD_MAX_STEPS = 40


def _cfg() -> dict:
    try:
        stored = get_plugin_config(_NS) or {}
    except Exception:
        stored = {}
    out = dict(_DEFAULTS)
    for k, v in stored.items():
        if v not in (None, ""):
            out[k] = v
    return out


def _cfg_int(cfg: dict, key: str, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(float(str(cfg.get(key, _DEFAULTS[key]))))))
    except Exception:
        return int(_DEFAULTS[key])


def _cfg_bool(cfg: dict, key: str) -> bool:
    v = cfg.get(key, _DEFAULTS[key])
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "on")


PLUGIN_SETTINGS = {
    "namespace": _NS,
    "title": "🖱️  SCREEN AGENT (see & click)",
    "fields": [
        {"key": "model", "label": "Vision model", "type": "choice",
         "options": ["gemini-2.5-flash-lite", "gemini-2.5-flash",
                     "gemini-flash-lite-latest"],
         "default": "gemini-2.5-flash-lite"},
        {"key": "confirm_mode", "label": "Ask me before", "type": "choice",
         "options": ["irreversible", "every step", "never"],
         "default": "irreversible"},
        {"key": "max_steps", "label": "Step limit per task (1-40)", "type": "text",
         "default": "12"},
        {"key": "monitor", "label": "Monitor (auto, 1, 2, ...)", "type": "text",
         "default": "auto"},
        {"key": "settle_ms", "label": "Wait after each action (ms)", "type": "text",
         "default": "600"},
        {"key": "use_uia", "label": "Use the accessibility tree first (Windows)",
         "type": "toggle", "default": True},
        {"key": "narrate", "label": "Say every step out loud", "type": "toggle",
         "default": False},
    ],
    "action": {"label": "TEST AIM  (moves the mouse, never clicks)",
               "run": lambda values: _self_test(values or {})},
}


# ---------------------------------------------------------------------------
# Live state — one run per process
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_state: dict = {
    "running":   False,
    "thread":    None,
    "stop":      None,          # threading.Event
    "confirm":   None,          # threading.Event
    "approved":  False,
    "pending":   "",            # description of the step awaiting approval
    "goal":      "",
    "step":      0,
    "max_steps": 0,
    "last":      "",            # last observation
    "lines":     [],            # HUD panel transcript
    "dry_run":   False,
}


# ---------------------------------------------------------------------------
# HUD helpers — all no-ops when player is None
# ---------------------------------------------------------------------------
def _log(player, msg: str) -> None:
    if player:
        try:
            player.write_log(msg)
        except Exception:
            pass


def _say(player, instruction: str) -> None:
    """Ask JARVIS to speak mid-run (thread-safe; it phrases the English
    instruction in the user's own language)."""
    if player and hasattr(player, "request_say"):
        try:
            player.request_say(instruction)
        except Exception:
            pass


def _panel(player, line: str | None = None) -> None:
    """Append a line to the run transcript and repaint the content panel."""
    if line is not None:
        _state["lines"].append(line)
        del _state["lines"][:-40]
    if not player:
        return
    head = f"🎯 {_state['goal']}"
    if _state["dry_run"]:
        head += "   (dry run)"
    body = "\n".join(_state["lines"])
    try:
        player.show_content("SCREEN AGENT", f"{head}\n\n{body}")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Text folding — language-neutral matching for the accessibility tree.
# Strips accents by Unicode decomposition (é ü ş ğ ñ å ...), drops the mnemonic
# and ellipsis noise Windows puts in control names, casefolds the rest.
# ---------------------------------------------------------------------------
_PUNCT = re.compile(r"[\s&_\.… :\-–—()\[\]]+")


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return _PUNCT.sub("", s).casefold()


# ---------------------------------------------------------------------------
# Screen geometry
#
# Two coordinate spaces have to be reconciled and nearly every naive screen
# agent gets this wrong:
#   * mss captures PHYSICAL pixels (150% Windows scaling and macOS Retina both
#     hand back an image larger than the desktop you click on);
#   * pyautogui clicks in the LOGICAL space the OS reports.
# We never hardcode a ratio — we measure it, so the same code is correct at
# 100%, 125%, 150% and on a Retina panel.
# ---------------------------------------------------------------------------
def _monitors() -> list[dict]:
    if not _MSS:
        return []
    with mss.mss() as sct:
        return [dict(m) for m in sct.monitors]


def _foreground_rect() -> tuple[int, int, int, int] | None:
    """Physical rect of the focused window, when the OS will tell us cheaply."""
    if _OS != "windows":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
    except Exception:
        return None


def _pick_monitor(cfg: dict) -> dict:
    """The monitor to work on: an explicit index, or the one holding the focused
    window, falling back to the primary screen."""
    mons = _monitors()
    if not mons:
        raise RuntimeError("mss is not installed. Run: pip install mss")

    real = mons[1:] if len(mons) > 1 else mons[:1]

    raw = str(cfg.get("monitor", "auto")).strip().lower()
    if raw.isdigit():
        idx = max(1, min(len(real), int(raw)))
        return dict(real[idx - 1])

    fg = _foreground_rect()
    if fg:
        cx, cy = (fg[0] + fg[2]) // 2, (fg[1] + fg[3]) // 2
        for m in real:
            if (m["left"] <= cx < m["left"] + m["width"]
                    and m["top"] <= cy < m["top"] + m["height"]):
                return dict(m)
    return dict(real[0])


def _scale_factor() -> float:
    """Physical -> logical. Measured against the primary screen, because that is
    the one pyautogui.size() describes on every OS."""
    if not (_PYAUTOGUI and _MSS):
        return 1.0
    try:
        mons = _monitors()
        primary = mons[1] if len(mons) > 1 else mons[0]
        pa_w, _ = pyautogui.size()
        if primary["width"]:
            return float(pa_w) / float(primary["width"])
    except Exception:
        pass
    return 1.0


def _grab(mon: dict) -> tuple[bytes, int, int]:
    """JPEG of one monitor, downscaled for the model. Normalized coordinates are
    resolution-independent, so shrinking the upload costs nothing in accuracy
    and buys back most of the round-trip time."""
    if not _MSS:
        raise RuntimeError("mss is not installed. Run: pip install mss")
    with mss.mss() as sct:
        shot = sct.grab({"left": mon["left"], "top": mon["top"],
                         "width": mon["width"], "height": mon["height"]})
        raw, size = shot.rgb, shot.size

    if not _PIL:
        import mss.tools
        return mss.tools.to_png(raw, size), size[0], size[1]

    img = PIL.Image.frombytes("RGB", size, raw)
    img.thumbnail((1280, 1280), PIL.Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80, optimize=False)
    return buf.getvalue(), size[0], size[1]


def _point_to_screen(point, mon: dict, scale: float) -> tuple[int, int] | None:
    """Model's normalized [y, x] in 0-1000 -> real click coordinates."""
    try:
        y_n, x_n = float(point[0]), float(point[1])
    except Exception:
        return None
    # Clamp rather than reject: an element at the very edge often reads as
    # slightly past it, and a clamped click still lands on the right control.
    x_n = max(0.0, min(1000.0, x_n)) / 1000.0
    y_n = max(0.0, min(1000.0, y_n)) / 1000.0
    px = mon["left"] + x_n * mon["width"]
    py = mon["top"] + y_n * mon["height"]
    return int(round(px * scale)), int(round(py * scale))


# ---------------------------------------------------------------------------
# Locator 1 — the accessibility tree (Windows UI Automation)
#
# When it works it is exact, instant and free: no model call, no pixel guessing.
# It is also capable of taking many seconds inside a browser, so it runs under a
# hard time budget and a per-window blacklist: miss the budget once and we stop
# asking for that window and let vision do the work.
# ---------------------------------------------------------------------------
_uia_slow: set[int] = set()
_uia_enabled = True
_UIA_BUDGET = 2.0


def _uia_scan(label: str) -> tuple[int, int] | None:
    from pywinauto import Desktop
    import ctypes
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    if not hwnd:
        return None
    win = Desktop(backend="uia").window(handle=hwnd)

    want = _fold(label)
    if not want:
        return None

    best = None                      # (rank, rect)
    for ctrl in win.descendants():
        try:
            name = ctrl.window_text()
            if not name:
                continue
            folded = _fold(name)
            if not folded:
                continue
            if folded == want:
                rank = 0
            elif want in folded or folded in want:
                rank = 1
            else:
                continue
            r = ctrl.rectangle()
            if r.right <= r.left or r.bottom <= r.top:
                continue
            if best is None or rank < best[0]:
                best = (rank, r)
                if rank == 0:
                    break
        except Exception:
            continue

    if best is None:
        return None
    r = best[1]
    return (r.left + r.right) // 2, (r.top + r.bottom) // 2


def _uia_point(label: str) -> tuple[int, int] | None:
    """Physical centre of the control whose visible text matches `label`, or
    None. Never raises, never blocks longer than the budget."""
    if _OS != "windows" or not label or not _uia_enabled:
        return None
    try:
        import ctypes
        hwnd = int(ctypes.windll.user32.GetForegroundWindow())
    except Exception:
        return None
    if hwnd in _uia_slow:
        return None

    try:
        ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            fut = ex.submit(_uia_scan, label)
            try:
                return fut.result(timeout=_UIA_BUDGET)
            except concurrent.futures.TimeoutError:
                _uia_slow.add(hwnd)
                print("[ScreenAgent] UI Automation too slow for this window "
                      "- vision only from now on")
                return None
        finally:
            # A UIA scan that overran its budget must not hold up the run, so
            # the pool is torn down without waiting for it.
            ex.shutdown(wait=False)
    except Exception as e:
        print(f"[ScreenAgent] UI Automation unavailable: {e}")
        return None


# ---------------------------------------------------------------------------
# Locator 2 — the vision model. One call per step, returning both the decision
# and the coordinate, so a step costs exactly one round trip.
# ---------------------------------------------------------------------------
_PROMPT = """You are the eyes and hands of a desktop assistant. You operate a real \
computer running {os_name}, by looking at a screenshot and issuing ONE action at a time.

THE GOAL
{goal}

WHAT YOU HAVE DONE SO FAR
{history}

THE SCREENSHOT
The image is the user's screen. Everything you can see is real and live; \
anything you cannot see does not exist yet.

RULES
1. Reply with ONE JSON object and nothing else.
2. Coordinates are NORMALIZED: "point": [y, x], both numbers between 0 and 1000, \
y first (top to bottom), x second (left to right). Aim at the CENTRE of the element.
3. Put the element's visible text into "target_text" EXACTLY as it appears on \
screen, in its own language, spelling and capitalisation. Use "" if it has no text.
4. ONE step per reply. Never plan several clicks at once.
5. Look before you decide. If the previous step did not do what you expected, \
say so in "observation" and recover instead of repeating it.
6. When the goal is visibly achieved on this screenshot, answer with action "done".
7. If it cannot be achieved -- the element is not there, a dialog is in the way, \
a login is required, the wrong program is open -- answer with action "fail" and \
say why in one sentence.
8. NEVER type a password, a PIN, a card number, a security code or any other \
credential, even if the user asked you to. Answer with action "ask" instead and \
let the user type it.
9. "risk" is "irreversible" if the action sends, posts, publishes, buys, pays, \
deletes, overwrites, formats, installs, uninstalls, or confirms something that \
cannot be taken back. Everything else is "safe". Judge by what the control DOES, \
whatever language it is written in.
10. "message" is one short ENGLISH sentence. It is re-spoken to the user in their \
own language, so keep it plain and free of jargon.

ACTIONS
  click / double_click / right_click   need "point" and "target_text"
  type                                 needs "text" (and "point" to click the field first, if it is not already focused)
  key                                  needs "key"    e.g. "enter", "esc", "tab"
  hotkey                               needs "keys"   e.g. "ctrl+s", "alt+tab"
  scroll                               needs "direction" ("up"/"down") and optionally "amount" and "point"
  drag                                 needs "point" and "point_to"
  wait                                 needs "seconds" -- use when something is still loading
  done / fail / ask                    need "message"

REPLY FORMAT
{{"observation": "...", "reasoning": "...", "action": "click", "point": [412, 780], \
"target_text": "...", "text": "", "key": "", "keys": "", "direction": "", \
"amount": 3, "seconds": 0, "point_to": [], "risk": "safe", "message": ""}}"""


# The per-step genai.Client this file used to build is gone: requests now go
# through core/gemini.py, which owns the key, the deadline and the fallback
# ladder, and builds its client itself. Constructing one here as well meant a
# throwaway object on every step of an agent loop for nothing.


class QuotaExhausted(RuntimeError):
    """The API key has no requests left — worth its own type, because it is the
    one failure a user can neither retry away nor debug."""


def _retry_delay(err: str) -> float:
    """Seconds the API asked us to wait, from its own retryDelay field."""
    m = re.search(r"'?retryDelay'?[\"']?\s*[:=]\s*[\"']?(\d+(?:\.\d+)?)", err)
    if m:
        return float(m.group(1))
    m = re.search(r"retry in (\d+(?:\.\d+)?)", err)
    return float(m.group(1)) if m else 20.0


def _parse(text: str) -> dict:
    """The models are asked for one JSON object and usually give one — but a
    lite model will occasionally wrap it in an array, or fence it in prose.
    Recover from both rather than failing a whole run over punctuation."""
    text = (text or "").strip()
    data = None
    try:
        data = json.loads(text)
    except Exception:
        m = re.search(r"[\{\[].*[\}\]]", text, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except Exception:
                data = None
    if isinstance(data, list):
        data = next((d for d in data if isinstance(d, dict)), None)
    if not isinstance(data, dict):
        raise RuntimeError(f"the vision model returned no usable JSON: {text[:120]}")
    return data


def _decide(model: str, goal: str, history: list[str], img: bytes,
            stop: threading.Event | None = None) -> dict:
    from google.genai import types as gtypes

    prompt = _PROMPT.format(
        os_name={"windows": "Windows", "mac": "macOS"}.get(_OS, "Linux"),
        goal=goal,
        history="\n".join(history[-8:]) if history else "(nothing yet — this is the first look)",
    )
    contents = [gtypes.Part.from_bytes(data=img, mime_type="image/jpeg"), prompt]
    config = gtypes.GenerateContentConfig(temperature=0.0,
                                          response_mime_type="application/json")

    last: Exception | None = None
    for attempt in (1, 2):
        try:
            # Through core/gemini.py: the model the user picked in settings is
            # tried first and gets a deadline, with the ladder behind it.
            from core import gemini
            resp = gemini.call(contents, tier=model, config=config,
                               timeout_ms=30_000)
            if resp is None:
                raise RuntimeError("every Gemini model on the ladder failed")
            return _parse(getattr(resp, "text", "") or "")
        except Exception as e:
            last = e
            err = str(e)
            # A rate limit is normal on the free tier — one step of a loop is one
            # request, so a long task can walk straight into it. Wait out a short
            # cooldown once; give up honestly on a daily cap.
            if "429" in err or "RESOURCE_EXHAUSTED" in err:
                delay = _retry_delay(err)
                if attempt == 1 and delay <= 45:
                    print(f"[ScreenAgent] rate limited — waiting {delay:.0f}s")
                    if stop is not None and stop.wait(delay):
                        raise RuntimeError("stopped")
                    elif stop is None:
                        time.sleep(delay)
                    continue
                raise QuotaExhausted(
                    "your Gemini API quota is used up for now — each step of a "
                    "screen task costs one request"
                ) from e
            if attempt == 1:
                time.sleep(1.0)     # one transient network blip is not a failure
                continue
            raise
    raise last if last else RuntimeError("the vision model did not answer")


# ---------------------------------------------------------------------------
# Actuators
# ---------------------------------------------------------------------------
_KEY_ALIASES = {
    "return": "enter", "escape": "esc", "del": "delete", "ins": "insert",
    "pgup": "pageup", "pgdn": "pagedown", "control": "ctrl", "ctl": "ctrl",
    "option": "alt", "opt": "alt", "cmd": "command", "meta": "command",
    "super": "winleft", "win": "winleft", "windows": "winleft",
    "spacebar": "space", "caps": "capslock",
}


def _key(name: str) -> str:
    k = str(name or "").strip().lower()
    k = _KEY_ALIASES.get(k, k)
    if k == "command" and _OS != "mac":
        k = "ctrl"
    if k == "winleft" and _OS == "mac":
        k = "command"
    return k


def _is_ascii(text: str) -> bool:
    try:
        text.encode("ascii")
        return True
    except Exception:
        return False


def _type_text(text: str) -> None:
    """Type into the focused field.

    pyautogui presses keys, so it can only produce what a US keyboard produces:
    ş, ğ, ü, я, 漢, ñ and every emoji come out wrong or not at all. For anything
    outside ASCII — which is most of the world — we go through the clipboard and
    put the user's own clipboard back afterwards.
    """
    if _is_ascii(text) and len(text) <= 200:
        pyautogui.write(text, interval=0.012)
        return

    if not _PYPERCLIP:
        pyautogui.write(text, interval=0.012)   # best effort; will mangle accents
        return

    previous = None
    try:
        previous = pyperclip.paste()
    except Exception:
        pass
    pyperclip.copy(text)
    time.sleep(0.06)
    pyautogui.hotkey("command" if _OS == "mac" else "ctrl", "v")
    time.sleep(0.2)
    if previous is not None:
        try:
            pyperclip.copy(previous)
        except Exception:
            pass


def _perform(act: str, data: dict, mon: dict, scale: float) -> str:
    """Do one action. Returns a short English description of what was done."""
    point = data.get("point") or []
    label = str(data.get("target_text") or "").strip()

    def _aim() -> tuple[int, int] | None:
        # Accessibility tree first — it knows exactly where the control is.
        if label:
            hit = _uia_point(label)
            if hit:
                return int(round(hit[0] * scale)), int(round(hit[1] * scale))
        return _point_to_screen(point, mon, scale)

    if act in ("click", "double_click", "right_click"):
        xy = _aim()
        if not xy:
            raise RuntimeError("no usable coordinate for the click")
        pyautogui.moveTo(xy[0], xy[1], duration=0.18)
        if act == "click":
            pyautogui.click()
        elif act == "double_click":
            pyautogui.doubleClick()
        else:
            pyautogui.rightClick()
        return f"{act} {label or xy}"

    if act == "type":
        xy = _aim() if (point or label) else None
        if xy:
            pyautogui.moveTo(xy[0], xy[1], duration=0.15)
            pyautogui.click()
            time.sleep(0.15)
        text = str(data.get("text") or "")
        _type_text(text)
        shown = text if len(text) <= 40 else text[:40] + "…"
        return f'typed "{shown}"'

    if act == "key":
        k = _key(data.get("key"))
        pyautogui.press(k)
        return f"pressed {k}"

    if act == "hotkey":
        keys = [_key(k) for k in re.split(r"[+\s]+", str(data.get("keys") or "")) if k.strip()]
        if not keys:
            raise RuntimeError("empty key combination")
        pyautogui.hotkey(*keys)
        return f"pressed {'+'.join(keys)}"

    if act == "scroll":
        xy = _point_to_screen(point, mon, scale) if point else None
        if xy:
            pyautogui.moveTo(xy[0], xy[1], duration=0.12)
        try:
            amount = int(data.get("amount") or 3)
        except Exception:
            amount = 3
        amount = max(1, min(20, amount))
        down = str(data.get("direction") or "down").lower().startswith("d")
        pyautogui.scroll(-amount * 120 if down else amount * 120)
        return f"scrolled {'down' if down else 'up'}"

    if act == "drag":
        a = _point_to_screen(point, mon, scale)
        b = _point_to_screen(data.get("point_to") or [], mon, scale)
        if not (a and b):
            raise RuntimeError("drag needs both a start and an end point")
        pyautogui.moveTo(a[0], a[1], duration=0.18)
        pyautogui.dragTo(b[0], b[1], duration=0.45, button="left")
        return f"dragged {label}".strip()

    if act == "wait":
        try:
            secs = float(data.get("seconds") or 1.0)
        except Exception:
            secs = 1.0
        secs = max(0.2, min(10.0, secs))
        time.sleep(secs)
        return f"waited {secs:.1f}s"

    raise RuntimeError(f"unknown action '{act}'")


_ICONS = {
    "click": "🖱️", "double_click": "🖱️", "right_click": "🖱️", "type": "⌨️",
    "key": "⌨️", "hotkey": "⌨️", "scroll": "🖲️", "drag": "✋", "wait": "⏳",
}


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------
def _finish(player, spoken: str, log_line: str) -> None:
    _log(player, f"JARVIS: {log_line}")
    _panel(player, log_line)
    _say(player, spoken)
    with _lock:
        _state["running"]  = False
        _state["pending"]  = ""
        _state["approved"] = False


def _await_approval(player, description: str, timeout: float = 180.0) -> bool:
    """Pause and ask the user out loud. Returns True if they approved.

    The answer comes back as a normal tool call — the user says yes in whatever
    words and language they like, and Gemini calls screen_agent(action=
    'confirm'). That is why there is no keyword list here.
    """
    ev = _state["confirm"]
    ev.clear()
    with _lock:
        _state["approved"] = False
        _state["pending"]  = description
    _panel(player, f"   ⏸️  waiting for your approval — {description}")
    _say(player, f"Tell the user you are about to {description}, that this cannot "
                 f"be undone, and ask whether you should go ahead. Keep it to one "
                 f"short sentence.")
    ev.wait(timeout)
    with _lock:
        ok = bool(_state["approved"])
        _state["pending"] = ""
    return ok


def _worker(player, goal: str, max_steps: int, dry_run: bool,
            cfg: dict, api_key: str) -> None:
    global _uia_enabled

    stop        = _state["stop"]
    model       = str(cfg.get("model") or _DEFAULTS["model"])
    settle      = _cfg_int(cfg, "settle_ms", 0, 5000) / 1000.0
    narrate     = _cfg_bool(cfg, "narrate")
    _uia_enabled = _cfg_bool(cfg, "use_uia")
    confirm_raw = str(cfg.get("confirm_mode") or "irreversible").lower()
    confirm_all = confirm_raw.startswith("every")
    confirm_off = confirm_raw.startswith("never")

    history: list[str] = []
    recent:  list[str] = []

    try:
        mon    = _pick_monitor(cfg)
        scale  = _scale_factor()
        print(f"[ScreenAgent] monitor {mon['width']}x{mon['height']} at "
              f"({mon['left']},{mon['top']}), physical->logical scale {scale:.3f}")

        for step in range(1, max_steps + 1):
            if stop.is_set():
                _finish(player,
                        "Tell the user you have stopped working on the screen.",
                        f"⏹️  Stopped at step {step}.")
                return

            with _lock:
                _state["step"] = step

            img, _w, _h = _grab(mon)
            data = _decide(model, goal, history, img, stop)

            act  = str(data.get("action") or "").strip().lower()
            obs  = str(data.get("observation") or "").strip()
            msg  = str(data.get("message") or "").strip()
            risk = str(data.get("risk") or "safe").strip().lower()
            with _lock:
                _state["last"] = obs

            print(f"[ScreenAgent] [{step}/{max_steps}] {act} - {obs[:90]}")

            if act == "done":
                _finish(player,
                        f"Tell the user the task on screen is finished: {msg or goal}",
                        f"✅ {msg or 'Done.'}")
                return

            if act == "fail":
                _finish(player,
                        f"Tell the user you could not finish the task on screen, and "
                        f"why: {msg or 'the screen did not show what was needed'}",
                        f"⚠️ {msg or 'Could not finish.'}")
                return

            if act == "ask":
                _finish(player,
                        f"Tell the user you have stopped because this step needs them: "
                        f"{msg or 'it requires information only they should enter'}. "
                        f"Ask them to do that part themselves and then tell you to continue.",
                        f"🙋 {msg or 'Needs you.'}")
                return

            label = str(data.get("target_text") or "").strip()
            plain = f"{act} {label}".strip() if label else act

            # Stuck detector — three identical decisions in a row means the
            # screen is not responding the way the model believes it is.
            recent.append(f"{act}|{label}|{data.get('point')}")
            if len(recent) >= 3 and len(set(recent[-3:])) == 1:
                _finish(player,
                        "Tell the user the screen stopped responding to what you were "
                        "trying, so you stopped rather than repeating yourself.",
                        "⚠️ Stuck — the same step had no effect three times.")
                return

            if dry_run:
                _panel(player, f"[{step}/{max_steps}] 👀 would {plain}")
                history.append(f"{step}. (dry run) would {plain} — {obs}")
                continue

            needs_ok = (not confirm_off) and (confirm_all or risk == "irreversible")
            if needs_ok:
                if not _await_approval(player, plain):
                    _finish(player,
                            "Tell the user you did not go ahead with that step and "
                            "have stopped.",
                            f'⏹️  Not approved — stopped before "{plain}".')
                    return
                if stop.is_set():
                    _finish(player,
                            "Tell the user you have stopped working on the screen.",
                            "⏹️  Stopped.")
                    return

            try:
                did = _perform(act, data, mon, scale)
            except Exception as e:
                if type(e).__name__ == "FailSafeException":
                    _finish(player,
                            "Tell the user you stopped immediately because they moved "
                            "the mouse to the corner.",
                            "🛑 Aborted by the mouse-corner failsafe.")
                    return
                history.append(f"{step}. tried {plain} but it failed: {e}")
                _panel(player, f"[{step}/{max_steps}] ⚠️ {plain} failed: {e}")
                continue

            icon = _ICONS.get(act, "•")
            _panel(player, f"[{step}/{max_steps}] {icon} {did}")
            history.append(f"{step}. {did} — before it, the screen showed: {obs}")
            if narrate and msg:
                _say(player, f"Briefly tell the user, in one short sentence: {msg}")

            time.sleep(settle)

        _finish(player,
                f"Tell the user you reached the step limit of {max_steps} without "
                f"finishing, and ask whether you should carry on.",
                f"⏹️  Step limit ({max_steps}) reached.")

    except QuotaExhausted as e:
        print(f"[ScreenAgent] quota: {e}")
        _finish(player,
                f"Tell the user you had to stop because {e}. Suggest they try "
                f"again later or use a smaller step limit.",
                "❌ Out of API quota.")
    except Exception as e:
        print(f"[ScreenAgent] failed: {e}")
        _finish(player,
                f"Tell the user the screen agent could not run: {e}",
                f"❌ Screen agent failed: {e}")


# ---------------------------------------------------------------------------
# Settings self-test — the honest way to check aim: it finds something on the
# real screen and parks the mouse on it. Nothing is ever clicked.
# ---------------------------------------------------------------------------
def _missing_deps() -> list[str]:
    out = []
    if not _PYAUTOGUI:
        out.append("pyautogui")
    if not _MSS:
        out.append("mss")
    if not _PIL:
        out.append("pillow")
    return out


def _self_test(values: dict) -> str:
    from memory.config_manager import get_gemini_key

    missing = _missing_deps()
    if missing:
        return f"Missing: {', '.join(missing)}"
    key = get_gemini_key()
    if not key:
        return "No Gemini API key configured."

    cfg = dict(_DEFAULTS)
    cfg.update({k: v for k, v in (values or {}).items() if v not in (None, "")})

    try:
        mon   = _pick_monitor(cfg)
        scale = _scale_factor()
        img, _w, _h = _grab(mon)
        data = _decide(str(cfg.get("model")),
                       "Point at the single most obvious clickable button or icon "
                       "on this screen. Use action 'click'.", [], img)
        label = str(data.get("target_text") or "?")
        xy = _point_to_screen(data.get("point") or [], mon, scale)
        if not xy:
            return "The model answered, but gave no usable coordinate."
        pyautogui.moveTo(xy[0], xy[1], duration=0.4)
        return (f'OK — aimed at "{label}" at {xy} on a {mon["width"]}x{mon["height"]} '
                f"monitor (scale {scale:.2f}). The mouse is on it now; "
                f"nothing was clicked.")
    except Exception as e:
        return f"Test failed: {e}"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def run(parameters: dict, player=None, session_memory=None) -> str:
    action = str((parameters or {}).get("action") or "start").strip().lower()

    # -- stop ---------------------------------------------------------------
    if action in ("stop", "cancel", "abort"):
        with _lock:
            running = _state["running"]
            stop_ev, conf_ev = _state["stop"], _state["confirm"]
        if not running:
            return "The screen agent is not doing anything right now."
        if stop_ev:
            stop_ev.set()
        if conf_ev:
            with _lock:
                _state["approved"] = False
            conf_ev.set()            # unblock a pending approval so it can exit
        _log(player, "JARVIS: Screen agent stopping.")
        return ("Stopping. Confirm to the user that you have stopped working on "
                "the screen.")

    # -- confirm ------------------------------------------------------------
    if action in ("confirm", "approve", "yes", "continue"):
        with _lock:
            pending = _state["pending"]
            conf_ev = _state["confirm"]
        if not pending or not conf_ev:
            return ("There is no step waiting for approval. Say nothing about "
                    "approval and just continue the conversation normally.")
        with _lock:
            _state["approved"] = True
        conf_ev.set()
        return (f'Approved — continuing with "{pending}". Acknowledge in one short '
                f"sentence, then stay quiet; I report the rest myself.")

    # -- status -------------------------------------------------------------
    if action == "status":
        with _lock:
            if not _state["running"]:
                return "The screen agent is idle."
            step, total = _state["step"], _state["max_steps"]
            goal, last, pend = _state["goal"], _state["last"], _state["pending"]
        if pend:
            return (f"Paused at step {step} of {total}, waiting for approval to "
                    f"{pend}. Goal: {goal}")
        return (f'Working on the screen: "{goal}". Step {step} of {total}. '
                f"Last thing seen: {last or 'nothing yet'}.")

    # -- start --------------------------------------------------------------
    missing = _missing_deps()
    if missing:
        return (f"I cannot use the screen: {', '.join(missing)} "
                f"{'is' if len(missing) == 1 else 'are'} not installed. "
                f"Install with: pip install {' '.join(missing)}")

    from memory.config_manager import get_gemini_key
    api_key = get_gemini_key()
    if not api_key:
        return "I cannot use the screen: no Gemini API key is configured."

    goal = str((parameters or {}).get("goal") or "").strip()
    if not goal:
        return ("Ask the user what exactly they want done on the screen — I need "
                "a concrete goal before I can start.")

    with _lock:
        if _state["running"]:
            return (f'I am already working on the screen: "{_state["goal"]}". Ask '
                    f"the user whether to stop that first.")

    cfg     = _cfg()
    default = _cfg_int(cfg, "max_steps", 1, _HARD_MAX_STEPS)
    try:
        requested = int((parameters or {}).get("max_steps") or default)
    except Exception:
        requested = default
    max_steps = max(1, min(_HARD_MAX_STEPS, requested))
    dry_run   = bool((parameters or {}).get("dry_run"))

    stop_ev, conf_ev = threading.Event(), threading.Event()
    with _lock:
        _state.update({
            "running": True, "stop": stop_ev, "confirm": conf_ev,
            "approved": False, "pending": "", "goal": goal, "step": 0,
            "max_steps": max_steps, "last": "", "lines": [], "dry_run": dry_run,
        })

    _panel(player, "👁️  Looking at the screen...")
    _log(player, f"JARVIS: Working on the screen — {goal}")

    thread = threading.Thread(target=_worker, name="screen-agent",
                              args=(player, goal, max_steps, dry_run, cfg, api_key),
                              daemon=True)
    with _lock:
        _state["thread"] = thread
    thread.start()

    if dry_run:
        return ("[SCREEN_AGENT_STARTED] I am looking at the screen and planning "
                f'"{goal}" without touching anything. Tell the user that in one '
                "short sentence, then say nothing more — I report the plan myself.")
    return (f'[SCREEN_AGENT_STARTED] I am now working on the screen: "{goal}". '
            f"Tell the user you are starting, in one short sentence, then stop and "
            f"say nothing more — I narrate the important steps and the result "
            f"myself. Do not call this tool again unless the user asks to stop or "
            f"approves a step.")
