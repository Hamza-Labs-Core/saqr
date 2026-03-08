/**
 * Syntax highlighting utilities for terminal UI code blocks.
 *
 * Provides language detection from file paths and a basic token-level
 * highlighter using regex patterns. For richer highlighting, consumers
 * can integrate Shiki or Prism and use detectLanguage() for auto-detection.
 *
 * @module utils/syntax-highlight
 */

/** Known language identifiers. */
export type LanguageId =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "shell"
  | "json"
  | "yaml"
  | "toml"
  | "html"
  | "css"
  | "sql"
  | "markdown"
  | "dockerfile"
  | "plaintext";

/** Map file extensions to language IDs. */
const EXT_MAP: Record<string, LanguageId> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyw: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  sql: "sql",
  md: "markdown",
  mdx: "markdown",
  dockerfile: "dockerfile",
};

/** Map filenames (without extension) to language IDs. */
const NAME_MAP: Record<string, LanguageId> = {
  Dockerfile: "dockerfile",
  Makefile: "shell",
  Rakefile: "ruby",
  Gemfile: "ruby",
  Podfile: "ruby",
  Vagrantfile: "ruby",
};

/**
 * Detect the language from a file path.
 *
 * @param filePath - Full or relative file path (e.g., "src/index.ts")
 * @returns The detected language ID, or "plaintext" if unknown.
 */
export function detectLanguage(filePath: string): LanguageId {
  if (!filePath) return "plaintext";

  // Check exact filename matches first
  const fileName = filePath.split("/").pop() ?? "";
  if (NAME_MAP[fileName]) return NAME_MAP[fileName];

  // Check extension
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? "plaintext";
}

/**
 * A syntax token produced by the highlighter.
 */
export interface SyntaxToken {
  type: "keyword" | "string" | "number" | "comment" | "function" | "operator" | "punctuation" | "text";
  value: string;
}

/** Regex patterns for basic tokenization. */
const TOKEN_PATTERNS: Array<{ type: SyntaxToken["type"]; pattern: RegExp }> = [
  // Single-line comments
  { type: "comment", pattern: /\/\/[^\n]*|#[^\n]*/g },
  // Multi-line comments
  { type: "comment", pattern: /\/\*[\s\S]*?\*\//g },
  // Strings (double, single, backtick)
  { type: "string", pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g },
  // Numbers (hex, decimal, float)
  { type: "number", pattern: /\b0x[\da-fA-F]+\b|\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/g },
  // Common keywords
  {
    type: "keyword",
    pattern: /\b(?:const|let|var|function|class|interface|type|enum|import|export|from|return|if|else|for|while|do|switch|case|break|continue|new|this|super|extends|implements|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|null|undefined|true|false|default|yield|static|public|private|protected|readonly|abstract|declare|namespace|module|require|def|self|None|True|False|fn|pub|mod|use|struct|impl|trait|match|loop|mut|ref|where|unsafe|crate|extern|move|dyn)\b/g,
  },
  // Function calls
  { type: "function", pattern: /\b[a-zA-Z_]\w*(?=\s*\()/g },
  // Operators
  { type: "operator", pattern: /[+\-*/%=<>!&|^~?:]+|=>|\.{3}/g },
  // Punctuation
  { type: "punctuation", pattern: /[{}[\]();,.]/g },
];

/**
 * Tokenize source code into basic syntax tokens.
 *
 * This is a lightweight regex-based tokenizer suitable for quick previews.
 * For production-quality highlighting, use Shiki or Prism with detectLanguage().
 *
 * @param code - The source code to tokenize
 * @param _language - Language ID (currently unused, reserved for future per-language grammars)
 * @returns Array of syntax tokens covering the full input
 */
export function tokenize(code: string, _language?: LanguageId): SyntaxToken[] {
  if (!code) return [];

  // Build a flat list of all matches with their positions
  const matches: Array<{ type: SyntaxToken["type"]; start: number; end: number; value: string }> = [];

  for (const { type, pattern } of TOKEN_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(code)) !== null) {
      matches.push({
        type,
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
      });
    }
  }

  // Sort by position, then by length (longer matches win)
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  // Build non-overlapping token list
  const tokens: SyntaxToken[] = [];
  let pos = 0;

  for (const m of matches) {
    if (m.start < pos) continue; // Skip overlapping

    if (m.start > pos) {
      tokens.push({ type: "text", value: code.slice(pos, m.start) });
    }

    tokens.push({ type: m.type, value: m.value });
    pos = m.end;
  }

  if (pos < code.length) {
    tokens.push({ type: "text", value: code.slice(pos) });
  }

  return tokens;
}

/**
 * Map a SyntaxToken type to the corresponding CSS variable name.
 */
export function tokenTypeToCssVar(type: SyntaxToken["type"]): string {
  const map: Record<SyntaxToken["type"], string> = {
    keyword: "var(--saqr-syn-keyword)",
    string: "var(--saqr-syn-string)",
    number: "var(--saqr-syn-number)",
    comment: "var(--saqr-syn-comment)",
    function: "var(--saqr-syn-function)",
    operator: "var(--saqr-syn-operator)",
    punctuation: "var(--saqr-syn-punctuation)",
    text: "inherit",
  };
  return map[type];
}
