/**
 * Agent lifecycle state machine.
 *
 * Enforces valid state transitions, emits StateChangeEvent on every
 * transition, and implements error recovery with exponential backoff.
 *
 * State transitions:
 *   initializing -> idle | error | closed
 *   idle         -> running | closed
 *   running      -> idle | error
 *   error        -> idle | closed
 *   closed       -> (terminal, no transitions)
 *
 * Special: transition to 'closed' is allowed from any non-closed state.
 */

import { InvalidStateTransitionError } from "./errors.js";

/**
 * Agent lifecycle states.
 */
export type AgentLifecycleState =
  | "initializing"
  | "idle"
  | "running"
  | "error"
  | "closed";

/**
 * Describes an error that occurred in the agent.
 */
export interface AgentError {
  code: string;
  message: string;
  recoverable: boolean;
  retryAfterMs?: number;
}

/**
 * Emitted on every state transition.
 */
export interface StateChangeEvent {
  sessionId: string;
  previousState: AgentLifecycleState;
  currentState: AgentLifecycleState;
  timestamp: Date;
  reason?: string;
  error?: AgentError;
}

/**
 * Configuration for automatic error recovery.
 */
export interface RecoveryPolicy {
  maxRetries: number;
  backoffMs: number;
  maxBackoffMs: number;
  recoverableErrors: string[];
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  maxBackoffMs: 30000,
  recoverableErrors: [
    "RATE_LIMITED",
    "NETWORK_ERROR",
    "PROVIDER_TIMEOUT",
    "TRANSIENT_SPAWN_FAILURE",
  ],
};

type StateChangeCallback = (event: StateChangeEvent) => void;

/**
 * Valid transition map. The key is the "from" state; the value array lists
 * the states that can be transitioned to (excluding the special "closed"
 * override which is handled separately).
 */
const VALID_TRANSITIONS: Record<AgentLifecycleState, AgentLifecycleState[]> = {
  initializing: ["idle", "error", "closed"],
  idle: ["running", "closed"],
  running: ["idle", "error"],
  error: ["idle", "closed"],
  closed: [], // terminal
};

export class AgentStateMachine {
  private _state: AgentLifecycleState = "initializing";
  private _listeners: Set<StateChangeCallback> = new Set();
  private _retryCount = 0;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly recoveryPolicy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
  ) {}

  get state(): AgentLifecycleState {
    return this._state;
  }

  /**
   * Transition to a new state.
   *
   * @throws InvalidStateTransitionError if the transition is not allowed.
   */
  transition(
    to: AgentLifecycleState,
    reason?: string,
    error?: AgentError,
  ): void {
    const from = this._state;

    if (from === "closed") {
      throw new InvalidStateTransitionError(
        from,
        to,
        "closed is a terminal state",
      );
    }

    // "closed" can be reached from any non-closed state
    if (to === "closed") {
      // Cancel any pending recovery timer
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      this._applyTransition(from, to, reason, error);
      return;
    }

    if (!VALID_TRANSITIONS[from].includes(to)) {
      throw new InvalidStateTransitionError(from, to);
    }

    this._applyTransition(from, to, reason, error);
  }

  /**
   * Register a listener for state changes.
   * Returns an unsubscribe function.
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this._listeners.add(callback);
    return () => {
      this._listeners.delete(callback);
    };
  }

  /**
   * Attempt automatic error recovery with exponential backoff.
   *
   * The state machine must already be in the "error" state.
   *
   * @returns true if recovery succeeded (state is now "idle"), false otherwise.
   */
  async attemptRecovery(
    error: AgentError,
    retryFn: () => Promise<void>,
  ): Promise<boolean> {
    if (!error.recoverable) return false;
    if (!this.recoveryPolicy.recoverableErrors.includes(error.code))
      return false;
    if (this._retryCount >= this.recoveryPolicy.maxRetries) return false;

    this._retryCount++;
    const delay = Math.min(
      this.recoveryPolicy.backoffMs *
        Math.pow(2, this._retryCount - 1),
      this.recoveryPolicy.maxBackoffMs,
    );

    await new Promise<void>((resolve) => {
      this._retryTimer = setTimeout(resolve, delay);
    });
    this._retryTimer = null;

    // If we were closed while waiting, bail out
    if (this._state === "closed") return false;

    try {
      await retryFn();
      this.transition(
        "idle",
        `Recovery succeeded after ${this._retryCount} retries`,
      );
      this._retryCount = 0;
      return true;
    } catch {
      if (this._retryCount >= this.recoveryPolicy.maxRetries) {
        return false;
      }
      return this.attemptRecovery(error, retryFn);
    }
  }

  /**
   * Clear all timers and listeners.
   */
  destroy(): void {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._listeners.clear();
  }

  private _applyTransition(
    from: AgentLifecycleState,
    to: AgentLifecycleState,
    reason?: string,
    error?: AgentError,
  ): void {
    this._state = to;
    const event: StateChangeEvent = {
      sessionId: this.sessionId,
      previousState: from,
      currentState: to,
      timestamp: new Date(),
      reason,
      error,
    };
    // Snapshot current listeners to avoid issues if listeners add/remove
    const listeners = [...this._listeners];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors - they must not break the state machine
      }
    }
  }
}
