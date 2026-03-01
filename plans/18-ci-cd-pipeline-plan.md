# Implementation Plan: Story 18 -- CI/CD Pipeline

## Story 18: CI/CD Pipeline -- Implementation Plan

### 1. Current State Analysis

**Existing files that need modification:**
- `/home/meywd/Saqr/.github/workflows/ci.yml` -- Already has `workflow_call` trigger. Needs no changes. It is already correctly set up as a reusable workflow.
- `/home/meywd/Saqr/.github/workflows/pr-deploy.yml` -- Exists but uses EAS Build (`vars.ENABLE_EAS_BUILD`). Needs full rewrite to use GitHub Actions-native Android build and remove EAS dependency.
- `/home/meywd/Saqr/.github/workflows/release.yml` -- Exists but uses EAS Build. Needs full rewrite to add desktop builds, Android APK build, web deploy, and asset attachment.
- `/home/meywd/Saqr/scripts/version.sh` -- Exists but missing Cargo.toml and tauri.conf.json updates. Needs modification.
- `/home/meywd/Saqr/scripts/changelog.sh` -- Exists and is functional. No changes needed.
- `/home/meywd/Saqr/scripts/cleanup-prereleases.sh` -- Exists and is functional. No changes needed.
- `/home/meywd/Saqr/packages/sync-server/wrangler.toml` -- Already has `[env.preview]` section. No changes needed.
- `/home/meywd/Saqr/packages/admin-server/wrangler.toml` -- Already has `[env.preview]` section. No changes needed.

**Files that need creation:**
- None -- all files listed in the story already exist. The story says "Create" for the scripts and workflows, but they already exist as stubs from earlier work.

### 2. Detailed Changes Per File

---

#### 2.1 `scripts/version.sh` -- Add Cargo.toml and tauri.conf.json Updates

The current script at `/home/meywd/Saqr/scripts/version.sh` updates `package.json` and `app.json` but is missing the desktop-related updates. The following code block must be inserted after the `app.json` update block (after line 63) and before the GitHub Actions output block (line 66):

```bash
# Update desktop tauri.conf.json
TAURI_CONF="$(git rev-parse --show-toplevel)/packages/desktop/src-tauri/tauri.conf.json"
if [[ -f "$TAURI_CONF" ]]; then
  tmp=$(mktemp)
  jq --arg v "$VERSION" '.version = $v' "$TAURI_CONF" > "$tmp" && mv "$tmp" "$TAURI_CONF"
  echo "Updated $TAURI_CONF"
fi

# Update desktop Cargo.toml
CARGO_TOML="$(git rev-parse --show-toplevel)/packages/desktop/src-tauri/Cargo.toml"
if [[ -f "$CARGO_TOML" ]]; then
  # Replace version in [package] section only
  # Using sed: match "version = " lines only within the first occurrence
  sed -i "0,/^version = \".*\"/s//version = \"$VERSION\"/" "$CARGO_TOML"
  echo "Updated $CARGO_TOML"
fi
```

Note: The `sed` approach handles Cargo.toml safely because the `[package]` section is always first in a standard Cargo.toml. The `0,/pattern/s//replacement/` syntax ensures only the first match is replaced. An alternative is the Node.js approach used by Paseo (reading line-by-line, tracking `[package]` section), but sed is simpler for a bash script.

---

#### 2.2 `.github/workflows/ci.yml` -- No Changes Needed

The existing file already has `workflow_call` as a trigger on line 8. The reusable workflow is correctly configured. It runs all 10 package test suites plus gc-core bash tests.

---

#### 2.3 `.github/workflows/pr-deploy.yml` -- Full Rewrite

The current file uses EAS Build. It must be rewritten to remove EAS entirely and use the story's PR flow architecture:

```yaml
name: PR Deploy

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: pr-deploy-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  test:
    uses: ./.github/workflows/ci.yml

  version:
    name: Version (prerelease)
    needs: test
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
      build_number: ${{ steps.version.outputs.build_number }}
    steps:
      - uses: actions/checkout@v4

      - name: Compute version
        id: version
        run: bash scripts/version.sh --pr ${{ github.event.pull_request.number }}

  deploy-servers-preview:
    name: Deploy Servers (preview)
    needs: version
    if: ${{ vars.ENABLE_WRANGLER_DEPLOY == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Deploy sync-server (preview)
        working-directory: packages/sync-server
        run: npx wrangler deploy --env preview
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy admin-server (preview)
        working-directory: packages/admin-server
        run: npx wrangler deploy --env preview
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Comment preview URLs on PR
        uses: actions/github-script@v7
        with:
          script: |
            const version = '${{ needs.version.outputs.version }}';
            const body = `## Server Preview Deploy\n\n` +
              `**Version:** \`${version}\`\n` +
              `| Service | URL |\n` +
              `|---------|-----|\n` +
              `| sync-server | \`saqr-sync-preview.<account>.workers.dev\` |\n` +
              `| admin-server | \`saqr-admin-preview.<account>.workers.dev\` |`;
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            });

  prerelease:
    name: Create Prerelease
    needs: [version, deploy-servers-preview]
    if: ${{ always() && needs.version.result == 'success' && !contains(needs.*.result, 'failure') }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - name: Create prerelease tag
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git tag "v${{ needs.version.outputs.version }}"
          git push origin "v${{ needs.version.outputs.version }}"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Create prerelease
        run: |
          gh release create "v${{ needs.version.outputs.version }}" \
            --prerelease \
            --title "v${{ needs.version.outputs.version }}" \
            --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Cleanup old prereleases
        run: bash scripts/cleanup-prereleases.sh --keep 5
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Key changes from current:
1. Removed `build-mobile` job entirely (no EAS, no Android build on PRs -- only server preview)
2. Removed EAS-related steps and `ENABLE_EAS_BUILD` variable
3. Kept server preview deploy and prerelease creation
4. Simplified prerelease dependencies (no longer depends on mobile build)
5. Added tag creation step before release creation (gh release create needs a tag)

---

#### 2.4 `.github/workflows/release.yml` -- Full Rewrite

This is the most substantial change. The release workflow needs to orchestrate: test, version, mobile Android build, desktop builds (3 platforms), web deploy, server deploy, and final release with asset attachment.

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  test:
    uses: ./.github/workflows/ci.yml

  version:
    name: Version (release)
    needs: test
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
      build_number: ${{ steps.version.outputs.build_number }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Compute version
        id: version
        run: bash scripts/version.sh

  # ─── Mobile Android APK Build ───────────────────────────────────────

  build-mobile-android:
    name: Build Android APK
    needs: version
    if: ${{ vars.ENABLE_MOBILE_BUILD == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Apply version
        run: bash scripts/version.sh

      - name: Prebuild Android
        working-directory: packages/mobile
        run: npx expo prebuild --platform android --no-install

      - name: Build release APK
        working-directory: packages/mobile/android
        run: ./gradlew assembleRelease

      - name: Rename APK artifact
        run: |
          VERSION="${{ needs.version.outputs.version }}"
          APK_PATH=$(find packages/mobile/android/app/build/outputs/apk/release -name "*.apk" | head -1)
          cp "$APK_PATH" "saqr-v${VERSION}-android.apk"

      - name: Upload APK artifact
        uses: actions/upload-artifact@v4
        with:
          name: android-apk
          path: saqr-v${{ needs.version.outputs.version }}-android.apk
          retention-days: 5

  # ─── Desktop Builds (Tauri) ─────────────────────────────────────────

  build-desktop-macos:
    name: Build Desktop (macOS)
    needs: version
    if: ${{ vars.ENABLE_DESKTOP_BUILD == 'true' }}
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Apply version
        run: bash scripts/version.sh

      - name: Build dashboard frontend
        run: pnpm --filter dashboard run build

      - name: Build and publish Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: packages/desktop
          tauriScript: npx tauri
          args: --target aarch64-apple-darwin
          # Do NOT let tauri-action create a release — we do it ourselves
          tagName: ""
          releaseName: ""

      - name: Upload macOS artifacts
        uses: actions/upload-artifact@v4
        with:
          name: desktop-macos
          path: |
            packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
            packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app.tar.gz
            packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app.tar.gz.sig
          retention-days: 5

  build-desktop-windows:
    name: Build Desktop (Windows)
    needs: version
    if: ${{ vars.ENABLE_DESKTOP_BUILD == 'true' }}
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Apply version
        shell: bash
        run: bash scripts/version.sh

      - name: Build dashboard frontend
        run: pnpm --filter dashboard run build

      - name: Build and publish Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: packages/desktop
          tauriScript: npx tauri
          tagName: ""
          releaseName: ""

      - name: Upload Windows artifacts
        uses: actions/upload-artifact@v4
        with:
          name: desktop-windows
          path: |
            packages/desktop/src-tauri/target/release/bundle/nsis/*.exe
            packages/desktop/src-tauri/target/release/bundle/msi/*.msi
          retention-days: 5

  build-desktop-linux:
    name: Build Desktop (Linux)
    needs: version
    if: ${{ vars.ENABLE_DESKTOP_BUILD == 'true' }}
    runs-on: ubuntu-22.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libgtk-3-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            patchelf

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Apply version
        run: bash scripts/version.sh

      - name: Build dashboard frontend
        run: pnpm --filter dashboard run build

      - name: Build and publish Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: packages/desktop
          tauriScript: npx tauri
          tagName: ""
          releaseName: ""

      - name: Upload Linux artifacts
        uses: actions/upload-artifact@v4
        with:
          name: desktop-linux
          path: |
            packages/desktop/src-tauri/target/release/bundle/appimage/*.AppImage
            packages/desktop/src-tauri/target/release/bundle/deb/*.deb
          retention-days: 5

  # ─── Web Deploy (Expo Web → Cloudflare Pages) ──────────────────────

  deploy-web:
    name: Deploy Web (Cloudflare Pages)
    needs: version
    if: ${{ vars.ENABLE_WEB_DEPLOY == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Apply version
        run: bash scripts/version.sh

      - name: Export web build
        working-directory: packages/mobile
        run: npx expo export --platform web

      - name: Deploy to Cloudflare Pages
        run: npx wrangler pages deploy packages/mobile/dist --project-name saqr-app
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

  # ─── Server Deploy (Cloudflare Workers) ─────────────────────────────

  deploy-servers:
    name: Deploy Servers (production)
    needs: version
    if: ${{ vars.ENABLE_WRANGLER_DEPLOY == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Deploy sync-server
        working-directory: packages/sync-server
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy admin-server
        working-directory: packages/admin-server
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

  # ─── Release (Changelog + Tag + GitHub Release + Assets) ────────────

  release:
    name: Create Release
    needs:
      - version
      - build-mobile-android
      - build-desktop-macos
      - build-desktop-windows
      - build-desktop-linux
      - deploy-web
      - deploy-servers
    if: ${{ always() && needs.version.result == 'success' && !contains(needs.*.result, 'failure') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Generate changelog
        id: changelog
        run: |
          bash scripts/changelog.sh > changelog.txt
          echo "Generated changelog:"
          cat changelog.txt
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Prepend to CHANGELOG.md
        run: |
          VERSION="v${{ needs.version.outputs.version }}"
          DATE=$(date +%Y-%m-%d)
          {
            echo "## ${VERSION} (${DATE})"
            echo ""
            cat changelog.txt
          } > changelog_entry.txt

          if [[ -f CHANGELOG.md ]]; then
            head -n 2 CHANGELOG.md > CHANGELOG_new.md
            echo "" >> CHANGELOG_new.md
            cat changelog_entry.txt >> CHANGELOG_new.md
            echo "" >> CHANGELOG_new.md
            tail -n +3 CHANGELOG.md >> CHANGELOG_new.md
            mv CHANGELOG_new.md CHANGELOG.md
          else
            {
              echo "# Changelog"
              echo ""
              cat changelog_entry.txt
            } > CHANGELOG.md
          fi

      - name: Commit changelog
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add CHANGELOG.md
          git diff --cached --quiet && echo "No changelog changes" || \
            git commit -m "chore(release): v${{ needs.version.outputs.version }} changelog"

      - name: Create tag
        run: git tag "v${{ needs.version.outputs.version }}"

      - name: Push changes and tag
        run: git push origin main --tags
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: release-assets
        # This downloads all artifacts from the workflow run into subdirectories

      - name: List downloaded artifacts
        run: find release-assets -type f 2>/dev/null || echo "No artifacts downloaded"

      - name: Create GitHub release with assets
        run: |
          VERSION="v${{ needs.version.outputs.version }}"
          
          # Collect all asset files
          ASSETS=()
          if [[ -d release-assets ]]; then
            while IFS= read -r file; do
              ASSETS+=("$file")
            done < <(find release-assets -type f \( \
              -name "*.apk" -o \
              -name "*.dmg" -o \
              -name "*.app.tar.gz" -o \
              -name "*.app.tar.gz.sig" -o \
              -name "*.exe" -o \
              -name "*.msi" -o \
              -name "*.AppImage" -o \
              -name "*.deb" -o \
              -name "latest.json" \
            \))
          fi

          # Build the gh release create command
          CMD=(gh release create "$VERSION" --title "$VERSION" --notes-file changelog.txt)
          for asset in "${ASSETS[@]}"; do
            CMD+=("$asset")
          done

          "${CMD[@]}"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

### 3. Key Design Decisions

#### 3.1 Concurrency Settings

| Workflow | Group | cancel-in-progress |
|----------|-------|--------------------|
| ci.yml | `${{ github.workflow }}-${{ github.ref }}` | `true` (already set) |
| pr-deploy.yml | `pr-deploy-${{ github.event.pull_request.number }}` | `true` -- new PR pushes cancel old ones |
| release.yml | `release` | `false` -- never cancel a release in progress |

The release workflow uses `cancel-in-progress: false` because canceling a half-completed release could leave tags/releases in an inconsistent state.

#### 3.2 Permissions Blocks

| Workflow | Permissions |
|----------|------------|
| ci.yml | `contents: read` (already set) |
| pr-deploy.yml | `contents: write` (for tag/release creation), `pull-requests: write` (for PR comments) |
| release.yml | `contents: write` (for tag, changelog commit, release creation) |

#### 3.3 Job Gating on Repository Variables

All optional jobs use `if: ${{ vars.VARIABLE_NAME == 'true' }}`. When the variable is not set (default), GitHub treats `vars.VARIABLE_NAME` as empty string, so the comparison fails and the job is skipped. This means:

- **Zero-config mode**: All optional jobs skip. Only test + version + prerelease/release run.
- **Gradual enablement**: Enable one variable at a time as infrastructure is ready.

| Variable | Jobs Gated |
|----------|-----------|
| `ENABLE_MOBILE_BUILD` | `build-mobile-android` |
| `ENABLE_DESKTOP_BUILD` | `build-desktop-macos`, `build-desktop-windows`, `build-desktop-linux` |
| `ENABLE_WEB_DEPLOY` | `deploy-web` |
| `ENABLE_WRANGLER_DEPLOY` | `deploy-servers-preview`, `deploy-servers` |

#### 3.4 Release Job Conditional Logic

The release job uses `if: ${{ always() && needs.version.result == 'success' && !contains(needs.*.result, 'failure') }}`. This means:
- It runs even if optional jobs were skipped (which is `skipped`, not `failure`)
- It blocks if any job actually failed
- It requires the version job to have succeeded

#### 3.5 tauri-action Configuration

Important: We do NOT let `tauri-apps/tauri-action` create its own GitHub Release. Setting `tagName: ""` and `releaseName: ""` prevents this. Instead, the artifacts are uploaded via `actions/upload-artifact` and then attached to our own release in the `release` job.

This is a deliberate departure from Paseo's approach (where tauri-action creates the release). The reason: Saqr's release job needs to aggregate assets from multiple sources (Android APK, 3 desktop platforms, web deploy confirmation) into a single release with a unified changelog.

#### 3.6 Android Build Without EAS

The current workflows use EAS Build. Story 18 explicitly requires building directly in GitHub Actions. The approach:

1. `actions/setup-java@v4` with Temurin JDK 17 (required by modern Android Gradle Plugin)
2. `android-actions/setup-android@v3` for Android SDK (installs command-line tools, build tools, platform APIs)
3. `npx expo prebuild --platform android --no-install` generates the native Android project
4. `./gradlew assembleRelease` compiles the APK

No signing is configured in the initial implementation. The APK will be unsigned (debug-signed). Signing configuration is documented as a future prerequisite.

---

### 4. Required Secrets and Variables

#### Repository Variables (Settings > Variables > Actions)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENABLE_MOBILE_BUILD` | _(not set = false)_ | Gate Android APK build job |
| `ENABLE_DESKTOP_BUILD` | _(not set = false)_ | Gate all 3 Tauri desktop build jobs |
| `ENABLE_WEB_DEPLOY` | _(not set = false)_ | Gate Expo web export to Cloudflare Pages |
| `ENABLE_WRANGLER_DEPLOY` | _(not set = false)_ | Gate Cloudflare Workers deploy (both preview and production) |

#### Repository Secrets

| Secret | Required For | Notes |
|--------|-------------|-------|
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy (workers + pages) | Single token for both `wrangler deploy` and `wrangler pages deploy` |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler deploy | Account ID for Cloudflare |
| `APPLE_CERTIFICATE` | macOS code signing | Base64-encoded .p12 certificate |
| `APPLE_CERTIFICATE_PASSWORD` | macOS code signing | Password for the .p12 |
| `APPLE_SIGNING_IDENTITY` | macOS code signing | e.g., "Developer ID Application: Company Name (TEAM_ID)" |
| `APPLE_ID` | macOS notarization | Apple ID email for notarization |
| `APPLE_PASSWORD` | macOS notarization | App-specific password for notarization |
| `APPLE_TEAM_ID` | macOS notarization | Apple Developer Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri auto-update signatures | Ed25519 private key for update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri auto-update signatures | Password for the signing key |

---

### 5. Implementation Sequence

The implementation should proceed in this order:

**Step 1**: Modify `scripts/version.sh` to add Cargo.toml and tauri.conf.json update support. Both updates are guarded by `if [[ -f ... ]]` so they are no-ops until Stories 16/17 create those files.

**Step 2**: Rewrite `.github/workflows/pr-deploy.yml` to remove EAS references and simplify to: test > version > server preview > prerelease.

**Step 3**: Rewrite `.github/workflows/release.yml` with the full pipeline: test > version > (mobile + desktop + web + servers in parallel) > release with assets.

**Step 4**: Verify that all optional jobs skip gracefully when variables are not set. The pipeline must work with zero secrets/variables configured.

---

### 6. Potential Challenges

1. **tauri-action artifact paths**: The exact output paths for tauri-action bundles depend on the Tauri 2 configuration and may vary. The glob patterns in `upload-artifact` (`bundle/dmg/*.dmg`, `bundle/nsis/*.exe`, etc.) may need adjustment based on actual Story 17 output.

2. **Windows shell for version.sh**: On `windows-latest`, bash scripts need `shell: bash` explicitly. The `Apply version` step on Windows has this set.

3. **Cargo.toml version update via sed**: If the Cargo.toml has multiple `version = "..."` lines (e.g., in `[dependencies]`), the `0,/pattern/` sed approach ensures only the first one (in `[package]`) is replaced. A more robust alternative would be to use `cargo-set-version` or a Node.js script like Paseo does.

4. **Asset naming from tauri-action**: The actual filenames produced by tauri-action depend on the `productName` in `tauri.conf.json` (which will be "Saqr" per Story 17). The expected names are `Saqr_0.1.42_aarch64.dmg`, etc. The release job uses glob patterns to find all relevant files.

5. **GITHUB_RUN_NUMBER monotonicity**: `GITHUB_RUN_NUMBER` is per-workflow, so the version numbers will be unique within each workflow but may overlap between pr-deploy and release workflows. This is acceptable because the PR versions include `-pr.N` suffix.

6. **latest.json for auto-update**: tauri-action generates a `latest.json` file when `TAURI_SIGNING_PRIVATE_KEY` is set. This file should be included in the release assets. The glob pattern in the release job includes `latest.json`.

---

### 7. Testing Verification

The story's testing plan maps to the implementation as follows:

| Test | How to Verify |
|------|--------------|
| T-1: version.sh --pr 7 --build 42 outputs 0.1.42-pr.7 | Run locally with `--build 42 --pr 7` |
| T-2: version.sh --build 42 outputs 0.1.42 | Run locally with `--build 42` |
| T-3: version.sh updates package.json | Check file after running |
| T-4: version.sh updates app.json | Check file after running (requires Story 16 app.json) |
| T-5: changelog.sh groups correctly | Run locally on repo with conventional commits |
| T-6: changelog.sh falls back to commits | Run without GH_TOKEN |
| T-7: cleanup-prereleases.sh keeps N | Already tested, no changes |
| T-8: PR workflow flow | Open a PR and watch Actions |
| T-9: Release workflow flow | Merge to main and watch Actions |
| T-10: Wrangler preview deploys | Set ENABLE_WRANGLER_DEPLOY=true and open PR |

Tests T-1 through T-4 can also be validated with a simple shell test script that runs version.sh with `--build` override and checks the output files. Tests T-5 and T-6 can be validated similarly by running changelog.sh against the repo.

---

### Critical Files for Implementation
- `/home/meywd/Saqr/scripts/version.sh` - Must add Cargo.toml and tauri.conf.json version update logic
- `/home/meywd/Saqr/.github/workflows/release.yml` - Full rewrite: add Android APK, desktop builds, web deploy, asset attachment
- `/home/meywd/Saqr/.github/workflows/pr-deploy.yml` - Rewrite to remove EAS, simplify to test/version/server-preview/prerelease
- `/home/meywd/Saqr/.github/workflows/ci.yml` - Reference only: already correctly configured as reusable workflow
- `/home/meywd/Saqr/stories/17-desktop-app-shell.md` - Reference for tauri.conf.json structure and build artifact paths