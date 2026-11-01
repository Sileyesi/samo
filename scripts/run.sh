#!/usr/bin/env bash
# Build (debug unless --release) and run Samo with the CEF runtime next to the binary.
set -e
cd "$(dirname "$0")/.."
export PATH="$PWD/.tools/bin:$PATH" CEF_PATH="${CEF_PATH:-$HOME/.local/share/cef}"
profile=debug; flag=
if [ "$1" = "--release" ]; then profile=release; flag=--release; shift; fi
cargo build $flag -p samo
cef_dir="$CEF_PATH/154.0.34/cef_linux_x86_64"
out="target/$profile"
for f in "$cef_dir"/*; do [ -f "$f" ] && ln -sf "$f" "$out/"; done
ln -sfn "$cef_dir/locales" "$out/locales"
export LD_LIBRARY_PATH="$PWD/$out${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$out/samo" "$@"
