#!/usr/bin/env node
// Generate all app icons from the brand logo source.
// Usage: node scripts/generate-icons.mjs
//
// Requires: pnpm add -D -w sharp to-ico

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import sharp from 'sharp';
import toIco from 'to-ico';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCE = join(ROOT, 'assets', 'Logo-small.png');

if (!existsSync(SOURCE)) {
  console.error(`Source image not found: ${SOURCE}`);
  process.exit(1);
}

const src = readFileSync(SOURCE);

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

async function resize(size) {
  return sharp(src)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function main() {
  console.log('Generating icons from', SOURCE);

  // ─── Mobile icons ───────────────────────────────────────────────────
  const mobileDir = join(ROOT, 'packages', 'mobile', 'assets');
  ensureDir(mobileDir);

  const mobileTargets = [
    { name: 'icon.png', size: 1024 },
    { name: 'adaptive-icon.png', size: 1024 },
    { name: 'favicon.png', size: 48 },
    { name: 'splash-icon.png', size: 200 },
  ];

  for (const { name, size } of mobileTargets) {
    const buf = await resize(size);
    writeFileSync(join(mobileDir, name), buf);
    console.log(`  mobile/${name} (${size}x${size})`);
  }

  // ─── Desktop icons ──────────────────────────────────────────────────
  const desktopDir = join(ROOT, 'packages', 'desktop', 'src-tauri', 'icons');
  ensureDir(desktopDir);

  const desktopPngs = [
    { name: '32x32.png', size: 32 },
    { name: '128x128.png', size: 128 },
    { name: '128x128@2x.png', size: 256 },
    { name: 'icon.png', size: 512 },
  ];

  for (const { name, size } of desktopPngs) {
    const buf = await resize(size);
    writeFileSync(join(desktopDir, name), buf);
    console.log(`  desktop/${name} (${size}x${size})`);
  }

  // icon.ico — multi-resolution Windows icon
  const icoSizes = [16, 32, 48, 256];
  const icoBuffers = await Promise.all(icoSizes.map((s) => resize(s)));
  const ico = await toIco(icoBuffers);
  writeFileSync(join(desktopDir, 'icon.ico'), ico);
  console.log(`  desktop/icon.ico (${icoSizes.join(',')})`);

  // icon.icns — macOS icon bundle (requires png2icns)
  try {
    execSync('command -v png2icns', { stdio: 'ignore' });
    // png2icns needs specific sizes: 16, 32, 128, 256, 512
    const icnsSizes = [16, 32, 128, 256, 512];
    const tmpFiles = [];
    for (const size of icnsSizes) {
      const tmpPath = join(desktopDir, `_tmp_${size}.png`);
      writeFileSync(tmpPath, await resize(size));
      tmpFiles.push(tmpPath);
    }
    const icnsPath = join(desktopDir, 'icon.icns');
    execSync(`png2icns ${icnsPath} ${tmpFiles.join(' ')}`, { stdio: 'inherit' });
    // Cleanup temp files
    for (const f of tmpFiles) {
      try { execSync(`rm ${f}`, { stdio: 'ignore' }); } catch {}
    }
    console.log('  desktop/icon.icns (multi-res)');
  } catch {
    console.warn('  ⚠ png2icns not found — skipping icon.icns generation');
    console.warn('    Install: sudo apt install icnsutils (Linux) or brew install libicns (macOS)');
  }

  // ─── Website favicons ──────────────────────────────────────────────
  const webDir = join(ROOT, 'packages', 'website', 'public');
  ensureDir(webDir);

  const webTargets = [
    { name: 'favicon.png', size: 32 },
    { name: 'apple-touch-icon.png', size: 180 },
  ];

  for (const { name, size } of webTargets) {
    const buf = await resize(size);
    writeFileSync(join(webDir, name), buf);
    console.log(`  website/${name} (${size}x${size})`);
  }

  // favicon.ico
  const faviconIco = await toIco([await resize(32)]);
  writeFileSync(join(webDir, 'favicon.ico'), faviconIco);
  console.log('  website/favicon.ico (32)');

  console.log('\nDone! All icons generated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
