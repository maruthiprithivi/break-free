# videos/

Source for the banner, the intro video and the four scenario walkthroughs. Remotion draws
everything; Higgsfield supplied only the backplate artwork and the narration.

## How it fits together

| | |
|---|---|
| `src/script.json` | the single source of truth: every narration line, the scene it drives, and which backplate it sits on |
| `public/audio/*.mp3` | one generated narration file per line in `script.json` |
| `public/backplates/*.png` | generated artwork, deliberately textless — all type is drawn by Remotion so it is always legible |
| `scripts/build-timing.mjs` | measures each `.mp3` with `ffprobe` and writes `src/timing.json` plus `out/*.vtt` |
| `src/scenes.tsx` | one component per scene; each advances its stage exactly when the narration line does |
| `src/Video.tsx` | assembles chapters, captions, audio and the backplate |
| `src/Stills.tsx` | the banner and the poster frames |

**Audio is the clock.** Nothing picks its own timing: the frame offsets for the animation,
the burned-in captions and the WebVTT cues all come from the measured length of the
narration, so they cannot drift apart.

## Rendering

Rendering happens in Docker, never on a developer machine:

```bash
docker build -t break-free-videos .
docker run --rm -v "$PWD/out:/app/out" break-free-videos            # everything
docker run --rm -v "$PWD/out:/app/out" break-free-videos bash render.sh stills
docker run --rm -v "$PWD/out:/app/out" break-free-videos bash render.sh preview
```

`preview` renders a single frame at the midpoint of every narration line — the cheap way to
find a layout problem, since a full encode takes minutes and a preview takes seconds.

To render on another machine and copy the results back:

```bash
BREAK_FREE_BUILD_HOST=user@host ./build-remote.sh          # BREAK_FREE_MODE=preview|stills|all
```

Finished media is copied into `docs/assets/`; `out/` is not committed.

## Regenerating the assets

The backplates and narration come from Higgsfield (`gpt_image_2_5` for the artwork,
`text2speech_v2` with the ElevenLabs engine for the voice). If you change a line in
`script.json`, regenerate that line's `.mp3` under the same file name and re-render — the
timing, captions and subtitle track all follow automatically.
