/**
 * Tests that the package exports all expected symbols.
 */
import { describe, it, expect } from "vitest";
import * as terminalUi from "../index.js";

describe("Package Exports", () => {
  it("exports Timeline component", () => {
    expect(terminalUi.Timeline).toBeDefined();
  });

  it("exports all sub-components", () => {
    expect(terminalUi.UserMessage).toBeDefined();
    expect(terminalUi.AssistantMessage).toBeDefined();
    expect(terminalUi.ThinkingBlock).toBeDefined();
    expect(terminalUi.ToolCall).toBeDefined();
    expect(terminalUi.PermissionRequest).toBeDefined();
    expect(terminalUi.ErrorBlock).toBeDefined();
    expect(terminalUi.SystemNotification).toBeDefined();
    expect(terminalUi.CompactNotification).toBeDefined();
    expect(terminalUi.UsageUpdate).toBeDefined();
  });

  it("exports ToolCall sub-variant components", () => {
    expect(terminalUi.ReadTool).toBeDefined();
    expect(terminalUi.EditTool).toBeDefined();
    expect(terminalUi.WriteTool).toBeDefined();
    expect(terminalUi.BashTool).toBeDefined();
    expect(terminalUi.GlobTool).toBeDefined();
    expect(terminalUi.GrepTool).toBeDefined();
    expect(terminalUi.WebFetchTool).toBeDefined();
    expect(terminalUi.TaskTool).toBeDefined();
  });

  it("exports hooks", () => {
    expect(terminalUi.useSession).toBeDefined();
    expect(terminalUi.useTimeline).toBeDefined();
    expect(terminalUi.useVoice).toBeDefined();
  });

  it("exports theme utilities", () => {
    expect(terminalUi.themeColorsToCssVars).toBeDefined();
    expect(terminalUi.syntaxThemeToCssVars).toBeDefined();
    expect(terminalUi.themeToCssVars).toBeDefined();
    expect(terminalUi.getToolColorVar).toBeDefined();
  });

  it("exports normalization utilities", () => {
    expect(terminalUi.normalizeGCEvent).toBeDefined();
    expect(terminalUi.normalizeSDKEvent).toBeDefined();
    expect(terminalUi.mergeIntoTimeline).toBeDefined();
  });

  it("exports syntax highlighting utilities", () => {
    expect(terminalUi.detectLanguage).toBeDefined();
    expect(terminalUi.tokenize).toBeDefined();
    expect(terminalUi.tokenTypeToCssVar).toBeDefined();
  });

  it("exports type guards", () => {
    expect(terminalUi.isUserMessage).toBeDefined();
    expect(terminalUi.isAssistantMessage).toBeDefined();
    expect(terminalUi.isThinkingBlock).toBeDefined();
    expect(terminalUi.isToolCall).toBeDefined();
    expect(terminalUi.isPermissionRequest).toBeDefined();
    expect(terminalUi.isPermissionResolved).toBeDefined();
    expect(terminalUi.isErrorItem).toBeDefined();
    expect(terminalUi.isSystemNotification).toBeDefined();
    expect(terminalUi.isCompactNotification).toBeDefined();
    expect(terminalUi.isUsageUpdate).toBeDefined();
  });

  it("exports theme constants", () => {
    expect(terminalUi.DARK_THEME).toBeDefined();
    expect(terminalUi.LIGHT_THEME).toBeDefined();
  });
});
