#!/bin/sh
# Render build/icon.svg → build/icon.png → build/icon.icns (what the .app actually uses).
set -e
cd "$(dirname "$0")/.."
npx electron scripts/render-icon.cjs >/dev/null 2>&1
set=$(mktemp -d)/icon.iconset
mkdir -p "$set"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$set/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$set/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o build/icon.icns
echo "build/icon.icns updated"
