/**
 * Language detection from file paths and extensions.
 *
 * Maps 60+ file extensions and special filenames to their corresponding
 * syntax highlighting language identifiers.
 *
 * @module highlighting/languageDetection
 */

/**
 * Extension-to-language mapping.
 * Keys are lowercase extensions (with leading dot).
 */
const EXTENSION_MAP: ReadonlyMap<string, string> = new Map([
  // JavaScript / TypeScript
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],

  // Python
  [".py", "python"],
  [".pyw", "python"],
  [".pyi", "python"],

  // Shell
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".fish", "bash"],

  // Data formats
  [".json", "json"],
  [".jsonc", "json"],
  [".json5", "json"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".toml", "toml"],
  [".ini", "ini"],
  [".cfg", "ini"],
  [".conf", "ini"],
  [".properties", "ini"],

  // Markup / Documentation
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".markdown", "markdown"],
  [".html", "html"],
  [".htm", "html"],
  [".xml", "xml"],
  [".svg", "xml"],
  [".xsl", "xml"],
  [".xslt", "xml"],
  [".plist", "xml"],

  // Stylesheets
  [".css", "css"],
  [".scss", "scss"],
  [".sass", "scss"],
  [".less", "less"],
  [".styl", "stylus"],

  // Go
  [".go", "go"],

  // Rust
  [".rs", "rust"],

  // Java / JVM
  [".java", "java"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".scala", "scala"],
  [".groovy", "groovy"],
  [".gradle", "groovy"],
  [".clj", "clojure"],
  [".cljs", "clojure"],

  // C / C++
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],

  // C#
  [".cs", "csharp"],

  // Ruby
  [".rb", "ruby"],
  [".rake", "ruby"],
  [".gemspec", "ruby"],

  // PHP
  [".php", "php"],

  // Swift / Objective-C
  [".swift", "swift"],
  [".m", "objectivec"],
  [".mm", "objectivec"],

  // R
  [".r", "r"],

  // SQL
  [".sql", "sql"],

  // GraphQL
  [".graphql", "graphql"],
  [".gql", "graphql"],

  // Lua
  [".lua", "lua"],

  // Vim
  [".vim", "vim"],

  // Lisp / Scheme
  [".el", "lisp"],
  [".lisp", "lisp"],
  [".scm", "scheme"],

  // Erlang / Elixir
  [".erl", "erlang"],
  [".hrl", "erlang"],
  [".ex", "elixir"],
  [".exs", "elixir"],

  // Haskell
  [".hs", "haskell"],
  [".lhs", "haskell"],

  // Dart
  [".dart", "dart"],

  // Perl
  [".pl", "perl"],
  [".pm", "perl"],

  // Protobuf
  [".proto", "protobuf"],

  // HCL / Terraform
  [".tf", "hcl"],
  [".hcl", "hcl"],
  [".tfvars", "hcl"],

  // Docker
  [".dockerfile", "dockerfile"],

  // Zig
  [".zig", "zig"],

  // Nim
  [".nim", "nim"],

  // OCaml
  [".ml", "ocaml"],
  [".mli", "ocaml"],

  // F#
  [".fs", "fsharp"],
  [".fsi", "fsharp"],
  [".fsx", "fsharp"],

  // PowerShell
  [".ps1", "powershell"],
  [".psm1", "powershell"],

  // Diff / Patch
  [".diff", "diff"],
  [".patch", "diff"],
]);

/**
 * Special filename-to-language mapping for files without extensions
 * or with specific names that indicate a language.
 */
const FILENAME_MAP: ReadonlyMap<string, string> = new Map([
  ["makefile", "makefile"],
  ["gnumakefile", "makefile"],
  ["dockerfile", "dockerfile"],
  ["containerfile", "dockerfile"],
  [".gitignore", "gitignore"],
  [".gitattributes", "gitignore"],
  [".gitmodules", "gitignore"],
  [".dockerignore", "gitignore"],
  [".npmignore", "gitignore"],
  [".env", "dotenv"],
  [".env.local", "dotenv"],
  [".env.development", "dotenv"],
  [".env.production", "dotenv"],
  [".env.test", "dotenv"],
  [".bashrc", "bash"],
  [".bash_profile", "bash"],
  [".bash_aliases", "bash"],
  [".zshrc", "bash"],
  [".zshenv", "bash"],
  [".zprofile", "bash"],
  [".profile", "bash"],
  ["vagrantfile", "ruby"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["guardfile", "ruby"],
  ["podfile", "ruby"],
  ["jenkinsfile", "groovy"],
  ["cmakelists.txt", "cmake"],
  ["justfile", "makefile"],
]);

/**
 * Detect the programming language from a file path.
 *
 * Uses the following priority:
 * 1. Special filename match (case-insensitive)
 * 2. File extension match (case-insensitive)
 * 3. Fallback to "plaintext"
 *
 * @param filePath - The full or partial file path.
 * @returns The detected language identifier.
 */
export function detectLanguage(filePath: string): string {
  if (!filePath) return "plaintext";

  // Normalize path separators
  const normalized = filePath.replace(/\\/g, "/");

  // Extract filename (last component)
  const parts = normalized.split("/");
  const fileName = parts[parts.length - 1] || "";
  const fileNameLower = fileName.toLowerCase();

  // 1. Check special filenames
  const filenameMatch = FILENAME_MAP.get(fileNameLower);
  if (filenameMatch) return filenameMatch;

  // Also check if the filename starts with a dot (like .env.local)
  // Try progressively shorter prefix matches
  if (fileNameLower.startsWith(".env")) {
    return "dotenv";
  }

  // 2. Extract extension and check
  const lastDotIdx = fileName.lastIndexOf(".");
  if (lastDotIdx >= 0) {
    const ext = fileName.slice(lastDotIdx).toLowerCase();
    const extMatch = EXTENSION_MAP.get(ext);
    if (extMatch) return extMatch;
  }

  // 3. Fallback
  return "plaintext";
}
