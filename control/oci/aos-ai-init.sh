#!/bin/bash
# First boot of aos-ai (cloud-init user data): install Tailscale and print its login link to the serial console,
# where the aos runner reads it with `oci compute console-history` and sends it to Discord. No inbound ports needed.
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname aos-ai 2>&1 | while IFS= read -r l; do echo "<2>AOSTS $l" > /dev/kmsg; done &
