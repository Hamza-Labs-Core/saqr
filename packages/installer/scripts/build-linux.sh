#!/usr/bin/env bash
# Build Linux installer (.deb + .tar.gz) for Saqr server.
#
# Creates:
# 1. A .deb package with systemd service
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
TARDIR="$DIST/saqr-${VERSION}-linux-${ARCH}"
rm -rf "$TARDIR"
mkdir -p "$TARDIR"
cp "$DIST/saqr" "$TARDIR/saqr"
chmod 755 "$TARDIR/saqr"
cat > "$TARDIR/install.sh" << 'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
sudo cp saqr /usr/local/bin/saqr
sudo chmod 755 /usr/local/bin/saqr
echo "Saqr installed to /usr/local/bin/saqr"
echo "Run: saqr login && saqr daemon start"
INSTALL
chmod 755 "$TARDIR/install.sh"
tar -czf "$DIST/saqr-${VERSION}-linux-${ARCH}.tar.gz" -C "$DIST" "saqr-${VERSION}-linux-${ARCH}"

# --- .deb package ---
DEB_ROOT="$DIST/deb-staging"
rm -rf "$DEB_ROOT"
mkdir -p "$DEB_ROOT/DEBIAN"
mkdir -p "$DEB_ROOT/usr/local/bin"
mkdir -p "$DEB_ROOT/etc/systemd/system"

cp "$DIST/saqr" "$DEB_ROOT/usr/local/bin/saqr"
chmod 755 "$DEB_ROOT/usr/local/bin/saqr"

# Control file
cat > "$DEB_ROOT/DEBIAN/control" << CONTROL
Package: saqr
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Maintainer: Hamza Labs <hello@hamza.dev>
Description: Saqr agent management platform - server daemon + CLI
 Remote agent management with terminal-faithful UI.
 Includes daemon, CLI, and development tools.
CONTROL

# Systemd service
cat > "$DEB_ROOT/etc/systemd/system/saqr-daemon.service" << SERVICE
[Unit]
Description=Saqr Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/saqr daemon start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

# Post-install script
cat > "$DEB_ROOT/DEBIAN/postinst" << 'POSTINST'
#!/bin/bash
systemctl daemon-reload
echo "Saqr installed. Run: saqr login && saqr daemon start"
echo "Or enable the service: sudo systemctl enable --now saqr-daemon"
POSTINST
chmod 755 "$DEB_ROOT/DEBIAN/postinst"

dpkg-deb --build "$DEB_ROOT" "$DIST/saqr-${VERSION}-linux-${ARCH}.deb" 2>/dev/null || echo "dpkg-deb not available — skipping .deb creation"

echo "Linux installers built in $DIST/"
