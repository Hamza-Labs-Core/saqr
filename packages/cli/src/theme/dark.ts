/**
 * Dark theme constant with all color values from the Story 02 spec.
 *
 * @module theme/dark
 */

import type { AppTheme } from "./types.js";
import { DARK_SYNTAX_THEME } from "./syntax.js";

/**
 * Complete dark theme specification.
 */
export const DARK_THEME: AppTheme = {
  mode: "dark",
  colors: {
    background: "#0D1117",
    surface: "#161B22",
    cardBg: "#1C1F2E",
    footerBg: "#0D1117",
    textPrimary: "#C9D1D9",
    textSecondary: "#8B949E",
    muted: "#6E7681",
    userBubble: "#2A2D3E",
    userText: "#E6EDF3",
    assistantBubble: "#1A1D2E",
    assistantText: "#C9D1D9",
    success: "#34D399",
    warning: "#FBBF24",
    error: "#EF4444",
    info: "#60A5FA",
    toolRead: "#60A5FA",
    toolEdit: "#FBBF24",
    toolWrite: "#34D399",
    toolBash: "#A78BFA",
    toolSearch: "#F472B6",
    toolWebFetch: "#38BDF8",
    toolTask: "#FB923C",
    thinkingBg: "#1E1E2E",
    thinkingText: "#8B949E",
    permissionBg: "#2E2A1A",
    errorBg: "#2E1A1A",
    codeBlockBg: "#161B22",
    diffAddedBg: "#1A3A2A",
    diffRemovedBg: "#3A1A1A",
    tableRowAlt: "#161B22",
    taskNesting: rgba("#FB923C", 0.3),
    scrubberBg: "#161B22",
    searchHighlight: "#FBBF24",
    border: "#30363D",
    borderActive: "#58A6FF",
  },
  syntax: DARK_SYNTAX_THEME,
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },
  typography: {
    fontSizeXs: 10,
    fontSizeSm: 12,
    fontSizeMd: 14,
    fontSizeLg: 16,
    fontSizeXl: 20,
    fontFamilyMono: "JetBrains Mono, SF Mono, Fira Code, monospace",
    fontFamilySystem: "SF Pro, Roboto, system-ui, sans-serif",
  },
};

function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
