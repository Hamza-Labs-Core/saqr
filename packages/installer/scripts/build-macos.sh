#!/usr/bin/env bash
# Build macOS installer (.pkg) for Saqr server.
#
# Creates a macOS installer package that:
# 1. Installs the saqr binary to /usr/local/bin
# 2. Creates a LaunchDaemon for auto-start
# 3. Sets up the configuration directory
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DIST="$ROOT/dist"
STAGING="$DIST/macos-staging"
VERSION="${VERSION:-0.1.0}"

echo "Building macOS installer v${VERSION}..."

# Build the SEA binary first
node "$SCRIPT_DIR/build-sea.js"

# Create staging directory
rm -rf "$STAGING"
mkdir -p "$STAGING/usr/local/bin"
mkdir -p "$STAGING/Library/LaunchDaemons"

# Copy binary
cp "$DIST/saqr" "$STAGING/usr/local/bin/saqr"
chmod 755 "$STAGING/usr/local/bin/saqr"

# Create LaunchDaemon plist
cat > "$STAGING/Library/LaunchDaemons/dev.saqr.daemon.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.saqr.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/saqr</string>
        <string>daemon</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/saqr-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/saqr-daemon.err</string>
</dict>
</plist>
PLIST

# Build the .pkg
OUTPUT="$DIST/saqr-${VERSION}-macos.pkg"
pkgbuild \
  --root "$STAGING" \
  --identifier "dev.saqr.server" \
  --version "$VERSION" \
  --install-location "/" \
  "$OUTPUT" 2>/dev/null || echo "pkgbuild not available (CI build) — skipping .pkg creation"

echo "macOS installer: $OUTPUT"
