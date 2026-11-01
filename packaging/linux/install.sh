#!/usr/bin/env bash
# Install Samo from this folder as a desktop application.
#   ./install.sh            per-user: ~/.local/opt/samo (no root needed)
#   sudo ./install.sh --system   system-wide: /opt/samo
#   ./install.sh --uninstall     remove a per-user install (add --system for /opt)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
system=0 uninstall=0
for a in "$@"; do
  case "$a" in
    --system) system=1 ;;
    --uninstall) uninstall=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
if [ "$system" = 1 ]; then
  prefix=/opt/samo bindir=/usr/local/bin share=/usr/share
else
  prefix="$HOME/.local/opt/samo" bindir="$HOME/.local/bin" share="${XDG_DATA_HOME:-$HOME/.local/share}"
fi

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$share/applications" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$share/icons/hicolor" || true
}

if [ "$uninstall" = 1 ]; then
  rm -rf "$prefix" "$bindir/samo" "$share/applications/samo.desktop"
  rm -f "$share"/icons/hicolor/*/apps/samo.png "$share/icons/hicolor/scalable/apps/samo.svg"
  refresh
  echo "Samo removed. Your profile stays in ~/.config/samo and ~/.local/share/samo."
  exit 0
fi

echo "Installing Samo to $prefix"
rm -rf "$prefix"
mkdir -p "$prefix" "$bindir" "$share/applications"
cp -a "$here/." "$prefix/"
rm -f "$prefix/install.sh"
ln -sf "$prefix/samo" "$bindir/samo"

for png in "$here"/share/icons/samo-*.png; do
  size="$(basename "$png" .png)"; size="${size#samo-}"
  mkdir -p "$share/icons/hicolor/${size}x${size}/apps"
  cp "$png" "$share/icons/hicolor/${size}x${size}/apps/samo.png"
done
mkdir -p "$share/icons/hicolor/scalable/apps"
cp "$here/share/icons/samo.svg" "$share/icons/hicolor/scalable/apps/samo.svg"

sed "s|^Exec=samo|Exec=$prefix/samo|" "$here/share/samo.desktop" > "$share/applications/samo.desktop"
refresh
echo "Done. Launch Samo from your app menu (or run: samo)."
case ":$PATH:" in *":$bindir:"*) ;; *) echo "Note: $bindir is not in PATH." ;; esac
