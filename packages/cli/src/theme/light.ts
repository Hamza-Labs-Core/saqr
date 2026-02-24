/**
 * Light theme constant with all color values from the Story 02 spec.
 *
 * @module theme/light
 */

import type { AppTheme } from "./types.js";
import { LIGHT_SYNTAX_THEME } from "./syntax.js";

/**
 * Complete light theme specification.
 */
export const LIGHT_THEME: AppTheme = {
  mode: "light",
  colors: {
    background: "#FFFFFF",
    surface: "#F6F8FA",
    cardBg: "#FFFFFF",
    footerBg: "#F6F8FA",
    textPrimary: "#24292F",
    textSecondary: "#57606A",
    muted: "#8B949E",
    userBubble: "#E8EAED",
    userText: "#24292F",
    assistantBubble: "#FFFFFF",
    assistantText: "#24292F",
    success: "#1A7F37",
    warning: "#9A6700",
    error: "#CF222E",
    info: "#0969DA",
    toolRead: "#0969DA",
    toolEdit: "#9A6700",
    toolWrite: "#1A7F37",
    toolBash: "#8250DF",
    toolSearch: "#BF3989",
    toolWebFetch: "#0969DA",
    toolTask: "#BC4C00",
    thinkingBg: "#F5F5F7",
    thinkingText: "#57606A",
    permissionBg: "#FFF8E1",
    errorBg: "#FFF0F0",
    codeBlockBg: "#F6F8FA",
    diffAddedBg: "#E6FFEC",
    diffRemovedBg: "#FFE6E6",
    tableRowAlt: "#F6F8FA",
    taskNesting: rgba("#BC4C00", 0.15),
    scrubberBg: "#F6F8FA",
    searchHighlight: "#FFF2C5",
    border: "#D0D7DE",
    borderActive: "#0969DA",
  },
  syntax: LIGHT_SYNTAX_THEME,
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
