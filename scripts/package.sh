#!/bin/zsh
# Zips the extension: dist/wiki-ai-<version>.zip with only what the browser needs (no tests, no git history).
# Usage: scripts/package.sh          for testers (adds TESTING.md, the "Load unpacked" guide)
#        scripts/package.sh --store  for the Chrome Web Store (manifest at the zip's root, no tester guide)
set -euo pipefail
cd "$(dirname "$0")/.."

store=false
suffix=""
if [[ "${1:-}" == "--store" ]]; then
  store=true
  suffix="-store"
fi

version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
out="dist/wiki-ai-$version$suffix.zip"
mkdir -p dist
rm -f "$out"

# Zip from a staging folder so the archive unpacks into a single "wiki-ai" folder.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/wiki-ai"
cp -R manifest.json background content lib options icons vendor "$stage/wiki-ai/"
$store || cp TESTING.md "$stage/wiki-ai/"
rm -f "$stage/wiki-ai/icons/logo-dark.svg" # only the README uses it
find "$stage" -name '.DS_Store' -delete

# The store wants manifest.json at the root of the zip; testers get a single "wiki-ai" folder.
if $store; then
  (cd "$stage/wiki-ai" && zip -qr - .) > "$out"
else
  (cd "$stage" && zip -qr - wiki-ai) > "$out"
fi

echo "$out ($(du -h "$out" | cut -f1 | tr -d ' '))"
