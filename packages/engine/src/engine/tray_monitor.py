"""
tray_monitor.py — AgentOS system tray status indicator.

Shows a colored icon in the OS menu bar / system tray:
  🟢 Green  — engine running, learner active
  🟡 Yellow — engine up but learner not reporting
  🔴 Red    — engine unreachable

Click the icon to see:
  - Maturity level + episode count + next unlock
  - Today's predictions
  - Top hot topics
  - Last self-update
  - Links to open the API dashboard

Supports:
  macOS  — menu bar (top right)
  Linux  — system tray (GNOME needs AppIndicator extension,
           KDE/XFCE work natively)

Dependencies:
  pip install pystray Pillow requests
  # Linux GNOME: sudo apt install gir1.2-ayatanaappindicator3-0.1
"""

from __future__ import annotations

import json
import platform
import subprocess
import sys
import threading
import time
import webbrowser
from typing import Any

try:
    import pystray
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print(
        "Missing dependencies. Install with:\n"
        "  pip install pystray Pillow requests\n"
        "  # Linux GNOME also needs:\n"
        "  sudo apt install gir1.2-ayatanaappindicator3-0.1"
    )
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Missing requests. Install with: pip install requests")
    sys.exit(1)


# ── Config ────────────────────────────────────────────────────────────────────

ENGINE_URL = "http://localhost:8765"
POLL_INTERVAL = 30  # seconds

COLORS = {
    "green":  (34, 197, 94),    # Tailwind green-500
    "yellow": (234, 179, 8),    # Tailwind yellow-500
    "red":    (239, 68, 68),    # Tailwind red-500
    "gray":   (107, 114, 128),  # Tailwind gray-500
}

MATURITY_EMOJI = {
    "child":       "🧒",
    "teen":        "🧑",
    "young_adult": "🧑‍💻",
    "adult":       "🧠",
}


# ── Icon generation ───────────────────────────────────────────────────────────

def _make_icon(color_name: str, size: int = 64) -> Image.Image:
    """
    Create a simple colored circle icon.
    On macOS, 22×22 is the standard menu bar size.
    On Linux, 22–32px is typical.
    """
    color = COLORS.get(color_name, COLORS["gray"])
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Outer circle (slight shadow feel)
    margin = 2
    draw.ellipse(
        [margin, margin, size - margin, size - margin],
        fill=(*color, 255),
    )

    # Inner highlight (top-left, gives depth)
    hl_size = size // 5
    draw.ellipse(
        [margin + 4, margin + 4, margin + 4 + hl_size, margin + 4 + hl_size],
        fill=(255, 255, 255, 80),
    )

    return img


ICON_GREEN  = _make_icon("green")
ICON_YELLOW = _make_icon("yellow")
ICON_RED    = _make_icon("red")
ICON_GRAY   = _make_icon("gray")


# ── Status polling ────────────────────────────────────────────────────────────

class EngineStatus:
    def __init__(self) -> None:
        self.reachable: bool = False
        self.stats: dict[str, Any] = {}
        self.predictions: list[dict[str, Any]] = []
        self.hot_topics: list[dict[str, Any]] = []
        self.last_checked: float = 0.0
        self.error: str = ""

    def refresh(self) -> None:
        try:
            stats_resp = requests.get(f"{ENGINE_URL}/learner/stats", timeout=4)
            if stats_resp.status_code == 200:
                self.stats = stats_resp.json()
                self.reachable = True
                self.error = ""

                # Fetch predictions and hot topics in parallel-ish (simple sequential)
                try:
                    self.predictions = requests.get(
                        f"{ENGINE_URL}/learner/predictions", timeout=3
                    ).json()[:5]
                except Exception:
                    pass

                try:
                    self.hot_topics = requests.get(
                        f"{ENGINE_URL}/learner/hot-topics?limit=5", timeout=3
                    ).json()[:5]
                except Exception:
                    pass
            else:
                self.reachable = False
                self.error = f"HTTP {stats_resp.status_code}"
        except requests.exceptions.ConnectionError:
            self.reachable = False
            self.error = "Engine not running"
        except Exception as e:
            self.reachable = False
            self.error = str(e)

        self.last_checked = time.time()

    @property
    def learner_active(self) -> bool:
        return self.reachable and self.stats.get("running", False)

    @property
    def icon_state(self) -> str:
        if not self.reachable:
            return "red"
        if self.learner_active:
            return "green"
        return "yellow"

    @property
    def maturity(self) -> str:
        return str(self.stats.get("maturity", "child"))

    @property
    def episode_count(self) -> int:
        return int(self.stats.get("episode_count", 0))

    @property
    def next_unlock(self) -> dict[str, Any]:
        return self.stats.get("next_unlock", {})  # type: ignore[return-value]


# ── Menu builder ──────────────────────────────────────────────────────────────

def _build_menu(status: EngineStatus, tray_app: "TrayApp") -> pystray.Menu:
    items: list[pystray.MenuItem] = []

    if not status.reachable:
        items += [
            pystray.MenuItem("🔴 AgentOS Engine — Offline", None, enabled=False),
            pystray.MenuItem(f"  {status.error}", None, enabled=False),
            pystray.MenuItem(pystray.Menu.SEPARATOR, None),
            pystray.MenuItem("Start Engine", tray_app.start_engine),
        ]
    else:
        emoji = MATURITY_EMOJI.get(status.maturity, "🤖")
        items.append(
            pystray.MenuItem(
                f"🟢 AgentOS — {emoji} {status.maturity.replace('_', ' ').title()}",
                None, enabled=False,
            )
        )

        # Episode count + progress to next unlock
        next_ul = status.next_unlock
        remaining = next_ul.get("remaining", 0)
        at = next_ul.get("at", 0)
        if isinstance(remaining, int) and remaining > 0 and isinstance(at, int):
            filled = max(0, at - remaining)
            bar_len = 12
            pct = filled / at if at > 0 else 0
            filled_bars = int(pct * bar_len)
            bar = "█" * filled_bars + "░" * (bar_len - filled_bars)
            items.append(
                pystray.MenuItem(
                    f"  [{bar}] {status.episode_count} episodes",
                    None, enabled=False,
                )
            )
            items.append(
                pystray.MenuItem(
                    f"  Next: {next_ul.get('unlocks', '?')} in {remaining} more",
                    None, enabled=False,
                )
            )
        else:
            items.append(
                pystray.MenuItem(
                    f"  {status.episode_count} episodes — fully unlocked",
                    None, enabled=False,
                )
            )

        items.append(pystray.MenuItem(pystray.Menu.SEPARATOR, None))

        # Predictions
        if status.predictions:
            items.append(pystray.MenuItem("📍 Today's predictions:", None, enabled=False))
            for p in status.predictions[:4]:
                conf = int(float(p.get("confidence", 0)) * 100)
                items.append(
                    pystray.MenuItem(
                        f"   {p.get('topic', '?')}  {conf}%",
                        None, enabled=False,
                    )
                )
        else:
            items.append(pystray.MenuItem("📍 No predictions yet", None, enabled=False))

        items.append(pystray.MenuItem(pystray.Menu.SEPARATOR, None))

        # Hot topics
        if status.hot_topics:
            topics_str = "  " + "  ·  ".join(
                t.get("topic", "") for t in status.hot_topics[:4]
            )
            items.append(pystray.MenuItem("🔥 Hot topics:", None, enabled=False))
            items.append(pystray.MenuItem(topics_str, None, enabled=False))

        items.append(pystray.MenuItem(pystray.Menu.SEPARATOR, None))

        # Links
        items += [
            pystray.MenuItem("Open Self-Model", tray_app.open_self_model),
            pystray.MenuItem("Open Audit Log", tray_app.open_audit_log),
            pystray.MenuItem("Open API Docs", tray_app.open_api_docs),
        ]

    # Footer
    checked_ago = int(time.time() - status.last_checked)
    items += [
        pystray.MenuItem(pystray.Menu.SEPARATOR, None),
        pystray.MenuItem(f"Refresh (last {checked_ago}s ago)", tray_app.refresh_now),
        pystray.MenuItem("Quit", tray_app.quit),
    ]

    return pystray.Menu(*items)


# ── TrayApp ───────────────────────────────────────────────────────────────────

class TrayApp:
    def __init__(self) -> None:
        self.status = EngineStatus()
        self._running = True

        # Initial poll before showing icon
        self.status.refresh()

        self.icon = pystray.Icon(
            name="agent-os",
            icon=self._current_icon(),
            title=self._current_title(),
            menu=_build_menu(self.status, self),
        )

    def _current_icon(self) -> Image.Image:
        state = self.status.icon_state
        return {"green": ICON_GREEN, "yellow": ICON_YELLOW, "red": ICON_RED}.get(
            state, ICON_GRAY
        )

    def _current_title(self) -> str:
        """Tooltip / hover text."""
        if not self.status.reachable:
            return "AgentOS — Engine offline"
        maturity = self.status.maturity.replace("_", " ").title()
        ep = self.status.episode_count
        return f"AgentOS — {maturity} • {ep} episodes"

    def _update(self) -> None:
        self.status.refresh()
        self.icon.icon = self._current_icon()
        self.icon.title = self._current_title()
        self.icon.menu = _build_menu(self.status, self)

    def _poll_loop(self) -> None:
        while self._running:
            time.sleep(POLL_INTERVAL)
            if self._running:
                self._update()

    def refresh_now(self, icon: Any, item: Any) -> None:
        threading.Thread(target=self._update, daemon=True).start()

    def start_engine(self, icon: Any, item: Any) -> None:
        """Try to start the engine service."""
        os_name = platform.system()
        if os_name == "Linux":
            subprocess.Popen(["systemctl", "--user", "start", "agent-os-engine"])
        elif os_name == "Darwin":
            subprocess.Popen(
                ["launchctl", "load",
                 f"{__import__('os').path.expanduser('~')}/Library/LaunchAgents/com.agent-os.engine.plist"]
            )
        threading.Thread(target=lambda: (time.sleep(3), self._update()), daemon=True).start()

    def open_self_model(self, icon: Any, item: Any) -> None:
        webbrowser.open(f"{ENGINE_URL}/learner/self-model")

    def open_audit_log(self, icon: Any, item: Any) -> None:
        webbrowser.open(f"{ENGINE_URL}/learner/audit-log")

    def open_api_docs(self, icon: Any, item: Any) -> None:
        webbrowser.open(f"{ENGINE_URL}/docs")

    def quit(self, icon: Any, item: Any) -> None:
        self._running = False
        self.icon.stop()

    def run(self) -> None:
        # Start background polling thread
        poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
        poll_thread.start()

        # Run the tray icon (blocks until quit)
        self.icon.run()


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    app = TrayApp()
    app.run()


if __name__ == "__main__":
    main()
