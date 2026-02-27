/**
 * Tests for syntax-highlight utilities.
 */
import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  tokenize,
  tokenTypeToCssVar,
} from "../utils/syntax-highlight.js";

describe("detectLanguage", () => {
  it("detects TypeScript from .ts extension", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
  });

  it("detects TypeScript from .tsx extension", () => {
    expect(detectLanguage("components/App.tsx")).toBe("typescript");
  });

  it("detects JavaScript from .js extension", () => {
    expect(detectLanguage("lib/utils.js")).toBe("javascript");
  });

  it("detects Python from .py extension", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  it("detects Rust from .rs extension", () => {
    expect(detectLanguage("src/lib.rs")).toBe("rust");
  });

  it("detects Go from .go extension", () => {
    expect(detectLanguage("main.go")).toBe("go");
  });

  it("detects shell from .sh extension", () => {
    expect(detectLanguage("scripts/build.sh")).toBe("shell");
  });

  it("detects JSON from .json extension", () => {
    expect(detectLanguage("package.json")).toBe("json");
  });

  it("detects JSONC from .jsonc extension", () => {
    expect(detectLanguage("wrangler.jsonc")).toBe("json");
  });

  it("detects YAML from .yml extension", () => {
    expect(detectLanguage("config.yml")).toBe("yaml");
  });

  it("detects Dockerfile by name", () => {
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
  });

  it("detects Makefile as shell", () => {
    expect(detectLanguage("Makefile")).toBe("shell");
  });

  it("returns plaintext for unknown extensions", () => {
    expect(detectLanguage("data.xyz")).toBe("plaintext");
  });

  it("returns plaintext for empty string", () => {
    expect(detectLanguage("")).toBe("plaintext");
  });

  it("handles deep paths", () => {
    expect(detectLanguage("packages/cli/src/types/timeline.ts")).toBe("typescript");
  });

  it("detects CSS from .css extension", () => {
    expect(detectLanguage("styles.css")).toBe("css");
  });

  it("detects SQL from .sql extension", () => {
    expect(detectLanguage("migrations/001.sql")).toBe("sql");
  });

  it("detects C++ from .cpp extension", () => {
    expect(detectLanguage("main.cpp")).toBe("cpp");
  });

  it("detects C from .c extension", () => {
    expect(detectLanguage("main.c")).toBe("c");
  });
});

describe("tokenize", () => {
  it("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("tokenizes a simple keyword", () => {
    const tokens = tokenize("const x = 1;");
    const keywords = tokens.filter((t) => t.type === "keyword");
    expect(keywords.length).toBeGreaterThanOrEqual(1);
    expect(keywords[0].value).toBe("const");
  });

  it("tokenizes strings", () => {
    const tokens = tokenize('const msg = "hello world";');
    const strings = tokens.filter((t) => t.type === "string");
    expect(strings.length).toBe(1);
    expect(strings[0].value).toBe('"hello world"');
  });

  it("tokenizes numbers", () => {
    const tokens = tokenize("const x = 42;");
    const numbers = tokens.filter((t) => t.type === "number");
    expect(numbers.length).toBe(1);
    expect(numbers[0].value).toBe("42");
  });

  it("tokenizes comments", () => {
    const tokens = tokenize("// this is a comment");
    const comments = tokens.filter((t) => t.type === "comment");
    expect(comments.length).toBe(1);
  });

  it("tokenizes function calls", () => {
    const tokens = tokenize("console.log()");
    const functions = tokens.filter((t) => t.type === "function");
    expect(functions.some((f) => f.value === "log")).toBe(true);
  });

  it("produces non-overlapping tokens that cover the whole input", () => {
    const code = 'const x = 42; // comment\nfunction foo() { return "bar"; }';
    const tokens = tokenize(code);
    const reconstructed = tokens.map((t) => t.value).join("");
    expect(reconstructed).toBe(code);
  });

  it("tokenizes hex numbers", () => {
    const tokens = tokenize("const mask = 0xFF00;");
    const numbers = tokens.filter((t) => t.type === "number");
    expect(numbers.some((n) => n.value === "0xFF00")).toBe(true);
  });
});

describe("tokenTypeToCssVar", () => {
  it("maps keyword to CSS variable", () => {
    expect(tokenTypeToCssVar("keyword")).toBe("var(--saqr-syn-keyword)");
  });

  it("maps string to CSS variable", () => {
    expect(tokenTypeToCssVar("string")).toBe("var(--saqr-syn-string)");
  });

  it("maps number to CSS variable", () => {
    expect(tokenTypeToCssVar("number")).toBe("var(--saqr-syn-number)");
  });

  it("maps comment to CSS variable", () => {
    expect(tokenTypeToCssVar("comment")).toBe("var(--saqr-syn-comment)");
  });

  it("maps function to CSS variable", () => {
    expect(tokenTypeToCssVar("function")).toBe("var(--saqr-syn-function)");
  });

  it("maps operator to CSS variable", () => {
    expect(tokenTypeToCssVar("operator")).toBe("var(--saqr-syn-operator)");
  });

  it("maps punctuation to CSS variable", () => {
    expect(tokenTypeToCssVar("punctuation")).toBe("var(--saqr-syn-punctuation)");
  });

  it("maps text to inherit", () => {
    expect(tokenTypeToCssVar("text")).toBe("inherit");
  });
});
