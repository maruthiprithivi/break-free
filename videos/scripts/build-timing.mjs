// Derives every frame offset in the project from the real duration of the generated
// narration files, and writes the matching WebVTT sidecars. Audio is the clock:
// nothing in the compositions picks its own timing.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FPS = 30;
const PACE = {
  intro: { leadIn: 1.2, gap: 0.5, chapterGap: 1.0, tail: 3.0 },
  scenario: { leadIn: 0.8, gap: 0.45, chapterGap: 0.6, tail: 2.0 },
};

const frames = (seconds) => Math.max(1, Math.round(seconds * FPS));

const audioSeconds = (id) => {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    join(root, "public", "audio", `${id}.mp3`),
  ]).toString().trim();
  const value = Number.parseFloat(out);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`bad duration for ${id}: ${out}`);
  return value;
};

const vttStamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, "0")}`;
};

const script = JSON.parse(readFileSync(join(root, "src", "script.json"), "utf8"));
const timing = { fps: FPS, videos: {} };

for (const video of script.videos) {
  const pace = PACE[video.kind] ?? PACE.scenario;
  const cues = [];
  const chapters = [];
  let cursor = frames(pace.leadIn);

  for (const chapter of video.chapters) {
    const chapterStart = cursor;
    let local = 0;
    const lines = [];

    for (const line of chapter.lines) {
      const audioFrames = frames(audioSeconds(line.id));
      const holdFrames = audioFrames + frames(pace.gap);
      lines.push({ id: line.id, startFrame: local, durationInFrames: holdFrames, audioFrames });
      cues.push({
        id: line.id,
        text: line.text,
        from: (chapterStart + local) / FPS,
        to: (chapterStart + local + audioFrames) / FPS,
      });
      local += holdFrames;
    }

    const chapterFrames = local + frames(pace.chapterGap);
    chapters.push({ id: chapter.id, startFrame: chapterStart, durationInFrames: chapterFrames, lines });
    cursor = chapterStart + chapterFrames;
  }

  // The final chapter holds through the tail so the closing card stays on screen.
  const tail = frames(pace.tail);
  chapters[chapters.length - 1].durationInFrames += tail;
  timing.videos[video.id] = { durationInFrames: cursor + tail, chapters };

  const vtt = ["WEBVTT", ""];
  cues.forEach((cue, i) => {
    vtt.push(String(i + 1), `${vttStamp(cue.from)} --> ${vttStamp(cue.to)}`, cue.text, "");
  });
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out", `${video.id}.vtt`), vtt.join("\n"));

  const secs = (timing.videos[video.id].durationInFrames / FPS).toFixed(1);
  console.log(`${video.id.padEnd(10)} ${chapters.length} chapter(s)  ${cues.length} cue(s)  ${secs}s`);
}

writeFileSync(join(root, "src", "timing.json"), `${JSON.stringify(timing, null, 2)}\n`);
console.log("wrote src/timing.json and out/*.vtt");
