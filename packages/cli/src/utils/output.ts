/**
 * CLI output formatting helpers.
 *
 * Provides colors, tables, spinners, and structured output
 * for the saqr CLI without external dependencies.
 */

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const isColorSupported =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  (process.stdout.isTTY ?? false);

function wrap(code: number, resetCode: number): (text: string) => string {
  if (!isColorSupported) return (text) => text;
  return (text) => `\x1b[${code}m${text}\x1b[${resetCode}m`;
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

// ---------------------------------------------------------------------------
// Status symbols
// ---------------------------------------------------------------------------

export const symbols = {
  success: green("✓"),
  error: red("✗"),
  warning: yellow("!"),
  info: blue("i"),
  arrow: cyan("→"),
  bullet: dim("•"),
} as const;

// ---------------------------------------------------------------------------
// Structured output helpers
// ---------------------------------------------------------------------------

/** Print an informational message. */
export function info(message: string): void {
  console.log(`${symbols.info} ${message}`);
}

/** Print a success message. */
export function success(message: string): void {
  console.log(`${symbols.success} ${message}`);
}

/** Print a warning message. */
export function warn(message: string): void {
  console.error(`${symbols.warning} ${yellow(message)}`);
}

/** Print an error message. */
export function error(message: string): void {
  console.error(`${symbols.error} ${red(message)}`);
}

/** Print a header/section title. */
export function header(title: string): void {
  console.log();
  console.log(bold(title));
  console.log(dim("─".repeat(Math.min(title.length + 4, 60))));
}

// ---------------------------------------------------------------------------
// Table helper
// ---------------------------------------------------------------------------

export interface TableColumn {
  label: string;
  width?: number;
  align?: "left" | "right";
}

/**
 * Print a simple aligned table to stdout.
 *
 * @param columns - Column definitions.
 * @param rows    - Array of row arrays (each row is an array of cell strings).
 */
export function table(columns: TableColumn[], rows: string[][]): void {
  const widths = columns.map((col, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), 0);
    return col.width ?? Math.max(col.label.length, dataMax);
  });

  // Header
  const headerLine = columns
    .map((col, i) => col.label.padEnd(widths[i]))
    .join("  ");
  console.log(bold(headerLine));
  console.log(dim(widths.map((w) => "─".repeat(w)).join("──")));

  // Rows
  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const cell = row[i] ?? "";
        return col.align === "right" ? cell.padStart(widths[i]) : cell.padEnd(widths[i]);
      })
      .join("  ");
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  /** Update the spinner message. */
  update(message: string): void;
  /** Stop the spinner and show a success message. */
  succeed(message: string): void;
  /** Stop the spinner and show an error message. */
  fail(message: string): void;
  /** Stop the spinner without a message. */
  stop(): void;
}

/**
 * Create a simple terminal spinner.
 *
 * @param message - Initial spinner message.
 * @returns Spinner control object.
 */
export function spinner(message: string): Spinner {
  let frame = 0;
  let text = message;
  let timer: ReturnType<typeof setInterval> | null = null;

  if (isColorSupported && process.stderr.isTTY) {
    timer = setInterval(() => {
      const char = cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
      process.stderr.write(`\r${char} ${text}`);
      frame++;
    }, 80);
  } else {
    process.stderr.write(`... ${text}\n`);
  }

  function clear(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      process.stderr.write("\r\x1b[K");
    }
  }

  return {
    update(msg: string) {
      text = msg;
    },
    succeed(msg: string) {
      clear();
      console.log(`${symbols.success} ${msg}`);
    },
    fail(msg: string) {
      clear();
      console.error(`${symbols.error} ${red(msg)}`);
    },
    stop() {
      clear();
    },
  };
}
