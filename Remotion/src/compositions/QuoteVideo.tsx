import {
  AbsoluteFill,
  Img,
  interpolate,
  OffthreadVideo,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from 'remotion';
import type {CSSProperties} from 'react';
import {colors, fontStack} from '../design/tokens';
import type {QuoteVideoProps} from '../types';

const clean = (value: string | undefined) => String(value ?? '').trim();
const isVideoAsset = (value: string | undefined) =>
  /\.(mp4|mov|m4v|webm|mkv)(?:$|[?#])/i.test(clean(value));
const HIGHLIGHT_COLORS = ['#E7FF02', '#82FE83', '#89F0FE', '#FF629C'];

type TextToken = {
  text: string;
  highlightIndex: number | null;
  lineBreak?: boolean;
};

const parseHighlightedWords = (text: string): TextToken[] => {
  const tokens: TextToken[] = [];
  let highlightIndex = -1;
  const pattern = /\[([^\]]+)\]/g;
  let cursor = 0;

  const pushLineBreak = () => {
    if (tokens.length === 0 || tokens[tokens.length - 1]?.lineBreak) return;
    tokens.push({text: '', highlightIndex: null, lineBreak: true});
  };

  const pushTextSegment = (value: string, segmentHighlightIndex: number | null) => {
    const parts = String(value || '').split('^');
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) pushLineBreak();
      const normalized = part.trim().replace(/\s+/g, ' ');
      if (!normalized) return;
      if (segmentHighlightIndex === null) {
        for (const word of normalized.split(' ').filter(Boolean)) {
          tokens.push({
            text: word,
            highlightIndex: null,
          });
        }
      } else {
        for (const word of normalized.split(' ').filter(Boolean)) {
          tokens.push({
            text: word,
            highlightIndex: segmentHighlightIndex,
          });
        }
      }
    });
  };

  const pushWords = (value: string) => {
    pushTextSegment(value, null);
  };

  const pushHighlighted = (value: string, segmentHighlightIndex: number) => {
    if (String(value || '').trim()) {
      pushTextSegment(value, segmentHighlightIndex);
    }
  };

  for (const match of text.matchAll(pattern)) {
    pushWords(text.slice(cursor, match.index));
    const highlightedParts = String(match[1] ?? '').split('^');
    highlightedParts.forEach((part, partIndex) => {
      if (partIndex > 0) pushLineBreak();
      if (!part.trim()) return;
      highlightIndex += 1;
      pushHighlighted(part, highlightIndex);
    });
    cursor = (match.index ?? 0) + match[0].length;
  }
  pushWords(text.slice(cursor));
  return tokens;
};

// Dynamic font scaling metrics to keep both short and long text visually balanced
const getNews2x1Metrics = (text: string, scale: number) => {
  const len = text.length;
  if (len > 200) return {size: 100 * scale, line: 108 * scale};
  if (len > 150) return {size: 120 * scale, line: 125 * scale};
  if (len > 100) return {size: 150 * scale, line: 155 * scale};
  if (len > 70) return {size: 190 * scale, line: 195 * scale};
  return {size: 244 * scale, line: 241 * scale};
};

const getNews1x1Metrics = (text: string, scale: number) => {
  const len = text.length;
  if (len > 170) return {size: 75 * scale, line: 82 * scale};
  if (len > 120) return {size: 90 * scale, line: 95 * scale};
  if (len > 80) return {size: 110 * scale, line: 115 * scale};
  if (len > 50) return {size: 125 * scale, line: 130 * scale};
  return {size: 146 * scale, line: 139 * scale};
};

const getQuote2x1Metrics = (text: string, scale: number) => {
  const len = text.length;
  if (len > 240) return {size: 96 * scale, line: 120 * scale};
  if (len > 180) return {size: 115 * scale, line: 140 * scale};
  if (len > 110) return {size: 125 * scale, line: 155 * scale};
  if (len > 70) return {size: 140 * scale, line: 175 * scale};
  return {size: 155 * scale, line: 195 * scale};
};

const getQuote1x1LeftMetrics = (text: string, scale: number) => {
  const len = text.length;
  if (len > 240) return {size: 68 * scale, line: 90 * scale};
  if (len > 180) return {size: 82 * scale, line: 110 * scale};
  if (len > 120) return {size: 98 * scale, line: 130 * scale};
  if (len > 70) return {size: 118 * scale, line: 155 * scale};
  return {size: 138 * scale, line: 180 * scale};
};

const getQuote1x1CenterMetrics = (text: string, scale: number) => {
  const len = text.length;
  if (len > 240) return {size: 68 * scale, line: 90 * scale};
  if (len > 180) return {size: 82 * scale, line: 110 * scale};
  if (len > 120) return {size: 100 * scale, line: 130 * scale};
  if (len > 70) return {size: 120 * scale, line: 155 * scale};
  return {size: 143 * scale, line: 180 * scale};
};

const FONT_CSS = `
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Regular.ttf')}') format('truetype');
  font-weight: 400;
}
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Medium.ttf')}') format('truetype');
  font-weight: 500 699;
}
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Bold.ttf')}') format('truetype');
  font-weight: 700 849;
}
@font-face {
  font-family: 'CoFo Sans';
  src: url('${staticFile('fonts/CoFo_Sans-Black.ttf')}') format('truetype');
  font-weight: 850 950;
}
`;

const Background = ({
  transparent,
  image,
  blur = 0,
  dim = 0.62,
}: {
  transparent: boolean;
  image?: string;
  blur?: number;
  dim?: number;
}) => {
  if (transparent) return null;
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const zoom = interpolate(frame, [0, durationInFrames], [1.0, 1.08]);

  return (
    <AbsoluteFill style={{backgroundColor: colors.black, overflow: 'hidden'}}>
      {image ? (
        isVideoAsset(image) ? (
          <OffthreadVideo
            src={image}
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: blur > 0 ? `blur(${blur}px)` : undefined,
              transform: `scale(${zoom * (blur > 0 ? 1.04 : 1.0)})`,
            }}
          />
        ) : (
          <Img
            src={image}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: blur > 0 ? `blur(${blur}px)` : undefined,
              transform: `scale(${zoom * (blur > 0 ? 1.04 : 1.0)})`,
            }}
          />
        )
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'linear-gradient(90deg, #404045 0%, #141417 100%)',
            transform: `scale(${zoom})`,
          }}
        />
      )}
      <AbsoluteFill style={{backgroundColor: 'rgba(0, 0, 0, 0.2)'}} />
      {image && dim > 0 && (
        <AbsoluteFill style={{backgroundColor: `rgba(0, 0, 0, ${dim})`}} />
      )}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(0deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 25%, rgba(0,0,0,0.1) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};

const AnimatedText = ({
  text,
  style,
  s,
  highlightDelaySeconds = 1.35,
  highlightDurationSeconds = 1.05,
  highlightStaggerSeconds = 1.2,
}: {
  text: string;
  style: React.CSSProperties;
  s: number;
  highlightDelaySeconds?: number;
  highlightDurationSeconds?: number;
  highlightStaggerSeconds?: number;
}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  
  const words = parseHighlightedWords(text);
  const lastTextTokenIndex = words.reduce((maxIndex, token, index) => (token.lineBreak ? maxIndex : index), 0);
  const textEntryComplete = Math.ceil(lastTextTokenIndex * 3.5 + 34 + 0.12 * fps);
  const highlightStart = Math.max(Math.round(highlightDelaySeconds * fps), textEntryComplete);
  const highlightDuration = Math.round(highlightDurationSeconds * fps);
  const highlightPause = Math.round(0.15 * fps);
  const highlightStagger = Math.max(Math.round(highlightStaggerSeconds * fps), highlightDuration + highlightPause);

  // Exit interpolation
  const exitStart = durationInFrames - Math.round(0.75 * fps);
  const exitEnd = durationInFrames - Math.round(0.1 * fps);
  const exit = interpolate(frame, [exitStart, exitEnd], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        ...style,
        display: 'block',
        textAlign: style.textAlign,
        opacity: exit,
      }}
    >
      {words.map((token, idx) => {
        if (token.lineBreak) {
          return <br key={idx} />;
        }

        // Entry spring staggered per word for a softer text reveal.
        const progress = spring({
          frame: Math.max(0, frame - idx * 3.5),
          fps,
          config: {damping: 28, stiffness: 54, mass: 1.25},
        });
        
        const y = interpolate(progress, [0, 1], [58 * s, 0]);
        const opacity = interpolate(progress, [0, 1], [0, 1]);
        const isHighlighted = token.highlightIndex !== null;
        const highlightProgress = isHighlighted
          ? interpolate(
              frame,
              [
                highlightStart + (token.highlightIndex ?? 0) * highlightStagger,
                highlightStart + (token.highlightIndex ?? 0) * highlightStagger + highlightDuration,
              ],
              [0, 1],
              {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
                easing: Easing.bezier(0.25, 0.1, 0.25, 1)
              }
            )
          : 0;
        const highlightTokenIndex = isHighlighted
          ? words.slice(0, idx).filter((item) => item.highlightIndex === token.highlightIndex).length
          : 0;
        const highlightTokenCount = isHighlighted
          ? Math.max(1, words.filter((item) => item.highlightIndex === token.highlightIndex).length)
          : 1;
        const tokenHighlightProgress = isHighlighted
          ? interpolate(
              highlightProgress,
              [highlightTokenIndex / highlightTokenCount, (highlightTokenIndex + 1) / highlightTokenCount],
              [0, 1],
              {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
                easing: Easing.bezier(0.25, 0.1, 0.25, 1),
              }
            )
          : 0;
        const highlightColor = isHighlighted
          ? HIGHLIGHT_COLORS[(token.highlightIndex ?? 0) % HIGHLIGHT_COLORS.length]
          : 'transparent';

        const isPunct = /^[,.!?;:?]+$/.test(token.text);
        const nextToken = idx + 1 < words.length ? words[idx + 1] : null;
        const prevToken = idx > 0 ? words[idx - 1] : null;
        const nextIsPunct = nextToken !== null && /^[,.!?;:?]+$/.test(nextToken.text);
        const nextIsBreak = nextToken?.lineBreak === true;
        const nextIsSameHighlight = isHighlighted && nextToken?.highlightIndex === token.highlightIndex;
        const prevIsSameHighlight = isHighlighted && prevToken?.highlightIndex === token.highlightIndex;
        const renderText = `${token.text}${nextIsSameHighlight ? '\u00A0' : ''}`;
        const hPadL = isPunct ? 0 : 4;
        const hPadR = isPunct ? 0 : 4;
        const highlightWidth = `${Math.max(0, Math.min(100, tokenHighlightProgress * 100))}%`;
        const highlightPadLeft = prevIsSameHighlight ? 0 : 8 * s;
        const highlightPadRight = nextIsSameHighlight ? 0 : 8 * s;
        const highlightPadTop = 3 * s;
        const highlightPadBottom = 16 * s;
        const highlightTextPadding = `${highlightPadTop}px ${highlightPadRight}px ${highlightPadBottom}px ${highlightPadLeft}px`;
        const highlightRadius = `${prevIsSameHighlight ? 0 : 8 * s}px ${nextIsSameHighlight ? 0 : 8 * s}px ${nextIsSameHighlight ? 0 : 8 * s}px ${prevIsSameHighlight ? 0 : 8 * s}px`;

        if (isHighlighted) {
          return (
            <span
              key={idx}
              style={{
                display: 'inline-block',
                position: 'relative',
                zIndex: 1,
                overflow: 'visible',
                verticalAlign: 'bottom',
                lineHeight: style.lineHeight,
                paddingTop: `${30 * s}px`,
                marginTop: `${-30 * s}px`,
                paddingBottom: `${30 * s}px`,
                marginBottom: `${-30 * s}px`,
                transform: `translateY(${y}px)`,
                  opacity,
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  position: 'relative',
                  color: colors.white,
                  padding: `0 ${highlightPadRight}px 0 ${highlightPadLeft}px`,
                  marginLeft: `${-4 * s}px`,
                  marginRight: `${-4 * s}px`,
                }}
              >
                <span
                  style={{
                    position: 'relative',
                    zIndex: 1,
                  }}
                >
                  {renderText}
                </span>
                <span
                  style={{
                    position: 'absolute',
                    zIndex: 2,
                    left: 0,
                    top: `${-highlightPadTop}px`,
                    bottom: `${-highlightPadBottom}px`,
                    width: highlightWidth,
                    overflow: 'hidden',
                    borderRadius: highlightRadius,
                    backgroundColor: highlightColor,
                    pointerEvents: 'none',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      padding: highlightTextPadding,
                      color: '#050505',
                      whiteSpace: 'pre',
                    }}
                  >
                    {renderText}
                  </span>
                </span>
              </span>
              {!nextIsPunct && !nextIsBreak && !nextIsSameHighlight && <span style={{display: 'inline-block'}}>&nbsp;</span>}
            </span>
          );
        }

        return (
          <span
            key={idx}
            style={{
              display: 'inline-block',
              position: 'relative',
              zIndex: 2,
              overflow: 'visible',
              verticalAlign: 'bottom',
              lineHeight: style.lineHeight,
              paddingTop: `${30 * s}px`,
              marginTop: `${-30 * s}px`,
              paddingBottom: `${30 * s}px`,
              marginBottom: `${-30 * s}px`,
              paddingLeft: `${hPadL * s}px`,
              marginLeft: `${-hPadL * s}px`,
              paddingRight: `${hPadR * s}px`,
              marginRight: `${-hPadR * s}px`,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                position: 'relative',
                color: colors.white,
                transform: `translateY(${y}px)`,
                opacity,
              }}
            >
              <span
                style={{
                  position: 'relative',
                  zIndex: 1,
                }}
              >
                {renderText}
              </span>
            </span>
            {!nextIsPunct && !nextIsBreak && <span style={{display: 'inline-block'}}>&nbsp;</span>}
          </span>
        );
      })}
    </div>
  );
};

const useAnimation = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: {damping: 20, stiffness: 95, mass: 0.9},
  });
  const delayed = spring({
    frame: Math.max(0, frame - 12),
    fps,
    config: {damping: 22, stiffness: 85, mass: 0.9},
  });
  
  const exitStart = durationInFrames - Math.round(0.75 * fps);
  const exitEnd = durationInFrames - Math.round(0.1 * fps);
  const exit = interpolate(frame, [exitStart, exitEnd], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {enter, delayed, exit};
};

const Logo = ({
  text,
  icon,
  isBadge,
  s,
  shadow,
  fontSize = 96,
  lineHeight = 92,
  textAlign = 'left',
}: {
  text: string;
  icon?: string;
  isBadge: boolean;
  s: number;
  shadow?: string;
  fontSize?: number;
  lineHeight?: number;
  textAlign?: 'left' | 'center' | 'right';
}) => {
  const hasIcon = Boolean(icon);
  const normalizedText = clean(text);
  const isDefaultSourceText = /^(?:ucontent|ut)$/i.test(normalizedText);
  const isTechnicalLogoText = /(?:^|[_\-\s])logo(?:$|[_\-\s])|_cc$|\.(?:png|jpe?g|webp|svg)$/i.test(normalizedText);
  const shouldShowText = !hasIcon || (!isDefaultSourceText && !isTechnicalLogoText);
  
  const iconNode = hasIcon && icon ? (
    icon === 'orange-circle' ? (
      <div
        style={{
          width: `${fontSize * 0.78 * s}px`,
          height: `${fontSize * 0.78 * s}px`,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #ff7a00 0%, #ff4d00 100%)',
          marginRight: `${fontSize * 0.15 * s}px`,
          flexShrink: 0,
        }}
      />
    ) : (
      <Img
        src={icon}
        style={{
          width: `${fontSize * 4.1 * s}px`,
          height: `${fontSize * 1.5 * s}px`,
          marginRight: shouldShowText ? `${fontSize * 0.2 * s}px` : 0,
          objectFit: 'contain',
          objectPosition: 'left center',
          flexShrink: 0,
        }}
      />
    )
  ) : null;

  if (isBadge) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: `${12 * s}px ${20 * s}px`,
          borderRadius: 100 * s,
          backgroundColor: 'rgba(0, 0, 0, 0.72)',
          textShadow: shadow,
        }}
      >
        {iconNode}
        {shouldShowText && (
          <span
            style={{
              fontSize: fontSize * s,
              lineHeight: `${lineHeight * s}px`,
              fontWeight: 500,
              color: colors.white,
              letterSpacing: '-0.01em',
            }}
          >
            {text}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start',
        textShadow: shadow,
        width: textAlign === 'center' ? '100%' : undefined,
      }}
    >
      {iconNode}
      {shouldShowText && (
        <span
          style={{
            fontSize: fontSize * s,
            lineHeight: `${lineHeight * s}px`,
            fontWeight: 500,
            color: colors.white,
            letterSpacing: '-0.01em',
          }}
        >
          {text}
        </span>
      )}
    </div>
  );
};

const AuthorAvatar = ({src, s, isWide}: {src: string; s: number; isWide: boolean}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();

  // Entry spring
  const enter = spring({
    frame,
    fps,
    config: {damping: 24, stiffness: 80, mass: 1.0},
  });

  // Exit interpolation
  const exitStart = durationInFrames - Math.round(0.75 * fps);
  const exitEnd = durationInFrames - Math.round(0.1 * fps);
  const exit = interpolate(frame, [exitStart, exitEnd], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Continuous slow zoom (Ken Burns)
  const zoom = interpolate(frame, [0, durationInFrames], [1.0, 1.12]);

  const targetOpacity = isWide ? 0.25 : 0.35;
  const opacity = interpolate(enter, [0, 1], [0, targetOpacity]);

  const commonStyle: CSSProperties = {
    position: 'absolute',
    borderRadius: '50%',
    overflow: 'hidden',
    opacity: opacity * exit,
    filter: 'grayscale(100%) brightness(0.8) contrast(1.2)',
    pointerEvents: 'none',
    WebkitMaskImage: 'radial-gradient(circle, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 70%)',
    maskImage: 'radial-gradient(circle, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 70%)',
    transform: `scale(${zoom})`,
  };

  if (isWide) {
    return (
      <div
        style={{
          ...commonStyle,
          right: 120 * s,
          top: 220 * s,
          width: 800 * s,
          height: 800 * s,
        }}
      >
        <Img
          src={src}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        ...commonStyle,
        right: -80 * s,
        top: 240 * s,
        width: 900 * s,
        height: 900 * s,
      }}
    >
      <Img
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }}
      />
    </div>
  );
};

export const QuoteVideo = ({
  type,
  layout,
  variant = 'editorial',
  transparent = false,
  source = 'UT',
  logo,
  quote,
  title,
  author,
  role,
  date,
  meta,
  accent,
  textScale = 1,
  lineHeightScale = 1,
  highlightDelaySeconds = 1.35,
  highlightDurationSeconds = 1.05,
  highlightStaggerSeconds = 1.2,
  background,
  avatar,
  logoIcon,
  showDecorativeQuote = false,
}: QuoteVideoProps) => {
  const {width, height} = useVideoConfig();
  const {delayed, exit} = useAnimation();
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [8, 22], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }) * exit;
  
  // 1920px is the Figma base height for both 1:1 and 2:1 templates
  const s = height / 1920;
  const mainTextScale = Math.max(0.72, Math.min(1.38, Number(textScale) || 1));
  const mainLineScale = Math.max(0.72, Math.min(1.5, Number(lineHeightScale) || 1));
  const softElementEnter: CSSProperties = {
    opacity: delayed * exit,
    transform: `translateY(${interpolate(delayed, [0, 1], [34 * s, 0])}px)`,
  };
  
  // Resolve content aliases
  const logoText = clean(logo || source) || 'UT';
  const contentText = clean(quote || title);
  const authorText = clean(author);
  const roleText = clean(role);
  const dateText = clean(date || meta);
  
  // Resolve card type: 'news' or 'quote'
  const resolvedType =
    type ||
    (variant === 'editorial' ? 'quote' : null) ||
    (variant === 'source-led' || variant === 'minimal' ? 'news' : null) ||
    (authorText ? 'quote' : 'news');

  const isWide = width / height > 1.4;
  
  // Resolve layout variant
  const resolvedLayout =
    layout ||
    (isWide
      ? 'Wide'
      : resolvedType === 'news'
      ? variant === 'minimal'
        ? 'BL'
        : 'TL'
      : 'Left');

  const shadow = transparent ? '0 8px 28px rgba(0,0,0,0.65)' : undefined;
  const markOpacity = transparent ? 0.18 : 0.09;

  // Font metrics & styling from Figma
  const safe = 134 * s; // SAFE = 7% of 1920

  const rootStyle: CSSProperties = {
    overflow: 'hidden',
    backgroundColor: transparent ? 'transparent' : colors.black,
    fontFamily: fontStack,
  };

  // Rendering News Card 1:1 (Square)
  if (resolvedType === 'news' && !isWide) {
    const isBadge = resolvedLayout === 'Badge';
    const isBL = resolvedLayout === 'BL';

    const {size: titleFontSize, line: titleLineHeight} = getNews1x1Metrics(contentText, s * mainTextScale);

    return (
      <AbsoluteFill style={rootStyle}>
        <style>{FONT_CSS}</style>
        <Background
          transparent={transparent}
          image={background?.image}
          blur={background?.blur}
          dim={background?.dim}
        />
        <div
          style={{
            position: 'absolute',
            inset: `${safe}px`,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: isBL ? 'flex-end' : 'space-between',
            alignItems: 'flex-start',
          }}
        >
          {/* Logo */}
          <div
            style={{
              marginBottom: isBL ? 40 * s : 0,
              ...softElementEnter,
            }}
          >
            <Logo
              text={logoText}
              icon={logoIcon}
              isBadge={isBadge}
              s={s}
              shadow={shadow}
              fontSize={96}
              lineHeight={92}
            />
          </div>

          {/* Copy (Title + Date) */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 48 * s,
              alignSelf: 'stretch',
            }}
          >
            <AnimatedText
              text={contentText}
              style={{
                fontSize: titleFontSize,
                lineHeight: `${titleLineHeight * mainLineScale}px`,
                fontWeight: 500,
                color: colors.white,
                letterSpacing: '-0.01em',
                textShadow: shadow,
              }}
              s={s}
              highlightDelaySeconds={highlightDelaySeconds}
              highlightDurationSeconds={highlightDurationSeconds}
              highlightStaggerSeconds={highlightStaggerSeconds}
            />
            {dateText && (
              <div
                style={{
                  fontSize: 80 * s,
                  lineHeight: `${82 * s}px`,
                  fontWeight: 500,
                  color: '#686868',
                  letterSpacing: '-0.01em',
                  textShadow: shadow,
                  ...softElementEnter,
                }}
              >
                {dateText}
              </div>
            )}
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  // Rendering Quote Card 1:1 (Square)
  if (resolvedType === 'quote' && !isWide) {
    const isCenter = resolvedLayout === 'Center';
    const isBadge = resolvedLayout === 'Badge';
    const {size: quoteFontSize, line: quoteLineHeight} = isCenter
      ? getQuote1x1CenterMetrics(contentText, s * mainTextScale)
      : getQuote1x1LeftMetrics(contentText, s * mainTextScale);
      
    const textAlign = isCenter ? 'center' : 'left';
    const alignItem = isCenter ? 'center' : 'flex-start';

    const authorLines = [authorText, roleText || dateText].filter(Boolean);

    return (
      <AbsoluteFill style={rootStyle}>
        <style>{FONT_CSS}</style>
        <Background
          transparent={transparent}
          image={background?.image}
          blur={background?.blur}
          dim={background?.dim}
        />
        {avatar && <AuthorAvatar src={avatar} s={s} isWide={false} />}
        
        {/* Background Decorative Quote Mark */}
        {showDecorativeQuote && (
          <div
            style={{
              position: 'absolute',
              left: isCenter ? '50%' : undefined,
              right: isCenter ? undefined : safe - 20 * s,
              top: isCenter ? 340 * s : undefined,
              bottom: isCenter ? undefined : 240 * s,
              transform: isCenter ? 'translateX(-50%)' : undefined,
              color: 'rgba(255, 255, 255, 0.07)',
              fontSize: isCenter ? 520 * s : 650 * s,
              lineHeight: 1,
              fontFamily: 'Georgia, serif',
              fontWeight: 400,
              opacity: delayed * exit,
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          >
            {isCenter ? '“' : '”'}
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            inset: `${safe}px`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: alignItem,
          }}
        >
          {/* Logo */}
          <div
            style={{
              alignSelf: isCenter ? 'center' : 'flex-start',
              ...softElementEnter,
            }}
          >
            <Logo
              text={logoText}
              icon={logoIcon}
              isBadge={isBadge}
              s={s}
              shadow={shadow}
              textAlign={textAlign}
            />
          </div>

          {/* Quote Area */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: isCenter ? 'center' : 'flex-start',
              width: '100%',
            }}
          >
            <AnimatedText
              text={contentText}
              style={{
                fontSize: quoteFontSize,
                lineHeight: `${quoteLineHeight * mainLineScale}px`,
                fontWeight: 500,
                color: colors.white,
                letterSpacing: '-0.01em',
                textAlign: textAlign,
                width: isCenter ? '100%' : '86%',
                textShadow: shadow,
              }}
              s={s}
              highlightDelaySeconds={highlightDelaySeconds}
              highlightDurationSeconds={highlightDurationSeconds}
              highlightStaggerSeconds={highlightStaggerSeconds}
            />
          </div>

          {/* Author Stack */}
          {authorLines.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2 * s,
                alignItems: alignItem,
                textShadow: shadow,
                ...softElementEnter,
              }}
            >
              {authorText && (
                <div
                  style={{
                    fontSize: 80 * s,
                    lineHeight: `${82 * s}px`,
                    fontWeight: 500,
                    color: colors.white,
                    letterSpacing: '-0.01em',
                    textAlign: textAlign,
                  }}
                >
                  {authorText}
                </div>
              )}
              {(roleText || dateText) && (
                <div
                  style={{
                    fontSize: 72 * s,
                    lineHeight: `${78 * s}px`,
                    fontWeight: 400,
                    color: '#adadad',
                    letterSpacing: '-0.01em',
                    textAlign: textAlign,
                  }}
                >
                  {roleText || dateText}
                </div>
              )}
            </div>
          )}
        </div>
      </AbsoluteFill>
    );
  }

  // Rendering News Card 2:1 (Wide)
  if (resolvedType === 'news' && isWide) {
    const left = 542 * s;
    const right = 3447 * s;
    const baseline = 1426 * s;
    const footerLogoFontSize = 96;
    const footerLogoHeight = footerLogoFontSize * 1.5 * s;
    const footerBottom = 1920 * s - baseline;

    const {size: titleFontSize, line: titleLineHeight} = getNews2x1Metrics(contentText, s * mainTextScale);

    return (
      <AbsoluteFill style={rootStyle}>
        <style>{FONT_CSS}</style>
        <Background
          transparent={transparent}
          image={background?.image}
          blur={background?.blur}
          dim={background?.dim}
        />

        {/* Dynamic Title Container */}
        <div
          style={{
            position: 'absolute',
            left,
            top: 422 * s, // NEWS_WIDE_TITLE_Y = 422
            width: right - left, // 2905 * s
          }}
        >
          <AnimatedText
            text={contentText}
            style={{
              fontSize: titleFontSize,
              lineHeight: `${titleLineHeight * mainLineScale}px`,
              fontWeight: 500,
              color: colors.white,
              letterSpacing: '-0.01em',
              textShadow: shadow,
            }}
            s={s}
            highlightDelaySeconds={highlightDelaySeconds}
            highlightDurationSeconds={highlightDurationSeconds}
            highlightStaggerSeconds={highlightStaggerSeconds}
          />
        </div>

        {/* Footer Logo (Left) */}
        <div
          style={{
            position: 'absolute',
            left,
            top: baseline - footerLogoHeight,
            ...softElementEnter,
          }}
        >
          <Logo
            text={logoText}
            icon={logoIcon}
            isBadge={false}
            s={s}
            shadow={shadow}
            fontSize={footerLogoFontSize}
            lineHeight={footerLogoFontSize}
          />
        </div>

        {/* Footer Meta Date (Right) */}
        {dateText && (
          <div
            style={{
              position: 'absolute',
              right: (3840 - 3447) * s,
              bottom: footerBottom,
              fontSize: 80 * s,
              lineHeight: `${82 * s}px`,
              fontWeight: 500,
              color: '#686868',
              letterSpacing: '-0.01em',
              textAlign: 'right',
              textShadow: shadow,
              ...softElementEnter,
            }}
          >
            {dateText}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // Rendering Quote Card 2:1 (Wide)
  // (resolvedType === 'quote' && isWide)
  const left = 542 * s;
  const right = 3447 * s;
  const baseline = 1426 * s;
  const footerLogoFontSize = 96;
  const footerLogoHeight = footerLogoFontSize * 1.5 * s;
  const footerBottom = 1920 * s - baseline;

  const authorLines = [authorText, roleText || dateText].filter(Boolean);
  const {size: quoteFontSize, line: quoteLineHeight} = getQuote2x1Metrics(contentText, s * mainTextScale);

  const isBadge = resolvedLayout === 'Badge';

  return (
    <AbsoluteFill style={rootStyle}>
      <style>{FONT_CSS}</style>
      <Background
        transparent={transparent}
        image={background?.image}
        blur={background?.blur}
        dim={background?.dim}
      />
      {avatar && <AuthorAvatar src={avatar} s={s} isWide={true} />}

      {/* Background Decorative Quote Mark */}
      {showDecorativeQuote && (
        <div
          style={{
            position: 'absolute',
            right: 180 * s,
            top: 80 * s,
            color: 'rgba(255, 255, 255, 0.05)',
            fontSize: 720 * s,
            lineHeight: 1,
            fontFamily: 'Georgia, serif',
            fontWeight: 400,
            opacity: delayed * exit,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          ”
        </div>
      )}

      {/* Dynamic Quote Container */}
      <div
        style={{
          position: 'absolute',
          left,
          top: 422 * s, // QUOTE_WIDE_Y = 422
          width: right - left, // 2905 * s
        }}
      >
        <AnimatedText
          text={contentText}
          style={{
            fontSize: quoteFontSize,
            lineHeight: `${quoteLineHeight * mainLineScale}px`,
            fontWeight: 500,
            color: colors.white,
            letterSpacing: '-0.01em',
            textShadow: shadow,
          }}
          s={s}
          highlightDelaySeconds={highlightDelaySeconds}
          highlightDurationSeconds={highlightDurationSeconds}
          highlightStaggerSeconds={highlightStaggerSeconds}
        />
      </div>

      {/* Footer Logo (Left) */}
      <div
        style={{
          position: 'absolute',
          left,
          top: baseline - footerLogoHeight,
          ...softElementEnter,
        }}
      >
        <Logo
          text={logoText}
          icon={logoIcon}
          isBadge={isBadge}
          s={s}
          shadow={shadow}
          fontSize={footerLogoFontSize}
          lineHeight={footerLogoFontSize}
        />
      </div>

      {/* Footer Author Stack */}
      {authorLines.length > 0 && (
        <div
          style={{
            position: 'absolute',
            right: (3840 - 3447) * s,
            bottom: footerBottom,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 2 * s,
            textShadow: shadow,
            ...softElementEnter,
          }}
        >
          {authorText && (
            <div
              style={{
                fontSize: 80 * s,
                lineHeight: `${90 * s}px`,
                fontWeight: 500,
                color: colors.white,
                letterSpacing: '-0.01em',
                textAlign: 'right',
              }}
            >
              {authorText}
            </div>
          )}
          {(roleText || dateText) && (
            <div
              style={{
                fontSize: 72 * s,
                lineHeight: `${78 * s}px`,
                fontWeight: 400,
                color: '#adadad',
                letterSpacing: '-0.01em',
                textAlign: 'right',
              }}
            >
              {roleText || dateText}
            </div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
