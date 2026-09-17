import React from "react";
import { Composition, Still } from "remotion";
import script from "./script.json";
import timing from "./timing.json";
import { BreakFreeVideo } from "./Video";
import { Banner, Poster } from "./Stills";

export const RemotionRoot: React.FC = () => (
  <>
    {script.videos.map((video) => (
      <React.Fragment key={video.id}>
        <Composition
          id={video.id}
          component={BreakFreeVideo}
          width={1920}
          height={1080}
          fps={timing.fps}
          durationInFrames={timing.videos[video.id as keyof typeof timing.videos].durationInFrames}
          defaultProps={{ videoId: video.id }}
        />
        <Still
          id={`poster-${video.id}`}
          component={Poster}
          width={1920}
          height={1080}
          defaultProps={{ videoId: video.id }}
        />
      </React.Fragment>
    ))}
    <Still id="banner" component={Banner} width={2400} height={800} />
  </>
);
