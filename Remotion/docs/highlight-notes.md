# Highlight implementation notes

Do not reintroduce these approaches without a fresh visual proof:

- Single highlighted phrase as one `inline` span with `box-decoration-break: clone`.
  It creates stepped blocks on line wraps and can cover neighboring text lines in 1:1 and dense layouts.
- Two-layer `background-clip: text` on the same highlighted span.
  Chromium/Remotion may render yellow blocks without visible text in stills/renders.
- Coloring the whole highlighted span black as soon as highlight progress starts.
  Uncovered text becomes black on the dark background and effectively disappears before the fill reaches it.
- Hiding highlighted text until its own highlight starts.
  Future highlighted lines disappear from the composition, which is visually wrong.

Current safe direction:

- Keep base text visible in white.
- Render highlight fill as a clipped overlay per word/token.
- Render black text only inside the clipped overlay, so uncovered text remains white.
- Use sequential `highlightIndex` timing for separate bracket groups and for `^` splits.
- Apply exit opacity to the whole `AnimatedText` wrapper, not to each token.
  Per-token exit opacity makes overlapping highlight overlays create bright vertical seams during fade-out.
- Do not start highlight animation until all text tokens have finished their entrance spring.
  A fixed `highlightDelaySeconds` can overlap long text entry and make highlights start while later words are still appearing.
