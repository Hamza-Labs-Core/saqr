#!/usr/bin/env bash
# Build Windows installer (zip portable + NSIS installer) for SaqrNest.
#
# Creates:
# 1. A portable .zip with the SaqrNest.exe binary
# 2. An NSIS installer (.exe) — compiled if makensis is available
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
DIST="$ROOT/dist"
VERSION="${VERSION:-0.1.0}"
# VIProductVersion requires strict X.X.X.X numeric format — strip prerelease suffix
VI_VERSION="${VERSION%%-*}.0"
COPYRIGHT_YEAR="$(date +%Y)"

echo "Building Windows installer v${VERSION}..."

# Note: SEA build must be run on Windows for Windows binaries.
# This script generates the installer scaffolding.

# --- Portable zip ---
ZIPDIR="$DIST/SaqrNest-${VERSION}-windows-x64"
rm -rf "$ZIPDIR"
mkdir -p "$ZIPDIR"

# Copy binary (if cross-compiled or exists)
if [ -f "$DIST/SaqrNest.exe" ]; then
  cp "$DIST/SaqrNest.exe" "$ZIPDIR/SaqrNest.exe"
fi

cat > "$ZIPDIR/README.txt" << README
SaqrNest v${VERSION}

Quick Start:
1. Open a terminal (PowerShell or cmd)
2. Run: saqrnest login
3. Run: saqrnest start
4. Open the Saqr desktop app or visit https://app.saqr.dev

To add to PATH, move SaqrNest.exe to a directory in your PATH,
or run: setx PATH "%PATH%;%CD%"
README

# Create zip if available
if command -v zip &> /dev/null; then
  cd "$DIST" && zip -r "SaqrNest-${VERSION}-windows-x64.zip" "SaqrNest-${VERSION}-windows-x64"
  cd "$SCRIPT_DIR"
fi

# --- NSIS script ---
# Use heredoc with variable substitution for VERSION, but escape NSIS $ variables
cat > "$DIST/saqrnest-installer.nsi" << NSIS
!include "MUI2.nsh"
!include "WinMessages.nsh"
!include "WordFunc.nsh"

!define VERSION "${VERSION}"
!define PRODUCT_NAME "SaqrNest"
!define PRODUCT_PUBLISHER "Hamza Labs"

Name "\${PRODUCT_NAME}"
OutFile "SaqrNest-Installer-${VERSION}-windows-x64.exe"
InstallDir "\$LOCALAPPDATA\\SaqrNest"
RequestExecutionLevel user

; Version info embedded in .exe
VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName" "\${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "\${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "SaqrNest — Agent Management Daemon & CLI"
VIAddVersionKey "FileVersion" "\${VERSION}"
VIAddVersionKey "ProductVersion" "\${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright © 2024-${COPYRIGHT_YEAR} Hamza Labs. All rights reserved."
VIAddVersionKey "InternalName" "SaqrNest"
VIAddVersionKey "OriginalFilename" "SaqrNest-Installer-\${VERSION}-windows-x64.exe"
VIAddVersionKey "Comments" "https://saqr.dev"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; --- Auto-uninstall previous version ---
Function .onInit
  ; Stop running daemon
  nsExec::ExecToLog '"\$LOCALAPPDATA\\SaqrNest\\SaqrNest.exe" stop'
  ; Kill tray app
  nsExec::ExecToLog 'taskkill /IM SaqrNestUI.exe /F'

  ; Check if a previous version is installed
  ReadRegStr \$0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest" "UninstallString"
  StrCmp \$0 "" done
    ; Previous installation found — run the uninstaller silently
    ExecWait '"\$0" /S _?=\$INSTDIR'
    Delete "\$0"
  done:
FunctionEnd

Section "Install"
  SetOutPath \$INSTDIR
  File "SaqrNest.exe"
  File /nonfatal "SaqrNestUI.exe"

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
  CreateDirectory "\$SMPROGRAMS\\SaqrNest"
  CreateShortcut "\$SMPROGRAMS\\SaqrNest\\SaqrNest.lnk" "\$INSTDIR\\SaqrNest.exe"
  CreateShortcut "\$SMPROGRAMS\\SaqrNest\\SaqrNestUI.lnk" "\$INSTDIR\\SaqrNestUI.exe"
  CreateShortcut "\$SMPROGRAMS\\SaqrNest\\Uninstall.lnk" "\$INSTDIR\\uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest" "DisplayName" "\${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest" "UninstallString" "\$INSTDIR\\uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest" "DisplayVersion" "\${VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest" "Publisher" "\${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest" "DisplayIcon" "\$INSTDIR\\SaqrNest.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest" "URLInfoAbout" "https://saqr.dev"
SectionEnd

Section "Uninstall"
  ; Stop running processes
  nsExec::ExecToLog '"\$INSTDIR\\SaqrNest.exe" stop'
  nsExec::ExecToLog 'taskkill /IM SaqrNestUI.exe /F'

  Delete "\$INSTDIR\\SaqrNest.exe"
  Delete "\$INSTDIR\\SaqrNestUI.exe"
  Delete "\$INSTDIR\\uninstall.exe"
  RMDir "\$INSTDIR"

  Delete "\$SMPROGRAMS\\SaqrNest\\SaqrNest.lnk"
  Delete "\$SMPROGRAMS\\SaqrNest\\SaqrNestUI.lnk"
  Delete "\$SMPROGRAMS\\SaqrNest\\Uninstall.lnk"
  RMDir "\$SMPROGRAMS\\SaqrNest"

  ; Remove from user PATH
  ReadRegStr \$0 HKCU "Environment" "Path"
  ; Remove our install dir from the PATH string
  \${WordReplace} "\$0" ";\$INSTDIR" "" "+" \$0
  \${WordReplace} "\$0" "\$INSTDIR;" "" "+" \$0
  \${WordReplace} "\$0" "\$INSTDIR" "" "+" \$0
  WriteRegStr HKCU "Environment" "Path" "\$0"
  SendMessage \${HWND_BROADCAST} \${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; Remove Add/Remove Programs entry
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaqrNest"
SectionEnd
NSIS

# --- Compile NSIS installer ---
if command -v makensis &>/dev/null; then
  echo "Compiling NSIS installer..."
  makensis "$DIST/saqrnest-installer.nsi"
  echo "Installer: $DIST/SaqrNest-Installer-${VERSION}-windows-x64.exe"
else
  echo "makensis not found — NSIS script generated but not compiled"
  echo "Install NSIS to compile: choco install nsis (Windows) or apt install nsis (Linux)"
fi

echo "Windows installer artifacts in $DIST/"
