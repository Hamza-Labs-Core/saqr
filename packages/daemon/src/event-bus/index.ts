/**
 * Event bus module — internal pub/sub for daemon components.
 *
 * @module event-bus
 */

export { EventBus } from "./event-bus.js";
export type {
  EventEnvelope,
  EventFilter,
  EventHandler,
  Unsubscribe,
} from "./event-bus.js";
