#!/usr/bin/env bash
# Thin wrapper: the real installer is setup.mjs (interactive, with preflight/postflight checks).
#   ./install.sh            -> node setup.mjs
#   ./install.sh --doctor   -> node setup.mjs --doctor
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v node >/dev/null 2>&1 || { echo "node not found — install Node 20+ from https://nodejs.org" >&2; exit 1; }
exec node setup.mjs "$@"
