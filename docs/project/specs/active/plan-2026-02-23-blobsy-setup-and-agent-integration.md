---
title: Blobsy Setup and Agent Integration
description: Simplified setup command and agent skill integration for blobsy
author: Joshua Levy (github.com/jlevy) with LLM assistance
---
# Feature: Blobsy Setup and Agent Integration

**Date:** 2026-02-23

**Author:** Joshua Levy with Claude assistance

**Status:** Draft

## Overview

Add a simplified `blobsy setup` command and agent skill integration to make blobsy
easier to discover and use within AI coding agents (Claude Code, Cursor, Codex, etc.).
This follows a simplified pattern compared to tbd, avoiding auto-installation hooks but
ensuring clear documentation and skill file installation.

## Goals

- **Simple setup**: Single `blobsy setup --auto <url>` command for initialization +
  agent integration
- **Agent discoverability**: Install skill files to `.claude/skills/blobsy/SKILL.md` and
  update `AGENTS.md`
- **Self-documenting**: Clear installation instructions in skill files (agents can
  install via npm)
- **Progressive disclosure**: Use `blobsy skill` for brief agent orientation, delegate
  to `status`/`doctor` for dynamic state
- **Documentation updates**: Update all design docs and developer docs to reflect new
  patterns

## Non-Goals

- **Auto-installation hooks**: No bash scripts to auto-install blobsy (simpler than tbd
  approach)
- **Interactive mode**: No `--interactive` prompts (can be added later if needed)
- **Session hooks**: No SessionStart/PreCompact hooks (agents use `blobsy skill` for
  orientation)
- **Prime command**: Drop `blobsy prime` (redundant with `skill`)

## Background

Currently, blobsy requires manual multi-step setup:
1. `npm install -g blobsy`
2. `blobsy init s3://...`
3. Agents don’t know blobsy exists unless user tells them

With tbd’s proven pattern as reference, we can simplify to:
1. `npm install -g blobsy`
2. `blobsy setup --auto s3://...`
3. Agents automatically discover blobsy via skill files

The key difference from tbd: we don’t need auto-installation scripts.
Skill files just document: “If blobsy is not installed, run
`npm install -g blobsy@latest`”

## Design

### Approach

1. **Add `blobsy setup` command** that wraps `blobsy init` and installs agent
   integration files
2. **Simplify agent commands**: Keep `blobsy skill` (drop `prime`), delegate to
   `status`/`doctor` for state
3. **Install skill files** to standard locations (`.claude/skills/blobsy/`, `AGENTS.md`)
4. **Update all documentation** to reflect new setup pattern

### Components

**New files:**
- `packages/blobsy/src/cli/commands/setup.ts` - Setup command implementation
- `.claude/skills/blobsy/SKILL.md` - Installed by setup (template from
  `packages/blobsy/SKILL.md`)

**Modified files:**
- `packages/blobsy/src/cli/cli.ts` - Add setup command, update help text
- `packages/blobsy/src/skill-text.ts` - Consolidate into `skill` (remove `prime`)
- `packages/blobsy/SKILL.md` - Update with installation + brief orientation
- `AGENTS.md` - Add blobsy integration section
- `README.md` - Update quick start to use `blobsy setup`
- `docs/project/design/current/blobsy-design.md` - Document setup command
- `CLAUDE.md` (AGENTS.md) - Update development guide

**Removed:**
- `blobsy prime` command (consolidated into `skill`)

### API Changes

**New command:**
```bash
blobsy setup [options] <url>

Options:
  --auto              Non-interactive setup (recommended)
  --region <region>   AWS region (for S3 backends)
  --endpoint <url>    Custom endpoint (S3-compatible services)
  --no-hooks          Skip git hooks installation

Examples:
  blobsy setup --auto s3://my-bucket/my-project/
  blobsy setup --auto local:../blob-storage
```

**Modified commands:**
- `blobsy` (no args) - Show help with prominent “Getting Started” section
- `blobsy init` - Remains low-level (just creates `.blobsy.yml`)

### `blobsy skill` Output (Context-Efficient)

**Purpose:** Brief agent orientation with pointers to dynamic commands

````markdown
# blobsy

Git-native large file storage. Track large files with `.bref` pointers in Git,
store blobs in S3/local/custom backends.

## Installation

```bash
npm install -g blobsy@latest
blobsy setup --auto s3://bucket/prefix/
```

## When to Use

- Large binary files (models, datasets, media, archives)
- Share files across machines without committing to Git
- Content-addressable, deduplicated storage
- Keywords: blobsy, .bref, large files, Git LFS alternative

## Quick Reference

```bash
blobsy track <path...>     # Track files (creates .bref)
blobsy push [path...]      # Upload to backend
blobsy pull [path...]      # Download from backend
blobsy status --json       # Current state (JSON)
blobsy doctor --json       # Health check (JSON)
```

## Current State

For dynamic info, use:
- `blobsy status --json` - Tracked files, sync state
- `blobsy doctor --json` - Configuration, health, issues

All commands: `--json`, `--quiet`, `--verbose`, `--dry-run`
````

**Token budget:** ~200-300 tokens (context-efficient)

### AGENTS.md Integration

```markdown
<!-- BEGIN BLOBSY INTEGRATION -->
# Blobsy

Git-native large file storage CLI.

**Installation:** `npm install -g blobsy@latest`
**Setup:** `blobsy setup --auto s3://bucket/prefix/`
**Orientation:** Run `blobsy skill` for quick reference

[Full content from blobsy skill command output]
<!-- END BLOBSY INTEGRATION -->
```

## Implementation Plan

### Phase 1: Setup Command + Skill Consolidation

- [ ] Consolidate `blobsy skill` (remove `prime`)
  - [ ] Update `packages/blobsy/src/skill-text.ts`
  - [ ] Make `skill` output context-efficient (~200-300 tokens)
  - [ ] Include installation, when to use, quick reference
  - [ ] Point to `status --json` and `doctor --json` for state
  - [ ] Remove `PRIME_TEXT` constant and `prime` command handler

- [ ] Create `packages/blobsy/src/cli/commands/setup.ts`
  - [ ] Implement `SetupAutoHandler` class
  - [ ] Verify git repository
  - [ ] Parse backend URL (same as init)
  - [ ] Call `blobsy init` internally
  - [ ] Return success message with next steps

- [ ] Update CLI
  - [ ] Register setup command in `packages/blobsy/src/cli/cli.ts`
  - [ ] Remove `prime` command registration
  - [ ] Update help text to reference `skill` (not `prime`)

- [ ] Test basic setup flow
  - [ ] Golden test: `tests/golden/commands/setup.tryscript.md`
  - [ ] Update `skill.tryscript.md` with new consolidated output
  - [ ] Remove `prime` tests if they exist
  - [ ] Test error cases (not in git repo, invalid URL)

### Phase 2: Agent Integration Files

- [ ] Implement agent file installation
  - [ ] `setupClaudeIfDetected()` - Install to `.claude/skills/blobsy/SKILL.md`
  - [ ] `setupAgentsMdIfDetected()` - Update `AGENTS.md` with markers
  - [ ] Skip installation if files already exist (idempotent)

- [ ] Update `packages/blobsy/SKILL.md` template
  - [ ] Add installation instructions
  - [ ] Add “If not installed” section
  - [ ] Update “When to Use” triggers

- [ ] Update `AGENTS.md` (root)
  - [ ] Add blobsy integration section with markers
  - [ ] Include installation and usage

- [ ] Test agent file installation
  - [ ] Verify `.claude/skills/blobsy/SKILL.md` content
  - [ ] Verify `AGENTS.md` markers and content
  - [ ] Test idempotency (re-running setup)

### Phase 3: Documentation Updates

- [ ] Update user-facing docs
  - [ ] `README.md` - Change quick start to use `blobsy setup --auto`
  - [ ] Update command reference table
  - [ ] Add “Agent Integration” section

- [ ] Update design docs
  - [ ] `docs/project/design/current/blobsy-design.md`
    - [ ] Add setup command section
    - [ ] Update “Self-documenting” principle with setup flow
    - [ ] Document agent integration files
  - [ ] Add note about simplified approach vs tbd

- [ ] Update developer docs
  - [ ] `CLAUDE.md` (AGENTS.md) - Update development guide
  - [ ] Add blobsy setup workflow
  - [ ] Document agent integration architecture

### Phase 4: Help Text and UX

- [ ] Update CLI help output
  - [ ] Add “Getting Started” epilog to main help
  - [ ] Show `blobsy setup --auto` as recommended installation
  - [ ] Update `blobsy init` help to note it’s low-level

- [ ] Update `blobsy` (no args) behavior
  - [ ] Show help with prominent setup instructions
  - [ ] Reference `blobsy skill` for agent orientation

- [ ] Update error messages
  - [ ] When not initialized, suggest `blobsy setup --auto`
  - [ ] Clear messaging about setup vs init

### Phase 5: Testing and Polish

- [ ] Golden tests for all new output
  - [ ] `setup.tryscript.md` - Setup command variations
  - [ ] `setup-help.tryscript.md` - Help output
  - [ ] Update `help.tryscript.md` with new “Getting Started” section

- [ ] Integration testing
  - [ ] Fresh repo setup flow
  - [ ] Re-running setup (idempotent)
  - [ ] Setup with different backend types (s3, local)

- [ ] Edge cases
  - [ ] Setup in non-git directory
  - [ ] Setup when already initialized
  - [ ] Invalid backend URLs

## Testing Strategy

**Golden tests:**
- Setup command output (success, errors)
- Help text changes
- Generated SKILL.md content
- AGENTS.md integration

**Integration tests:**
- Full setup flow in temporary repo
- Agent file installation
- Idempotency (re-running setup)

**Manual validation:**
1. Fresh repo: `blobsy setup --auto s3://test/`
2. Verify `.claude/skills/blobsy/SKILL.md` exists
3. Verify `AGENTS.md` has blobsy section
4. Run `blobsy prime` to see dashboard
5. Re-run setup, verify idempotent

## Rollout Plan

1. Merge spec → Create implementation beads
2. Implement Phase 1-2 (core setup + agent integration)
3. Review and test
4. Implement Phase 3-5 (docs + testing + polish)
5. Update README and publish

## Open Questions

None currently. Design is simplified and straightforward.

## References

- tbd setup implementation: `attic/tbd/packages/tbd/src/cli/commands/setup.ts`
- CLI agent skill patterns: `.tbd/docs/guidelines/cli-agent-skill-patterns.md`
- Current blobsy SKILL.md: `packages/blobsy/SKILL.md`
- Current blobsy design: `docs/project/design/current/blobsy-design.md`
