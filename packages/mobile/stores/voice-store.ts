import { create } from "zustand";
import {
  VoiceInputManager,
  type VoiceState,
  type VoiceConfig,
} from "../src/services/voice-input-manager.js";

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  language: "en-US",
  silenceTimeout: 2000,
  maxDuration: 60000,
};

interface VoiceStoreState {
  state: VoiceState;
  partialTranscript: string;
  finalTranscript: string;
  duration: number;
  error: string | null;

  startRecording: () => void;
  stopRecording: () => void;
  cancelRecording: () => void;
  finalize: (transcript: string) => void;
  onPartialResult: (text: string) => void;
  clearError: () => void;
  updateConfig: (config: Partial<VoiceConfig>) => void;

  _manager: VoiceInputManager;
}

export const useVoiceStore = create<VoiceStoreState>()((set, get) => {
  const manager = new VoiceInputManager(DEFAULT_VOICE_CONFIG);

  manager.onStateChange((newState) => {
    set({
      state: newState,
      partialTranscript: manager.getPartialTranscript(),
      finalTranscript: manager.getFinalTranscript(),
      duration: manager.getRecordingDuration(),
      error: manager.getError()?.message ?? null,
    });
  });

  return {
    state: "idle",
    partialTranscript: "",
    finalTranscript: "",
    duration: 0,
    error: null,
    _manager: manager,

    startRecording: () => {
      manager.startRecording();
    },

    stopRecording: () => {
      manager.stopRecording();
    },

    cancelRecording: () => {
      manager.cancelRecording();
    },

    finalize: (transcript: string) => {
      manager.finalize(transcript);
    },

    onPartialResult: (text: string) => {
      manager.onPartialResult(text);
      set({ partialTranscript: text });
    },

    clearError: () => {
      manager.clearError();
    },

    updateConfig: (config: Partial<VoiceConfig>) => {
      manager.updateConfig(config);
    },
  };
});
