import {
  AbsoluteFill,
  Img,
  interpolate,
  OffthreadVideo,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {CSSProperties} from 'react';
import {colors, fontStack} from '../design/tokens';
import type {QuoteVideoProps} from '../types';

const clean = (value: string | undefined) => String(value ?? '').trim();
const isVideoAsset = (value: string | undefined) =>
  /\.(mp4|mov|m4v|webm|mkv)(?:$|[?#])/i.test(clean(value));

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
}: {
  text: string;
  style: React.CSSProperties;
  s: number;
}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  
  const words = text.split(' ');

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
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: style.textAlign === 'center' ? 'center' : 'flex-start',
      }}
    >
      {words.map((word, idx) => {
        // Entry spring staggered by 1.5 frames per word
        const progress = spring({
          frame: Math.max(0, frame - idx * 1.5),
          fps,
          config: {damping: 18, stiffness: 120, mass: 0.8},
        });
        
        const y = interpolate(progress, [0, 1], [35 * s, 0]);
        const opacity = interpolate(progress, [0, 1], [0, 1]);

        return (
          <span
            key={idx}
            style={{
              display: 'inline-block',
              overflow: 'hidden',
              verticalAlign: 'bottom',
              lineHeight: style.lineHeight,
              paddingTop: `${20 * s}px`,
              marginTop: `${-20 * s}px`,
              paddingBottom: `${25 * s}px`,
              marginBottom: `${-25 * s}px`,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                transform: `translateY(${y}px)`,
                opacity: opacity * exit,
              }}
            >
              {word}
            </span>
            <span style={{display: 'inline-block'}}>&nbsp;</span>
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
  
  const iconNode = hasIcon && icon ? (
    icon === 'orange-circle' ? (
      <div
        style={{
          width: `${fontSize * 0.5 * s}px`,
          height: `${fontSize * 0.5 * s}px`,
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
          width: `${fontSize * 0.5 * s}px`,
          height: `${fontSize * 0.5 * s}px`,
          borderRadius: '50%',
          marginRight: `${fontSize * 0.15 * s}px`,
          objectFit: 'cover',
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
  background,
  avatar,
  logoIcon,
  showDecorativeQuote = false,
}: QuoteVideoProps) => {
  const {width, height} = useVideoConfig();
  const {enter, delayed, exit} = useAnimation();
  
  // 1920px is the Figma base height for both 1:1 and 2:1 templates
  const s = height / 1920;
  
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

    const logoNode = isBadge ? (
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
        <span
          style={{
            fontSize: 96 * s,
            lineHeight: `${92 * s}px`,
            fontWeight: 500,
            color: colors.white,
            letterSpacing: '-0.01em',
          }}
        >
          {logoText}
        </span>
      </div>
    ) : (
      <span
        style={{
          fontSize: 96 * s,
          lineHeight: `${92 * s}px`,
          fontWeight: 500,
          color: colors.white,
          letterSpacing: '-0.01em',
          textShadow: shadow,
        }}
      >
        {logoText}
      </span>
    );

    const {size: titleFontSize, line: titleLineHeight} = getNews1x1Metrics(contentText, s);

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
              opacity: delayed * exit,
              transform: `translateY(${interpolate(delayed, [0, 1], [-25 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.85, 1.0])})`,
            }}
          >
            {logoNode}
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
                lineHeight: `${titleLineHeight}px`,
                fontWeight: 500,
                color: colors.white,
                letterSpacing: '-0.01em',
                textShadow: shadow,
              }}
              s={s}
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
                  opacity: delayed * exit,
                  transform: `translateY(${interpolate(delayed, [0, 1], [15 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.95, 1.0])})`,
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
      ? getQuote1x1CenterMetrics(contentText, s)
      : getQuote1x1LeftMetrics(contentText, s);
      
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
              opacity: delayed * exit,
              transform: `translateY(${interpolate(delayed, [0, 1], [-25 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.85, 1.0])})`,
              transformOrigin: isCenter ? 'center' : 'left center',
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
                lineHeight: `${quoteLineHeight}px`,
                fontWeight: 500,
                color: colors.white,
                letterSpacing: '-0.01em',
                textAlign: textAlign,
                width: isCenter ? '100%' : '86%',
                textShadow: shadow,
              }}
              s={s}
            />
          </div>

          {/* Author Stack */}
          {authorLines.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8 * s,
                alignItems: alignItem,
                opacity: delayed * exit,
                transform: `translateY(${interpolate(delayed, [0, 1], [25 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.95, 1.0])})`,
                transformOrigin: isCenter ? 'center' : 'left center',
                textShadow: shadow,
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
    const footerHeight = 120 * s; // Logo size 120px

    const {size: titleFontSize, line: titleLineHeight} = getNews2x1Metrics(contentText, s);

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
              lineHeight: `${titleLineHeight}px`,
              fontWeight: 500,
              color: colors.white,
              letterSpacing: '-0.01em',
              textShadow: shadow,
            }}
            s={s}
          />
        </div>

        {/* Footer Logo (Left) */}
        <div
          style={{
            position: 'absolute',
            left,
            top: baseline - 120 * s,
            opacity: delayed * exit,
            transform: `translateY(${interpolate(delayed, [0, 1], [20 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.85, 1.0])})`,
            transformOrigin: 'left center',
          }}
        >
          <Logo
            text={logoText}
            icon={logoIcon}
            isBadge={false}
            s={s}
            shadow={shadow}
            fontSize={120}
            lineHeight={120}
          />
        </div>

        {/* Footer Meta Date (Right) */}
        {dateText && (
          <div
            style={{
              position: 'absolute',
              right: (3840 - 3447) * s,
              top: baseline - 82 * s,
              fontSize: 80 * s,
              lineHeight: `${82 * s}px`,
              fontWeight: 500,
              color: '#686868',
              letterSpacing: '-0.01em',
              textAlign: 'right',
              opacity: delayed * exit,
              transform: `translateY(${interpolate(delayed, [0, 1], [20 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.95, 1.0])})`,
              transformOrigin: 'right center',
              textShadow: shadow,
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

  const authorLines = [authorText, roleText || dateText].filter(Boolean);
  const {size: quoteFontSize, line: quoteLineHeight} = getQuote2x1Metrics(contentText, s);

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
            lineHeight: `${quoteLineHeight}px`,
            fontWeight: 500,
            color: colors.white,
            letterSpacing: '-0.01em',
            textShadow: shadow,
          }}
          s={s}
        />
      </div>

      {/* Footer Logo (Left) */}
      <div
        style={{
          position: 'absolute',
          left,
          top: baseline - 120 * s,
          opacity: delayed * exit,
          transform: `translateY(${interpolate(delayed, [0, 1], [20 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.85, 1.0])})`,
          transformOrigin: 'left center',
        }}
      >
        <Logo
          text={logoText}
          icon={logoIcon}
          isBadge={isBadge}
          s={s}
          shadow={shadow}
          fontSize={120}
          lineHeight={120}
        />
      </div>

      {/* Footer Author Stack */}
      {authorLines.length > 0 && (
        <div
          style={{
            position: 'absolute',
            right: (3840 - 3447) * s,
            bottom: (1920 - 1426) * s, // Align bottom to baseline
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 12 * s,
            opacity: delayed * exit,
            transform: `translateY(${interpolate(delayed, [0, 1], [25 * s, 0])}px) scale(${interpolate(delayed, [0, 1], [0.95, 1.0])})`,
            transformOrigin: 'right center',
            textShadow: shadow,
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
