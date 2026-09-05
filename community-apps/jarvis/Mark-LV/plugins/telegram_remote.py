"""
telegram_remote.py — drive JARVIS from anywhere, over Telegram.

WHY THIS EXISTS
    The Remote Dashboard already relays typed commands into the Live session
    (dashboard/server.py -> main.py _process_dashboard_commands), but it is a
    LAN thing: it binds a local IP, generates a self-signed certificate and even
    opens a firewall rule. Outside the house it is unreachable.

    Telegram solves exactly the missing half. This plugin LONG-POLLS Telegram's
    servers (getUpdates) — so there is no inbound port, no port forwarding, no
    NAT traversal and no certificate warning. The only socket ever opened is an
    outbound HTTPS connection to api.telegram.org.

    No new dependency: `requests` is already in requirements.txt.

HOW A MESSAGE BECOMES A COMMAND
    Telegram message -> allowlist + freshness + rate checks -> player.on_text_command()
    -> main.py::_on_text_command -> session.send_client_content(). That is the
    same door the desk text box uses, so a remote command behaves identically to
    one typed at the machine — including every tool, guard and undo entry.

IT ONLY LISTENS WHEN YOU SAY SO
    Plugins have no startup hook, and a remote-control channel is the last thing
    that should open because a file was in a folder. "Start the Telegram remote"
    starts it, the same way water_reminder and whatsapp_guard start their loops.

SECURITY — WHAT ACTUALLY PROTECTS YOU
    1. Allowlist.       Only chat IDs you approved are obeyed. Everything else is
                        dropped in silence — a stranger who guesses the bot never
                        even learns it is alive.
    2. Pairing code.    An unknown chat becomes allowed ONLY by sending the exact
                        code you set, compared with hmac.compare_digest. The code
                        is consumed on first use.
    3. Private only.    Groups, channels, bots and edited messages are refused.
                        An edited old message can never re-fire a command.
    4. Backlog drop.    On start the update offset jumps past everything pending,
                        so messages sent while JARVIS was off never execute.
    5. Freshness.       A message older than 2 minutes is refused even if it is
                        somehow still in the queue. Two independent replay walls.
    6. Rate limit.      20 commands per minute per chat, then silence.
    7. Reply window.    Answers go back to Telegram only for 90s after a remote
                        command, and only to the chat that sent it. Your desk
                        conversations are never mirrored to your phone.
    8. Token hygiene.   The bot token lives in config/api_keys.json and is NEVER
                        printed: requests puts the URL in its exception text, so
                        every error string is scrubbed before it is logged.
    9. Visible at desk. Every accepted remote command is written to the activity
                        log with its sender. Nothing happens invisibly.
   10. Kill switches.   /stop from an approved chat, "stop the telegram remote"
                        by voice, or action="unpair" to erase the allowlist if a
                        phone is lost.

WHAT IT DELIBERATELY DOES NOT DO
    It does not weaken the confirmation gate. Shutdown, restart and WiFi still
    put a banner on the HUD and wait for a button pressed BY A HAND. Asking for
    them from Telegram tells you the banner is up — and it stays up until someone
    is physically there. That is the correct answer, not a limitation: a remote
    channel must not be able to confirm an irreversible action on its own.
"""
from __future__ import annotations

import hmac
import queue
import threading
import time

from memory.config_manager import (
    get_assistant_name,
    get_plugin_config,
    save_plugin_config,
)

_NS = "telegram_remote"

_API          = "https://api.telegram.org/bot{token}/{method}"
_POLL_TIMEOUT = 20      # long-poll seconds; also the worst-case stop latency
_HTTP_TIMEOUT = 35      # must exceed _POLL_TIMEOUT
_MAX_AGE      = 120     # refuse messages older than this (seconds)
_FUTURE_SKEW  = 60      # tolerate this much clock skew the other way
_MAX_TEXT     = 1000    # refuse absurdly long messages
_RATE_MAX     = 20      # commands per window, per chat
_RATE_WINDOW  = 60
_REPLY_WINDOW = 90      # seconds a chat keeps receiving JARVIS's answers
_REFUSE_NOTICE = 600    # seconds between "someone tried" notices at the desk


# ── shared state ─────────────────────────────────────────────────────────────

_lock = threading.Lock()
_state: dict = {
    "running":     False,
    "stopping":    False,  # stop asked for, poller not yet wound down
    "stop":        None,   # threading.Event
    "thread":      None,
    "sender":      None,
    "outbox":      None,   # queue.Queue of (chat_id, text)
    "orig_log":    None,   # the player's real write_log, while relaying
    "player":      None,
    "reply_to":    None,   # chat_id currently allowed to receive answers
    "reply_until": 0.0,
    "bot":         "",
    "started":     0.0,
    "refused_at":  0.0,   # last time the desk was told about a refused chat
    "seen":        0,      # accepted commands this run
}
_rate: dict[int, list[float]] = {}


# ── helpers ──────────────────────────────────────────────────────────────────

def _http():
    """`requests` is imported on first use, never at module scope.

    Nothing else in the app imports it at startup — measured, it costs 173 ms —
    and plugin discovery executes every plugin file on the launch path. A remote
    channel that is off by default must not be charged to every boot. The same
    mistake the 2.1-second openwakeword import made on the settings drawer.
    """
    import requests                       # noqa: PLC0415 — deliberate, see above
    return requests


def _scrub(text, token: str) -> str:
    """requests puts the full URL — token included — in its exception text."""
    s = str(text)
    if token:
        s = s.replace(token, "<token>")
        # Telegram tokens are "<digits>:<secret>"; scrub the halves too.
        if ":" in token:
            head, _, tail = token.partition(":")
            if len(tail) > 6:
                s = s.replace(tail, "<token>")
            if len(head) > 4:
                s = s.replace(head, "<botid>")
    return s


def _cfg() -> dict:
    return get_plugin_config(_NS)


def _parse_ids(raw) -> list[int]:
    out: list[int] = []
    for part in str(raw or "").replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            continue
    return out


def _log(player, text: str) -> None:
    if not player:
        return
    try:
        # Deliberately the ORIGINAL logger when relaying is installed, so our own
        # notices are never echoed back out to Telegram.
        orig = _state.get("orig_log")
        (orig or player.write_log)(text)
    except Exception:
        pass


def _rate_ok(chat_id: int) -> bool:
    now = time.monotonic()
    hits = [t for t in _rate.get(chat_id, []) if now - t < _RATE_WINDOW]
    if len(hits) >= _RATE_MAX:
        _rate[chat_id] = hits
        return False
    hits.append(now)
    _rate[chat_id] = hits
    return True


# ── settings (⚙ → PLUGIN SETTINGS) ───────────────────────────────────────────

def _test_connection(values: dict) -> tuple[bool, str]:
    """TEST button: prove the token works and name the bot, without saving state."""
    token = (values.get("bot_token") or "").strip()
    if not token:
        return False, "No bot token. Get one from @BotFather."
    try:
        r = _http().get(_API.format(token=token, method="getMe"), timeout=15)
        data = r.json()
    except Exception as e:
        return False, f"Could not reach Telegram: {_scrub(e, token)}"
    if not data.get("ok"):
        return False, f"Telegram refused the token ({data.get('description', 'unknown error')})."
    who = "@" + (data.get("result", {}).get("username") or "bot")
    ids = _parse_ids(values.get("allowed_chat_ids", ""))
    if ids:
        return True, f"Connected as {who}. {len(ids)} approved chat(s)."
    if (values.get("pairing_code") or "").strip():
        return True, f"Connected as {who}. No approved chats yet — send the pairing code to {who}."
    return True, f"Connected as {who}. Set a pairing code, or nothing will be accepted."


PLUGIN_SETTINGS = {
    "namespace": _NS,
    "title": "✈️  TELEGRAM REMOTE",
    "fields": [
        {"key": "bot_token", "label": "Bot Token", "type": "password",
         "placeholder": "Telegram → @BotFather → /newbot → the token it gives you"},
        {"key": "pairing_code", "label": "Pairing Code (one-time)", "type": "password",
         "placeholder": "Any secret phrase. Send it to the bot once to approve your phone."},
        {"key": "allowed_chat_ids", "label": "Approved Chat IDs", "type": "text",
         "placeholder": "Filled in by pairing. Comma-separated. Empty = nothing is accepted."},
        {"key": "relay_replies", "label": "Send JARVIS's answers back to Telegram",
         "type": "toggle", "default": True},
    ],
    "action": {"label": "TEST CONNECTION", "run": lambda values: _test_connection(values or {})},
}

PLUGIN = {
    "name": "telegram_remote",
    "description": (
        "Starts, stops or reports the Telegram remote-control bridge, which lets the "
        "user command this computer from their phone over Telegram while away from "
        "home. Call this for phrases like 'start the telegram remote', 'let me "
        "control the computer from my phone', 'turn on remote control', 'stop the "
        "telegram bridge', 'is the telegram remote running'. "
        "Do NOT use this to send a message to a person — sending a WhatsApp or "
        "Telegram message to a contact is the send_message tool. This tool only "
        "opens and closes the remote-control channel; it never messages anyone."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": ("start = begin listening for remote commands; "
                                "stop = stop listening; "
                                "status = report whether it is listening and who is approved; "
                                "unpair = erase every approved chat (use if a phone is lost)."),
            },
        },
        "required": [],
    },
}


# ── outbound: a queue, because write_log must never block on the network ─────

def _enqueue(chat_id: int, text: str) -> None:
    q = _state.get("outbox")
    if q is None or not chat_id or not text:
        return
    try:
        q.put_nowait((chat_id, text[:3500]))
    except Exception:
        pass


def _sender_loop(token: str, stop: threading.Event) -> None:
    q = _state["outbox"]
    url = _API.format(token=token, method="sendMessage")
    while not stop.is_set():
        try:
            chat_id, text = q.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            # No parse_mode on purpose: JARVIS's answers are arbitrary text and
            # Markdown parsing would reject or mangle them.
            _http().post(url, json={"chat_id": chat_id, "text": text,
                                     "disable_web_page_preview": True},
                          timeout=15)
        except Exception as e:
            print(f"[TelegramRemote] send failed: {_scrub(e, token)}")


# ── reply relay: mirror JARVIS's answers back, but only inside the window ────

_name_cache: list = ["", 0.0]


def _name_prefix() -> str:
    """The assistant's name can be changed from the UI mid-session, so it is
    re-read rather than frozen at install — but cached, because the caller is on
    the path of every log line. Only ever reached inside a reply window."""
    now = time.monotonic()
    if now - _name_cache[1] > 60:
        try:
            _name_cache[0] = f"{get_assistant_name()}:"
        except Exception:
            pass
        _name_cache[1] = now
    return _name_cache[0] or "JARVIS:"


def _maybe_relay(line: str) -> None:
    chat_id = _state.get("reply_to")
    if not chat_id or time.time() > _state.get("reply_until", 0):
        return
    if not _cfg().get("relay_replies", True):
        return
    name_prefix = _name_prefix()
    if line.startswith(name_prefix):
        _enqueue(chat_id, line[len(name_prefix):].strip())
    elif line.startswith("SYS:"):
        # Carries the confirmation banner notice — the one thing a remote user
        # genuinely needs to see, because they cannot press the button.
        _enqueue(chat_id, line.strip())


def _install_relay(player) -> None:
    """Wrap the player's write_log so answers can be forwarded.

    There is no transcript callback in core, and every reply already passes
    through write_log as "<assistant name>: ..." (main.py's turn_complete
    handler), so this is the one seam that needs no core edit. It is removed
    again on stop.
    """
    with _lock:
        if _state.get("orig_log"):
            return
        orig = player.write_log
        _state["orig_log"] = orig

    def wrapped(text):
        try:
            orig(text)
        finally:
            try:
                _maybe_relay(str(text))
            except Exception:
                pass

    player.write_log = wrapped


def _remove_relay(player) -> None:
    with _lock:
        orig = _state.get("orig_log")
        _state["orig_log"] = None
    if not orig or not player:
        return
    try:
        del player.write_log          # unshadow the class method
    except Exception:
        try:
            player.write_log = orig
        except Exception:
            pass


# ── inbound ──────────────────────────────────────────────────────────────────

def _drop_backlog(token: str):
    """Return an offset past everything already queued, so nothing sent while
    JARVIS was off is executed on start. Empty queue -> nothing to skip."""
    try:
        r = _http().get(_API.format(token=token, method="getUpdates"),
                         params={"offset": -1, "timeout": 0}, timeout=15)
        result = r.json().get("result") or []
    except Exception:
        return None
    if not result:
        return None
    return result[-1]["update_id"] + 1


def _deliver(player, text: str) -> bool:
    """Hand a command to the Live session exactly as the desk text box does."""
    fn = getattr(player, "on_text_command", None)
    if not callable(fn):
        return False
    # A remote command is deliberate control and there is no WAKE button within
    # reach — so wake first if asleep, the same reasoning main.py applies to a
    # dashboard command. State is checked before toggling, because on_wake_manual
    # is a toggle and would otherwise put an awake JARVIS to sleep.
    try:
        get_state = getattr(player, "wake_get_state", None)
        wake_now  = getattr(player, "on_wake_manual", None)
        if callable(get_state) and callable(wake_now):
            st = get_state() or {}
            if st.get("enabled") and not st.get("awake"):
                wake_now()
                time.sleep(0.3)
    except Exception:
        pass
    fn(text)
    return True


def _status_text() -> str:
    if not _state.get("running"):
        return "The Telegram remote is not running."
    mins = int((time.monotonic() - _state.get("started", 0)) // 60)
    ids  = _parse_ids(_cfg().get("allowed_chat_ids", ""))
    bot  = _state.get("bot") or "the bot"
    return (f"Listening as {bot} for {mins} minute(s). "
            f"{len(ids)} approved chat(s), {_state.get('seen', 0)} command(s) this session.")


def _handle(player, msg: dict, token: str) -> None:
    chat = msg.get("chat") or {}
    frm  = msg.get("from") or {}
    chat_id = chat.get("id")

    # -- shape: private human chats only -------------------------------------
    if chat.get("type") != "private" or frm.get("is_bot") or not isinstance(chat_id, int):
        return
    text = msg.get("text")
    if not isinstance(text, str):
        return
    text = text.strip()
    if not text or len(text) > _MAX_TEXT:
        return

    # -- freshness: second replay wall behind the backlog drop ---------------
    ts = msg.get("date")
    if isinstance(ts, (int, float)):
        age = time.time() - ts
        if age > _MAX_AGE or age < -_FUTURE_SKEW:
            return

    cfg     = _cfg()
    allowed = _parse_ids(cfg.get("allowed_chat_ids", ""))

    # -- pairing: the ONLY thing an unapproved chat may do -------------------
    if chat_id not in allowed:
        code = str(cfg.get("pairing_code") or "").strip()
        if code and hmac.compare_digest(text, code):
            allowed.append(chat_id)
            save_plugin_config(_NS, {
                "allowed_chat_ids": ",".join(str(i) for i in allowed),
                "pairing_code": "",           # consumed — one use only
            })
            _enqueue(chat_id, "Paired. This chat can now command the computer.")
            _log(player, f"SYS: Telegram remote paired with chat {chat_id}.")
            return
        # Silence towards Telegram — answering would confirm to a stranger that
        # the bot is live. But somebody trying to reach your computer IS news,
        # so the desk hears about it, throttled so it cannot be used to flood
        # the activity log.
        print(f"[TelegramRemote] refused chat {chat_id} (not approved)")
        now = time.monotonic()
        if now - _state.get("refused_at", 0.0) > _REFUSE_NOTICE:
            _state["refused_at"] = now
            _log(player, f"SYS: Telegram remote refused an unapproved chat ({chat_id}).")
        return

    if not _rate_ok(chat_id):
        return

    lower = text.lower()

    if lower in ("/start", "/help"):
        _enqueue(chat_id, "Approved. Send any command in plain language. "
                          "/status shows state, /stop closes this bridge.")
        return
    if lower == "/id":
        _enqueue(chat_id, f"This chat's ID is {chat_id}.")
        return
    if lower == "/status":
        _enqueue(chat_id, _status_text())
        return
    if lower == "/stop":
        _enqueue(chat_id, "Closing the remote bridge. Start it again from the computer.")
        time.sleep(0.6)                        # let the sender drain first
        ev = _state.get("stop")
        if ev:
            ev.set()
        return

    # -- a real command ------------------------------------------------------
    _state["reply_to"]    = chat_id
    _state["reply_until"] = time.time() + _REPLY_WINDOW

    who = str(frm.get("first_name") or frm.get("username") or chat_id)[:32]
    if _deliver(player, text):
        _state["seen"] = _state.get("seen", 0) + 1
        _log(player, f"[Telegram {who}]: {text}")
    else:
        _enqueue(chat_id, "No live session right now — the command was not run.")


def _worker(player, stop: threading.Event, token: str) -> None:
    offset = _drop_backlog(token)
    url    = _API.format(token=token, method="getUpdates")
    fails  = 0
    _log(player, "SYS: Telegram remote is listening.")
    try:
        while not stop.is_set():
            try:
                params = {"timeout": _POLL_TIMEOUT, "allowed_updates": '["message"]'}
                if offset is not None:
                    params["offset"] = offset
                r = _http().get(url, params=params, timeout=_HTTP_TIMEOUT)
                if r.status_code == 401:
                    _log(player, "SYS: Telegram rejected the bot token — remote stopped.")
                    return
                if r.status_code == 409:
                    _log(player, "SYS: Another Telegram poller is using this bot — remote stopped.")
                    return
                data = r.json()
                if not data.get("ok"):
                    raise RuntimeError(data.get("description", "getUpdates failed"))
                fails = 0
                for upd in data.get("result") or []:
                    offset = upd["update_id"] + 1
                    if stop.is_set():
                        break
                    # Only "message". An edited_message must never re-fire a command.
                    msg = upd.get("message")
                    if isinstance(msg, dict):
                        try:
                            _handle(player, msg, token)
                        except Exception as e:
                            print(f"[TelegramRemote] handler error: {_scrub(e, token)}")
            except Exception as e:
                fails += 1
                print(f"[TelegramRemote] poll error: {_scrub(e, token)}")
                if fails == 5:
                    _log(player, "SYS: Telegram remote is having trouble reaching "
                                 "Telegram — still retrying.")
                stop.wait(min(60, 2 ** min(fails, 5)))
    finally:
        with _lock:
            _state["running"]  = False
            _state["stopping"] = False
        _remove_relay(player)
        _state["reply_to"] = None
        _log(player, "SYS: Telegram remote stopped listening.")


# ── entry point ──────────────────────────────────────────────────────────────

def run(parameters: dict, player=None, session_memory=None) -> str:
    action = (parameters.get("action") or "start").strip().lower()

    # -------- STATUS --------
    if action in ("status", "state", "info"):
        return _status_text()

    # -------- UNPAIR --------
    if action in ("unpair", "revoke", "forget"):
        try:
            save_plugin_config(_NS, {"allowed_chat_ids": ""})
        except Exception as e:
            return f"Sir, I could not clear the approved chats: {e}"
        _log(player, "SYS: Telegram remote — every approved chat revoked.")
        return ("Every approved chat has been revoked. No phone can command this "
                "computer until you pair one again with a new pairing code.")

    # -------- STOP --------
    if action in ("stop", "off", "disable", "close"):
        with _lock:
            ev = _state.get("stop")
            running = _state.get("running")
            if running and ev is not None:
                _state["stopping"] = True
        if not running or ev is None:
            return "The Telegram remote is not running."
        ev.set()
        return "Telegram remote closed. Nothing can reach the computer from outside now."

    # -------- START --------
    # Claimed under the lock, not merely checked under it: two starts arriving
    # together would otherwise both pass and Telegram would answer the second
    # poller with a 409, killing the pair.
    with _lock:
        if _state.get("stopping"):
            return ("The Telegram remote is still closing the last connection — "
                    "give it a moment and ask again.")
        if _state.get("running"):
            return "The Telegram remote is already listening."
        _state["running"] = True

    def _release() -> None:
        with _lock:
            _state["running"] = False

    cfg   = _cfg()
    token = str(cfg.get("bot_token") or "").strip()
    if not token:
        _release()
        return ("There's no bot token set. Open the settings, create a bot with "
                "Telegram's @BotFather, paste the token into TELEGRAM REMOTE and "
                "set a pairing code.")

    if (not _parse_ids(cfg.get("allowed_chat_ids", ""))
            and not str(cfg.get("pairing_code") or "").strip()):
        _release()
        return ("No approved chats and no pairing code, so nothing could ever be "
                "accepted. Set a pairing code in the settings first, then message "
                "that code to your bot once to approve your phone.")

    if player is None:
        _release()
        return "Sir, I have no interface to route remote commands into."

    try:
        r = _http().get(_API.format(token=token, method="getMe"), timeout=15)
        me = r.json()
        if not me.get("ok"):
            _release()
            return f"Telegram refused the token: {me.get('description', 'unknown error')}."
        bot_name = "@" + (me.get("result", {}).get("username") or "bot")
    except Exception as e:
        _release()
        return f"Sir, I couldn't reach Telegram: {_scrub(e, token)}"

    stop = threading.Event()
    _state.update({
        "running": True, "stopping": False,
        "stop": stop, "outbox": queue.Queue(maxsize=200),
        "bot": bot_name, "started": time.monotonic(), "seen": 0,
        "player": player, "reply_to": None, "reply_until": 0.0,
    })
    _rate.clear()

    if cfg.get("relay_replies", True):
        _install_relay(player)

    sender = threading.Thread(target=_sender_loop, args=(token, stop),
                              daemon=True, name="telegram-remote-send")
    sender.start()
    thread = threading.Thread(target=_worker, args=(player, stop, token),
                              daemon=True, name="telegram-remote-poll")
    thread.start()
    _state["sender"], _state["thread"] = sender, thread

    ids = _parse_ids(cfg.get("allowed_chat_ids", ""))
    if ids:
        return (f"Telegram remote is live on {bot_name}. Message it from any of your "
                f"{len(ids)} approved chats and I'll act on it here.")
    return (f"Telegram remote is live on {bot_name}, but no chat is approved yet. "
            f"Send your pairing code to {bot_name} once and that chat becomes the "
            f"only one I'll obey.")
