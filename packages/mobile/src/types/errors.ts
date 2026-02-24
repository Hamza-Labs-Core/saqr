/**
 * Error Types for the Saqr Mobile App.
 *
 * Defines discriminated union error types for QR scanning,
 * voice input, and connection failures.
 *
 * @module types/errors
 */

/** QR scanner error types. */
export type QRScanError =
  | { type: "INVALID_FORMAT"; message: string }
  | { type: "EXPIRED"; message: string }
  | { type: "PARSE_ERROR"; message: string }
  | { type: "CAMERA_ERROR"; message: string };

/** Voice input error types. */
export type VoiceInputError =
  | { type: "PERMISSION_DENIED"; message: string }
  | { type: "NOT_AVAILABLE"; message: string }
  | { type: "RECOGNITION_FAILED"; message: string }
  | { type: "NETWORK_ERROR"; message: string };

/** Connection error types. */
export type ConnectionError =
  | { type: "TIMEOUT"; message: string; hostId: string }
  | { type: "REFUSED"; message: string; hostId: string }
  | { type: "CLOSED"; message: string; hostId: string; code: number }
  | { type: "PROTOCOL"; message: string; hostId: string };
