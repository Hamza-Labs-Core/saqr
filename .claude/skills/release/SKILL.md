---
name: release
description: Build, test, commit, tag, and push a new release. Use when the user says "release", "make a release", "create release", or "ship it".
allowed-tools: Bash, Read, Edit, Glob, Grep
---

# Release Workflow

Automate the full release cycle: build -> test -> commit -> tag -> push

## Steps

### 1. Pre-flight Checks
- Run `git status` to check for uncommitted changes
- If there are changes, ask user for commit message or use a default based on changes

### 2. Build
- Run `flutter analyze` to check for issues
- Run `flutter build apk --release` for Android (or appropriate platform)
- Stop if build fails

### 3. Test
- Run `flutter test` to execute all tests
- Stop if tests fail

### 4. Commit (if needed)
- Stage all relevant changes (exclude generated files, .serena/, etc.)
- Create commit with descriptive message
- Use conventional commit format: `feat:`, `fix:`, `chore:`, etc.

### 5. Tag
- Get latest tag with `git tag -l | sort -V | tail -1`
- Increment patch version (e.g., v0.2.8 -> v0.2.9)
- For breaking changes or new features, ask user about major/minor bump
- Create annotated tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`

### 6. Push
- Push commits: `git push origin main`
- Push tags: `git push origin --tags`

## Version Increment Rules
- **Patch** (0.0.X): Bug fixes, small changes (default)
- **Minor** (0.X.0): New features, non-breaking
- **Major** (X.0.0): Breaking changes

## Error Handling
- If any step fails, stop and report the error
- Do not push if build or tests fail
- Allow user to fix issues and retry

## Output
After successful release, display:
- New version tag
- Commit hash
- GitHub release URL (if applicable)
