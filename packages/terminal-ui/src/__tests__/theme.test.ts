/**
 * Tests for theme utilities — CSS variable mapping.
 */
import { describe, it, expect } from "vitest";
import { themeColorsToCssVars, syntaxThemeToCssVars, themeToCssVars, getToolColorVar } from "../theme.js";
import { DARK_THEME, LIGHT_THEME } from "../types.js";

describe("themeColorsToCssVars", () => {
  it("maps all 35 color keys to CSS variables", () => {
    const vars = themeColorsToCssVars(DARK_THEME.colors);
    expect(Object.keys(vars)).toHaveLength(35);
    expect(vars["--saqr-bg"]).toBe("#0D1117");
    expect(vars["--saqr-surface"]).toBe("#161B22");
    expect(vars["--saqr-text-primary"]).toBe("#C9D1D9");
    expect(vars["--saqr-error"]).toBe("#EF4444");
    expect(vars["--saqr-tool-read"]).toBe("#60A5FA");
    expect(vars["--saqr-tool-bash"]).toBe("#A78BFA");
  });

  it("maps light theme colors", () => {
    const vars = themeColorsToCssVars(LIGHT_THEME.colors);
    expect(vars["--saqr-bg"]).not.toBe("#0D1117");
  });
});

describe("syntaxThemeToCssVars", () => {
  it("maps all 16 syntax token keys", () => {
    const vars = syntaxThemeToCssVars(DARK_THEME.syntax);
    expect(Object.keys(vars)).toHaveLength(16);
    expect(vars["--saqr-syn-keyword"]).toBeDefined();
    expect(vars["--saqr-syn-string"]).toBeDefined();
    expect(vars["--saqr-syn-comment"]).toBeDefined();
    expect(vars["--saqr-syn-property"]).toBeDefined();
  });
});

describe("themeToCssVars", () => {
  it("includes colors, syntax, spacing, and typography", () => {
    const vars = themeToCssVars(DARK_THEME);
    // 35 colors + 16 syntax + 6 spacing + 7 typography = 64
    expect(Object.keys(vars).length).toBeGreaterThanOrEqual(64);

    // Spacing
    expect(vars["--saqr-space-xs"]).toBe("4px");
    expect(vars["--saqr-space-md"]).toBe("16px");

    // Typography
    expect(vars["--saqr-font-md"]).toBe("14px");
    expect(vars["--saqr-font-mono"]).toContain("JetBrains Mono");
  });
});

describe("getToolColorVar", () => {
  it("returns correct CSS variable for each tool", () => {
    expect(getToolColorVar("Read")).toBe("var(--saqr-tool-read)");
    expect(getToolColorVar("Edit")).toBe("var(--saqr-tool-edit)");
    expect(getToolColorVar("Write")).toBe("var(--saqr-tool-write)");
    expect(getToolColorVar("Bash")).toBe("var(--saqr-tool-bash)");
    expect(getToolColorVar("Glob")).toBe("var(--saqr-tool-search)");
    expect(getToolColorVar("Grep")).toBe("var(--saqr-tool-search)");
    expect(getToolColorVar("WebFetch")).toBe("var(--saqr-tool-webfetch)");
    expect(getToolColorVar("Task")).toBe("var(--saqr-tool-task)");
  });

  it("returns muted for unknown tools", () => {
    expect(getToolColorVar("Unknown")).toBe("var(--saqr-muted)");
  });
});
