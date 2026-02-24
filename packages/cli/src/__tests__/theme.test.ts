/**
 * Tests for the Theme System.
 *
 * Validates that dark and light themes contain all required color keys,
 * spacing values, typography settings, and syntax highlighting colors.
 */
import { describe, it, expect } from "vitest";
import type {
  AppTheme,
  ThemeColors,
  SyntaxTheme,
  ThemeSpacing,
  ThemeTypography,
} from "../theme/types.js";
import { DARK_THEME, LIGHT_THEME } from "../theme/index.js";
import { DARK_SYNTAX_THEME, LIGHT_SYNTAX_THEME } from "../theme/syntax.js";

// ---------------------------------------------------------------------------
// Required keys
// ---------------------------------------------------------------------------

const REQUIRED_COLOR_KEYS: (keyof ThemeColors)[] = [
  "background",
  "surface",
  "cardBg",
  "footerBg",
  "textPrimary",
  "textSecondary",
  "muted",
  "userBubble",
  "userText",
  "assistantBubble",
  "assistantText",
  "success",
  "warning",
  "error",
  "info",
  "toolRead",
  "toolEdit",
  "toolWrite",
  "toolBash",
  "toolSearch",
  "toolWebFetch",
  "toolTask",
  "thinkingBg",
  "thinkingText",
  "permissionBg",
  "errorBg",
  "codeBlockBg",
  "diffAddedBg",
  "diffRemovedBg",
  "tableRowAlt",
  "taskNesting",
  "scrubberBg",
  "searchHighlight",
  "border",
  "borderActive",
];

const REQUIRED_SYNTAX_KEYS: (keyof SyntaxTheme)[] = [
  "keyword",
  "string",
  "number",
  "comment",
  "function",
  "variable",
  "type",
  "operator",
  "punctuation",
  "tag",
  "attribute",
  "regexp",
  "constant",
  "builtin",
  "className",
  "property",
];

// ---------------------------------------------------------------------------
// DARK_THEME
// ---------------------------------------------------------------------------

describe("DARK_THEME", () => {
  it("has mode set to 'dark'", () => {
    expect(DARK_THEME.mode).toBe("dark");
  });

  it("contains all required ThemeColors keys", () => {
    for (const key of REQUIRED_COLOR_KEYS) {
      expect(DARK_THEME.colors).toHaveProperty(key);
      expect(typeof DARK_THEME.colors[key]).toBe("string");
      expect(DARK_THEME.colors[key].length).toBeGreaterThan(0);
    }
  });

  it("has correct background color from spec", () => {
    expect(DARK_THEME.colors.background).toBe("#0D1117");
  });

  it("has correct user bubble color from spec", () => {
    expect(DARK_THEME.colors.userBubble).toBe("#2A2D3E");
  });

  it("has correct assistant bubble color from spec", () => {
    expect(DARK_THEME.colors.assistantBubble).toBe("#1A1D2E");
  });

  it("has correct error background color from spec", () => {
    expect(DARK_THEME.colors.errorBg).toBe("#2E1A1A");
  });

  it("has correct permission background color from spec", () => {
    expect(DARK_THEME.colors.permissionBg).toBe("#2E2A1A");
  });

  it("contains all spacing values", () => {
    expect(typeof DARK_THEME.spacing.xs).toBe("number");
    expect(typeof DARK_THEME.spacing.sm).toBe("number");
    expect(typeof DARK_THEME.spacing.md).toBe("number");
    expect(typeof DARK_THEME.spacing.lg).toBe("number");
    expect(typeof DARK_THEME.spacing.xl).toBe("number");
    expect(typeof DARK_THEME.spacing.xxl).toBe("number");
  });

  it("contains all typography settings", () => {
    expect(typeof DARK_THEME.typography.fontSizeXs).toBe("number");
    expect(typeof DARK_THEME.typography.fontSizeSm).toBe("number");
    expect(typeof DARK_THEME.typography.fontSizeMd).toBe("number");
    expect(typeof DARK_THEME.typography.fontSizeLg).toBe("number");
    expect(typeof DARK_THEME.typography.fontSizeXl).toBe("number");
    expect(typeof DARK_THEME.typography.fontFamilyMono).toBe("string");
    expect(typeof DARK_THEME.typography.fontFamilySystem).toBe("string");
  });

  it("contains syntax theme", () => {
    expect(DARK_THEME.syntax).toBeDefined();
    for (const key of REQUIRED_SYNTAX_KEYS) {
      expect(DARK_THEME.syntax).toHaveProperty(key);
      expect(typeof DARK_THEME.syntax[key]).toBe("string");
    }
  });

  it("all color values are valid hex colors or rgba", () => {
    const hexOrRgba = /^(#[0-9a-fA-F]{3,8}|rgba?\(\d+,\s*\d+,\s*\d+,?\s*[\d.]*\))$/;
    for (const [key, value] of Object.entries(DARK_THEME.colors)) {
      expect(value).toMatch(hexOrRgba);
    }
  });
});

// ---------------------------------------------------------------------------
// LIGHT_THEME
// ---------------------------------------------------------------------------

describe("LIGHT_THEME", () => {
  it("has mode set to 'light'", () => {
    expect(LIGHT_THEME.mode).toBe("light");
  });

  it("contains all required ThemeColors keys", () => {
    for (const key of REQUIRED_COLOR_KEYS) {
      expect(LIGHT_THEME.colors).toHaveProperty(key);
      expect(typeof LIGHT_THEME.colors[key]).toBe("string");
      expect(LIGHT_THEME.colors[key].length).toBeGreaterThan(0);
    }
  });

  it("has correct background color from spec", () => {
    expect(LIGHT_THEME.colors.background).toBe("#FFFFFF");
  });

  it("has correct user bubble color from spec", () => {
    expect(LIGHT_THEME.colors.userBubble).toBe("#E8EAED");
  });

  it("has correct error background color from spec", () => {
    expect(LIGHT_THEME.colors.errorBg).toBe("#FFF0F0");
  });

  it("has correct permission background color from spec", () => {
    expect(LIGHT_THEME.colors.permissionBg).toBe("#FFF8E1");
  });

  it("dark and light themes have the same set of color keys", () => {
    const darkKeys = Object.keys(DARK_THEME.colors).sort();
    const lightKeys = Object.keys(LIGHT_THEME.colors).sort();
    expect(darkKeys).toEqual(lightKeys);
  });

  it("dark and light themes have different color values where expected", () => {
    expect(DARK_THEME.colors.background).not.toBe(LIGHT_THEME.colors.background);
    expect(DARK_THEME.colors.textPrimary).not.toBe(LIGHT_THEME.colors.textPrimary);
    expect(DARK_THEME.colors.surface).not.toBe(LIGHT_THEME.colors.surface);
  });

  it("all color values are valid hex colors or rgba", () => {
    const hexOrRgba = /^(#[0-9a-fA-F]{3,8}|rgba?\(\d+,\s*\d+,\s*\d+,?\s*[\d.]*\))$/;
    for (const [key, value] of Object.entries(LIGHT_THEME.colors)) {
      expect(value).toMatch(hexOrRgba);
    }
  });
});

// ---------------------------------------------------------------------------
// Syntax Themes
// ---------------------------------------------------------------------------

describe("Syntax Themes", () => {
  it("DARK_SYNTAX_THEME has all required token keys", () => {
    for (const key of REQUIRED_SYNTAX_KEYS) {
      expect(DARK_SYNTAX_THEME).toHaveProperty(key);
      expect(typeof DARK_SYNTAX_THEME[key]).toBe("string");
    }
  });

  it("LIGHT_SYNTAX_THEME has all required token keys", () => {
    for (const key of REQUIRED_SYNTAX_KEYS) {
      expect(LIGHT_SYNTAX_THEME).toHaveProperty(key);
      expect(typeof LIGHT_SYNTAX_THEME[key]).toBe("string");
    }
  });

  it("dark and light syntax themes have different keyword colors", () => {
    expect(DARK_SYNTAX_THEME.keyword).not.toBe(LIGHT_SYNTAX_THEME.keyword);
  });

  it("syntax themes have the same keys", () => {
    const darkKeys = Object.keys(DARK_SYNTAX_THEME).sort();
    const lightKeys = Object.keys(LIGHT_SYNTAX_THEME).sort();
    expect(darkKeys).toEqual(lightKeys);
  });
});

// ---------------------------------------------------------------------------
// AppTheme structural validation
// ---------------------------------------------------------------------------

describe("AppTheme structure", () => {
  const themes: Array<[string, AppTheme]> = [
    ["DARK_THEME", DARK_THEME],
    ["LIGHT_THEME", LIGHT_THEME],
  ];

  it.each(themes)("%s has spacing values in ascending order", (_name, theme) => {
    expect(theme.spacing.xs).toBeLessThan(theme.spacing.sm);
    expect(theme.spacing.sm).toBeLessThan(theme.spacing.md);
    expect(theme.spacing.md).toBeLessThan(theme.spacing.lg);
    expect(theme.spacing.lg).toBeLessThan(theme.spacing.xl);
    expect(theme.spacing.xl).toBeLessThan(theme.spacing.xxl);
  });

  it.each(themes)("%s has font sizes in ascending order", (_name, theme) => {
    expect(theme.typography.fontSizeXs).toBeLessThan(theme.typography.fontSizeSm);
    expect(theme.typography.fontSizeSm).toBeLessThan(theme.typography.fontSizeMd);
    expect(theme.typography.fontSizeMd).toBeLessThan(theme.typography.fontSizeLg);
    expect(theme.typography.fontSizeLg).toBeLessThan(theme.typography.fontSizeXl);
  });

  it.each(themes)("%s spacing and typography are the same across themes", (_name, _theme) => {
    // Both themes should share the same spacing and typography
    expect(DARK_THEME.spacing).toEqual(LIGHT_THEME.spacing);
    expect(DARK_THEME.typography).toEqual(LIGHT_THEME.typography);
  });
});
