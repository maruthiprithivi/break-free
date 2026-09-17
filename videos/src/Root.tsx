import React from 'react';
import {Composition} from 'remotion';
import {Scenario} from './Scenario';
import {scenarios} from './scenarios';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {scenarios.map((s) => (
        <Composition
          key={s.id}
          id={s.id}
          component={Scenario}
          durationInFrames={Math.ceil(s.duration * 30)}
          fps={30}
          width={1280}
          height={720}
          defaultProps={{scenario: s}}
        />
      ))}
    </>
  );
};
