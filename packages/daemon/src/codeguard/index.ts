/**
 * Codeguard module — Security anti-pattern detection for AI agents.
 *
 * Exports the RuleManager (CRUD for rules), ViolationTracker
 * (event-driven violation monitoring), and RuleRegistry
 * (curated + popular rule discovery).
 */

export {
  RuleManager,
  type CodeguardRule,
  type CodeguardRulesFile,
  type RuleSeverity,
  type RuleLayer,
  type MergedRule,
} from "./rule-manager.js";

export {
  ViolationTracker,
  type ViolationRecord,
  type RuleStats,
} from "./violation-tracker.js";

export {
  RuleRegistry,
  type RegistryRule,
  type RegistryFile,
  type BrowseOptions,
} from "./rule-registry.js";

export {
  TelemetrySender,
  type TelemetryConfig,
  type TelemetrySnapshot,
} from "./telemetry-sender.js";
