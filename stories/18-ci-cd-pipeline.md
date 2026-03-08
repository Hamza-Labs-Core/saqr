# Story 18: CI/CD Pipeline — Build, Deploy, Release

## Overview

Stories 16 and 17 produce real mobile and desktop applications. This story builds the CI/CD pipeline that tests, builds, deploys, and releases everything automatically.

The pipeline covers:
- **PR flow**: Run tests → build preview artifacts → deploy server previews → create prerelease
- **Release flow**: Run tests → build production artifacts → deploy servers → tag + changelog + GitHub Release with all binaries attached
- **Server deploys**: Cloudflare Workers (sync-server + admin-server) via Wrangler
- **Mobile builds**: Android APK via Gradle in GitHub Actions, iOS via xcodebuild (not EAS)
- **Desktop builds**: macOS/Windows/Linux via tauri-action in GitHub Actions
- **Web export**: Expo web → Cloudflare Pages

Version format: `0.1.{build}` for releases, `0.1.{build}-pr.{N}` for prereleases. Changelog grouped by conventional commit type. Only last 5 prereleases kept.

**Guiding principle**: All builds happen in GitHub Actions. No external build services (EAS, etc). The pipeline should work for open-source contributors with zero secrets configured — optional jobs are gated on repository variables.

---

## Scope

### In Scope

- Reusable test workflow (ci.yml with workflow_call)
- PR workflow: test → version → server preview → prerelease
- Release workflow: test → version → build all → deploy → release
- Mobile build job (Android APK in GitHub Actions)
- Desktop build jobs (macOS, Windows, Linux via tauri-action)
- Web export + Cloudflare Pages deploy
- Server deploy (sync-server + admin-server via Wrangler)
- Version script (updates package.json, app.json, Cargo.toml)
- Changelog script (groups by conventional commit type)
- Prerelease cleanup script (keeps last N)
- CHANGELOG.md auto-generation
- Git tags + GitHub Releases with all binary assets

### Out of Scope

- App Store / Google Play submission (future story)
- iOS App Store builds (requires Apple Developer Program membership)
- Release signing key generation (documented as prerequisites)
- Monitoring / alerting for deploy failures

---

## Requirements

### 1. Workflow Architecture

```
PR opened/updated → pr-deploy.yml
  ├── test (reusable ci.yml)
  ├── version → 0.1.{N}-pr.{PR}
  ├── deploy-servers-preview (if ENABLE_WRANGLER_DEPLOY)
  └── prerelease (GitHub prerelease + cleanup)

Push to main → release.yml
  ├── test (reusable ci.yml)
  ├── version → 0.1.{N}
  ├── build-mobile-android (if ENABLE_MOBILE_BUILD)
  ├── build-desktop (if ENABLE_DESKTOP_BUILD)
  │   ├── macOS (.dmg)
  │   ├── Windows (.msi, .exe)
  │   └── Linux (.AppImage, .deb)
  ├── deploy-web (if ENABLE_WEB_DEPLOY)
  ├── deploy-servers (if ENABLE_WRANGLER_DEPLOY)
  └── release (changelog + tag + GitHub Release + attach assets)
```

### 2. Version Script (scripts/version.sh)

```bash
# Input: --pr <N> for prerelease, no flag for release
# Uses GITHUB_RUN_NUMBER as build number
# Updates:
#   - package.json (root) → version field
#   - packages/mobile/app.json → expo.version, buildNumber, versionCode
#   - packages/desktop/src-tauri/tauri.conf.json → version
# Writes to $GITHUB_OUTPUT: version, build_number
```

### 3. Mobile Android Build (GitHub Actions)

No EAS. Build directly on ubuntu-latest:

```yaml
steps:
  - Setup Java 17 (temurin)
  - Setup Android SDK (command-line tools)
  - Setup Node.js 22 + pnpm
  - pnpm install
  - Apply version (scripts/version.sh)
  - npx expo prebuild --platform android --no-install
  - cd packages/mobile/android
  - ./gradlew assembleRelease
  - Upload packages/mobile/android/app/build/outputs/apk/release/*.apk
```

Estimated build time: 10-15 minutes.

### 4. Desktop Build (tauri-action)

Three parallel jobs on different runners:

**macOS** (macos-latest):
```yaml
- Setup Node.js 22 + Rust stable
- pnpm install, build dashboard
- tauri-apps/tauri-action@v0
  → Saqr_x.y.z_aarch64.dmg
  → Saqr_aarch64.app.tar.gz + .sig
```

**Windows** (windows-latest):
```yaml
- Setup Node.js 22 + Rust stable
- pnpm install, build dashboard
- tauri-apps/tauri-action@v0
  → Saqr_x.y.z_x64-setup.exe (NSIS)
  → Saqr_x.y.z_x64_en-US.msi (WiX)
```

**Linux** (ubuntu-22.04):
```yaml
- apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
- Setup Node.js 22 + Rust stable
- pnpm install, build dashboard
- tauri-apps/tauri-action@v0
  → Saqr_x.y.z_amd64.AppImage
  → Saqr_x.y.z_amd64.deb
```

### 5. Web Export + Deploy

```yaml
- npx expo export --platform web
- npx wrangler pages deploy packages/mobile/dist --project-name saqr-app
```

### 6. Server Deploy (Wrangler)

Same as current PR implementation:
```yaml
- npx wrangler deploy (sync-server)
- npx wrangler deploy (admin-server)
# Preview env for PRs, production for main
```

### 7. Changelog Script (scripts/changelog.sh)

Groups merged PRs by conventional commit prefix:
- `feat*` → Features
- `fix*` → Fixes
- `docs*` → Docs
- Everything else → Other

Falls back to commit first-lines if no PRs found (gh CLI unavailable).

### 8. Prerelease Cleanup (scripts/cleanup-prereleases.sh)

Keeps the N most recent prereleases (default 5). Deletes older ones including their git tags.

### 9. Release Assets

A production release (e.g., v0.1.42) attaches:

| Asset | Source |
|-------|--------|
| `saqr-v0.1.42-android.apk` | Mobile Android build |
| `Saqr_0.1.42_aarch64.dmg` | macOS desktop |
| `Saqr_aarch64.app.tar.gz` | macOS auto-update |
| `Saqr_aarch64.app.tar.gz.sig` | macOS update signature |
| `Saqr_0.1.42_x64-setup.exe` | Windows desktop (NSIS) |
| `Saqr_0.1.42_x64_en-US.msi` | Windows desktop (WiX) |
| `Saqr_0.1.42_amd64.AppImage` | Linux desktop (portable) |
| `Saqr_0.1.42_amd64.deb` | Linux desktop (Debian) |
| `latest.json` | Tauri auto-update manifest |

---

## Required Secrets and Variables

### Repository Variables (Settings → Variables → Actions)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENABLE_MOBILE_BUILD` | `false` | Gate Android APK build job |
| `ENABLE_DESKTOP_BUILD` | `false` | Gate Tauri desktop build jobs |
| `ENABLE_WEB_DEPLOY` | `false` | Gate Expo web → Cloudflare Pages |
| `ENABLE_WRANGLER_DEPLOY` | `false` | Gate Cloudflare Workers deploy |

### Repository Secrets

| Secret | Required For |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler deploy |
| `APPLE_CERTIFICATE` | macOS code signing |
| `APPLE_CERTIFICATE_PASSWORD` | macOS code signing |
| `APPLE_SIGNING_IDENTITY` | macOS code signing |
| `APPLE_ID` | macOS notarization |
| `APPLE_PASSWORD` | macOS notarization |
| `APPLE_TEAM_ID` | macOS notarization |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri auto-update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri auto-update signatures |

---

## Files

| Action | File |
|--------|------|
| Modify | `.github/workflows/ci.yml` — add workflow_call trigger |
| Create | `.github/workflows/pr-deploy.yml` — PR pipeline |
| Create | `.github/workflows/release.yml` — Release pipeline |
| Create | `scripts/version.sh` — Version computation + apply |
| Create | `scripts/changelog.sh` — Grouped changelog generation |
| Create | `scripts/cleanup-prereleases.sh` — Prerelease pruning |
| Create | `CHANGELOG.md` — Initial empty changelog |
| Modify | `packages/sync-server/wrangler.toml` — add [env.preview] |
| Modify | `packages/admin-server/wrangler.toml` — add [env.preview] |

---

## Testing Plan

| Test | Description |
|------|-------------|
| T-1 | version.sh: --pr 7 --build 42 outputs `0.1.42-pr.7` |
| T-2 | version.sh: --build 42 outputs `0.1.42` |
| T-3 | version.sh: updates package.json version field |
| T-4 | version.sh: updates app.json buildNumber + versionCode |
| T-5 | changelog.sh: groups feat/fix/docs/other correctly |
| T-6 | changelog.sh: falls back to commits when no PRs |
| T-7 | cleanup-prereleases.sh: keeps exactly N newest |
| T-8 | PR workflow: tests pass → version computed → prerelease created |
| T-9 | Release workflow: tests pass → tag created → release with notes |
| T-10 | Wrangler preview env deploys with `--env preview` |

---

## Definition of Done

- [ ] PR to main triggers: test → version → server preview → prerelease
- [ ] Push to main triggers: test → version → build → deploy → release
- [ ] All build jobs gated on repository variables (skip when not configured)
- [ ] Android APK builds in GitHub Actions without EAS
- [ ] Desktop builds for macOS/Windows/Linux via tauri-action
- [ ] Web export deploys to Cloudflare Pages
- [ ] Server deploys via Wrangler (preview for PR, production for main)
- [ ] Version format: `0.1.{build}` (release), `0.1.{build}-pr.{N}` (prerelease)
- [ ] CHANGELOG.md auto-generated with grouped entries
- [ ] Git tags: `v0.1.42`, `v0.1.42-pr.3`
- [ ] GitHub Release has all binary assets attached
- [ ] Only 5 most recent prereleases kept
- [ ] Pipeline works with zero secrets configured (all optional jobs skip gracefully)
