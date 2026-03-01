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
import { execSync } from "node:child_process";
import { writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist");
const MONO_ROOT = resolve(ROOT, "../..");

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

async function main() {
  const platform = process.platform;
  const arch = process.arch;
  const binaryName = platform === "win32" ? "saqr.exe" : "saqr";

  console.log(`Building SEA for ${platform}-${arch}...`);

  // 1. Ensure dist directory
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

  // 2. Bundle the CLI entry point with esbuild
  const entryPoint = resolve(MONO_ROOT, "packages/cli/src/bin/saqr.ts");
  const bundlePath = resolve(DIST, "saqr-bundle.js");

  console.log("Bundling with esbuild...");
  run(`npx esbuild "${entryPoint}" --bundle --platform=node --target=node20 --format=cjs --outfile="${bundlePath}" --external:fsevents`);

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
  run(`node --experimental-sea-config "${configPath}"`);

  // 5. Copy node binary
  const nodeBin = process.execPath;
  const outputBin = resolve(DIST, binaryName);
  console.log(`Copying node binary to ${outputBin}...`);
  copyFileSync(nodeBin, outputBin);

  // 6. Inject the blob
  console.log("Injecting SEA blob...");
  if (platform === "darwin") {
    run(`codesign --remove-signature "${outputBin}"`);
    run(`npx postject "${outputBin}" NODE_SEA_BLOB "${seaConfig.output}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`);
    run(`codesign --sign - "${outputBin}"`);
  } else if (platform === "linux") {
    run(`npx postject "${outputBin}" NODE_SEA_BLOB "${seaConfig.output}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`);
  } else if (platform === "win32") {
    // signtool remove not needed for unsigned builds
    run(`npx postject "${outputBin}" NODE_SEA_BLOB "${seaConfig.output}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`);
  }

  console.log(`\nSEA binary built: ${outputBin}`);
  console.log("Done!");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
