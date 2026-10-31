"""aos-unlock: root service that unlocks the Hyprland lock screen when given a valid one-time code.

Runs from a root-owned copy (/usr/local/lib/aos-unlock/unlockd.py), installed by install.sh.
The TOTP secret lives in /etc/aos-unlock/secret (root 600), so nothing running as Ayush can read it;
clients (the desk MCP) can only submit codes over /run/aos-unlock.sock (root:<user> 0660).

Protocol, one line in and one JSON line out:
  unlock <6 digits> [relock_minutes]   -> unlock hyprlock, relock after relock_minutes (default 30, max 240)
  lock                                 -> lock now
  status                               -> locked?, relock pending?, lockout?
Rules: RFC 6238 (SHA1, 6 digits, 30 s, +-1 step), each code works once, 5 failures in 15 min lock out
unlocking for 15 min, and every unlock, failure and relock is posted to Discord.
"""

import base64
import grp
import hashlib
import hmac
import json
import os
import pwd
import signal
import socket
import struct
import subprocess
import threading
import time
import urllib.request

CONF = "/etc/aos-unlock"
STATE = "/var/lib/aos-unlock/state.json"
SOCK = "/run/aos-unlock.sock"
USER = open(f"{CONF}/user").read().strip()
UID = pwd.getpwnam(USER).pw_uid
MAX_FAILS, FAIL_WINDOW, LOCKOUT = 5, 15 * 60, 15 * 60

lock = threading.Lock()
relock_timer: threading.Timer | None = None
fails: list[float] = []
lockout_until = 0.0


def notify(text: str) -> None:
    try:
        url = open(f"{CONF}/webhook").read().strip()
        body = json.dumps({"content": text, "allowed_mentions": {"parse": []}}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                              "User-Agent": "aos-unlock (1.0)"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:  # noqa: BLE001 - a missing alert must never break unlocking
        pass


def last_counter() -> int:
    try:
        return int(json.load(open(STATE))["last_counter"])
    except (OSError, ValueError, KeyError):
        return 0


def save_counter(counter: int) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"last_counter": counter}, f)
    os.replace(tmp, STATE)


def totp_at(secret: bytes, counter: int) -> str:
    digest = hmac.new(secret, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def check_code(code: str) -> int | None:
    """Return the matching time step, or None. Rejects reused or older steps."""
    secret = base64.b32decode(open(f"{CONF}/secret").read().strip().upper())
    now = int(time.time() // 30)
    floor = last_counter()
    for step in (now - 1, now, now + 1):
        if step > floor and hmac.compare_digest(totp_at(secret, step), code):
            return step
    return None


def hyprlock_pids() -> list[int]:
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            if open(f"/proc/{entry}/comm").read().strip() != "hyprlock":
                continue
            if os.stat(f"/proc/{entry}").st_uid == UID:
                pids.append(int(entry))
        except OSError:
            continue
    return pids


def lock_now(reason: str) -> None:
    global relock_timer
    with lock:
        relock_timer = None
    if hyprlock_pids():
        return
    subprocess.run(["loginctl", "lock-sessions"], timeout=10, check=False)
    notify(f"🔒 PC locked ({reason}).")


def handle(line: str) -> dict:
    global relock_timer, lockout_until
    parts = line.split()
    if not parts:
        return {"ok": False, "error": "empty"}
    cmd = parts[0].lower()
    if cmd == "status":
        return {"ok": True, "locked": bool(hyprlock_pids()), "relock_pending": relock_timer is not None,
                "lockout_seconds": max(0, int(lockout_until - time.time()))}
    if cmd == "lock":
        if relock_timer:
            relock_timer.cancel()
        lock_now("asked from Discord")
        return {"ok": True, "locked": True}
    if cmd != "unlock" or len(parts) < 2:
        return {"ok": False, "error": "usage: unlock <code> [relock_minutes] | lock | status"}

    with lock:
        now = time.time()
        if now < lockout_until:
            return {"ok": False, "error": f"too many wrong codes, unlocking disabled for {int(lockout_until - now)} s"}
        code = parts[1]
        step = check_code(code) if (len(code) == 6 and code.isdigit()) else None
        if step is None:
            fails[:] = [t for t in fails if now - t < FAIL_WINDOW] + [now]
            if len(fails) >= MAX_FAILS:
                lockout_until = now + LOCKOUT
                fails.clear()
                notify(f"🚨 {MAX_FAILS} wrong unlock codes in a row: unlocking disabled for 15 min.")
                return {"ok": False, "error": "wrong code; too many failures, unlocking disabled for 15 min"}
            notify("⚠️ Wrong or reused unlock code.")
            return {"ok": False, "error": "wrong or reused code"}
        save_counter(step)
        fails.clear()

    pids = hyprlock_pids()
    if not pids:
        return {"ok": True, "unlocked": False, "note": "screen was not locked"}
    for pid in pids:
        os.kill(pid, signal.SIGUSR1)  # hyprlock unlocks on SIGUSR1
    minutes = 30
    if len(parts) > 2 and parts[2].isdigit():
        minutes = max(1, min(int(parts[2]), 240))
    with lock:
        if relock_timer:
            relock_timer.cancel()
        relock_timer = threading.Timer(minutes * 60, lock_now, args=(f"auto relock after {minutes} min",))
        relock_timer.daemon = True
        relock_timer.start()
    notify(f"🔓 PC unlocked with a one-time code. Auto relock in {minutes} min (send `lock` to lock now).")
    return {"ok": True, "unlocked": True, "relock_minutes": minutes}


def serve() -> None:
    os.makedirs(os.path.dirname(STATE), mode=0o700, exist_ok=True)
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK)
    os.chown(SOCK, 0, grp.getgrnam(USER).gr_gid)
    os.chmod(SOCK, 0o660)
    srv.listen(4)
    while True:
        conn, _ = srv.accept()
        with conn:
            conn.settimeout(5)
            try:
                line = conn.recv(256).decode(errors="replace").strip()
                reply = handle(line)
            except Exception as err:  # noqa: BLE001 - always answer the client
                reply = {"ok": False, "error": str(err)[:200]}
            conn.sendall((json.dumps(reply) + "\n").encode())


if __name__ == "__main__":
    serve()
