/**
 * Tests for useVoice hook.
 *
 * Since Web Speech API is not available in Node.js test environment,
 * we test the hook's behavior when SpeechRecognition is unavailable
 * and when mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock React hooks for testing outside a component
const mockState: Record<string, unknown> = {};
let stateCounter = 0;
const mockRefs: Record<string, { current: unknown }> = {};
let refCounter = 0;

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const key = `state_${stateCounter++}`;
    if (!(key in mockState)) {
      mockState[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    return [mockState[key], (val: unknown) => { mockState[key] = typeof val === "function" ? (val as (prev: unknown) => unknown)(mockState[key]) : val; }];
  },
  useRef: (initial: unknown) => {
    const key = `ref_${refCounter++}`;
    if (!(key in mockRefs)) {
      mockRefs[key] = { current: initial };
    }
    return mockRefs[key];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => (() => void) | void) => {
    // Execute the effect immediately in tests
    fn();
  },
}));

describe("useVoice", () => {
  beforeEach(() => {
    stateCounter = 0;
    refCounter = 0;
    Object.keys(mockState).forEach((key) => delete mockState[key]);
    Object.keys(mockRefs).forEach((key) => delete mockRefs[key]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports unsupported when SpeechRecognition is not available", async () => {
    // Import fresh to get clean state
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice();
    expect(result.isSupported).toBe(false);
    expect(result.state).toBe("unsupported");
  });

  it("returns expected API shape", async () => {
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice();
    expect(typeof result.startRecording).toBe("function");
    expect(typeof result.stopRecording).toBe("function");
    expect(typeof result.cancelRecording).toBe("function");
    expect(typeof result.partialTranscript).toBe("string");
    expect(typeof result.finalTranscript).toBe("string");
    expect(result.error).toBeNull();
  });

  it("startRecording is a no-op when unsupported", async () => {
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice();
    // Should not throw
    result.startRecording();
    expect(result.state).toBe("unsupported");
  });

  it("accepts language option", async () => {
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice({ language: "ar-SA" });
    expect(result.isSupported).toBe(false); // Still unsupported in test env
  });

  it("accepts silenceTimeout option", async () => {
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice({ silenceTimeout: 5000 });
    expect(result.isSupported).toBe(false);
  });

  it("accepts maxDuration option", async () => {
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice({ maxDuration: 120000 });
    expect(result.isSupported).toBe(false);
  });

  it("stopRecording is a no-op when unsupported", async () => {
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice();
    result.stopRecording();
    // No error
  });

  it("cancelRecording is a no-op when unsupported", async () => {
    const { useVoice } = await import("../hooks/useVoice.js");
    const result = useVoice();
    result.cancelRecording();
    // No error
  });
});
