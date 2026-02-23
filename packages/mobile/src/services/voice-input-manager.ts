/**
 * VoiceInputManager - Audio state machine and speech-to-text result handling.
 *
 * Manages the voice recording lifecycle: idle -> recording -> processing -> idle,
 * with silence detection, max duration, partial transcript updates, and error states.
 *
 * @module services/voice-input-manager
 */

import type { VoiceInputError } from "../types/errors.js";

/** Voice input states. */
export type VoiceState = "idle" | "recording" | "processing" | "error";

/** Voice input configuration. */
export interface VoiceConfig {
  /** Speech recognition language. */
  language: string;
  /** Auto-stop after this many ms of silence. */
  silenceTimeout: number;
  /** Maximum recording duration in ms. */
  maxDuration: number;
}

/** State change listener. */
type StateChangeListener = (state: VoiceState) => void;

/**
 * Manages voice input state machine and speech-to-text results.
 */
export class VoiceInputManager {
  private state: VoiceState = "idle";
  private config: VoiceConfig;
  private partialTranscript = "";
  private finalTranscript = "";
  private error: VoiceInputError | null = null;
  private recordingStartTime: number | null = null;
  private recordingEndTime: number | null = null;
  private lastSpeechTime: number | null = null;
  private listeners: Set<StateChangeListener> = new Set();

  constructor(config: VoiceConfig) {
    this.config = { ...config };
  }

  /**
   * Format a duration in seconds as "M:SS".
   */
  static formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  /**
   * Get the current state.
   */
  getState(): VoiceState {
    return this.state;
  }

  /**
   * Get the current partial transcript.
   */
  getPartialTranscript(): string {
    return this.partialTranscript;
  }

  /**
   * Get the final transcript after recording stops.
   */
  getFinalTranscript(): string {
    return this.finalTranscript;
  }

  /**
   * Get the current error, if any.
   */
  getError(): VoiceInputError | null {
    return this.error;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): VoiceConfig {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  updateConfig(updates: Partial<VoiceConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get the recording duration in seconds.
   */
  getRecordingDuration(): number {
    if (!this.recordingStartTime) return 0;

    const endTime = this.recordingEndTime ?? Date.now();
    return Math.floor((endTime - this.recordingStartTime) / 1000);
  }

  /**
   * Start recording. Transitions from idle to recording.
   */
  startRecording(): void {
    if (this.state === "recording") return;

    this.partialTranscript = "";
    this.finalTranscript = "";
    this.error = null;
    this.recordingStartTime = Date.now();
    this.recordingEndTime = null;
    this.lastSpeechTime = Date.now();
    this.setState("recording");
  }

  /**
   * Stop recording. Transitions from recording to processing.
   */
  stopRecording(): void {
    if (this.state !== "recording") return;

    this.recordingEndTime = Date.now();
    this.setState("processing");
  }

  /**
   * Finalize the transcript. Transitions from processing to idle.
   */
  finalize(finalTranscript: string): void {
    if (this.state !== "processing") return;

    this.finalTranscript = finalTranscript;
    this.setState("idle");
  }

  /**
   * Cancel recording. Transitions from recording to idle.
   * Discards the partial transcript.
   */
  cancelRecording(): void {
    if (this.state !== "recording") return;

    this.partialTranscript = "";
    this.recordingStartTime = null;
    this.recordingEndTime = null;
    this.setState("idle");
  }

  /**
   * Handle a partial speech recognition result.
   */
  onPartialResult(text: string): void {
    if (this.state !== "recording") return;
    this.partialTranscript = text;
    this.lastSpeechTime = Date.now();
  }

  /**
   * Set an error state.
   */
  setError(error: VoiceInputError): void {
    this.error = error;
    this.recordingEndTime = Date.now();
    this.setState("error");
  }

  /**
   * Clear the error and return to idle.
   */
  clearError(): void {
    this.error = null;
    this.setState("idle");
  }

  /**
   * Reset the silence timer (called when speech is detected).
   */
  resetSilenceTimer(): void {
    this.lastSpeechTime = Date.now();
  }

  /**
   * Check if silence timeout has been reached.
   * Should be called periodically during recording.
   */
  checkSilenceTimeout(): void {
    if (this.state !== "recording") return;
    if (!this.lastSpeechTime) return;

    const elapsed = Date.now() - this.lastSpeechTime;
    if (elapsed >= this.config.silenceTimeout) {
      this.stopRecording();
    }
  }

  /**
   * Check if maximum recording duration has been reached.
   * Should be called periodically during recording.
   */
  checkMaxDuration(): void {
    if (this.state !== "recording") return;
    if (!this.recordingStartTime) return;

    const elapsed = Date.now() - this.recordingStartTime;
    if (elapsed >= this.config.maxDuration) {
      this.stopRecording();
    }
  }

  /**
   * Register a state change listener.
   * @returns An unsubscribe function.
   */
  onStateChange(callback: StateChangeListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.listeners.clear();
    this.recordingStartTime = null;
    this.recordingEndTime = null;
  }

  private setState(newState: VoiceState): void {
    if (this.state === newState) return;
    this.state = newState;
    for (const listener of this.listeners) {
      listener(newState);
    }
  }
}
