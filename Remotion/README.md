# UT Motion Graphics

Code-first Remotion workspace for animated news cards and quote overlays.

## Formats

- All compositions render at 50 fps.
- `Quote2x1`: 3840x1920 MP4, H.264, CRF 16, 7 seconds.
- `Quote2x1Alpha`: 3840x1920 WebM with alpha, VP8, `yuva420p`, 7 seconds.
- `Quote1x1`: 1920x1920 MP4, H.264, CRF 16, 6 seconds.
- `Quote1x1Alpha`: 1920x1920 WebM with alpha, VP8, `yuva420p`, 6 seconds.

## Commands

- `npm run studio` opens Remotion Studio with `data/quote-2x1.json`.
- `npm run render:2x1` renders `out/quote-2x1.mp4`.
- `npm run render:2x1:alpha` renders `out/quote-2x1-alpha.webm`.
- `npm run render:1x1` renders `out/quote-1x1.mp4`.
- `npm run render:1x1:alpha` renders `out/quote-1x1-alpha.webm`.
- `npm run generate -- 2x1 data/quote-2x1.json out/custom.mp4` renders any JSON with a preset.
- `npm run check` runs TypeScript.

Edit input JSON files in `data/`. Main reusable component: `src/compositions/QuoteVideo.tsx`.
