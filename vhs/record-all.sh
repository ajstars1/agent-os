#!/bin/bash
# Record all AgentOS demo GIFs
# Usage: ./vhs/record-all.sh
#
# Requires: vhs  (brew install vhs  OR  go install github.com/charmbracelet/vhs@latest)

set -e

cd "$(dirname "$0")/.."

if ! command -v vhs &>/dev/null; then
  echo "vhs not found. Install it:"
  echo "  brew install vhs"
  echo "  # or: go install github.com/charmbracelet/vhs@latest"
  exit 1
fi

TAPES=(speed memory companion learner skills arch)

echo "Recording individual sections…"
for tape in "${TAPES[@]}"; do
  echo "  → $tape"
  vhs "vhs/${tape}.tape"
done

echo "Recording full showcase (this takes ~55s)…"
vhs vhs/full.tape

echo ""
echo "Done. GIFs saved to vhs/gifs/"
ls -lh vhs/gifs/*.gif 2>/dev/null
