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
- **Progressive disclosure**: Leverage existing `blobsy skill` and `blobsy prime`
  commands
- **Documentation updates**: Update all design docs and developer docs to reflect new
  patterns

## Non-Goals

- **Auto-installation hooks**: No bash scripts to auto-install blobsy (simpler than tbd
  approach)
- **Interactive mode**: No `--interactive` prompts (can be added later if needed)
- **Session hooks**: No SessionStart/PreCompact hooks (agents just reference
  `blobsy prime` manually)

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
2. **Leverage existing commands**: `blobsy skill` and `blobsy prime` already exist
3. **Install skill files** to standard locations (`.claude/skills/blobsy/`, `AGENTS.md`)
4. **Update all documentation** to reflect new setup pattern

### Components

**New files:**
- `packages/blobsy/src/cli/commands/setup.ts` - Setup command implementation
- `.claude/skills/blobsy/SKILL.md` - Installed by setup (template from
  `packages/blobsy/SKILL.md`)

**Modified files:**
- `packages/blobsy/src/cli/cli.ts` - Add setup command, update help text
- `packages/blobsy/SKILL.md` - Add installation instructions
- `AGENTS.md` - Add blobsy integration section
- `README.md` - Update quick start to use `blobsy setup`
- `docs/project/design/current/blobsy-design.md` - Document setup command
- `CLAUDE.md` (AGENTS.md) - Update development guide

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

### SKILL.md Format

````yaml
---
name: blobsy
description: Git-native large file storage CLI. Track large files with .bref pointers while storing blobs in S3, local, or custom backends.
---

# Blobsy Agent Skill

## Installation

If blobsy is not installed, run:
```bash
npm install -g blobsy@latest
````

Then initialize in your project:
```bash
blobsy setup --auto s3://bucket/prefix/
```

## When to Use

Use blobsy when:
- Repository contains large binary files (models, datasets, media)
- Files need to be shared across machines without committing to Git
- You need content-addressable, deduplicated blob storage
- User mentions: blobsy, large files, .bref, Git LFS alternative

## Quick Reference

```bash
blobsy track <path...>     # Track files (creates .bref pointers)
blobsy push [path...]      # Upload blobs to backend
blobsy pull [path...]      # Download blobs from backend
blobsy status [path...]    # Show tracked file states
blobsy prime              # Show context and dashboard
```

## Global Options

All commands accept: `--json`, `--quiet`, `--verbose`, `--dry-run`

…
````

### AGENTS.md Integration

```markdown
<!-- BEGIN BLOBSY INTEGRATION -->
# Blobsy

Git-native large file storage CLI.

Installation: `npm install -g blobsy@latest`
Setup: `blobsy setup --auto s3://bucket/prefix/`
Context: Run `blobsy prime` to see current state

[Full content from blobsy skill]
<!-- END BLOBSY INTEGRATION -->
````

## Implementation Plan

### Phase 1: Setup Command Core

- [ ] Create `packages/blobsy/src/cli/commands/setup.ts`
  - [ ] Implement `SetupAutoHandler` class
  - [ ] Verify git repository
  - [ ] Parse backend URL (same as init)
  - [ ] Call `blobsy init` internally
  - [ ] Return success message with next steps

- [ ] Add setup command to CLI
  - [ ] Register in `packages/blobsy/src/cli/cli.ts`
  - [ ] Add to command list in help

- [ ] Test basic setup flow
  - [ ] Golden test: `tests/golden/commands/setup.tryscript.md`
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
  - [ ] Reference `blobsy prime` for context

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
