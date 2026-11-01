#!/bin/zsh
# Zips the extension for testers: dist/wiki-ai-<version>.zip with only what the browser needs
# (no tests, no git history) plus TESTING.md. Usage: scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
out="dist/wiki-ai-$version.zip"
mkdir -p dist
rm -f "$out"

# Zip from a staging folder so the archive unpacks into a single "wiki-ai" folder.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/wiki-ai"
cp -R manifest.json background content lib options TESTING.md "$stage/wiki-ai/"
find "$stage" -name '.DS_Store' -delete

(cd "$stage" && zip -qr - wiki-ai) > "$out"

echo "$out ($(du -h "$out" | cut -f1 | tr -d ' '))"
