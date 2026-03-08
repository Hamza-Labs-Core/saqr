/**
 * useVoice — Web Speech API hook for browser-based voice input.
 *
 * Wraps the SpeechRecognition API into a React hook with state management
 * that mirrors the mobile VoiceInputManager's state machine:
 *   idle → recording → processing → idle
 *
 * Works in Tauri WebView, Chrome, Edge, and Safari.
 * Falls back gracefully when the API is unavailable.
 */
import { useState, useRef, useCallback, useEffect } from "react";

// ---------------------------------------------------------------------------
// Web Speech API — local type definitions
// Defined here instead of relying on the DOM lib so that this file can be
// type-checked by projects that don't include DOM (e.g. React Native).
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventLike {
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

// ---------------------------------------------------------------------------

export type VoiceState = "idle" | "recording" | "processing" | "error" | "unsupported";

export interface UseVoiceOptions {
  /** Speech recognition language (default: "en-US") */
  language?: string;
  /** Auto-stop after this many ms of silence (default: 3000) */
  silenceTimeout?: number;
  /** Maximum recording duration in ms (default: 60000) */
  maxDuration?: number;
  /** Called with the final transcript */
  onResult?: (transcript: string) => void;
}

export interface UseVoiceResult {
  /** Current voice input state */
  state: VoiceState;
  /** Partial transcript (updates during recording) */
  partialTranscript: string;
  /** Final transcript (set after processing completes) */
  finalTranscript: string;
  /** Start recording */
  startRecording: () => void;
  /** Stop recording */
  stopRecording: () => void;
  /** Cancel recording (discard transcript) */
  cancelRecording: () => void;
  /** Whether the Web Speech API is supported */
  isSupported: boolean;
  /** Error message if state is "error" */
  error: string | null;
}

/** Get the SpeechRecognition constructor, if available. */
function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as Record<string, unknown>).SpeechRecognition ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition ??
    null
  ) as SpeechRecognitionConstructor | null;
}

export function useVoice(options: UseVoiceOptions = {}): UseVoiceResult {
  const {
    language = "en-US",
    silenceTimeout = 3000,
    maxDuration = 60000,
    onResult,
  } = options;

  const SpeechRecognitionCtor = getSpeechRecognition();
  const isSupported = SpeechRecognitionCtor !== null;

  const [state, setState] = useState<VoiceState>(isSupported ? "idle" : "unsupported");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const clearTimers = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!SpeechRecognitionCtor || state === "recording") return;

    setPartialTranscript("");
    setFinalTranscript("");
    setError(null);

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = language;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = "";
      let final = "";

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      setPartialTranscript(interim);
      if (final) {
        setFinalTranscript(final);
      }

      // Reset silence timer on speech
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      silenceTimerRef.current = setTimeout(() => {
        recognition.stop();
      }, silenceTimeout);
    };

    recognition.onend = () => {
      clearTimers();
      setState("processing");

      // Short delay for final result propagation, then finalize
      setTimeout(() => {
        setFinalTranscript((prev) => {
          const transcript = prev || partialTranscript;
          if (transcript && onResultRef.current) {
            onResultRef.current(transcript);
          }
          return transcript;
        });
        setState("idle");
      }, 100);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      clearTimers();
      if (event.error === "aborted" || event.error === "no-speech") {
        setState("idle");
        return;
      }
      setError(event.error);
      setState("error");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState("recording");

    // Max duration timer
    maxDurationTimerRef.current = setTimeout(() => {
      recognition.stop();
    }, maxDuration);
  }, [SpeechRecognitionCtor, state, language, silenceTimeout, maxDuration, clearTimers, partialTranscript]);

  const stopRecording = useCallback(() => {
    clearTimers();
    recognitionRef.current?.stop();
  }, [clearTimers]);

  const cancelRecording = useCallback(() => {
    clearTimers();
    if (recognitionRef.current) {
      // Prevent onend from firing onResult
      recognitionRef.current.onend = null;
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    setPartialTranscript("");
    setFinalTranscript("");
    setState("idle");
  }, [clearTimers]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimers();
      recognitionRef.current?.abort();
    };
  }, [clearTimers]);

  return {
    state,
    partialTranscript,
    finalTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    isSupported,
    error,
  };
}
