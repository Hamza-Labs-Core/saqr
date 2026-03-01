#!/usr/bin/env bash
# Build Windows installer (zip portable + NSIS stub) for Saqr server.
#
# Creates:
# 1. A portable .zip with the saqr.exe binary
# 2. An NSIS installer script (requires NSIS to compile)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DIST="$ROOT/dist"
VERSION="${VERSION:-0.1.0}"

echo "Building Windows installer v${VERSION}..."

# Note: SEA build must be run on Windows for Windows binaries.
# This script generates the installer scaffolding.

# --- Portable zip ---
ZIPDIR="$DIST/saqr-${VERSION}-windows"
rm -rf "$ZIPDIR"
mkdir -p "$ZIPDIR"

# Copy binary (if cross-compiled or exists)
if [ -f "$DIST/saqr.exe" ]; then
  cp "$DIST/saqr.exe" "$ZIPDIR/saqr.exe"
fi

cat > "$ZIPDIR/README.txt" << README
Saqr Server v${VERSION}

Quick Start:
1. Open a terminal (PowerShell or cmd)
2. Run: saqr login
3. Run: saqr daemon start
4. Open the Saqr desktop app or visit https://app.saqr.dev

To add to PATH, move saqr.exe to a directory in your PATH,
or run: setx PATH "%PATH%;%CD%"
README

# Create zip if available
if command -v zip &> /dev/null; then
  cd "$DIST" && zip -r "saqr-${VERSION}-windows.zip" "saqr-${VERSION}-windows"
fi

# --- NSIS script ---
cat > "$DIST/saqr-installer.nsi" << 'NSIS'
!include "MUI2.nsh"

Name "Saqr"
OutFile "saqr-setup.exe"
InstallDir "$LOCALAPPDATA\Saqr"
RequestExecutionLevel user

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath $INSTDIR
  File "saqr.exe"

  ; Add to user PATH
  EnVar::AddValue "PATH" "$INSTDIR"

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Start menu shortcut
  CreateDirectory "$SMPROGRAMS\Saqr"
  CreateShortcut "$SMPROGRAMS\Saqr\Saqr.lnk" "$INSTDIR\saqr.exe"
  CreateShortcut "$SMPROGRAMS\Saqr\Uninstall.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\saqr.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Saqr\Saqr.lnk"
  Delete "$SMPROGRAMS\Saqr\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Saqr"
  EnVar::DeleteValue "PATH" "$INSTDIR"
SectionEnd
NSIS

echo "Windows installer artifacts in $DIST/"
