#!/bin/sh
# greetd's initial_session (boot only): start the normal Hyprland session flagged as an
# auto-login, so lock-on-autologin.sh locks the screen before anything else.
# Manual logins go through the sotto greeter and never set this flag.
export AOS_AUTOLOGIN=1
exec /usr/bin/start-hyprland
