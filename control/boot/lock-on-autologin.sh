#!/bin/sh
# First exec-once in hyprland.conf. After an unattended boot the desktop is logged in (so the
# Discord agent, VNC and runner start) but locked at once, with no grace period.
[ "$AOS_AUTOLOGIN" = 1 ] || exit 0
exec hyprlock --grace 0 --immediate-render
