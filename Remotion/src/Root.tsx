import {Composition} from 'remotion';
import {QuoteVideo} from './compositions/QuoteVideo';
import {
  defaultQuote2x1,
  defaultQuote1x1,
  defaultNews2x1,
  defaultQuote1x1Left,
} from './data/defaultQuote';

const FPS = 50;
const DURATION_2X1_SECONDS = 7;
const DURATION_1X1_SECONDS = 6;

export const RemotionRoot = () => {
  return (
    <>
      {/* --- HIGH RESOLUTION 2X (3840x1920 and 1920x1920) --- */}
      
      {/* 2:1 Quote Composition (3840x1920) */}
      <Composition
        id="Quote2x1"
        component={QuoteVideo}
        durationInFrames={DURATION_2X1_SECONDS * FPS}
        fps={FPS}
        width={3840}
        height={1920}
        defaultProps={defaultQuote2x1}
      />
      <Composition
        id="Quote2x1Alpha"
        component={QuoteVideo}
        durationInFrames={DURATION_2X1_SECONDS * FPS}
        fps={FPS}
        width={3840}
        height={1920}
        defaultProps={{...defaultQuote2x1, transparent: true}}
      />

      {/* 1:1 Quote/News Composition (1920x1920) */}
      <Composition
        id="Quote1x1"
        component={QuoteVideo}
        durationInFrames={DURATION_1X1_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1920}
        defaultProps={defaultQuote1x1Left}
      />
      <Composition
        id="Quote1x1Alpha"
        component={QuoteVideo}
        durationInFrames={DURATION_1X1_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1920}
        defaultProps={{...defaultQuote1x1Left, transparent: true}}
      />
      <Composition
        id="News2x1"
        component={QuoteVideo}
        durationInFrames={DURATION_2X1_SECONDS * FPS}
        fps={FPS}
        width={3840}
        height={1920}
        defaultProps={defaultNews2x1}
      />
      <Composition
        id="News2x1Alpha"
        component={QuoteVideo}
        durationInFrames={DURATION_2X1_SECONDS * FPS}
        fps={FPS}
        width={3840}
        height={1920}
        defaultProps={{...defaultNews2x1, transparent: true}}
      />
      <Composition
        id="News1x1"
        component={QuoteVideo}
        durationInFrames={DURATION_1X1_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1920}
        defaultProps={defaultQuote1x1}
      />
      <Composition
        id="News1x1Alpha"
        component={QuoteVideo}
        durationInFrames={DURATION_1X1_SECONDS * FPS}
        fps={FPS}
        width={1920}
        height={1920}
        defaultProps={{...defaultQuote1x1, transparent: true}}
      />

    </>
  );
};
