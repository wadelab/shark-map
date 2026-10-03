#!/usr/bin/env bash
# Assemble the deployable site in _site/ and stamp the version into index.html.
# The version is VERSION plus the short commit SHA, e.g. v0.1.0+1a2b3c4.
set -euo pipefail
cd "$(dirname "$0")/.."

sha="${GITHUB_SHA:-$(git rev-parse --verify -q HEAD 2>/dev/null || true)}"
sha="$(printf '%s' "$sha" | tr -cd '0-9a-f' | cut -c1-7)"
release="$(tr -cd '0-9.' < VERSION)"
version="v${release}+${sha:-unknown}"
built="$(date -u +%Y-%m-%dT%H:%MZ)"

rm -rf _site
mkdir -p _site
cp -r index.html app.js style.css maple-leaf.svg vendor _site/
sed -i.bak -e "s|__APP_VERSION__|${version}|" -e "s|__BUILD_DATE__|${built}|" _site/index.html
rm _site/index.html.bak

if grep -q '__APP_VERSION__\|__BUILD_DATE__' _site/index.html; then
  echo "version placeholders were not replaced" >&2
  exit 1
fi
echo "Built ${version} at ${built}"
