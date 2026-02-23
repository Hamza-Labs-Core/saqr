/**
 * Tests for language detection from file extensions.
 *
 * Validates the extension-to-language mapping (40+ mappings) and
 * edge cases like special filenames (Makefile, Dockerfile, etc.).
 */
import { describe, it, expect } from "vitest";
import { detectLanguage } from "../highlighting/languageDetection.js";

describe("detectLanguage", () => {
  // ---------------------------------------------------------------------------
  // Standard extensions
  // ---------------------------------------------------------------------------

  describe("standard file extensions", () => {
    const cases: Array<[string, string]> = [
      ["/src/index.js", "javascript"],
      ["/src/index.jsx", "javascript"],
      ["/src/index.mjs", "javascript"],
      ["/src/index.cjs", "javascript"],
      ["/src/index.ts", "typescript"],
      ["/src/index.tsx", "typescript"],
      ["/src/index.mts", "typescript"],
      ["/src/index.cts", "typescript"],
      ["/src/main.py", "python"],
      ["/src/main.pyw", "python"],
      ["/scripts/build.sh", "bash"],
      ["/scripts/build.bash", "bash"],
      ["/scripts/build.zsh", "bash"],
      ["/data/config.json", "json"],
      ["/data/config.jsonc", "json"],
      ["/config.yaml", "yaml"],
      ["/config.yml", "yaml"],
      ["/README.md", "markdown"],
      ["/README.mdx", "markdown"],
      ["/index.html", "html"],
      ["/index.htm", "html"],
      ["/styles.css", "css"],
      ["/styles.scss", "scss"],
      ["/styles.sass", "scss"],
      ["/styles.less", "less"],
      ["/main.go", "go"],
      ["/main.rs", "rust"],
      ["/Main.java", "java"],
      ["/Main.kt", "kotlin"],
      ["/Main.scala", "scala"],
      ["/main.c", "c"],
      ["/main.h", "c"],
      ["/main.cpp", "cpp"],
      ["/main.cc", "cpp"],
      ["/main.cxx", "cpp"],
      ["/main.hpp", "cpp"],
      ["/main.cs", "csharp"],
      ["/main.rb", "ruby"],
      ["/main.php", "php"],
      ["/main.swift", "swift"],
      ["/main.m", "objectivec"],
      ["/main.r", "r"],
      ["/main.R", "r"],
      ["/main.sql", "sql"],
      ["/main.graphql", "graphql"],
      ["/main.gql", "graphql"],
      ["/main.xml", "xml"],
      ["/main.svg", "xml"],
      ["/main.toml", "toml"],
      ["/main.ini", "ini"],
      ["/main.cfg", "ini"],
      ["/main.lua", "lua"],
      ["/main.vim", "vim"],
      ["/main.el", "lisp"],
      ["/main.clj", "clojure"],
      ["/main.erl", "erlang"],
      ["/main.ex", "elixir"],
      ["/main.exs", "elixir"],
      ["/main.hs", "haskell"],
      ["/main.dart", "dart"],
      ["/main.pl", "perl"],
      ["/main.pm", "perl"],
      ["/main.proto", "protobuf"],
      ["/main.tf", "hcl"],
      ["/main.hcl", "hcl"],
    ];

    it.each(cases)("detects %s as %s", (filePath, expectedLanguage) => {
      expect(detectLanguage(filePath)).toBe(expectedLanguage);
    });
  });

  // ---------------------------------------------------------------------------
  // Special filenames (no extension)
  // ---------------------------------------------------------------------------

  describe("special filenames", () => {
    const cases: Array<[string, string]> = [
      ["/project/Makefile", "makefile"],
      ["/project/Dockerfile", "dockerfile"],
      ["/project/.gitignore", "gitignore"],
      ["/project/.env", "dotenv"],
      ["/project/.env.local", "dotenv"],
      ["/project/.bashrc", "bash"],
      ["/project/.zshrc", "bash"],
      ["/project/.profile", "bash"],
      ["/project/Vagrantfile", "ruby"],
      ["/project/Gemfile", "ruby"],
      ["/project/Rakefile", "ruby"],
      ["/project/Jenkinsfile", "groovy"],
    ];

    it.each(cases)("detects %s as %s", (filePath, expectedLanguage) => {
      expect(detectLanguage(filePath)).toBe(expectedLanguage);
    });
  });

  // ---------------------------------------------------------------------------
  // Case insensitivity
  // ---------------------------------------------------------------------------

  describe("case insensitivity for extensions", () => {
    it("handles uppercase extensions", () => {
      expect(detectLanguage("/FILE.JS")).toBe("javascript");
      expect(detectLanguage("/FILE.PY")).toBe("python");
      expect(detectLanguage("/FILE.TS")).toBe("typescript");
    });

    it("handles mixed case extensions", () => {
      expect(detectLanguage("/file.Ts")).toBe("typescript");
      expect(detectLanguage("/file.Jsx")).toBe("javascript");
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback
  // ---------------------------------------------------------------------------

  describe("fallback to plaintext", () => {
    it("returns 'plaintext' for unknown extensions", () => {
      expect(detectLanguage("/file.xyz")).toBe("plaintext");
      expect(detectLanguage("/file.unknownext")).toBe("plaintext");
    });

    it("returns 'plaintext' for files with no extension and unrecognized name", () => {
      expect(detectLanguage("/some/random/file")).toBe("plaintext");
    });

    it("returns 'plaintext' for empty string", () => {
      expect(detectLanguage("")).toBe("plaintext");
    });
  });

  // ---------------------------------------------------------------------------
  // Path handling
  // ---------------------------------------------------------------------------

  describe("path handling", () => {
    it("handles nested paths correctly", () => {
      expect(detectLanguage("/a/b/c/d/e/index.ts")).toBe("typescript");
    });

    it("handles Windows-style paths", () => {
      expect(detectLanguage("C:\\Users\\test\\index.ts")).toBe("typescript");
    });

    it("handles filenames with dots in them", () => {
      expect(detectLanguage("/test.config.ts")).toBe("typescript");
      expect(detectLanguage("/test.spec.js")).toBe("javascript");
    });

    it("handles files with only extension", () => {
      expect(detectLanguage(".ts")).toBe("typescript");
      expect(detectLanguage(".py")).toBe("python");
    });
  });
});
