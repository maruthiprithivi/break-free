#!/usr/bin/env bash
#
# Assemble CHANGELOG.md from changelog.d/ fragments.
#
# The Unreleased section used to be a single block every branch appended to, so
# every pair of branches conflicted there on lines neither author cared about.
# One file per change means two branches touch two different paths.
#
#   scripts/changelog.sh preview           print the assembled Unreleased section
#   scripts/changelog.sh release <version> fold fragments into CHANGELOG.md
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$root/changelog.d"
log="$root/CHANGELOG.md"

# Sorted so the output is the same on every machine, and README.md is documentation.
fragments() { find "$dir" -maxdepth 1 -name '*.md' ! -name 'README.md' | sort; }

body() {
  local f
  for f in $(fragments); do
    sed -e '$a\' "$f"   # guarantee a trailing newline, whatever the author left
  done
}

case "${1:-}" in
  preview)
    [ -n "$(fragments)" ] || { echo "no fragments in changelog.d/"; exit 0; }
    printf '## Unreleased\n\n'; body
    ;;
  release)
    version="${2:?usage: changelog.sh release <version>}"
    [ -n "$(fragments)" ] || { echo "no fragments to release" >&2; exit 1; }
    [ -f "$log" ] || { echo "$log is missing" >&2; exit 1; }
    # Insert immediately above the newest released section, not after line 1:
    # whatever preamble the file carries under its title stays under its title.
    first="$(grep -n '^## ' "$log" | head -1 | cut -d: -f1 || true)"
    tmp="$(mktemp)"
    if [ -n "$first" ]; then
      {
        head -n "$((first - 1))" "$log"
        printf '## %s — %s\n\n' "$version" "$(date +%F)"
        body
        printf '\n'
        tail -n +"$first" "$log"
      } >"$tmp"
    else
      { cat "$log"; printf '\n## %s — %s\n\n' "$version" "$(date +%F)"; body; } >"$tmp"
    fi
    mv "$tmp" "$log"
    fragments | xargs rm --
    echo "released $version; $log updated and changelog.d/ cleared"
    ;;
  *)
    sed -n '8,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
