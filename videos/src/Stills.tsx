import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import script from "./script.json";
import { glow, mono, sans, theme } from "./theme";

const Plate: React.FC<{ src: string; opacity?: number }> = ({ src, opacity = 0.85 }) => (
  <AbsoluteFill>
    <Img
      src={staticFile(`backplates/${src}`)}
      style={{ width: "100%", height: "100%", objectFit: "cover", opacity }}
    />
    {/* Heavy on the left so the type stays readable, almost clear on the right so the
        artwork is actually visible rather than a rumour. */}
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(90deg, rgba(7,9,12,0.97) 0%, rgba(7,9,12,0.88) 30%, rgba(7,9,12,0.45) 68%, rgba(7,9,12,0.2) 100%)",
      }}
    />
  </AbsoluteFill>
);

export const Banner: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: theme.bg }}>
    <Plate src="hero.png" opacity={0.95} />
    <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 128 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 132,
          fontWeight: 700,
          letterSpacing: 8,
          lineHeight: 1,
          display: "flex",
          gap: 30,
        }}
      >
        <span style={{ color: theme.text }}>BREAK</span>
        <span style={{ color: theme.green, textShadow: glow("rgba(52,211,153,0.5)", 40) }}>FREE</span>
      </div>
      <div
        style={{
          marginTop: 26,
          height: 1,
          width: 700,
          background: `linear-gradient(90deg, ${theme.green}, transparent)`,
        }}
      />
      <div style={{ marginTop: 26, fontFamily: sans, fontSize: 40, color: theme.dim }}>
        {script.brand.tagline}
      </div>
      <div style={{ marginTop: 34, display: "flex", gap: 16 }}>
        {["MCP server", "Claude Code and Codex", "DeepSeek - Kimi - GLM - MiniMax - Ollama"].map((c) => (
          <span
            key={c}
            style={{
              fontFamily: mono,
              fontSize: 22,
              color: theme.cyan,
              border: `1px solid ${theme.cyan}`,
              background: "rgba(34,211,238,0.08)",
              borderRadius: 999,
              padding: "8px 20px",
            }}
          >
            {c}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);

export const Poster: React.FC<{ videoId: string }> = ({ videoId }) => {
  const video = script.videos.find((v) => v.id === videoId);
  if (!video) throw new Error(`unknown video: ${videoId}`);
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Plate src={video.poster} opacity={0.85} />
      <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 110, paddingRight: 110 }}>
        <div style={{ fontFamily: mono, fontSize: 22, letterSpacing: 5, color: theme.green }}>
          BREAK FREE
        </div>
        <div
          style={{
            marginTop: 20,
            fontFamily: sans,
            fontSize: 82,
            fontWeight: 600,
            color: theme.text,
            letterSpacing: -1.5,
            maxWidth: 1300,
            lineHeight: 1.08,
          }}
        >
          {video.title}
        </div>
        <div style={{ marginTop: 22, fontFamily: sans, fontSize: 34, color: theme.dim }}>
          {video.subtitle}
        </div>
        <div style={{ marginTop: 48, display: "flex", alignItems: "center", gap: 20 }}>
          <span
            style={{
              width: 74,
              height: 74,
              borderRadius: 999,
              border: `2px solid ${theme.green}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: glow("rgba(52,211,153,0.35)", 30),
            }}
          >
            <span
              style={{
                width: 0,
                height: 0,
                marginLeft: 6,
                borderTop: "15px solid transparent",
                borderBottom: "15px solid transparent",
                borderLeft: `24px solid ${theme.green}`,
              }}
            />
          </span>
          <span style={{ fontFamily: mono, fontSize: 24, color: theme.dim }}>
            narrated, with subtitles
          </span>
        </div>
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 110,
          bottom: 66,
          fontFamily: mono,
          fontSize: 22,
          color: theme.faint,
          letterSpacing: 1.5,
        }}
      >
        {script.brand.repo}
      </div>
    </AbsoluteFill>
  );
};
