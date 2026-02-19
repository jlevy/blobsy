# Publishing Guide

This project uses tag-triggered releases with OIDC trusted publishing to npm.
No npm tokens or secrets to manage.

## Workflow Overview

1. **During development**: Merge PRs to `main`.
2. **To release**: Write release notes, bump version, commit, tag, and push.
3. **CI publishes automatically**: The release workflow builds, validates, publishes to
   npm, and creates a GitHub Release using `release-notes.md`.

## One-Time Setup

Before the first release, complete these steps:

### 1. Manual First Publish

The package must exist on npm before OIDC can be configured.
Run from the package directory (important: the root `.npmrc` has pnpm-specific config
that confuses npm):

```bash
cd packages/PACKAGE
npm publish --access public
```

This will prompt for web-based authentication in your browser.

### 2. Configure OIDC Trusted Publishing on npm

1. Go to https://www.npmjs.com/package/PACKAGE/access

2. Under “Publishing access”, click “Add a trusted publisher” or “Configure Trusted
   Publishing”

3. Select **GitHub Actions** as the publisher

4. Fill in the form:
   - **Organization or user**: `OWNER`
   - **Repository**: `REPO`
   - **Workflow filename**: `release.yml`
   - **Environment name**: Leave blank (not required unless using GitHub environments)

5. For **Publishing access**, select **“Require two-factor authentication and disallow
   tokens (recommended)”** -- OIDC trusted publishers work regardless of this setting

6. Click “Set up connection”

### 3. Verify Repository is Public

OIDC trusted publishing requires a public GitHub repository.

## Release Workflow

All commands are non-interactive and can be run by an agent or human.

### Step 1: Prepare

```bash
git checkout main
git pull
git status  # Must be clean
```

### Step 2: Review Changes and Write Release Notes

Review changes since last release:

```bash
pnpm release:changes
```

This shows all commits since the last tag (or all commits if no tags exist).

Write `release-notes.md` at the repo root, summarizing the changes.
This file becomes the GitHub Release body.
See “Writing Release Notes” below for format.

### Step 3: Determine Version

Choose version bump based on the changes:

- `patch` (0.1.0 -> 0.1.1): Bug fixes, docs, internal changes
- `minor` (0.1.0 -> 0.2.0): New features, non-breaking changes
- `major` (0.1.0 -> 1.0.0): Breaking changes

Update `version` in the package’s `package.json`.

### Step 4: Commit, Tag, Push

```bash
git add .
git commit -m "chore: release PACKAGE v0.2.0"
git tag v0.2.0
git push && git push --tags
```

The release workflow will automatically build, publish to npm, and create a GitHub
Release with the contents of `release-notes.md`.

## Writing Release Notes

The `release-notes.md` file at the repo root is the source of truth for release notes.
It is written *before* tagging and committed with the release.
The CI workflow reads it directly via `body_path: release-notes.md`.

### Step 1: Review Changes

```bash
pnpm release:changes
```

This outputs all commits since the last release tag as a flat list.
Use this as input for writing the release notes summary.

### Step 2: Categorize and Summarize

Group changes thematically, not by individual commit.
Categories to use:

- **Features**: New capabilities, significant enhancements
- **Fixes**: Bug fixes, corrections
- **Refactoring**: Internal improvements, code quality (if notable)
- **Documentation**: Significant doc changes (skip trivial updates)

Write concise descriptions that explain what changed from the user’s perspective.
Multiple related commits should be combined into a single bullet point.

### Step 3: Write release-notes.md

```markdown
## What's Changed

### Features

- **Feature name**: Brief description of what it does
- **Another feature**: What users can now do

### Fixes

- Fixed specific issue with clear description
- Another fix with context

### Refactoring

- Significant internal change (if user-relevant)

**Full commit history**: https://github.com/OWNER/REPO/compare/vX.X.X...vY.Y.Y
```

### Tips

- **Be concise**: Each bullet should be one line
- **Focus on impact**: What can users do now?
  What’s fixed?
- **Group related commits**: “Fixed 5 coverage bugs” not 5 separate bullets
- **Skip trivial changes**: Badge updates, typo fixes don’t need mention
- **Link to full history**: Always include the compare URL for details

## How OIDC Publishing Works

This project uses npm’s trusted publishing via OIDC (OpenID Connect):

- **No tokens to manage**: GitHub Actions presents an OIDC identity to npm
- **No secrets to rotate**: npm issues a one-time credential for each workflow run
- **Provenance attestation**: Published packages include signed build provenance

The release workflow (`.github/workflows/release.yml`) triggers on `v*` tags and
publishes automatically without requiring an `NPM_TOKEN` secret.

## Quick Reference

```bash
# Full release sequence
git checkout main && git pull
pnpm release:changes                    # Review changes
# Write release-notes.md               # Summarize changes
# Edit packages/PACKAGE/package.json   # Bump version
git add . && git commit -m "chore: release PACKAGE v0.2.0"
git tag v0.2.0
git push && git push --tags
```

## Troubleshooting

**Release workflow not running?**

- Ensure tag format is `v*` (e.g., `v0.2.0`)
- Check tag was pushed: `git ls-remote --tags origin`

**npm publish failing with 401/403?**

- Verify OIDC is configured: https://www.npmjs.com/package/PACKAGE/access
- Check repository is listed under “Trusted Publishing”
- Ensure the repository is public

**First publish?**

- OIDC requires the package to already exist on npm
- Do a manual `npm publish --access public` first (see One-Time Setup)

## Manual Publishing

If you need to publish without CI:

```bash
pnpm release
```

This runs `pnpm build && pnpm publint && pnpm -r publish --access public`.
