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

export const Scenario: React.FC<{scenario: ScenarioData}> = ({scenario}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const n = scenario.sentences.length;
  const titleFrames = Math.floor(fps * 2.2);
  const stepFrames = (durationInFrames - titleFrames) / n;
  const idx =
    frame < titleFrames
      ? -1
      : Math.min(n - 1, Math.floor((frame - titleFrames) / stepFrames));
  const local = frame - titleFrames - idx * stepFrames;

  const bgScale = 1 + interpolate(frame, [0, durationInFrames], [0, 0.08]);

  return (
    <AbsoluteFill style={{backgroundColor: '#f6f0e4', fontFamily: 'Arial, Helvetica, sans-serif'}}>
      <Img
        src={staticFile(scenario.image)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${bgScale})`,
        }}
      />
      <AbsoluteFill style={{backgroundColor: 'rgba(246, 240, 228, 0.72)'}} />
      <Audio src={staticFile(scenario.audio)} />

      {idx === -1 ? (
        <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
          <div
            style={{
              fontSize: 22,
              letterSpacing: 6,
              color: '#5a3fa8',
              textTransform: 'uppercase',
              marginBottom: 18,
              opacity: interpolate(frame, [0, 12], [0, 1]),
            }}
          >
            Break Free
          </div>
          <div
            style={{
              fontSize: 58,
              fontWeight: 700,
              color: '#141414',
              textAlign: 'center',
              padding: '0 80px',
              opacity: interpolate(frame, [6, 20], [0, 1]),
            }}
          >
            {scenario.title}
          </div>
        </AbsoluteFill>
      ) : (
        <>
          <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', paddingBottom: 130}}>
            <div
              style={{
                fontSize: 44,
                fontWeight: 600,
                color: '#141414',
                textAlign: 'center',
                maxWidth: 1000,
                opacity: interpolate(local, [0, 8], [0, 1]),
                transform: `translateY(${interpolate(local, [0, 8], [24, 0])}px)`,
              }}
            >
              {scenario.steps[idx]}
            </div>
          </AbsoluteFill>

          {/* subtitle (narration) */}
          <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 44}}>
            <div
              style={{
                fontSize: 26,
                lineHeight: 1.4,
                color: '#141414',
                backgroundColor: 'rgba(255,255,255,0.88)',
                padding: '12px 26px',
                borderRadius: 10,
                maxWidth: 1120,
                textAlign: 'center',
              }}
            >
              {scenario.sentences[idx]}
            </div>
          </AbsoluteFill>
        </>
      )}

      {/* progress dots */}
      <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 14}}>
        <div style={{display: 'flex', gap: 8}}>
          {Array.from({length: n}).map((_, i) => (
            <div
              key={i}
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: i <= idx ? '#5a3fa8' : 'rgba(90,63,168,0.25)',
              }}
            />
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
