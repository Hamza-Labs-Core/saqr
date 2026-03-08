/**
 * Tests for installer configuration and generator functions.
 */
import { describe, it, expect } from "vitest";
import {
  detectPlatform,
  generateSeaConfig,
  generateSystemdUnit,
  generateLaunchDaemonPlist,
  generateDebianControl,
} from "./installer-config.js";

describe("detectPlatform", () => {
  it("returns valid config for current platform", () => {
    const config = detectPlatform();
    expect(config.version).toBe("0.1.0");
    expect(["darwin", "linux", "win32"]).toContain(config.platform);
    expect(["x64", "arm64"]).toContain(config.arch);
    expect(config.binaryName).toBeTruthy();
    expect(config.installDir).toBeTruthy();
  });

  it("binary name is saqrnest on unix", () => {
    const config = detectPlatform();
    if (config.platform !== "win32") {
      expect(config.binaryName).toBe("saqrnest");
    }
  });

  it("install dir is /usr/local/bin on unix", () => {
    const config = detectPlatform();
    if (config.platform !== "win32") {
      expect(config.installDir).toBe("/usr/local/bin");
    }
  });
});

describe("generateSeaConfig", () => {
  it("generates valid SEA config", () => {
    const config = generateSeaConfig("/dist/bundle.js", "/dist/sea-prep.blob");
    expect(config.main).toBe("/dist/bundle.js");
    expect(config.output).toBe("/dist/sea-prep.blob");
    expect(config.disableExperimentalSEAWarning).toBe(true);
    expect(config.useSnapshot).toBe(false);
    expect(config.useCodeCache).toBe(true);
  });
});

describe("generateSystemdUnit", () => {
  it("generates valid systemd unit", () => {
    const unit = generateSystemdUnit("/usr/local/bin/saqrnest");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("ExecStart=/usr/local/bin/saqrnest start --foreground");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});

describe("generateLaunchDaemonPlist", () => {
  it("generates valid plist", () => {
    const plist = generateLaunchDaemonPlist("/usr/local/bin/saqrnest");
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>dev.hamzalabs.saqrnest.daemon</string>");
    expect(plist).toContain("<string>/usr/local/bin/saqrnest</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
  });
});

describe("build-windows.sh NSIS template", () => {
  it("VIProductVersion uses numeric-only X.X.X.X format even for prerelease versions", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const script = readFileSync(
      resolve(__dirname, "../scripts/build-windows.sh"),
      "utf-8",
    );

    // The script must strip prerelease suffixes (e.g. "0.1.44-pr.3") from
    // VIProductVersion, since NSIS requires strict X.X.X.X numeric format.
    // It should use a sanitized variable, not raw ${VERSION}.0
    expect(script).toMatch(/VI_VERSION/);
    expect(script).not.toMatch(/VIProductVersion "\$\{VERSION\}\.0"/);
  });
});

describe("build-sea.js", () => {
  it("bundles with CJS format (SEA requires CommonJS)", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const script = readFileSync(
      resolve(__dirname, "../scripts/build-sea.js"),
      "utf-8",
    );
    // SEA blobs cannot use ESM — Node.js loads them as scripts, not modules.
    // --format=esm would produce `import` statements that cause:
    //   "SyntaxError: Cannot use import statement outside a module"
    expect(script).toContain("--format=cjs");
    expect(script).not.toMatch(/--format=esm/);
  });

  it("uses execFileSync instead of execSync to avoid shell injection", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const script = readFileSync(
      resolve(__dirname, "../scripts/build-sea.js"),
      "utf-8",
    );
    // execSync(string) passes the command through a shell, which can interpret
    // metacharacters in file paths. execFileSync(bin, args) executes directly.
    expect(script).toContain("execFileSync");
    expect(script).not.toMatch(/\bexecSync\b/);
  });

  it("does not hardcode npx.cmd (use shell: true for cross-platform)", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const script = readFileSync(
      resolve(__dirname, "../scripts/build-sea.js"),
      "utf-8",
    );
    // npx.cmd is a Windows-only batch wrapper — execFileSync cannot run .cmd
    // files directly. Instead, use execFileSync with shell: true which handles
    // .cmd resolution on Windows while keeping args as a safe array.
    expect(script).not.toContain("npx.cmd");
  });
});

describe("CLI login command security", () => {
  it("uses execFile (not exec) for browser opening to prevent command injection", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const login = readFileSync(
      resolve(__dirname, "../../cli/src/commands/login.ts"),
      "utf-8",
    );
    // exec(string) passes the command through a shell — a malicious sync server
    // could inject shell commands via verification_uri_complete.
    // execFile(bin, args) bypasses the shell entirely.
    expect(login).toContain("execFile");
    expect(login).not.toMatch(/\bexec\b\(/);
    expect(login).not.toMatch(/from ["']node:child_process["'].*\bexec\b[^F]/);
    // cmd.exe is a shell — execFile("cmd", ...) still allows injection
    expect(login).not.toMatch(/execFile\(["']cmd/);
  });

  it("validates URL scheme before opening browser", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const login = readFileSync(
      resolve(__dirname, "../../cli/src/commands/login.ts"),
      "utf-8",
    );
    // Must validate that only http: and https: URLs are opened
    expect(login).toContain('parsed.protocol !== "https:"');
    expect(login).toContain('parsed.protocol !== "http:"');
  });
});

describe("CLI entry point SEA compatibility", () => {
  it("does not use import.meta at top-level (breaks CJS SEA bundle)", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const entry = readFileSync(
      resolve(__dirname, "../../cli/src/bin/saqr.ts"),
      "utf-8",
    );
    // import.meta.url is empty when bundled with --format=cjs, which causes
    // fileURLToPath(import.meta.url) to throw at runtime. The main() guard
    // must use a CJS-compatible check instead.
    expect(entry).not.toMatch(/fileURLToPath\(import\.meta\.url\)/);
  });

  it("workspace packages used by CLI are bundleable by esbuild", () => {
    const { readFileSync, existsSync } = require("node:fs");
    const { resolve } = require("node:path");
    // Verify all @saqr/* imports in CLI commands can be resolved from source
    // (not dist/) since the SEA build bundles from TypeScript source
    const srcDir = resolve(__dirname, "../../cli/src/commands");
    const commands = ["login.ts", "logout.ts", "start.ts", "status.ts", "stop.ts"];
    for (const cmd of commands) {
      const filePath = resolve(srcDir, cmd);
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, "utf-8");
      // Static imports of @saqr/* must be resolvable by esbuild
      const staticImports = content.match(/from ["']@saqr\/[^"']+["']/g) || [];
      for (const imp of staticImports) {
        const pkg = imp.match(/@saqr\/([^"']+)/)?.[1];
        // Verify the package's src/index.ts exists (esbuild resolves from source)
        const srcIndex = resolve(__dirname, `../../${pkg}/src/index.ts`);
        expect(existsSync(srcIndex), `${cmd}: ${imp} — missing ${srcIndex}`).toBe(true);
      }
    }
  });
});

describe("generateDebianControl", () => {
  it("generates valid control file", () => {
    const control = generateDebianControl("0.1.0", "amd64");
    expect(control).toContain("Package: saqrnest");
    expect(control).toContain("Version: 0.1.0");
    expect(control).toContain("Architecture: amd64");
    expect(control).toContain("Maintainer: Hamza Labs");
    expect(control).toContain("Description: SaqrNest");
  });

  it("uses provided version and arch", () => {
    const control = generateDebianControl("1.2.3", "arm64");
    expect(control).toContain("Version: 1.2.3");
    expect(control).toContain("Architecture: arm64");
  });
});
