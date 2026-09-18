#!/usr/bin/env bash
# Runs inside the container.
#   render.sh          measure narration, typecheck, render stills and every video
#   render.sh stills   stills only (banner + posters) - seconds, not minutes
#   render.sh preview  one frame per narration line, for checking layout cheaply
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

mode="${1:-all}"
ids=$(node -e 'process.stdout.write(require("./src/script.json").videos.map(v=>v.id).join(" "))')
mkdir -p out

echo "== timing (measured from the generated narration)"
node scripts/build-timing.mjs
cp src/timing.json out/timing.json

echo "== typecheck"
npx tsc --noEmit

echo "== stills"
npx remotion still src/index.ts banner out/banner.png --gl=swangle --log=error
for id in $ids; do
  npx remotion still src/index.ts "poster-$id" "out/poster-$id.jpg" \
    --gl=swangle --jpeg-quality=88 --log=error
done
[ "$mode" = "stills" ] && { ls -la out; exit 0; }

if [ "$mode" = "preview" ]; then
  echo "== preview frames (midpoint of every narration line)"
  mkdir -p out/preview
  node -e '
    const t = require("./src/timing.json");
    const rows = [];
    for (const [video, v] of Object.entries(t.videos))
      for (const c of v.chapters)
        for (const l of c.lines)
          rows.push([video, l.id, c.startFrame + l.startFrame + Math.round(l.audioFrames * 0.55)]);
    process.stdout.write(rows.map((r) => r.join(" ")).join("\n"));
  ' > /tmp/frames.txt
  while read -r video line frame; do
    [ -n "$video" ] || continue
    echo "-- $line @ $frame"
    npx remotion still src/index.ts "$video" "out/preview/$line.jpg" \
      --frame="$frame" --gl=swangle --jpeg-quality=80 --log=error
  done < /tmp/frames.txt
  exit 0
fi

echo "== videos"
for id in $ids; do
  npx remotion render src/index.ts "$id" "out/$id.mp4" \
    --gl=swangle \
    --concurrency="${REMOTION_CONCURRENCY:-4}" \
    --x264-preset=slow \
    --audio-bitrate=96k \
    --enforce-audio-track \
    --log=info
done

echo "== output"
ls -la out
