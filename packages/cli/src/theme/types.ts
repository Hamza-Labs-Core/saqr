/**
 * Theme type definitions for the CLI Session Rendering system.
 *
 * @module theme/types
 */

/**
 * Complete theme colors specification.
 * Every color key is used by at least one rendering component.
 */
export interface ThemeColors {
  background: string;
  surface: string;
  cardBg: string;
  footerBg: string;
  textPrimary: string;
  textSecondary: string;
  muted: string;
  userBubble: string;
  userText: string;
  assistantBubble: string;
  assistantText: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  toolRead: string;
  toolEdit: string;
  toolWrite: string;
  toolBash: string;
  toolSearch: string;
  toolWebFetch: string;
  toolTask: string;
  thinkingBg: string;
  thinkingText: string;
  permissionBg: string;
  errorBg: string;
  codeBlockBg: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  tableRowAlt: string;
  taskNesting: string;
  scrubberBg: string;
  searchHighlight: string;
  border: string;
  borderActive: string;
}

/**
 * Syntax highlighting token colors.
 */
export interface SyntaxTheme {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  variable: string;
  type: string;
  operator: string;
  punctuation: string;
  tag: string;
  attribute: string;
  regexp: string;
  constant: string;
  builtin: string;
  className: string;
  property: string;
}

/**
 * Spacing scale for consistent layout.
 */
export interface ThemeSpacing {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

/**
 * Typography settings.
 */
export interface ThemeTypography {
  fontSizeXs: number;
  fontSizeSm: number;
  fontSizeMd: number;
  fontSizeLg: number;
  fontSizeXl: number;
  fontFamilyMono: string;
  fontFamilySystem: string;
}

/**
 * Complete application theme combining all design tokens.
 */
export interface AppTheme {
  mode: "dark" | "light";
  colors: ThemeColors;
  syntax: SyntaxTheme;
  spacing: ThemeSpacing;
  typography: ThemeTypography;
}
