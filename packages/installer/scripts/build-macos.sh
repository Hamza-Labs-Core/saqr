#!/usr/bin/env bash
# Build macOS installer (.pkg) for SaqrNest.
#
# Creates a macOS installer package that:
# 1. Installs the saqrnest binary to /usr/local/bin
# 2. Installs SaqrNestUI.app to /Applications (if available)
# 3. Creates a LaunchDaemon for auto-start
# 4. Creates a LaunchAgent for tray UI at login
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
mkdir -p "$STAGING/Library/LaunchAgents"

# Copy binary
cp "$DIST/saqrnest" "$STAGING/usr/local/bin/saqrnest"
chmod 755 "$STAGING/usr/local/bin/saqrnest"

# Copy tray app if available
if [ -d "$DIST/SaqrNestUI.app" ]; then
  mkdir -p "$STAGING/Applications"
  cp -R "$DIST/SaqrNestUI.app" "$STAGING/Applications/SaqrNestUI.app"
fi

# Create preinstall script
mkdir -p "$DIST/scripts"
cat > "$DIST/scripts/preinstall" << 'PREINST'
#!/bin/bash
# Stop existing daemon and tray
launchctl unload /Library/LaunchDaemons/dev.hamzalabs.saqrnest.daemon.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/dev.hamzalabs.saqrnest.ui.plist 2>/dev/null || true
pkill -f SaqrNestUI 2>/dev/null || true
/usr/local/bin/saqrnest stop 2>/dev/null || true
exit 0
PREINST
chmod 755 "$DIST/scripts/preinstall"

# Create LaunchDaemon plist
cat > "$STAGING/Library/LaunchDaemons/dev.hamzalabs.saqrnest.daemon.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.hamzalabs.saqrnest.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/saqrnest</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/saqrnest-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/saqrnest-daemon.err</string>
</dict>
</plist>
PLIST

# Create LaunchAgent for tray UI
cat > "$STAGING/Library/LaunchAgents/dev.hamzalabs.saqrnest.ui.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.hamzalabs.saqrnest.ui</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/SaqrNestUI.app/Contents/MacOS/SaqrNestUI</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
PLIST

# Build component .pkg
COMPONENT_PKG="$DIST/saqrnest-component.pkg"
pkgbuild \
  --root "$STAGING" \
  --identifier "dev.hamzalabs.saqrnest" \
  --version "$VERSION" \
  --install-location "/" \
  --scripts "$DIST/scripts" \
  "$COMPONENT_PKG" 2>/dev/null || {
    echo "pkgbuild not available (CI build) — skipping .pkg creation"
    echo "macOS installer: (skipped)"
    exit 0
  }

# Create distribution XML for productbuild (adds welcome, license, branding)
COPYRIGHT_YEAR="$(date +%Y)"
cat > "$DIST/distribution.xml" << DISTXML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>SaqrNest v${VERSION}</title>
    <organization>dev.hamzalabs</organization>
    <domains enable_localSystem="true"/>
    <options customize="never" require-scripts="true" rootVolumeOnly="true"/>
    <welcome file="welcome.html" mime-type="text/html"/>
    <license file="license.txt" mime-type="text/plain"/>
    <pkg-ref id="dev.hamzalabs.saqrnest"/>
    <choices-outline>
        <line choice="default">
            <line choice="dev.hamzalabs.saqrnest"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="dev.hamzalabs.saqrnest" visible="false">
        <pkg-ref id="dev.hamzalabs.saqrnest"/>
    </choice>
    <pkg-ref id="dev.hamzalabs.saqrnest" version="${VERSION}" onConclusion="none">saqrnest-component.pkg</pkg-ref>
</installer-gui-script>
DISTXML

# Welcome HTML
cat > "$DIST/welcome.html" << WELCOME
<html><body style="font-family: -apple-system, Helvetica Neue, sans-serif; font-size: 14px;">
<h2>SaqrNest v${VERSION}</h2>
<p>Agent management daemon &amp; CLI by <strong>Hamza Labs</strong>.</p>
<p>This installer will set up:</p>
<ul>
<li><code>saqrnest</code> CLI binary</li>
<li>LaunchDaemon for auto-start</li>
<li>SaqrNestUI tray app (if included)</li>
</ul>
<p style="color: #888; font-size: 11px;">Copyright &copy; 2024-${COPYRIGHT_YEAR} Hamza Labs. All rights reserved.</p>
</body></html>
WELCOME

# License text
cat > "$DIST/license.txt" << 'LICENSE'
MIT License

Copyright (c) 2024 Hamza Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
LICENSE

# Build distribution .pkg (wraps component + adds welcome/license)
OUTPUT="$DIST/SaqrNest-Installer-${VERSION}-macos-universal.pkg"
productbuild \
  --distribution "$DIST/distribution.xml" \
  --resources "$DIST" \
  --package-path "$DIST" \
  "$OUTPUT" 2>/dev/null || {
    # Fallback: use component .pkg directly if productbuild unavailable
    mv "$COMPONENT_PKG" "$OUTPUT"
  }

# Clean up intermediate files
rm -f "$COMPONENT_PKG" "$DIST/distribution.xml" "$DIST/welcome.html" "$DIST/license.txt"

echo "macOS installer: $OUTPUT"
