import { useCallback } from "react";
import { useVoiceStore } from "../stores/voice-store.js";
import type { VoiceState } from "../src/services/voice-input-manager.js";

/**
 * Hook for voice input functionality.
 * Wraps the VoiceInputManager via the Zustand store.
 */
export function useVoiceInput() {
  const state = useVoiceStore((s) => s.state);
  const partialTranscript = useVoiceStore((s) => s.partialTranscript);
  const finalTranscript = useVoiceStore((s) => s.finalTranscript);
  const duration = useVoiceStore((s) => s.duration);
  const error = useVoiceStore((s) => s.error);
  const startRecording = useVoiceStore((s) => s.startRecording);
  const stopRecording = useVoiceStore((s) => s.stopRecording);
  const cancelRecording = useVoiceStore((s) => s.cancelRecording);
  const clearError = useVoiceStore((s) => s.clearError);

  const isRecording = state === "recording";
  const isProcessing = state === "processing";

  const toggle = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else if (state === "idle") {
      startRecording();
    }
  }, [isRecording, state, startRecording, stopRecording]);

  return {
    state: state as VoiceState,
    isRecording,
    isProcessing,
    partialTranscript,
    finalTranscript,
    duration,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
    clearError,
    toggle,
  };
}
