#!/usr/bin/env bash
# Renders the videos on a remote Docker host and copies the results back.
#
#   BREAK_FREE_BUILD_HOST=user@host ./build-remote.sh
#
# Nothing is installed, built or rendered on the machine you run this from.
# shellcheck disable=SC2029  # $remote is meant to expand on this side, not the remote
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

host="${BREAK_FREE_BUILD_HOST:-}"
[ -n "$host" ] || { echo "set BREAK_FREE_BUILD_HOST=user@host" >&2; exit 1; }
remote="${BREAK_FREE_BUILD_DIR:-break-free-videos}"

echo "== sync -> $host:$remote"
ssh "$host" "mkdir -p '$remote/out'"
rsync -az --delete \
  --exclude node_modules --exclude out \
  ./ "$host:$remote/"

echo "== build image"
ssh "$host" "cd '$remote' && docker build -q -t break-free-videos ."

# BREAK_FREE_MODE=preview renders one frame per narration line; =stills only the banner
# and posters; anything else renders everything.
mode="${BREAK_FREE_MODE:-all}"
echo "== render ($mode)"
ssh "$host" "cd '$remote' && docker run --rm --shm-size=2g \
  -e REMOTION_CONCURRENCY=\${REMOTION_CONCURRENCY:-8} \
  -v \"\$PWD/out:/app/out\" break-free-videos bash render.sh '$mode'"

echo "== collect"
mkdir -p out
rsync -az "$host:$remote/out/" ./out/
# The timing table is generated from the narration inside the container; keep it in the repo
# so the compositions are reproducible without a render.
rsync -az "$host:$remote/out/timing.json" ./src/timing.json
ls -la out
