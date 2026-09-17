import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {ScenarioData} from './scenarios';

const INK = '#1b1b1f';
const TEAL = '#0d9488';
const PURPLE = '#7c3aed';
const GREEN = '#16a34a';
const PAPER = '#f6f0e4';

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
// pure progress helper (no hooks — safe in loops/conditionals)
const prog = (frame: number, delay: number, dur = 18) =>
  easeOut(
    interpolate(frame, [delay, delay + dur], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );

// A hand-drawn terminal node that pops in.
const Node: React.FC<{
  x: number; y: number; w: number; h: number; accent: string; active: boolean;
  pop: number; label?: string; labelColor?: string;
}> = ({x, y, w, h, accent, active, pop, label, labelColor}) => {
  const s = 0.6 + 0.4 * pop;
  return (
    <g transform={`translate(${x + w / 2},${y + h / 2}) scale(${s}) translate(${-x - w / 2},${-y - h / 2})`} opacity={pop}>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={active ? '#fffdf6' : '#fbf7ec'} stroke={accent} strokeWidth={4} />
      <circle cx={x + 22} cy={y + 26} r={5} fill={accent} />
      <circle cx={x + 42} cy={y + 26} r={5} fill={accent} opacity={0.55} />
      <circle cx={x + 62} cy={y + 26} r={5} fill={accent} opacity={0.25} />
      {label ? (
        <text x={x + w / 2} y={y + h / 2 + 8} textAnchor="middle" fontSize={30} fontWeight={700} fill={labelColor ?? INK} fontFamily="Arial, sans-serif">{label}</text>
      ) : null}
    </g>
  );
};

// Animated arrow that draws itself in.
const Arrow: React.FC<{
  x1: number; y1: number; x2: number; y2: number; p: number; accent: string; bend?: number;
}> = ({x1, y1, x2, y2, p, accent, bend = 0}) => {
  const d = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1 + bend}, ${(x1 + x2) / 2} ${y2 + bend}, ${x2} ${y2}`;
  const len = 240;
  return (
    <g>
      <path d={d} fill="none" stroke={accent} strokeWidth={5} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - p)} opacity={p} />
      <circle cx={x2} cy={y2} r={7} fill={accent} opacity={p} />
    </g>
  );
};

// Animated drawing checkmark.
const Check: React.FC<{x: number; y: number; size: number; p: number; color?: string}> = ({x, y, size, p, color = GREEN}) => {
  const len = 70;
  return (
    <path d={`M ${x - size / 2} ${y} l ${size * 0.35} ${size * 0.35} l ${size * 0.65} ${-size * 0.65}`}
      fill="none" stroke={color} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round"
      strokeDasharray={len} strokeDashoffset={len * (1 - p)} opacity={p} />
  );
};

// Spinning progress ring.
const Ring: React.FC<{cx: number; cy: number; r: number; accent: string; frame: number; fps: number}> = ({cx, cy, r, accent, frame, fps}) => {
  const rot = (frame * 3) % 360;
  return (
    <g transform={`rotate(${rot} ${cx} ${cy})`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={accent} strokeWidth={9} strokeLinecap="round" strokeDasharray={`${r * 4.2} ${r * 2}`} />
    </g>
  );
};

// Floating doodle particles for texture.
const Doodles: React.FC<{frame: number; fps: number}> = ({frame, fps}) => {
  const drift = (i: number) => Math.sin(frame / (fps * 1.2) + i) * 6;
  const items = [
    {x: 80, y: 90, c: TEAL, t: 'zig'}, {x: 1200, y: 70, c: PURPLE, t: 'dot'},
    {x: 60, y: 620, c: PURPLE, t: 'dot'}, {x: 1220, y: 600, c: TEAL, t: 'zig'},
  ] as const;
  return (
    <g>
      {items.map((it, i) => (
        <g key={i} transform={`translate(0,${drift(i)})`}>
          {it.t === 'dot' ? <circle cx={it.x} cy={it.y} r={5} fill={it.c} /> : null}
          {it.t === 'zig' ? <path d={`M ${it.x - 20} ${it.y + 10} l 10 -16 l 10 16 l 10 -16`} fill="none" stroke={it.c} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" /> : null}
        </g>
      ))}
    </g>
  );
};

// ---------------------------------------------------------------- scenes
const DelegateScene: React.FC<{idx: number; frame: number; fps: number}> = ({idx, frame, fps}) => (
  <g>
    <Node x={150} y={240} w={340} h={170} accent={PURPLE} active={idx >= 1} pop={prog(frame, 0)} label="you · lead" />
    <Node x={790} y={240} w={340} h={170} accent={TEAL} active={false} pop={prog(frame, 12)} label="DeepSeek" />
    <Arrow x1={495} y1={325} x2={785} y2={325} p={prog(frame, 20)} accent={INK} />
    {idx >= 1 ? <path d="M 320 190 l 60 -30 l 60 30" fill="none" stroke={PURPLE} strokeWidth={6} strokeLinecap="round" opacity={prog(frame, 0)} /> : null}
    {idx >= 2 ? <Check x={960} y={305} size={70} p={prog(frame, 0)} /> : null}
    {idx >= 2 ? <Ring cx={960} cy={190} r={38} accent={GREEN} frame={frame} fps={fps} /> : null}
  </g>
);

const ParallelScene: React.FC<{idx: number; frame: number; fps: number}> = ({idx, frame, fps}) => {
  const nodes = [
    {x: 120, y: 370, l: 'DeepSeek', c: TEAL},
    {x: 470, y: 370, l: 'Kimi', c: PURPLE},
    {x: 820, y: 370, l: 'GLM', c: GREEN},
  ];
  return (
    <g>
      <Node x={430} y={110} w={420} h={130} accent={INK} active prog={prog(frame, 0)} label="upgrade 20 files" />
      {nodes.map((nd, i) => (
        <g key={i}>
          <Node x={nd.x} y={nd.y} w={340} h={150} accent={nd.c} active={false} pop={prog(frame, 14 + i * 8)} label={nd.l} />
          <Arrow x1={640} y1={245} x2={nd.x + 170} y2={nd.y} p={prog(frame, 22 + i * 8)} accent={INK} bend={40} />
          {idx >= 2 ? <Ring cx={nd.x + 170} cy={nd.y - 44} r={26} accent={nd.c} frame={frame} fps={fps} /> : null}
          {idx >= 2 ? <Check x={nd.x + 170} y={nd.y + 85} size={46} p={prog(frame, 0)} /> : null}
        </g>
      ))}
      {idx >= 3 ? (
        <g>
          <Arrow x1={290} y1={525} x2={640} y2={610} p={prog(frame, 0)} accent={INK} bend={-40} />
          <Arrow x1={640} y1={525} x2={640} y2={610} p={prog(frame, 0)} accent={INK} bend={-40} />
          <Arrow x1={990} y1={525} x2={640} y2={610} p={prog(frame, 0)} accent={INK} bend={-40} />
          <Node x={490} y={610} w={300} h={76} accent={GREEN} active pop={prog(frame, 8)} label="merged" labelColor={GREEN} />
        </g>
      ) : null}
    </g>
  );
};

const ReviewScene: React.FC<{idx: number; frame: number; fps: number}> = ({idx, frame, fps}) => {
  const mx = 520 + prog(frame, 0, 36) * 240;
  return (
    <g>
      <Node x={140} y={260} w={340} h={170} accent={INK} active={false} pop={prog(frame, 0)} label="diff" />
      <Arrow x1={485} y1={345} x2={640} y2={345} p={prog(frame, 12)} accent={INK} />
      {idx >= 1 ? (
        <g transform={`translate(${mx},345)`}>
          <circle r={70} fill="none" stroke={PURPLE} strokeWidth={8} />
          <circle r={50} fill="rgba(124,58,237,0.12)" />
          <line x1={-14} y1={14} x2={80} y2={-80} stroke={PURPLE} strokeWidth={10} strokeLinecap="round" />
        </g>
      ) : null}
      {idx >= 2 ? <Check x={1050} y={345} size={80} p={prog(frame, 0)} /> : null}
      {idx >= 3 ? (
        <path d="M 1050 250 v -40 a 60 60 0 0 0 -60 -60 h -10 a 60 60 0 0 0 -60 60 v 110 a 60 60 0 0 1 -60 60 h -10 a 60 60 0 0 1 -60 -60 v -70"
          fill="none" stroke={GREEN} strokeWidth={8} strokeLinecap="round" opacity={prog(frame, 0)} />
      ) : null}
    </g>
  );
};

const HarnessScene: React.FC<{idx: number; frame: number; fps: number}> = ({idx, frame, fps}) => (
  <g>
    <Node x={370} y={230} w={540} h={220} accent={TEAL} active={false} pop={prog(frame, 0)} label="codex" labelColor={TEAL} />
    {idx >= 1 ? (
      <g transform={`translate(1000,300) scale(${0.5 + 0.5 * prog(frame, 0)})`} opacity={prog(frame, 0)}>
        <path d="M 0 0 L 60 0 L 60 40 L 30 55 L 0 40 Z" fill={PURPLE} />
        <circle cx={30} cy={16} r={6} fill="none" stroke="#fff" strokeWidth={3} />
      </g>
    ) : null}
    {idx >= 2 ? (
      <g>
        <line x1={140} y1={500} x2={940} y2={500} stroke={INK} strokeWidth={8} strokeLinecap="round" opacity={0.2} />
        <line x1={140} y1={500} x2={140 + 800 * prog(frame, 0)} y2={500} stroke={PURPLE} strokeWidth={10} strokeLinecap="round" />
        <circle cx={140 + 800 * prog(frame, 0)} cy={500} r={14} fill={PURPLE} />
      </g>
    ) : null}
    {idx >= 3 ? <Check x={640} y={600} size={80} p={prog(frame, 0)} /> : null}
  </g>
);

const Scene: React.FC<{scenario: ScenarioData; idx: number; frame: number; fps: number}> = ({scenario, idx, frame, fps}) => {
  switch (scenario.id) {
    case 'delegate': return <DelegateScene idx={idx} frame={frame} fps={fps} />;
    case 'parallel': return <ParallelScene idx={idx} frame={frame} fps={fps} />;
    case 'review': return <ReviewScene idx={idx} frame={frame} fps={fps} />;
    case 'harness': return <HarnessScene idx={idx} frame={frame} fps={fps} />;
    default: return null;
  }
};

// ---------------------------------------------------------------- main
export const Scenario: React.FC<{scenario: ScenarioData}> = ({scenario}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const n = scenario.sentences.length;
  const titleFrames = Math.floor(fps * 2.4);
  const stepFrames = (durationInFrames - titleFrames) / n;
  const idx = frame < titleFrames ? -1 : Math.min(n - 1, Math.floor((frame - titleFrames) / stepFrames));
  const local = frame - titleFrames - idx * stepFrames;

  return (
    <AbsoluteFill style={{backgroundColor: PAPER, fontFamily: 'Arial, Helvetica, sans-serif'}}>
      <Img src={staticFile(scenario.image)} style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.16}} />
      <Audio src={staticFile(scenario.audio)} />

      {idx === -1 ? (
        <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
          <div style={{fontSize: 22, letterSpacing: 6, color: PURPLE, textTransform: 'uppercase', marginBottom: 18, opacity: interpolate(frame, [0, 12], [0, 1])}}>Break Free</div>
          <div style={{fontSize: 56, fontWeight: 800, color: INK, textAlign: 'center', padding: '0 80px', opacity: interpolate(frame, [6, 22], [0, 1])}}>{scenario.title}</div>
        </AbsoluteFill>
      ) : (
        <>
          <svg viewBox="0 0 1280 720" width="100%" height="100%" style={{position: 'absolute', inset: 0}}>
            <Doodles frame={frame} fps={fps} />
            <Scene scenario={scenario} idx={idx} frame={frame} fps={fps} />
          </svg>

          <AbsoluteFill style={{justifyContent: 'flex-start', alignItems: 'center', paddingTop: 44}}>
            <div style={{fontSize: 38, fontWeight: 800, color: INK, textAlign: 'center', padding: '10px 26px', backgroundColor: 'rgba(255,255,255,0.82)', borderRadius: 12, opacity: interpolate(local, [0, 8], [0, 1])}}>
              {scenario.steps[idx]}
            </div>
          </AbsoluteFill>

          <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 48}}>
            <div style={{fontSize: 25, lineHeight: 1.4, color: INK, backgroundColor: 'rgba(255,255,255,0.9)', padding: '12px 26px', borderRadius: 10, maxWidth: 1120, textAlign: 'center'}}>
              {scenario.sentences[idx]}
            </div>
          </AbsoluteFill>

          <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 16}}>
            <div style={{display: 'flex', gap: 8}}>
              {Array.from({length: n}).map((_, i) => (
                <div key={i} style={{width: 10, height: 10, borderRadius: 5, backgroundColor: i <= idx ? PURPLE : 'rgba(124,58,237,0.25)'}} />
              ))}
            </div>
          </AbsoluteFill>
        </>
      )}
    </AbsoluteFill>
  );
};
