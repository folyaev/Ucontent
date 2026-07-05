export type QuoteVariant = 'editorial' | 'source-led' | 'minimal';

export type CardType = 'news' | 'quote';

export type CardLayout = 'TL' | 'BL' | 'Badge' | 'Left' | 'Center' | 'Wide';

export type QuoteVideoProps = {
  // Types and Layouts matching Figma options
  type?: CardType;
  layout?: CardLayout;
  
  // Backwards compatibility with previous schema
  variant?: QuoteVariant;
  
  transparent?: boolean;
  
  // Content fields
  source?: string; // Logo text (Figma logo / source)
  logo?: string;   // Alias for source
  
  quote?: string;  // Quote text (Figma quote / title)
  title?: string;  // Alias for quote
  
  author?: string; // Author name
  role?: string;   // Author role
  avatar?: string; // Author photo / avatar URL or path
  
  date?: string;   // Date (Figma meta / date)
  meta?: string;   // Alias for date
  
  label?: string;
  accent?: string;
  textScale?: number; // Multiplier for title / quote typography
  logoIcon?: string; // Logo icon URL or path or special keyword
  showDecorativeQuote?: boolean; // Whether to render the background decorative quote mark
  
  background?: {
    image?: string;
    video?: string;
    blur?: number;
    dim?: number;
  };
};
