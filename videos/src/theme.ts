import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSans } from "@remotion/google-fonts/Inter";

// Only the weights and subset the compositions actually use. The defaults fetch every
// weight of every subset, which is well over a hundred requests per render tab.
// The two families have different weight unions, so the options are inlined rather than
// shared, and each call gets contextually typed.
const monoFace = loadMono("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
  ignoreTooManyRequestsWarning: true,
}).fontFamily;

const sansFace = loadSans("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
  ignoreTooManyRequestsWarning: true,
}).fontFamily;

export const mono = `${monoFace}, "DejaVu Sans Mono", "Liberation Mono", monospace`;
export const sans = `${sansFace}, "DejaVu Sans", "Liberation Sans", sans-serif`;

export const theme = {
  bg: "#07090c",
  panel: "rgba(13,17,23,0.82)",
  panelSolid: "#0d1117",
  line: "#1e2a38",
  lineSoft: "rgba(52,211,153,0.16)",
  text: "#e6edf3",
  dim: "#8b97a6",
  faint: "#586170",
  green: "#34d399",
  cyan: "#22d3ee",
  amber: "#fbbf24",
  red: "#f87171",
  violet: "#a78bfa",
} as const;

export const glow = (colour: string, strength = 26) => `0 0 ${strength}px ${colour}`;
