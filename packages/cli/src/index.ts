/**
 * @saqr/cli - CLI tool for the Saqr multi-agent hook system.
 *
 * This package provides the `saqr` CLI binary and exports command handlers
 * for programmatic use.
 */

export { parseArgs } from "./bin/saqr.js";
export type { ParsedArgs } from "./bin/saqr.js";

export {
  runInstall,
  runDoctor,
  runStart,
  runStop,
  runStatus,
  runWatch,
  runQuery,
  runAgent,
} from "./commands/index.js";

export {
  bold,
  dim,
  red,
  green,
  yellow,
  blue,
  cyan,
  gray,
  symbols,
  info,
  success,
  warn,
  error,
  header,
  table,
  spinner,
} from "./utils/output.js";

export type { TableColumn, Spinner } from "./utils/output.js";
