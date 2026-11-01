#!/usr/bin/env bash
# Build a self-contained Linux bundle: dist/samo-<version>-linux-x86_64.tar.gz
# (binary + CEF runtime + UI + icons + .desktop + install.sh).
#   scripts/package-linux.sh [--no-build] [version]
set -euo pipefail
cd "$(dirname "$0")/.."
build=1
[ "${1:-}" = "--no-build" ] && { build=0; shift; }
version="${1:-}"; case "$version" in v[0-9]*|[0-9]*) ;; *) version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)";; esac
version="${version#v}"
export PATH="$PWD/.tools/bin:$PATH" CEF_PATH="${CEF_PATH:-$HOME/.local/share/cef}"
[ "$build" = 1 ] && cargo build --release -p samo

cef_dir="$(ls -d "$CEF_PATH"/*/cef_linux_x86_64 | head -1)"
name="samo-$version-linux-x86_64"
out="dist/$name"
rm -rf "$out" && mkdir -p "$out/share/icons"

install -m755 target/release/samo "$out/samo"
strip "$out/samo" 2>/dev/null || true
# CEF runtime (no headers/cmake/sources, no setuid sandbox: Samo runs with --no-sandbox).
for f in "$cef_dir"/*; do
  case "$(basename "$f")" in
    *.so|*.so.*|*.pak|*.dat|*.bin|*.json|CREDITS.html) cp -L "$f" "$out/" ;;
  esac
done
cp -rL "$cef_dir/locales" "$out/locales"
mv "$out/CREDITS.html" "$out/CEF-CREDITS.html"
rm -f "$out/archive.json"
# The CEF distribution ships libcef.so with debug info (~1.4 GB); stripped it is ~250 MB.
strip --strip-unneeded "$out"/*.so "$out"/*.so.* 2>/dev/null || true

mkdir -p "$out/ui" && cp -r ui/. "$out/ui/" && rm -rf "$out/ui/dev" "$out/ui/pages/dev-mock.js"
cp packaging/icons/samo.svg packaging/icons/samo-*.png "$out/share/icons/"
cp packaging/linux/samo.desktop "$out/share/samo.desktop"
install -m755 packaging/linux/install.sh "$out/install.sh"
cp LICENSE README.md "$out/"

tar -C dist -czf "dist/$name.tar.gz" "$name"
echo "dist/$name.tar.gz ($(du -h "dist/$name.tar.gz" | cut -f1))"
