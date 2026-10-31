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

# Tester builds: no personal gateway, Gemini by default.
python3 - "$stage/wiki-ai/lib/settings.js" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s, a = re.subn(r"const MY_GATEWAY = '[^']*';", "const MY_GATEWAY = '';", s)
s, b = re.subn(r"const DEFAULT_PROVIDER = '[^']*';", "const DEFAULT_PROVIDER = 'gemini';", s)
if a != 1 or b != 1:
    sys.exit('package.sh: could not find MY_GATEWAY / DEFAULT_PROVIDER in lib/settings.js')
open(p, 'w').write(s)
PY
gateway_host=$(python3 -c "import re; print(re.search(r\"MY_GATEWAY = 'https://([^/']+)\", open('lib/settings.js').read()).group(1))" 2>/dev/null || true)
if [[ -n "$gateway_host" ]] && grep -rq "$gateway_host" "$stage"; then
  echo "package.sh: the gateway address is still in the build; not packaging." >&2
  exit 1
fi
(cd "$stage" && zip -qr - wiki-ai) > "$out"

echo "$out ($(du -h "$out" | cut -f1 | tr -d ' '))"
