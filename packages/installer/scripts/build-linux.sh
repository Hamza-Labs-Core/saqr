#!/usr/bin/env bash
# Build Linux installer (.deb + .tar.gz) for SaqrNest.
#
# Creates:
# 1. A .deb package with systemd service + desktop entry
# 2. A .tar.gz portable archive
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DIST="$ROOT/dist"
STAGING="$DIST/linux-staging"
VERSION="${VERSION:-0.1.0}"
ARCH="${ARCH:-amd64}"

echo "Building Linux installer v${VERSION} (${ARCH})..."

# Build the SEA binary first
node "$SCRIPT_DIR/build-sea.js"

# --- Portable tar.gz ---
TARDIR="$DIST/SaqrNest-${VERSION}-linux-${ARCH}"
rm -rf "$TARDIR"
mkdir -p "$TARDIR"
cp "$DIST/saqrnest" "$TARDIR/saqrnest"
chmod 755 "$TARDIR/saqrnest"
cat > "$TARDIR/install.sh" << 'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
sudo cp saqrnest /usr/local/bin/saqrnest
sudo chmod 755 /usr/local/bin/saqrnest
echo "SaqrNest installed to /usr/local/bin/saqrnest"
echo "Run: saqrnest login && saqrnest start"
INSTALL
chmod 755 "$TARDIR/install.sh"
tar -czf "$DIST/SaqrNest-${VERSION}-linux-${ARCH}.tar.gz" -C "$DIST" "SaqrNest-${VERSION}-linux-${ARCH}"

# --- .deb package ---
DEB_ROOT="$DIST/deb-staging"
rm -rf "$DEB_ROOT"
mkdir -p "$DEB_ROOT/DEBIAN"
mkdir -p "$DEB_ROOT/usr/local/bin"
mkdir -p "$DEB_ROOT/etc/systemd/system"
mkdir -p "$DEB_ROOT/usr/share/applications"
mkdir -p "$DEB_ROOT/etc/xdg/autostart"

cp "$DIST/saqrnest" "$DEB_ROOT/usr/local/bin/saqrnest"
chmod 755 "$DEB_ROOT/usr/local/bin/saqrnest"

# Debian copyright file
mkdir -p "$DEB_ROOT/usr/share/doc/saqrnest"
cat > "$DEB_ROOT/usr/share/doc/saqrnest/copyright" << COPYRIGHT
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: SaqrNest
Upstream-Contact: Hamza Labs <hello@hamza.dev>
Source: https://github.com/Hamza-Labs-Core/saqr

Files: *
Copyright: 2024-$(date +%Y) Hamza Labs
License: MIT

License: MIT
 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:
 .
 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.
 .
 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
COPYRIGHT

# Copy tray binary if available
if [ -f "$DIST/saqrnest-ui" ]; then
  cp "$DIST/saqrnest-ui" "$DEB_ROOT/usr/local/bin/saqrnest-ui"
  chmod 755 "$DEB_ROOT/usr/local/bin/saqrnest-ui"
fi

# Calculate installed size in KB
INSTALLED_SIZE=$(du -sk "$DEB_ROOT" 2>/dev/null | cut -f1)
INSTALLED_SIZE="${INSTALLED_SIZE:-10240}"

# Control file
cat > "$DEB_ROOT/DEBIAN/control" << CONTROL
Package: saqrnest
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${INSTALLED_SIZE}
Maintainer: Hamza Labs <hello@hamza.dev>
Homepage: https://saqr.dev
Description: SaqrNest — agent management daemon + CLI
 Multi-agent management platform with terminal-faithful UI.
 Includes daemon, CLI, and tray application.
 .
 Copyright (c) 2024-$(date +%Y) Hamza Labs. All rights reserved.
CONTROL

# Systemd service
cat > "$DEB_ROOT/etc/systemd/system/saqrnest.service" << SERVICE
[Unit]
Description=SaqrNest Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/saqrnest start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

# Desktop entry for tray UI
cat > "$DEB_ROOT/usr/share/applications/saqrnest-ui.desktop" << DESKTOP
[Desktop Entry]
Name=SaqrNest
Comment=SaqrNest system tray application
Exec=/usr/local/bin/saqrnest-ui
Icon=saqrnest
Type=Application
Categories=Development;Utility;
StartupNotify=false
DESKTOP

# Autostart entry for tray UI
cat > "$DEB_ROOT/etc/xdg/autostart/saqrnest-ui.desktop" << AUTOSTART
[Desktop Entry]
Name=SaqrNest
Comment=SaqrNest system tray application
Exec=/usr/local/bin/saqrnest-ui
Icon=saqrnest
Type=Application
X-GNOME-Autostart-enabled=true
AUTOSTART

# Pre-remove script
cat > "$DEB_ROOT/DEBIAN/prerm" << 'PRERM'
#!/bin/bash
systemctl stop saqrnest 2>/dev/null || true
pkill -f saqrnest-ui 2>/dev/null || true
exit 0
PRERM
chmod 755 "$DEB_ROOT/DEBIAN/prerm"

# Post-install script
cat > "$DEB_ROOT/DEBIAN/postinst" << 'POSTINST'
#!/bin/bash
systemctl daemon-reload
echo "SaqrNest installed."
echo "Run: saqrnest login && saqrnest start"
echo "Or enable the service: sudo systemctl enable --now saqrnest"
POSTINST
chmod 755 "$DEB_ROOT/DEBIAN/postinst"

dpkg-deb --build "$DEB_ROOT" "$DIST/SaqrNest-Installer-${VERSION}-linux-${ARCH}.deb" 2>/dev/null || echo "dpkg-deb not available — skipping .deb creation"

echo "Linux installers built in $DIST/"
