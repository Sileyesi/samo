#!/bin/sh
# Dev only: headless screenshot of the chrome harness.
# usage: ui/dev/chrome-shot.sh <out.png> "<query>" [w=1280] [h=140] [virtual-time-ms=4000]
# Needs: python3 -m http.server 8791 -b 127.0.0.1 -d <repo root>
SP=${SAMO_SHOT_DIR:-${TMPDIR:-/tmp}/samo-shots}; mkdir -p "$SP"
mkdir -p "$SP/chrome-helium" "$(dirname "$1")"
timeout 40 helium-browser --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$SP/chrome-helium" --window-size=${3:-1280},${4:-140} --virtual-time-budget=${5:-4000} \
  --screenshot="$1" "http://127.0.0.1:8791/ui/dev/chrome-dev.html?$2" >/dev/null 2>&1
echo "$1"
