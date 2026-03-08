/**
 * Theme utilities — maps CLI AppTheme to CSS custom properties.
 */
import type { AppTheme, ThemeColors, SyntaxTheme } from "@saqr/cli/theme";

/**
 * Map a CLI ThemeColors object to a record of CSS custom property names → values.
 */
export function themeColorsToCssVars(colors: ThemeColors): Record<string, string> {
  return {
    "--saqr-bg": colors.background,
    "--saqr-surface": colors.surface,
    "--saqr-card-bg": colors.cardBg,
    "--saqr-footer-bg": colors.footerBg,
    "--saqr-text-primary": colors.textPrimary,
    "--saqr-text-secondary": colors.textSecondary,
    "--saqr-muted": colors.muted,
    "--saqr-user-bubble": colors.userBubble,
    "--saqr-user-text": colors.userText,
    "--saqr-assistant-bubble": colors.assistantBubble,
    "--saqr-assistant-text": colors.assistantText,
    "--saqr-success": colors.success,
    "--saqr-warning": colors.warning,
    "--saqr-error": colors.error,
    "--saqr-info": colors.info,
    "--saqr-tool-read": colors.toolRead,
    "--saqr-tool-edit": colors.toolEdit,
    "--saqr-tool-write": colors.toolWrite,
    "--saqr-tool-bash": colors.toolBash,
    "--saqr-tool-search": colors.toolSearch,
    "--saqr-tool-webfetch": colors.toolWebFetch,
    "--saqr-tool-task": colors.toolTask,
    "--saqr-thinking-bg": colors.thinkingBg,
    "--saqr-thinking-text": colors.thinkingText,
    "--saqr-permission-bg": colors.permissionBg,
    "--saqr-error-bg": colors.errorBg,
    "--saqr-code-block-bg": colors.codeBlockBg,
    "--saqr-diff-added-bg": colors.diffAddedBg,
    "--saqr-diff-removed-bg": colors.diffRemovedBg,
    "--saqr-table-row-alt": colors.tableRowAlt,
    "--saqr-task-nesting": colors.taskNesting,
    "--saqr-scrubber-bg": colors.scrubberBg,
    "--saqr-search-highlight": colors.searchHighlight,
    "--saqr-border": colors.border,
    "--saqr-border-active": colors.borderActive,
  };
}

/**
 * Map a CLI SyntaxTheme to CSS custom properties.
 */
export function syntaxThemeToCssVars(syntax: SyntaxTheme): Record<string, string> {
  return {
    "--saqr-syn-keyword": syntax.keyword,
    "--saqr-syn-string": syntax.string,
    "--saqr-syn-number": syntax.number,
    "--saqr-syn-comment": syntax.comment,
    "--saqr-syn-function": syntax.function,
    "--saqr-syn-variable": syntax.variable,
    "--saqr-syn-type": syntax.type,
    "--saqr-syn-operator": syntax.operator,
    "--saqr-syn-punctuation": syntax.punctuation,
    "--saqr-syn-tag": syntax.tag,
    "--saqr-syn-attribute": syntax.attribute,
    "--saqr-syn-regexp": syntax.regexp,
    "--saqr-syn-constant": syntax.constant,
    "--saqr-syn-builtin": syntax.builtin,
    "--saqr-syn-classname": syntax.className,
    "--saqr-syn-property": syntax.property,
  };
}

/**
 * Convert a full AppTheme to a record of all CSS custom properties.
 */
export function themeToCssVars(theme: AppTheme): Record<string, string> {
  return {
    ...themeColorsToCssVars(theme.colors),
    ...syntaxThemeToCssVars(theme.syntax),
    "--saqr-space-xs": `${theme.spacing.xs}px`,
    "--saqr-space-sm": `${theme.spacing.sm}px`,
    "--saqr-space-md": `${theme.spacing.md}px`,
    "--saqr-space-lg": `${theme.spacing.lg}px`,
    "--saqr-space-xl": `${theme.spacing.xl}px`,
    "--saqr-space-xxl": `${theme.spacing.xxl}px`,
    "--saqr-font-xs": `${theme.typography.fontSizeXs}px`,
    "--saqr-font-sm": `${theme.typography.fontSizeSm}px`,
    "--saqr-font-md": `${theme.typography.fontSizeMd}px`,
    "--saqr-font-lg": `${theme.typography.fontSizeLg}px`,
    "--saqr-font-xl": `${theme.typography.fontSizeXl}px`,
    "--saqr-font-mono": theme.typography.fontFamilyMono,
    "--saqr-font-system": theme.typography.fontFamilySystem,
  };
}

/**
 * Get the CSS custom property name for a tool color.
 */
export function getToolColorVar(toolName: string): string {
  const map: Record<string, string> = {
    Read: "var(--saqr-tool-read)",
    Edit: "var(--saqr-tool-edit)",
    Write: "var(--saqr-tool-write)",
    Bash: "var(--saqr-tool-bash)",
    Glob: "var(--saqr-tool-search)",
    Grep: "var(--saqr-tool-search)",
    WebFetch: "var(--saqr-tool-webfetch)",
    Task: "var(--saqr-tool-task)",
  };
  return map[toolName] ?? "var(--saqr-muted)";
}
