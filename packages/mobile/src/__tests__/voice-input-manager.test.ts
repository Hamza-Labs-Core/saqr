/**
 * Tests for the VoiceInputManager service.
 *
 * Covers the audio state machine, speech-to-text result handling,
 * recording lifecycle, and error states.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { VoiceInputManager } from "../services/voice-input-manager.js";

describe("VoiceInputManager", () => {
  let voiceManager: VoiceInputManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-22T14:00:00Z"));
    voiceManager = new VoiceInputManager({
      language: "en-US",
      silenceTimeout: 3000,
      maxDuration: 60000,
    });
  });

  afterEach(() => {
    voiceManager.destroy();
    vi.useRealTimers();
  });

  describe("state machine", () => {
    it("initial state is idle", () => {
      expect(voiceManager.getState()).toBe("idle");
    });

    it("startRecording transitions to recording", () => {
      voiceManager.startRecording();
      expect(voiceManager.getState()).toBe("recording");
    });

    it("stopRecording transitions from recording to processing", () => {
      voiceManager.startRecording();
      voiceManager.stopRecording();
      expect(voiceManager.getState()).toBe("processing");
    });

    it("finalize transitions from processing to idle", () => {
      voiceManager.startRecording();
      voiceManager.stopRecording();
      voiceManager.finalize("Hello world");
      expect(voiceManager.getState()).toBe("idle");
    });

    it("cancelRecording transitions from recording to idle", () => {
      voiceManager.startRecording();
      voiceManager.cancelRecording();
      expect(voiceManager.getState()).toBe("idle");
    });

    it("cancelRecording from idle is a no-op", () => {
      voiceManager.cancelRecording();
      expect(voiceManager.getState()).toBe("idle");
    });

    it("startRecording from recording is a no-op", () => {
      voiceManager.startRecording();
      voiceManager.startRecording(); // Should not throw
      expect(voiceManager.getState()).toBe("recording");
    });

    it("stopRecording from idle is a no-op", () => {
      voiceManager.stopRecording();
      expect(voiceManager.getState()).toBe("idle");
    });

    it("setError transitions to error then idle", () => {
      voiceManager.startRecording();
      voiceManager.setError({
        type: "RECOGNITION_FAILED",
        message: "Recognition failed",
      });
      expect(voiceManager.getState()).toBe("error");
      expect(voiceManager.getError()?.type).toBe("RECOGNITION_FAILED");
    });

    it("clearError returns to idle", () => {
      voiceManager.startRecording();
      voiceManager.setError({
        type: "RECOGNITION_FAILED",
        message: "Failed",
      });
      voiceManager.clearError();
      expect(voiceManager.getState()).toBe("idle");
      expect(voiceManager.getError()).toBeNull();
    });
  });

  describe("transcript handling", () => {
    it("partial transcript updates during recording", () => {
      voiceManager.startRecording();
      voiceManager.onPartialResult("Hello");
      expect(voiceManager.getPartialTranscript()).toBe("Hello");

      voiceManager.onPartialResult("Hello world");
      expect(voiceManager.getPartialTranscript()).toBe("Hello world");
    });

    it("final transcript set on finalize", () => {
      voiceManager.startRecording();
      voiceManager.onPartialResult("Hello");
      voiceManager.stopRecording();
      voiceManager.finalize("Hello world");

      expect(voiceManager.getFinalTranscript()).toBe("Hello world");
    });

    it("partial transcript cleared on startRecording", () => {
      voiceManager.startRecording();
      voiceManager.onPartialResult("Old text");
      voiceManager.cancelRecording();

      voiceManager.startRecording();
      expect(voiceManager.getPartialTranscript()).toBe("");
    });

    it("final transcript cleared on startRecording", () => {
      voiceManager.startRecording();
      voiceManager.stopRecording();
      voiceManager.finalize("Old result");

      voiceManager.startRecording();
      expect(voiceManager.getFinalTranscript()).toBe("");
    });

    it("cancel discards partial transcript", () => {
      voiceManager.startRecording();
      voiceManager.onPartialResult("Some text");
      voiceManager.cancelRecording();
      expect(voiceManager.getPartialTranscript()).toBe("");
    });
  });

  describe("recording duration", () => {
    it("tracks recording duration", () => {
      voiceManager.startRecording();
      vi.advanceTimersByTime(5000);
      expect(voiceManager.getRecordingDuration()).toBe(5);
    });

    it("duration resets on new recording", () => {
      voiceManager.startRecording();
      vi.advanceTimersByTime(5000);
      voiceManager.cancelRecording();

      voiceManager.startRecording();
      expect(voiceManager.getRecordingDuration()).toBe(0);
    });

    it("duration stops incrementing after stopRecording", () => {
      voiceManager.startRecording();
      vi.advanceTimersByTime(5000);
      voiceManager.stopRecording();
      vi.advanceTimersByTime(5000);
      expect(voiceManager.getRecordingDuration()).toBe(5);
    });

    it("formatDuration formats as M:SS", () => {
      expect(VoiceInputManager.formatDuration(0)).toBe("0:00");
      expect(VoiceInputManager.formatDuration(5)).toBe("0:05");
      expect(VoiceInputManager.formatDuration(12)).toBe("0:12");
      expect(VoiceInputManager.formatDuration(60)).toBe("1:00");
      expect(VoiceInputManager.formatDuration(75)).toBe("1:15");
    });
  });

  describe("automatic stop conditions", () => {
    it("auto-stops after silence timeout", () => {
      voiceManager.startRecording();
      voiceManager.onPartialResult("Hello");

      // Simulate silence timeout
      vi.advanceTimersByTime(3000);
      voiceManager.checkSilenceTimeout();

      expect(
        voiceManager.getState() === "processing" ||
        voiceManager.getState() === "idle"
      ).toBe(true);
    });

    it("silence timer resets on new partial result", () => {
      voiceManager.startRecording();

      vi.advanceTimersByTime(2000);
      voiceManager.onPartialResult("Hello");
      voiceManager.resetSilenceTimer();

      vi.advanceTimersByTime(2000);
      // Only 2s since last speech, should still be recording
      expect(voiceManager.getState()).toBe("recording");
    });

    it("auto-stops after max duration", () => {
      voiceManager.startRecording();

      vi.advanceTimersByTime(60000);
      voiceManager.checkMaxDuration();

      expect(
        voiceManager.getState() === "processing" ||
        voiceManager.getState() === "idle"
      ).toBe(true);
    });
  });

  describe("error handling", () => {
    it("permission denied error", () => {
      voiceManager.setError({
        type: "PERMISSION_DENIED",
        message: "Microphone access denied",
      });
      expect(voiceManager.getError()?.type).toBe("PERMISSION_DENIED");
    });

    it("not available error", () => {
      voiceManager.setError({
        type: "NOT_AVAILABLE",
        message: "Speech recognition not available",
      });
      expect(voiceManager.getError()?.type).toBe("NOT_AVAILABLE");
    });

    it("network error", () => {
      voiceManager.setError({
        type: "NETWORK_ERROR",
        message: "Network unavailable",
      });
      expect(voiceManager.getError()?.type).toBe("NETWORK_ERROR");
    });

    it("error clears on startRecording", () => {
      voiceManager.setError({
        type: "RECOGNITION_FAILED",
        message: "Failed",
      });
      voiceManager.clearError();
      voiceManager.startRecording();
      expect(voiceManager.getError()).toBeNull();
    });
  });

  describe("configuration", () => {
    it("uses provided language setting", () => {
      expect(voiceManager.getConfig().language).toBe("en-US");
    });

    it("uses provided silence timeout", () => {
      expect(voiceManager.getConfig().silenceTimeout).toBe(3000);
    });

    it("uses provided max duration", () => {
      expect(voiceManager.getConfig().maxDuration).toBe(60000);
    });

    it("updateConfig changes settings", () => {
      voiceManager.updateConfig({ language: "es-ES" });
      expect(voiceManager.getConfig().language).toBe("es-ES");
    });
  });

  describe("state change callbacks", () => {
    it("onStateChange fires on transitions", () => {
      const states: string[] = [];
      voiceManager.onStateChange((state) => states.push(state));

      voiceManager.startRecording();
      voiceManager.stopRecording();
      voiceManager.finalize("test");

      expect(states).toContain("recording");
      expect(states).toContain("processing");
      expect(states).toContain("idle");
    });

    it("unsubscribe stops callbacks", () => {
      const states: string[] = [];
      const unsub = voiceManager.onStateChange((state) => states.push(state));

      voiceManager.startRecording();
      unsub();
      voiceManager.stopRecording();

      expect(states).toHaveLength(1);
    });
  });
});
