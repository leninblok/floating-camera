#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo 'Usage: bash scripts/smoke-macos.sh /path/to/installer.dmg' >&2
  exit 64
fi
mount_path="$(mktemp -d -t kruzhok-dmg-check)"
cleanup() {
  hdiutil detach "$mount_path" -quiet || hdiutil detach "$mount_path" -force -quiet || true
  rmdir "$mount_path" 2>/dev/null || true
}
trap cleanup EXIT
hdiutil attach "$1" -mountpoint "$mount_path" -nobrowse -readonly -quiet
apps=("$mount_path"/*.app)
[[ ${#apps[@]} -eq 1 && -d "${apps[0]}" ]]
app_path="${apps[0]}"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist")"
node scripts/verify-universal.js "$app_path"
codesign --verify --strict "$app_path"
node scripts/smoke-tauri.js "$app_path/Contents/MacOS/$executable"
