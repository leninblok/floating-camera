#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1" ]]; then
  echo "Usage: npm run verify:mac -- 'dist/mac/Кружок.app'" >&2
  exit 64
fi

app_path="$1"
codesign --verify --strict --verbose=2 "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"
xcrun stapler validate "$app_path"
