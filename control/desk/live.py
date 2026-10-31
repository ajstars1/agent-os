"""Live view of the desktop in Discord: one webhook message whose screenshot is swapped every few seconds.

Started by the desk MCP (live_start). Usage: python3 -I live.py <minutes> <every_seconds>
Stdlib only. The webhook URL comes from control/.env.local (DISCORD_WEBHOOK_URL).
"""

import json
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env.local"
PID_FILE = Path.home() / ".cache" / "aos-desk" / "live.pid"


def webhook_url() -> str:
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("DISCORD_WEBHOOK_URL="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("DISCORD_WEBHOOK_URL missing in control/.env.local")


def grab() -> bytes | None:
    r = subprocess.run(["grim", "-c", "-t", "png", "-l", "4", "-"], capture_output=True, timeout=15)
    return r.stdout if r.returncode == 0 else None


def send(method: str, url: str, content: str, png: bytes | None) -> dict:
    payload: dict = {"content": content, "allowed_mentions": {"parse": []}}
    if png is None:
        body, ctype = json.dumps(payload).encode(), "application/json"
    else:
        payload["attachments"] = [{"id": 0, "filename": "screen.png"}]
        b = uuid.uuid4().hex
        body = b"".join([
            f'--{b}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n'.encode(),
            json.dumps(payload).encode(),
            f'\r\n--{b}\r\nContent-Disposition: form-data; name="files[0]"; filename="screen.png"\r\nContent-Type: image/png\r\n\r\n'.encode(),
            png,
            f"\r\n--{b}--\r\n".encode(),
        ])
        ctype = f"multipart/form-data; boundary={b}"
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Content-Type": ctype, "User-Agent": "aos-desk-live (1.0)"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as err:
            if err.code != 429:
                raise
            time.sleep(float(json.loads(err.read() or b"{}").get("retry_after", 2)))
    return {}


def main() -> None:
    minutes, every = float(sys.argv[1]), float(sys.argv[2])
    hook = webhook_url()
    stop = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.update(now=True))
    end = time.time() + minutes * 60
    stamp = lambda: time.strftime("%H:%M:%S")  # noqa: E731
    msg = send("POST", hook + "?wait=true", f"🔴 live view, {minutes:g} min ({stamp()})", grab())
    edit = f"{hook}/messages/{msg['id']}"
    try:
        while not stop["now"] and time.time() < end:
            time.sleep(every)
            png = grab()
            label = f"🔴 live {stamp()}, ends {time.strftime('%H:%M', time.localtime(end))}"
            send("PATCH", edit, label if png else f"{label}: screen locked or capture failed", png)
    finally:
        send("PATCH", edit, f"⏹ live view ended {stamp()} (last frame)", None)
        PID_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
