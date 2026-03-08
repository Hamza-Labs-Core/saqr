/**
 * Installer configuration and platform detection.
 */

export interface InstallerConfig {
  version: string;
  platform: "darwin" | "linux" | "win32";
  arch: "x64" | "arm64";
  binaryName: string;
  installDir: string;
}

export function detectPlatform(): InstallerConfig {
  const platform = process.platform as "darwin" | "linux" | "win32";
  const arch = process.arch as "x64" | "arm64";
  const binaryName = platform === "win32" ? "SaqrNest.exe" : "saqrnest";

  const installDir = platform === "darwin"
    ? "/usr/local/bin"
    : platform === "linux"
    ? "/usr/local/bin"
    : `${process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local"}\\SaqrNest`;

  return {
    version: process.env.VERSION ?? "0.1.0",
    platform,
    arch,
    binaryName,
    installDir,
  };
}

/**
 * Generate the SEA (Single Executable Application) config.
 */
export interface SeaConfig {
  main: string;
  output: string;
  disableExperimentalSEAWarning: boolean;
  useSnapshot: boolean;
  useCodeCache: boolean;
}

export function generateSeaConfig(bundlePath: string, blobPath: string): SeaConfig {
  return {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
}

/**
 * Generate systemd service unit content.
 */
export function generateSystemdUnit(binaryPath: string): string {
  return `[Unit]
Description=SaqrNest Daemon
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath} start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate macOS LaunchDaemon plist content.
 */
export function generateLaunchDaemonPlist(binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.hamzalabs.saqrnest.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${binaryPath}</string>
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
`;
}

/**
 * Generate Debian control file content.
 */
export function generateDebianControl(version: string, arch: string): string {
  return `Package: saqrnest
Version: ${version}
Section: devel
Priority: optional
Architecture: ${arch}
Maintainer: Hamza Labs <hello@hamza.dev>
Homepage: https://saqr.dev
Description: SaqrNest — agent management daemon + CLI
 Multi-agent management platform with terminal-faithful UI.
 Includes daemon, CLI, and tray application.
`;
}
