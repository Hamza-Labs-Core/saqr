#!/usr/bin/env bash
# Build Windows installer (zip portable + NSIS installer) for Saqr server.
#
# Creates:
# 1. A portable .zip with the saqr.exe binary
# 2. An NSIS installer (.exe) — compiled if makensis is available
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DIST="$ROOT/dist"
VERSION="${VERSION:-0.1.0}"
# VIProductVersion requires strict X.X.X.X numeric format — strip prerelease suffix
VI_VERSION="${VERSION%%-*}.0"

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
  cd "$SCRIPT_DIR"
fi

# --- NSIS script ---
# Use heredoc with variable substitution for VERSION, but escape NSIS $ variables
cat > "$DIST/saqr-installer.nsi" << NSIS
!include "MUI2.nsh"
!include "WinMessages.nsh"
!include "WordFunc.nsh"

!define VERSION "${VERSION}"
!define PRODUCT_NAME "Saqr"
!define PRODUCT_PUBLISHER "Hamza Labs"

Name "\${PRODUCT_NAME}"
OutFile "saqr-setup.exe"
InstallDir "\$LOCALAPPDATA\\Saqr"
RequestExecutionLevel user

; Version info embedded in .exe
VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName" "\${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "\${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "Saqr Agent Server"
VIAddVersionKey "FileVersion" "\${VERSION}"
VIAddVersionKey "ProductVersion" "\${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright Hamza Labs"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath \$INSTDIR
  File "saqr.exe"

  ; Add to user PATH via registry (no EnVar plugin needed)
  ReadRegStr \$0 HKCU "Environment" "Path"
  StrCmp \$0 "" 0 +2
    StrCpy \$0 ""
  StrCpy \$0 "\$0;\$INSTDIR"
  WriteRegStr HKCU "Environment" "Path" "\$0"
  ; Broadcast change so running processes pick up new PATH
  SendMessage \${HWND_BROADCAST} \${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Create uninstaller
  WriteUninstaller "\$INSTDIR\\uninstall.exe"

  ; Start menu shortcuts
  CreateDirectory "\$SMPROGRAMS\\Saqr"
  CreateShortcut "\$SMPROGRAMS\\Saqr\\Saqr.lnk" "\$INSTDIR\\saqr.exe"
  CreateShortcut "\$SMPROGRAMS\\Saqr\\Uninstall.lnk" "\$INSTDIR\\uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Saqr" "DisplayName" "\${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Saqr" "UninstallString" "\$INSTDIR\\uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Saqr" "DisplayVersion" "\${VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Saqr" "Publisher" "\${PRODUCT_PUBLISHER}"
SectionEnd

Section "Uninstall"
  Delete "\$INSTDIR\\saqr.exe"
  Delete "\$INSTDIR\\uninstall.exe"
  RMDir "\$INSTDIR"

  Delete "\$SMPROGRAMS\\Saqr\\Saqr.lnk"
  Delete "\$SMPROGRAMS\\Saqr\\Uninstall.lnk"
  RMDir "\$SMPROGRAMS\\Saqr"

  ; Remove from user PATH
  ReadRegStr \$0 HKCU "Environment" "Path"
  ; Remove our install dir from the PATH string
  \${WordReplace} "\$0" ";\$INSTDIR" "" "+" \$0
  \${WordReplace} "\$0" "\$INSTDIR;" "" "+" \$0
  \${WordReplace} "\$0" "\$INSTDIR" "" "+" \$0
  WriteRegStr HKCU "Environment" "Path" "\$0"
  SendMessage \${HWND_BROADCAST} \${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Remove Add/Remove Programs entry
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Saqr"
SectionEnd
NSIS

# --- Compile NSIS installer ---
if command -v makensis &>/dev/null; then
  echo "Compiling NSIS installer..."
  makensis "$DIST/saqr-installer.nsi"
  mv "$DIST/saqr-setup.exe" "$DIST/SaqrNest.exe"
  echo "Installer: $DIST/SaqrNest.exe"
else
  echo "makensis not found — NSIS script generated but not compiled"
  echo "Install NSIS to compile: choco install nsis (Windows) or apt install nsis (Linux)"
fi

echo "Windows installer artifacts in $DIST/"
