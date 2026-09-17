import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { glow, mono, sans, theme } from "./theme";

/** 0 -> 1 over `length` frames starting at `from`, eased. */
export const ramp = (frame: number, from: number, length: number) =>
  interpolate(frame, [from, from + length], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

/** Fade in at the start of a sequence and out at the end. */
export const useEnvelope = (duration: number, inFrames = 12, outFrames = 10) => {
  const frame = useCurrentFrame();
  return Math.min(
    interpolate(frame, [0, inFrames], [0, 1], { extrapolateRight: "clamp" }),
    interpolate(frame, [duration - outFrames, duration], [1, 0], { extrapolateLeft: "clamp" }),
  );
};

export const Backplate: React.FC<{ src: string; duration: number; opacity?: number }> = ({
  src,
  duration,
  opacity = 0.66,
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, duration], [1.04, 1.13], { extrapolateRight: "clamp" });
  const drift = interpolate(frame, [0, duration], [0, -22], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={staticFile(`backplates/${src}`)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translateX(${drift}px)`,
          opacity,
          filter: "saturate(1.05) contrast(1.05)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, rgba(7,9,12,0.92) 0%, rgba(7,9,12,0.55) 45%, rgba(7,9,12,0.8) 100%)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(7,9,12,0.9) 0%, rgba(7,9,12,0.15) 30%, rgba(7,9,12,0.55) 72%, rgba(7,9,12,0.97) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

export const GridLines: React.FC = () => {
  const frame = useCurrentFrame();
  const shift = (frame * 0.25) % 64;
  return (
    <AbsoluteFill
      style={{
        opacity: 0.22,
        backgroundImage: `linear-gradient(${theme.lineSoft} 1px, transparent 1px), linear-gradient(90deg, ${theme.lineSoft} 1px, transparent 1px)`,
        backgroundSize: "64px 64px",
        backgroundPosition: `${shift}px ${shift}px`,
        maskImage: "radial-gradient(ellipse at 50% 45%, black 25%, transparent 78%)",
        WebkitMaskImage: "radial-gradient(ellipse at 50% 45%, black 25%, transparent 78%)",
      }}
    />
  );
};

export const Scanlines: React.FC = () => (
  <AbsoluteFill
    style={{
      opacity: 0.16,
      backgroundImage:
        "repeating-linear-gradient(0deg, rgba(255,255,255,0.055) 0px, rgba(255,255,255,0.055) 1px, transparent 1px, transparent 3px)",
    }}
  />
);

export const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      background: "radial-gradient(ellipse at 50% 42%, transparent 42%, rgba(0,0,0,0.72) 100%)",
    }}
  />
);

// A tiled 220px noise patch rather than a full-frame SVG filter: the browser evaluates
// feTurbulence once for the tile instead of over 2 megapixels on every frame. Static,
// too, because animated noise would dominate the bitrate of an otherwise still, dark shot.
const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export const Grain: React.FC = () => (
  <AbsoluteFill
    style={{
      opacity: 0.05,
      mixBlendMode: "overlay",
      backgroundImage: NOISE,
      backgroundSize: "220px 220px",
    }}
  />
);

export const Panel: React.FC<{
  children?: React.ReactNode;
  accent?: string;
  width?: number | string;
  padding?: number;
  style?: React.CSSProperties;
  dimmed?: boolean;
}> = ({ children, accent = theme.line, width, padding = 26, style, dimmed }) => (
  <div
    style={{
      width,
      padding,
      borderRadius: 14,
      border: `1px solid ${accent}`,
      background: theme.panel,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.04), 0 18px 48px rgba(0,0,0,0.55)`,
      backdropFilter: "blur(2px)",
      opacity: dimmed ? 0.34 : 1,
      filter: dimmed ? "grayscale(0.7)" : undefined,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Label: React.FC<{ children: React.ReactNode; colour?: string }> = ({
  children,
  colour = theme.faint,
}) => (
  <div
    style={{
      fontFamily: mono,
      fontSize: 17,
      letterSpacing: 3,
      textTransform: "uppercase",
      color: colour,
    }}
  >
    {children}
  </div>
);

export const Chip: React.FC<{
  children: React.ReactNode;
  colour?: string;
  muted?: boolean;
  size?: number;
}> = ({ children, colour = theme.cyan, muted, size = 20 }) => (
  <span
    style={{
      fontFamily: mono,
      fontSize: size,
      padding: `6px 14px`,
      borderRadius: 999,
      border: `1px solid ${muted ? theme.line : colour}`,
      color: muted ? theme.faint : colour,
      background: muted ? "transparent" : `${colour}14`,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);

export const Stamp: React.FC<{ state: "pass" | "fail" | "skip"; detail?: string }> = ({
  state,
  detail,
}) => {
  const colour = state === "pass" ? theme.green : state === "fail" ? theme.red : theme.faint;
  const word = state === "pass" ? "PASS" : state === "fail" ? "FAIL" : "SKIPPED";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <span
        style={{
          fontFamily: mono,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: 4,
          color: colour,
          border: `2px solid ${colour}`,
          borderRadius: 8,
          padding: "6px 16px",
          textShadow: glow(`${colour}66`, 18),
        }}
      >
        {word}
      </span>
      {detail ? (
        <span style={{ fontFamily: mono, fontSize: 20, color: theme.dim }}>{detail}</span>
      ) : null}
    </div>
  );
};

export const Bar: React.FC<{ progress: number; colour?: string; width?: number }> = ({
  progress,
  colour = theme.cyan,
  width = 220,
}) => (
  <div style={{ width, height: 8, borderRadius: 999, background: "rgba(255,255,255,0.07)" }}>
    <div
      style={{
        width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
        height: "100%",
        borderRadius: 999,
        background: colour,
        boxShadow: glow(`${colour}55`, 12),
      }}
    />
  </div>
);

/** Types `text` out over `reveal` (0 -> 1) and parks a caret at the end. */
export const TypedLine: React.FC<{
  text: string;
  reveal: number;
  colour?: string;
  size?: number;
  caret?: boolean;
}> = ({ text, reveal, colour = theme.text, size = 24, caret }) => {
  const frame = useCurrentFrame();
  const shown = text.slice(0, Math.round(Math.max(0, Math.min(1, reveal)) * text.length));
  return (
    <div style={{ fontFamily: mono, fontSize: size, color: colour, whiteSpace: "pre-wrap" }}>
      {shown}
      {caret && Math.floor(frame / 15) % 2 === 0 ? (
        <span style={{ color: theme.green }}>_</span>
      ) : null}
    </div>
  );
};

export const Terminal: React.FC<{
  title?: string;
  children: React.ReactNode;
  width?: number | string;
}> = ({ title = "zsh", children, width = 1040 }) => (
  <div
    style={{
      width,
      borderRadius: 14,
      overflow: "hidden",
      border: `1px solid ${theme.line}`,
      background: "rgba(5,7,10,0.94)",
      boxShadow: "0 26px 70px rgba(0,0,0,0.6)",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "12px 18px",
        borderBottom: `1px solid ${theme.line}`,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      {[theme.red, theme.amber, theme.green].map((c) => (
        <span key={c} style={{ width: 11, height: 11, borderRadius: 999, background: `${c}99` }} />
      ))}
      <span style={{ fontFamily: mono, fontSize: 16, color: theme.faint, marginLeft: 10 }}>
        {title}
      </span>
    </div>
    <div style={{ padding: "22px 26px", display: "flex", flexDirection: "column", gap: 10 }}>
      {children}
    </div>
  </div>
);

export const Wordmark: React.FC<{ size?: number; reveal?: number }> = ({ size = 96, reveal = 1 }) => (
  <div
    style={{
      fontFamily: mono,
      fontSize: size,
      fontWeight: 700,
      letterSpacing: size * 0.06,
      lineHeight: 1,
      display: "flex",
      gap: size * 0.22,
      opacity: reveal,
    }}
  >
    <span style={{ color: theme.text }}>BREAK</span>
    <span style={{ color: theme.green, textShadow: glow("rgba(52,211,153,0.45)", 34) }}>FREE</span>
  </div>
);

export const ChapterHeader: React.FC<{ label: string; heading: string; reveal: number }> = ({
  label,
  heading,
  reveal,
}) => {
  if (!heading) return null;
  return (
    <div style={{ position: "absolute", top: 76, left: 96, opacity: reveal }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
        <span
          style={{
            fontFamily: mono,
            fontSize: 22,
            letterSpacing: 5,
            color: theme.green,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: sans,
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: -0.5,
            color: theme.text,
          }}
        >
          {heading}
        </span>
      </div>
      <div
        style={{
          marginTop: 14,
          height: 1,
          width: 520 * reveal,
          background: `linear-gradient(90deg, ${theme.green}, transparent)`,
        }}
      />
    </div>
  );
};

export const Watermark: React.FC<{ repo: string }> = ({ repo }) => (
  <div
    style={{
      position: "absolute",
      top: 80,
      right: 96,
      textAlign: "right",
      fontFamily: mono,
      fontSize: 17,
      color: theme.faint,
      letterSpacing: 1.5,
    }}
  >
    <div style={{ color: theme.dim }}>break-free</div>
    <div>{repo}</div>
  </div>
);

export const Subtitles: React.FC<{ text: string; reveal: number }> = ({ text, reveal }) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 82,
      display: "flex",
      justifyContent: "center",
      padding: "0 140px",
    }}
  >
    <div
      style={{
        maxWidth: 1420,
        padding: "20px 34px",
        borderRadius: 12,
        background: "rgba(4,6,9,0.78)",
        border: `1px solid rgba(52,211,153,0.18)`,
        borderLeft: `3px solid ${theme.green}`,
        opacity: reveal,
        transform: `translateY(${(1 - reveal) * 10}px)`,
      }}
    >
      <p
        style={{
          margin: 0,
          fontFamily: sans,
          fontSize: 34,
          lineHeight: 1.35,
          color: theme.text,
          textAlign: "center",
          textWrap: "balance",
        }}
      >
        {text}
      </p>
    </div>
  </div>
);

export const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      alignItems: "center",
      justifyContent: "center",
      paddingTop: 170,
      paddingBottom: 215,
    }}
  >
    {children}
  </AbsoluteFill>
);

export const Row: React.FC<{ children: React.ReactNode; gap?: number; style?: React.CSSProperties }> = ({
  children,
  gap = 24,
  style,
}) => (
  <div style={{ display: "flex", alignItems: "center", gap, ...style }}>{children}</div>
);

export const Col: React.FC<{ children: React.ReactNode; gap?: number; style?: React.CSSProperties }> = ({
  children,
  gap = 16,
  style,
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap, ...style }}>{children}</div>
);

/** Flowing connector between two points in a 1920x1080 stage overlay. */
export const Flow: React.FC<{
  d: string;
  progress: number;
  colour?: string;
  dashed?: boolean;
  width?: number;
}> = ({ d, progress, colour = theme.green, dashed, width = 2 }) => {
  const frame = useCurrentFrame();
  return (
    <path
      d={d}
      fill="none"
      stroke={colour}
      strokeWidth={width}
      strokeLinecap="round"
      opacity={0.15 + 0.85 * Math.max(0, Math.min(1, progress))}
      strokeDasharray={dashed ? "7 11" : undefined}
      strokeDashoffset={dashed ? -frame * 1.4 : undefined}
      style={{ filter: `drop-shadow(0 0 6px ${colour}55)` }}
    />
  );
};

/** Straight connectors inside a local box, for wiring node graphs together. */
export const Wires: React.FC<{
  w: number;
  h: number;
  lines: [number, number, number, number][];
  colour?: string;
  dashed?: boolean;
  thickness?: number;
}> = ({ w, h, lines, colour = theme.line, dashed, thickness = 2 }) => {
  const frame = useCurrentFrame();
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      {lines.map(([x1, y1, x2, y2], i) => (
        <line
          key={i}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={colour}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={dashed ? "6 10" : undefined}
          strokeDashoffset={dashed ? -frame * 1.2 : undefined}
          style={{ filter: `drop-shadow(0 0 5px ${colour}66)` }}
        />
      ))}
    </svg>
  );
};

/** One node fanning out to `centres`, drawn in a box `w` wide and `h` tall. */
export const fanout = (w: number, h: number, centres: number[]): [number, number, number, number][] => {
  const mid = h / 2;
  return [
    [w / 2, 0, w / 2, mid],
    [Math.min(...centres), mid, Math.max(...centres), mid],
    ...centres.map((c) => [c, mid, c, h] as [number, number, number, number]),
  ];
};

/** `centres` converging back into one node. */
export const fanin = (w: number, h: number, centres: number[]): [number, number, number, number][] => {
  const mid = h / 2;
  return [
    ...centres.map((c) => [c, 0, c, mid] as [number, number, number, number]),
    [Math.min(...centres), mid, Math.max(...centres), mid],
    [w / 2, mid, w / 2, h],
  ];
};

/** A horizontal arrow with a head, for hand-off between two cards. */
export const arrow = (len: number, y: number): [number, number, number, number][] => [
  [0, y, len, y],
  [len - 13, y - 8, len, y],
  [len - 13, y + 8, len, y],
];

export const Svg: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    width={1920}
    height={1080}
    viewBox="0 0 1920 1080"
    style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
  >
    {children}
  </svg>
);
