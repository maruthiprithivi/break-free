import React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import script from "./script.json";
import timing from "./timing.json";
import { theme } from "./theme";
import { scenes, SceneProps, UnknownScene } from "./scenes";
import {
  Backplate,
  ChapterHeader,
  Grain,
  GridLines,
  Scanlines,
  Subtitles,
  useEnvelope,
  Vignette,
  Watermark,
} from "./ui";

type Line2 = { id: string; text: string; scene: string };
type Chapter = { id: string; label: string; heading: string; backplate: string; scene?: string; lines: Line2[] };
type LineTiming = { id: string; startFrame: number; durationInFrames: number; audioFrames: number };
type ChapterTiming = { id: string; startFrame: number; durationInFrames: number; lines: LineTiming[] };

const activeLine = (lines: LineTiming[], frame: number) => {
  let index = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (frame >= lines[i].startFrame) index = i;
  }
  return index;
};

const ChapterBlock: React.FC<{ chapter: Chapter; timing: ChapterTiming; videoId: string }> = ({ chapter, timing: ct, videoId }) => {
  const frame = useCurrentFrame();
  const envelope = useEnvelope(ct.durationInFrames, 14, 10);
  const index = activeLine(ct.lines, frame);
  const current = ct.lines[index];
  const local = frame - current.startFrame;
  const stageProgress = Math.min(1, Math.max(0, local / Math.max(1, current.audioFrames)));

  // The caption tracks the audio: up as the line starts, down as it ends.
  const captionIn = interpolate(local, [0, 7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const captionOut = interpolate(
    local,
    [current.audioFrames, current.audioFrames + 8],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const lastLine = index === ct.lines.length - 1;
  const caption = Math.min(captionIn, lastLine ? 1 : captionOut);

  const line = chapter.lines[index];
  const Scene = scenes[line.scene] ?? UnknownScene;
  const props: SceneProps = {
    stage: index,
    stageProgress,
    frame,
    duration: ct.durationInFrames,
    install: script.brand.install,
    repo: script.brand.repo,
    videoId,
    lineId: line.id,
  };

  return (
    <AbsoluteFill style={{ opacity: envelope }}>
      <Backplate src={chapter.backplate} duration={ct.durationInFrames} />
      <GridLines />
      <Scene key={line.scene} {...props} />
      <ChapterHeader label={chapter.label} heading={chapter.heading} reveal={envelope} />
      <Watermark repo={script.brand.repo} />
      <Subtitles text={chapter.lines[index].text} reveal={caption} />
      <Scanlines />
      <Grain />
      <Vignette />
      {ct.lines.map((line) => (
        <Sequence key={line.id} from={line.startFrame} durationInFrames={line.audioFrames + 2}>
          <Audio src={staticFile(`audio/${line.id}.mp3`)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const BreakFreeVideo: React.FC<{ videoId: string }> = ({ videoId }) => {
  const video = script.videos.find((v) => v.id === videoId);
  if (!video) throw new Error(`unknown video: ${videoId}`);
  const vt = timing.videos[videoId as keyof typeof timing.videos] as { chapters: ChapterTiming[] };

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {video.chapters.map((chapter, i) => (
        <Sequence
          key={chapter.id}
          from={vt.chapters[i].startFrame}
          durationInFrames={vt.chapters[i].durationInFrames}
        >
          <ChapterBlock chapter={chapter as Chapter} timing={vt.chapters[i]} videoId={videoId} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
