// News Card / 1:1 Builder — Figma Plugin (no UI, pure JS)

const SIDE = 1920;                  // базовый размер
const SAFE = Math.round(SIDE * 0.07); // 7% от стороны
const RADIUS = 0;
const GRADIENT_H = SIDE;

const FONT_FAMILY = "CoFo Sans Variable";

// Типографика
const TITLE_SIZE = 146;
const TITLE_LINE = 139;
const TITLE_STYLE = "Medium";

const LOGO_SIZE = 96;
const LOGO_LINE = 92;
const LOGO_STYLE = "Medium";

const META_SIZE = 80;
const META_LINE = 82;
const META_STYLE = "Medium";

const QUOTE_LEFT_SIZE = 101;
const QUOTE_LEFT_LINE = 139;
const QUOTE_CENTER_SIZE = 143;
const QUOTE_CENTER_LINE = 144;
const QUOTE_AUTHOR_SIZE = 80;
const QUOTE_AUTHOR_LINE = 82;
const QUOTE_ROLE_SIZE = 72;
const QUOTE_ROLE_LINE = 78;
const ROLE_STYLE = "Regular";
const QUOTE_WIDE_SIZE = 135;
const QUOTE_WIDE_LINE = 170;
const LOGO_WIDE_SIZE = 120;
const QUOTE_WIDE_WIDTH = 2905;
const QUOTE_WIDE_X = 542;
const QUOTE_WIDE_Y = 422;
const LOGO_WIDE_GAP = 270;
const QUOTE_AUTHOR_GAP = 12;
const QUOTE_BOTTOM_Y = 1426;
const QUOTE_AUTHOR_RIGHT = 3447;
const NEWS_WIDE_TITLE_SIZE = 244;
const NEWS_WIDE_TITLE_LINE = 241;
const NEWS_WIDE_LOGO_SIZE = 120;
const NEWS_WIDE_TITLE_Y = 422;
const NEWS_WIDE_GAP = 270;

const FONT_STYLES = {
  title: TITLE_STYLE,
  logo: LOGO_STYLE,
  meta: META_STYLE,
  role: ROLE_STYLE,
};

const SAMPLE_CONTENT = {
  logo: "iPhones.ru",
  title: "Apple может снять с производства Vision Pro до конца 2024 года",
  meta: "23 октября 2024",
};

const SAMPLE_CONTENT_2X1 = {
  logo: "LENTA.RU",
  title: "Россиян предупредили о вернувшихся в магазины способах обмана",
  meta: "2 декабря 2024",
};

const CONTENT_GAP = 48;
const LOGO_COPY_GAP = 40;
const GRADIENT_BLACK_EXTENT = 0.25; // доля высоты, до которой держим плотный чёрный
const GRADIENT_TOP_ALPHA = 1; // непрозрачность на верхней точке перехода
const GRADIENT_BOTTOM_ALPHA = 0.1; // остаточная непрозрачность в самом низу

const SAMPLE_QUOTES = {
  left: {
    logo: "iPhones.ru",
    quote:
      "«Осетины за столом никогда не соревновались. Наоборот, это считалось постыдным, когда кто-то тебя может упрекнуть, что ты обжора или ещё кто-то. Осетины в еде были воздержаны»",
    author: "Марат Цагараев",
    role: "Председатель ИЭО «Уацамонга»",
  },
  center: {
    logo: "iPhones.ru",
    quote: "«Пока москвичи трудятся с утра до вечера, у итальянцев «обед, сиеста и пивко»»",
    author: "Сергей Собянин",
    role: "Мэр Москвы",
  },
};

const SIDE_2X1 = 3840;
const SAFE_2X1 = Math.round(SIDE_2X1 * 0.07);
const SAMPLE_QUOTES_2X1 = {
  wide: {
    quote:
      "Мы оба размышляли о Великой истории наших народов и о том факте, что мы так успешно сражались вместе во время Второй мировой войны.",
    author: "Дональд Трамп",
    role: "Президент США",
    logo: "TRUTH.",
  },
};

async function loadFonts() {
  async function ensureStyle(style) {
    try {
      await figma.loadFontAsync({ family: FONT_FAMILY, style });
      return style;
    } catch (err) {
      await figma.loadFontAsync({ family: FONT_FAMILY, style: "Regular" });
      return "Regular";
    }
  }

  FONT_STYLES.title = await ensureStyle(TITLE_STYLE);
  FONT_STYLES.logo = await ensureStyle(LOGO_STYLE);
  FONT_STYLES.meta = await ensureStyle(META_STYLE);
  FONT_STYLES.role = await ensureStyle(ROLE_STYLE);
}

function createBaseCard2x1(name) {
  const component = figma.createComponent();
  component.name = name;
  component.resize(SIDE_2X1, SIDE);
  component.clipsContent = true;
  component.fills = [];
  component.strokes = [];
  component.effects = [];

  const card = figma.createFrame();
  card.name = "Card";
  card.resize(SIDE_2X1, SIDE);
  card.clipsContent = true;
  card.fills = [];
  card.strokes = [];
  card.effects = [];
  component.appendChild(card);

  const image = rect("Image", SIDE_2X1, SIDE);
  image.fills = [
    {
      type: "GRADIENT_LINEAR",
      gradientTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      gradientStops: [
        { position: 0, color: { r: 0.25, g: 0.25, b: 0.27, a: 1 } },
        { position: 1, color: { r: 0.08, g: 0.08, b: 0.09, a: 1 } },
      ],
    },
  ];
  card.appendChild(image);

  const matte = rect("MatteBottom", SIDE_2X1, SIDE);
  matte.opacity = 0.2;
  matte.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
  card.appendChild(matte);

  const gradient = makeGradientRect(SIDE);
  gradient.resize(SIDE_2X1, SIDE);
  gradient.x = 0;
  gradient.y = 0;
  card.appendChild(gradient);

  return { component, card };
}

function rect(name, w, h) {
  const r = figma.createRectangle();
  r.name = name;
  r.resize(w, h);
  return r;
}

function makeGradientRect(height) {
  const g = rect("GradientBottom", SIDE, height);
  const paint = {
    type: "GRADIENT_LINEAR",
    gradientTransform: [
      [0, -1, 1], // снизу вверх
      [1, 0, 0],
    ],
    gradientStops: [
      { position: 0, color: { r: 0, g: 0, b: 0, a: GRADIENT_TOP_ALPHA } },
      { position: Math.min(1, GRADIENT_BLACK_EXTENT), color: { r: 0, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 0, a: GRADIENT_BOTTOM_ALPHA } },
    ],
    visible: true,
  };
  g.fills = [paint];
  return g;
}

function textNode(name, font, fill, characters, options = {}) {
  const t = figma.createText();
  t.name = name;
  t.fontName = { family: FONT_FAMILY, style: font.style };
  t.fontSize = font.size;
  t.lineHeight = { unit: "PIXELS", value: font.line };
  if (options.letterSpacing !== undefined) {
    t.letterSpacing = { unit: "PERCENT", value: options.letterSpacing };
  }
  t.characters = characters;
  t.fills = [fill];
  t.textAutoResize = options.autoResize !== undefined ? options.autoResize : "HEIGHT";
  return t;
}

function solidFill(a = 1, color = { r: 1, g: 1, b: 1 }) {
  return { type: "SOLID", color, opacity: a };
}

function createBaseCard(name) {
  const component = figma.createComponent();
  component.name = name;
  component.resize(SIDE, SIDE);
  component.clipsContent = true;
  component.fills = [];
  component.strokes = [];
  component.effects = [];

  const card = figma.createFrame();
  card.name = "Card";
  card.resize(SIDE, SIDE);
  card.clipsContent = true;
  card.fills = [];
  card.strokes = [];
  card.effects = [];
  component.appendChild(card);

  const image = rect("Image", SIDE, SIDE);
  image.fills = [
    {
      type: "GRADIENT_LINEAR",
      gradientTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      gradientStops: [
        { position: 0, color: { r: 0.25, g: 0.25, b: 0.27, a: 1 } },
        { position: 1, color: { r: 0.08, g: 0.08, b: 0.09, a: 1 } },
      ],
    },
  ];
  card.appendChild(image);

  const matte = rect("MatteBottom", SIDE, SIDE);
  matte.opacity = 0.2;
  matte.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
  card.appendChild(matte);

  const gradient = makeGradientRect(GRADIENT_H);
  gradient.y = 0;
  gradient.x = 0;
  card.appendChild(gradient);

  return { component, card };
}

function makeLogoBadge(label) {
  const badge = figma.createFrame();
  badge.name = "LogoBadge";
  badge.layoutMode = "HORIZONTAL";
  badge.counterAxisSizingMode = "AUTO";
  badge.primaryAxisSizingMode = "AUTO";
  badge.paddingLeft = badge.paddingRight = 20;
  badge.paddingTop = badge.paddingBottom = 12;
  badge.itemSpacing = 12;
  badge.cornerRadius = 100;
  badge.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.72 }];
  badge.strokes = [];
  badge.effects = [];

  const labelNode = textNode(
    "Logo",
    { size: LOGO_SIZE, line: LOGO_LINE, style: FONT_STYLES.logo },
    solidFill(1),
    label,
    { letterSpacing: -1, autoResize: "WIDTH_AND_HEIGHT" }
  );
  badge.appendChild(labelNode);
  return badge;
}

function assembleVariant(name, logoPos, logoBadge) {
  const { component, card } = createBaseCard(name);
  const textWidth = SIDE - SAFE * 2;

  const content = figma.createFrame();
  content.name = "Content";
  content.layoutMode = "VERTICAL";
  content.clipsContent = false;
  content.primaryAxisSizingMode = "FIXED";
  content.counterAxisSizingMode = "FIXED";
  content.resize(SIDE, SIDE);
  content.paddingLeft = content.paddingRight = SAFE;
  content.paddingTop = SAFE;
  content.paddingBottom = SAFE;
  content.itemSpacing = logoPos === "BL" ? LOGO_COPY_GAP : 0;
  content.primaryAxisAlignItems = logoPos === "BL" ? "MAX" : "SPACE_BETWEEN";
  content.counterAxisAlignItems = "MIN";
  content.fills = [];
  content.strokes = [];
  content.effects = [];
  card.appendChild(content);

  const title = textNode(
    "Title",
    { size: TITLE_SIZE, line: TITLE_LINE, style: FONT_STYLES.title },
    solidFill(1),
    SAMPLE_CONTENT.title,
    { letterSpacing: -1 }
  );
  title.resize(textWidth, title.height);
  title.layoutGrow = 1;
  title.layoutAlign = "STRETCH";

  const meta = textNode(
    "Meta",
    { size: META_SIZE, line: META_LINE, style: FONT_STYLES.meta },
    solidFill(1, { r: 0.4078, g: 0.4078, b: 0.4078 }),
    SAMPLE_CONTENT.meta,
    { letterSpacing: -1 }
  );
  meta.resize(textWidth, meta.height);
  meta.layoutGrow = 1;
  meta.layoutAlign = "STRETCH";

  const copy = figma.createFrame();
  copy.name = "Copy";
  copy.layoutMode = "VERTICAL";
  copy.counterAxisSizingMode = "FIXED";
  copy.primaryAxisSizingMode = "AUTO";
  copy.primaryAxisAlignItems = "MAX";
  copy.counterAxisAlignItems = "MIN";
  copy.paddingLeft = copy.paddingRight = 0;
  copy.paddingTop = copy.paddingBottom = 0;
  copy.itemSpacing = CONTENT_GAP;
  copy.fills = [];
  copy.strokes = [];
  copy.effects = [];
  copy.layoutAlign = "STRETCH";
  copy.appendChild(title);
  copy.appendChild(meta);

  const logoNode = logoBadge
    ? makeLogoBadge(SAMPLE_CONTENT.logo)
    : textNode(
        "Logo",
        { size: LOGO_SIZE, line: LOGO_LINE, style: FONT_STYLES.logo },
        solidFill(1),
        SAMPLE_CONTENT.logo,
        { letterSpacing: -1, autoResize: "WIDTH_AND_HEIGHT" }
      );

  card.appendChild(logoNode);
  const logoGroup = figma.group([logoNode], card);
  logoGroup.name = "Logo";
  content.insertChild(0, logoGroup);
  content.appendChild(copy);
  copy.layoutAlign = "STRETCH";
  copy.resize(textWidth, copy.height);

  return component;
}

function assembleNewsWide2x1(name) {
  const { component, card } = createBaseCard2x1(name);
  const left = QUOTE_WIDE_X;
  const right = QUOTE_AUTHOR_RIGHT;
  const baseline = QUOTE_BOTTOM_Y;

  const content = figma.createFrame();
  content.name = "Content";
  content.layoutMode = "NONE";
  content.resize(SIDE_2X1, SIDE);
  content.fills = [];
  content.strokes = [];
  content.effects = [];
  card.appendChild(content);

  const title = textNode(
    "Title",
    { size: NEWS_WIDE_TITLE_SIZE, line: NEWS_WIDE_TITLE_LINE, style: FONT_STYLES.title },
    solidFill(1),
    SAMPLE_CONTENT_2X1.title,
    { letterSpacing: -1 }
  );
  const maxTextWidth = Math.max(0, right - left);
  title.resize(maxTextWidth, title.height);

  const logo = textNode(
    "Logo",
    { size: NEWS_WIDE_LOGO_SIZE, line: LOGO_LINE, style: FONT_STYLES.logo },
    solidFill(1),
    SAMPLE_CONTENT_2X1.logo,
    { letterSpacing: -1, autoResize: "WIDTH_AND_HEIGHT" }
  );

  const meta = textNode(
    "Meta",
    { size: META_SIZE, line: META_LINE, style: FONT_STYLES.meta },
    solidFill(1, { r: 0.4078, g: 0.4078, b: 0.4078 }),
    SAMPLE_CONTENT_2X1.meta,
    { letterSpacing: -1 }
  );
  meta.textAlignHorizontal = "RIGHT";

  const footerHeight = Math.max(logo.height, meta.height);
  const titleTopCandidate = baseline - footerHeight - NEWS_WIDE_GAP - title.height;
  const titleTop = Math.max(NEWS_WIDE_TITLE_Y, titleTopCandidate);
  title.x = left;
  title.y = titleTop;
  title.constraints = { horizontal: "MIN", vertical: "MIN" };

  logo.x = left;
  logo.y = baseline - logo.height;
  logo.constraints = { horizontal: "MIN", vertical: "MAX" };

  meta.x = right - meta.width;
  meta.y = baseline - meta.height;
  meta.constraints = { horizontal: "MAX", vertical: "MAX" };

  content.appendChild(title);
  content.appendChild(logo);
  content.appendChild(meta);

  return component;
}

function assembleQuoteVariant(name, layout) {
  const { component, card } = createBaseCard(name);
  const sample = layout === "center" ? SAMPLE_QUOTES.center : SAMPLE_QUOTES.left;
  const quoteSize = layout === "center" ? QUOTE_CENTER_SIZE : QUOTE_LEFT_SIZE;
  const quoteLine = layout === "center" ? QUOTE_CENTER_LINE : QUOTE_LEFT_LINE;
  const textWidth = SIDE - SAFE * 2;
  const bottomSafe = SIDE - SAFE;

  const content = figma.createFrame();
  content.name = "Content";
  content.layoutMode = "NONE";
  content.resize(SIDE, SIDE);
  content.fills = [];
  content.strokes = [];
  content.effects = [];
  card.appendChild(content);

  const logo = textNode(
    "Logo",
    { size: LOGO_SIZE, line: LOGO_LINE, style: FONT_STYLES.logo },
    solidFill(1),
    sample.logo,
    { letterSpacing: -1 }
  );
  logo.textAlignHorizontal = layout === "center" ? "CENTER" : "LEFT";

  const quote = textNode(
    "Quote",
    { size: quoteSize, line: quoteLine, style: FONT_STYLES.title },
    solidFill(1),
    sample.quote,
    { letterSpacing: -1 }
  );
  quote.resize(textWidth, quote.height);
  quote.textAlignHorizontal = layout === "center" ? "CENTER" : "LEFT";
  quote.layoutAlign = layout === "center" ? "CENTER" : "MIN";

  const authorStack = figma.createFrame();
  authorStack.name = "Author";
  authorStack.layoutMode = "VERTICAL";
  authorStack.counterAxisSizingMode = "AUTO";
  authorStack.primaryAxisSizingMode = "AUTO";
  authorStack.counterAxisAlignItems = layout === "center" ? "CENTER" : "MIN";
  authorStack.primaryAxisAlignItems = "MIN";
  authorStack.itemSpacing = 8;
  authorStack.fills = [];
  authorStack.strokes = [];
  authorStack.effects = [];

  const authorName = textNode(
    "Author",
    { size: QUOTE_AUTHOR_SIZE, line: QUOTE_AUTHOR_LINE, style: FONT_STYLES.logo },
    solidFill(1),
    sample.author,
    { letterSpacing: -1 }
  );
  authorName.textAlignHorizontal = layout === "center" ? "CENTER" : "LEFT";

  const authorRole = textNode(
    "Role",
    { size: QUOTE_ROLE_SIZE, line: QUOTE_ROLE_LINE, style: FONT_STYLES.role },
    solidFill(1, { r: 0.68, g: 0.68, b: 0.68 }),
    sample.role,
    { letterSpacing: -1 }
  );
  authorRole.textAlignHorizontal = layout === "center" ? "CENTER" : "LEFT";

  authorStack.appendChild(authorName);
  authorStack.appendChild(authorRole);
  const authorGroup = authorStack;

  const quoteContainer = figma.createFrame();
  quoteContainer.name = "QuoteContainer";
  quoteContainer.layoutMode = "VERTICAL";
  quoteContainer.counterAxisSizingMode = "FIXED";
  quoteContainer.primaryAxisSizingMode = "FIXED";
  quoteContainer.counterAxisAlignItems = layout === "center" ? "CENTER" : "MIN";
  quoteContainer.primaryAxisAlignItems = "CENTER";
  quoteContainer.paddingTop = quoteContainer.paddingBottom = 0;
  quoteContainer.paddingLeft = quoteContainer.paddingRight = 0;
  quoteContainer.itemSpacing = 0;
  quoteContainer.fills = [];
  quoteContainer.strokes = [];
  quoteContainer.effects = [];
  quoteContainer.appendChild(quote);
  quoteContainer.resize(textWidth, quote.height);
  content.appendChild(logo);
  content.appendChild(quoteContainer);
  content.appendChild(authorGroup);

  // Positioning
  const logoWidth = logo.width;
  const logoHeight = logo.height;
  const quoteHeight = quote.height;
  const authorHeight = authorGroup.height;

  if (layout === "center") {
    logo.x = Math.round((SIDE - logoWidth) / 2);
    logo.y = SAFE;

    authorGroup.x = Math.round((SIDE - authorGroup.width) / 2);
    authorGroup.y = bottomSafe - authorHeight;

    const availableTop = logo.y + logoHeight + LOGO_COPY_GAP;
    const availableBottom = authorGroup.y - LOGO_COPY_GAP;
    const availableSpace = availableBottom - availableTop;
    const containerHeight = availableSpace > 0 ? availableSpace : quoteHeight;

    quoteContainer.resize(textWidth, containerHeight);
    quoteContainer.x = SAFE;
    quoteContainer.y = availableSpace > 0 ? availableTop : availableTop;
  } else {
    logo.x = SAFE;
    logo.y = SAFE;

    authorGroup.x = SAFE;
    authorGroup.y = bottomSafe - authorHeight;

    const quoteAreaTop = logo.y + logoHeight + LOGO_COPY_GAP;
    const quoteAreaBottom = authorGroup.y - LOGO_COPY_GAP;
    const available = quoteAreaBottom - quoteAreaTop;
    const containerHeight = available > 0 ? available : quoteHeight;

    quoteContainer.resize(textWidth, containerHeight);
    quoteContainer.x = SAFE;
    quoteContainer.y = available > 0 ? quoteAreaTop : quoteAreaTop;
  }

  // Constraints to keep relative positioning
  logo.constraints = {
    horizontal: layout === "center" ? "CENTER" : "MIN",
    vertical: "MIN",
  };
  quoteContainer.constraints = {
    horizontal: "MIN",
    vertical: "MIN",
  };
  quote.constraints = {
    horizontal: layout === "center" ? "CENTER" : "MIN",
    vertical: "CENTER",
  };
  authorGroup.constraints = {
    horizontal: layout === "center" ? "CENTER" : "MIN",
    vertical: "MAX",
  };

  return component;
}

function assembleQuoteWide(name) {
  const { component, card } = createBaseCard2x1(name);
  const sample = SAMPLE_QUOTES_2X1.wide;

  const left = QUOTE_WIDE_X;
  const right = QUOTE_AUTHOR_RIGHT;
  const baseline = QUOTE_BOTTOM_Y;

  const content = figma.createFrame();
  content.name = "Content";
  content.layoutMode = "NONE";
  content.resize(SIDE_2X1, SIDE);
  content.fills = [];
  content.strokes = [];
  content.effects = [];
  card.appendChild(content);

  const quote = textNode(
    "Quote",
    { size: QUOTE_WIDE_SIZE, line: QUOTE_WIDE_LINE, style: FONT_STYLES.title },
    solidFill(1),
    sample.quote,
    { letterSpacing: -1 }
  );
  const maxTextWidth = Math.max(0, right - left);
  const quoteWidth = Math.min(QUOTE_WIDE_WIDTH, maxTextWidth);
  quote.resize(quoteWidth, quote.height);
  const quoteHeight = quote.height;

  const logo = textNode(
    "Logo",
    { size: LOGO_WIDE_SIZE, line: LOGO_WIDE_SIZE, style: FONT_STYLES.logo },
    solidFill(1),
    sample.logo,
    { letterSpacing: -2, autoResize: "WIDTH_AND_HEIGHT" }
  );
  const logoHeight = logo.height;

  const maxQuoteTop = baseline - logoHeight - LOGO_WIDE_GAP - quoteHeight;
  const quoteTop = Math.max(QUOTE_WIDE_Y, maxQuoteTop);
  quote.x = left;
  quote.y = quoteTop;
  quote.constraints = { horizontal: "MIN", vertical: "MIN" };

  const logoTop = baseline - logoHeight;
  logo.x = left;
  logo.y = logoTop;
  logo.constraints = { horizontal: "MIN", vertical: "MAX" };

  const authorName = textNode(
    "Author",
    { size: QUOTE_AUTHOR_SIZE, line: QUOTE_AUTHOR_LINE, style: FONT_STYLES.logo },
    solidFill(1),
    sample.author,
    { letterSpacing: -1 }
  );
  authorName.textAlignHorizontal = "RIGHT";

  const authorRole = textNode(
    "Role",
    { size: QUOTE_ROLE_SIZE, line: QUOTE_ROLE_LINE, style: FONT_STYLES.role },
    solidFill(1, { r: 0.68, g: 0.68, b: 0.68 }),
    sample.role,
    { letterSpacing: -1 }
  );
  authorRole.textAlignHorizontal = "RIGHT";

  const authorGroup = figma.createFrame();
  authorGroup.name = "Author";
  authorGroup.layoutMode = "VERTICAL";
  authorGroup.counterAxisSizingMode = "AUTO";
  authorGroup.primaryAxisSizingMode = "AUTO";
  authorGroup.counterAxisAlignItems = "MAX";
  authorGroup.primaryAxisAlignItems = "MIN";
  authorGroup.itemSpacing = QUOTE_AUTHOR_GAP;
  authorGroup.fills = [];
  authorGroup.strokes = [];
  authorGroup.effects = [];
  authorGroup.appendChild(authorName);
  authorGroup.appendChild(authorRole);
  authorGroup.x = right - authorGroup.width;
  authorGroup.y = baseline - authorGroup.height;
  authorGroup.constraints = { horizontal: "MAX", vertical: "MAX" };

  content.appendChild(quote);
  content.appendChild(logo);
  content.appendChild(authorGroup);

  return component;
}

async function main() {
  await loadFonts();

  const a = assembleVariant("A — Logo TL", "TL", false);
  const b = assembleVariant("B — Logo BL", "BL", false);
  const c = assembleVariant("C — Logo Badge", "TL", true);
  const qLeft = assembleQuoteVariant("Quote — Left", "left");
  const qCenter = assembleQuoteVariant("Quote — Center", "center");
  const wideQuote = assembleQuoteWide("Quote 2x1 — Wide");
  const newsWide = assembleNewsWide2x1("News 2x1 — Wide");

  const page = figma.currentPage;
  page.appendChild(a);
  page.appendChild(b);
  page.appendChild(c);
  page.appendChild(qLeft);
  page.appendChild(qCenter);
  page.appendChild(wideQuote);
  page.appendChild(newsWide);

  const previewGap = SAFE * 2;
  b.x = SIDE + previewGap;
  c.x = (SIDE + previewGap) * 2;
  qLeft.x = 0;
  qLeft.y = SIDE + previewGap;
  qCenter.x = SIDE + previewGap;
  qCenter.y = SIDE + previewGap;
  wideQuote.x = 0;
  wideQuote.y = SIDE * 2 + previewGap * 2;
  newsWide.x = SIDE_2X1 + previewGap;
  newsWide.y = wideQuote.y;

  const newsSet = figma.combineAsVariants([a, b, c], figma.currentPage);
  newsSet.name = "News Card / 1:1";
  newsSet.layoutMode = "HORIZONTAL";
  newsSet.counterAxisSizingMode = "AUTO";
  newsSet.primaryAxisSizingMode = "AUTO";
  newsSet.itemSpacing = previewGap;
  newsSet.variantGroupProperties = {
    logo: { values: ["TL", "BL", "Badge"] },
  };

  a.name = "logo=TL";
  b.name = "logo=BL";
  c.name = "logo=Badge";
  newsSet.x = 0;
  newsSet.y = 0;

  const quoteSet = figma.combineAsVariants([qLeft, qCenter], figma.currentPage);
  quoteSet.name = "Quote Card / 1:1";
  quoteSet.layoutMode = "HORIZONTAL";
  quoteSet.counterAxisSizingMode = "AUTO";
  quoteSet.primaryAxisSizingMode = "AUTO";
  quoteSet.itemSpacing = previewGap;
  quoteSet.variantGroupProperties = {
    layout: { values: ["Left", "Center"] },
  };

  qLeft.name = "layout=Left";
  qCenter.name = "layout=Center";
  quoteSet.x = 0;
  quoteSet.y = SIDE + previewGap;

  const wideSet = figma.combineAsVariants([wideQuote], figma.currentPage);
  wideSet.name = "Quote Card / 2x1";
  wideSet.layoutMode = "HORIZONTAL";
  wideSet.counterAxisSizingMode = "AUTO";
  wideSet.primaryAxisSizingMode = "AUTO";
  wideSet.variantGroupProperties = {
    layout: { values: ["Wide"] },
  };
  wideQuote.name = "layout=Wide";
  wideSet.x = 0;
  wideSet.y = SIDE * 2 + previewGap * 2;

  const newsWideSet = figma.combineAsVariants([newsWide], figma.currentPage);
  newsWideSet.name = "News Card / 2x1";
  newsWideSet.layoutMode = "HORIZONTAL";
  newsWideSet.counterAxisSizingMode = "AUTO";
  newsWideSet.primaryAxisSizingMode = "AUTO";
  newsWideSet.variantGroupProperties = {
    layout: { values: ["Wide"] },
  };
  newsWide.name = "layout=Wide";
  newsWideSet.x = SIDE_2X1 + previewGap;
  newsWideSet.y = SIDE * 2 + previewGap * 2;

  figma.viewport.scrollAndZoomIntoView([newsSet, quoteSet, wideSet, newsWideSet]);
  figma.closePlugin("Созданы наборы: News A/B/C, Quote Left/Center, Quote 2x1 и News 2x1");
}

main();
