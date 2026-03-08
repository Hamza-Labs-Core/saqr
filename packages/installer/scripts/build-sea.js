#!/usr/bin/env node
/**
 * Build a Node.js Single Executable Application (SEA) for Saqr.
 *
 * Uses Node.js 20+ SEA API to create a standalone binary that bundles
 * the daemon and CLI without requiring a system Node.js installation.
 *
 * Steps:
 * 1. Bundle CLI + daemon into a single JS file (esbuild)
 * 2. Generate SEA configuration blob
 * 3. Copy node binary and inject the blob
 *
 * @see https://nodejs.org/api/single-executable-applications.html
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist");
const MONO_ROOT = resolve(ROOT, "../..");

/**
 * Execute a command with explicit args array (no shell interpolation).
 * Uses execFileSync with shell:true so .cmd wrappers (npx, esbuild) work on
 * Windows while still keeping arguments in a safe array (not string-interpolated).
 */
function run(bin, args = [], opts = {}) {
  console.log(`> ${bin} ${args.join(" ")}`);
  execFileSync(bin, args, { stdio: "inherit", shell: true, cwd: ROOT, ...opts });
}

async function main() {
  const platform = process.platform;
  const arch = process.arch;
  const binaryName = platform === "win32" ? "SaqrNest.exe" : "saqrnest";

  console.log(`Building SEA for ${platform}-${arch}...`);

  // 1. Ensure dist directory
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

  // 2. Bundle the CLI entry point with esbuild
  const entryPoint = resolve(MONO_ROOT, "packages/cli/src/bin/saqr.ts");
  const bundlePath = resolve(DIST, "saqr-bundle.js");

  console.log("Bundling with esbuild...");
  run("npx", [
    "esbuild", entryPoint,
    "--bundle", "--platform=node", "--target=node20", "--format=cjs",
    `--outfile=${bundlePath}`, "--external:fsevents",
    `--alias:@saqr/shared=${resolve(MONO_ROOT, "packages/shared/src/index.ts")}`,
    `--alias:@saqr/sync-client=${resolve(MONO_ROOT, "packages/sync-client/src/index.ts")}`,
    `--alias:@saqr/daemon=${resolve(MONO_ROOT, "packages/daemon/src/index.ts")}`,
    `--alias:@saqr/dashboard=${resolve(MONO_ROOT, "packages/dashboard/src/index.ts")}`,
  ]);

  // 3. Generate SEA config
  const seaConfig = {
    main: bundlePath,
    output: resolve(DIST, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  const configPath = resolve(DIST, "sea-config.json");
  writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

  // 4. Generate the blob
  console.log("Generating SEA blob...");
  run("node", ["--experimental-sea-config", configPath]);

  // 5. Copy node binary
  const nodeBin = process.execPath;
  const outputBin = resolve(DIST, binaryName);
  console.log(`Copying node binary to ${outputBin}...`);
  copyFileSync(nodeBin, outputBin);

  // 6. Inject the blob
  console.log("Injecting SEA blob...");
  const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
  const postjectArgs = ["postject", outputBin, "NODE_SEA_BLOB", seaConfig.output, "--sentinel-fuse", SENTINEL_FUSE];

  if (platform === "darwin") {
    run("codesign", ["--remove-signature", outputBin]);
    run("npx", [...postjectArgs, "--macho-segment-name", "NODE_SEA"]);
    run("codesign", ["--sign", "-", outputBin]);
  } else if (platform === "linux") {
    run("npx", postjectArgs);
  } else if (platform === "win32") {
    // signtool remove not needed for unsigned builds
    run("npx", postjectArgs);
  }

  // 7. Stamp Windows PE version info (file properties visible in Explorer)
  if (platform === "win32") {
    console.log("Stamping Windows PE version info...");
    const version = process.env.VERSION ?? "0.1.0";
    // file-version and product-version require X.X.X.X format
    const versionParts = version.replace(/-.*$/, "").split(".");
    while (versionParts.length < 4) versionParts.push("0");
    const fileVersion = versionParts.slice(0, 4).join(".");

    try {
      const rceditMod = await import("rcedit");
      const rcedit = rceditMod.default ?? rceditMod;
      const opts = {
        "file-version": fileVersion,
        "product-version": fileVersion,
        "version-string": {
          CompanyName: "Hamza Labs",
          FileDescription: "SaqrNest — Agent Management Daemon & CLI",
          ProductName: "SaqrNest",
          InternalName: "SaqrNest",
          OriginalFilename: "SaqrNest.exe",
          LegalCopyright: `Copyright \u00A9 2024-${new Date().getFullYear()} Hamza Labs. All rights reserved.`,
        },
        // Note: icon embedding is skipped — rewriting the icon resource section
        // on an 80MB SEA binary causes rcedit to hang for 17+ minutes on CI.
        // The NSIS installer stamps its own icon separately.
      };
      // rcedit v4 is async-only. Add a timeout to prevent CI hangs.
      const RCEDIT_TIMEOUT_MS = 60_000;
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`rcedit timed out after ${RCEDIT_TIMEOUT_MS / 1000}s`)), RCEDIT_TIMEOUT_MS),
      );
      await Promise.race([rcedit(outputBin, opts), timeout]);
      console.log("PE version info stamped.");
    } catch (err) {
      console.warn("Warning: could not stamp PE version info:", err.message);
      console.warn("Install rcedit (npm i -D rcedit) and wine (on Linux/macOS) to embed .exe metadata.");
    }
  }

  console.log(`\nSEA binary built: ${outputBin}`);
  console.log("Done!");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
