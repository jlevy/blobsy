---
title: Blobsy v3 Redesign — Implementation Plan
description: Phased plan to implement design v3 (one storage contract, one ref format, snapshots) with no backward compatibility
author: Claude (round 9 follow-up) with Joshua Levy
---
# Feature: Blobsy v3 Redesign

**Date:** 2026-10-23

**Author:** Claude (round 9 follow-up)

**Status:** Draft, for owner review together with the design

**Design:** [blobsy-design.md](../../design/current/blobsy-design.md) (v3). This plan
covers order, scope and tests; the design doc is the specification.

## Overview

This plan implements design v3:

- content-addressed, create-only storage with derived keys;
- one `.bref` TSV format for file, directory and pin refs;
- a recoverability rule in place of the merge base;
- local state under the git dir, plus a shared content cache;
- guard hooks and opt-in restore hooks;
- a per-path merge driver with a validator;
- snapshots for caches and assets;
- a consolidated command surface.

**No backward compatibility** (`CLAUDE.md`): v2 pointers, config keys, commands and
stored objects are dropped, with no migration.
Test repos are re-created.

This plan supersedes `plan-2026-10-22-pointers-with-computed-keys.md`, whose content is
folded into Phase 1 here.

## Goals

- Every use case in design §2 works end to end (UC-6 and UC-7 history import are
  deferred).
- The three round 9 blockers are fixed by construction:
  - **B-1:** recoverability rule;
  - **B-2:** pre-push reads the pushed refs;
  - **B-3:** large-file guard.
- The source shrinks in Phase 1 before it grows.
  Each phase ships the smallest cut that works.
- The performance targets of design §15 are measured in CI.

## Non-Goals

- Everything in design §17 (non-goals and deferred work).
- Single-binary distribution.
  It is an experiment alongside Phase 1, not a blocker.

## Background

- **Round 9 findings and decisions:** `blobsy-design-review-round9-use-cases.md`.
- **Code facts used here** are from the complexity sub-review and the lead reviewer’s
  reads at `04a3d1a`:
  - the four write-back sites: `commands-stage2.ts:334–343, 719–724, 747–754,
    2112–2120`;
  - about 12 checks that treat `remote_key` presence as “pushed”;
  - `decideSyncAction`’s merge base: `stage2:553–594`;
  - the template system: `template.ts`;
  - the inert subdir-config walk: `config.ts:159–278`.
- **Hash benchmarks:** `research-2026-10-22-hash-performance-node-bun-rust.md`.

## Design

See the design doc. Module layout (design §4–§12):

```
cli/verbs/    one file per verb: plan() + execute(); one reporter renders human/--json/--quiet/--dry-run
core/         hash (blake3|sha256, 1 MB reads, worker pool), hashcache, paths, config (3 scopes), errors, git helpers
store/        Backend interface + s3 (SDK) / rclone / local / command; putIfAbsent, exists[], list; content cache
refs/         ref format (parse/serialize/validate), entry loop for add/push/pull/status, merge algorithm
snap/         tree walk with fidelity, deterministic tar.zst, publish/restore/ls/gc
doctor/       check registry; each module registers checks
```

## Implementation Plan

### Phase 1: New core for file refs (deletes most of v2)

This is the smallest cut that gives UC-1 one-commit flows with safe pulls.

- [ ] **Delete:**
  - `template.ts` and `remote.key_template`;
  - all `refUpdates` write-back;
  - `track`’s key clearing;
  - `decideSyncAction`’s merge base;
  - `.blobsy/trash/`;
  - the subdir-config walk;
  - `sync.tools` and `checksum`;
  - the aws-cli backend;
  - gzip/brotli;
  - hidden commands (`init`, `track`, `untrack`, `verify`, `health`, `check-unpushed`,
    `pre-push-check`, `hooks`, `readme`, `skill`), folded per design §6 with no aliases.
- [ ] **Ref format** (design §4.2): parser, serializer and validator for
  `#blobsy-ref 1 <algo>`. Phase 1 supports file refs only; directory and pin rows are
  rejected until Phases 2 and 3.
- [ ] **Hashing** (design §4.5): BLAKE3 native with a WASM fallback, and SHA-256; repo
  `hash:` setting; 1 MB `fs.read` loop; parallel worker pool.
  - Gate: run the K3 cross-hardware benchmark first (Apple M, AMD Zen, Graviton, GitHub
    runner). Default to BLAKE3 if ≥3× on 2 of 4.
- [ ] **Store** (design §4.3): derived key layout; `putIfAbsent` (SDK `If-None-Match`,
  local `O_EXCL`, rclone/command exists-then-put); batched `exists` and `list`; upload
  metadata; the `doctor` create-only probe.
- [ ] **Local state** (design §4.6): the hash cache under `git rev-parse --git-path
  blobsy` with the racy-clean rule and synced records; no `.blobsy/` in the working
  tree.
- [ ] **Commands:** `setup`, `add` (file targets, `--each`), `rm [--keep-local]`, `mv`,
  `push`, `pull [--force]`, `sync`, `status [--remote|--verify]`, `doctor [--fix|--ci]`,
  `config [--global|--local]`, `docs [--skill]`. Built on the plan/execute + reporter
  structure from the start, so later phases don’t triple the output plumbing.
- [ ] **Recoverability rule** (design §10) in `pull` and `rm`.
- [ ] **Hooks** (design §9):
  - `pre-commit`: validator, payload check, large-file guard with `git_max_file_size`;
  - `pre-push`: reads stdin refs, uploads from the cache or working tree, otherwise
    aborts.
- [ ] **Config** (design §11): three scopes; one `backend:` URL or command object;
  project-only keys enforced.
- [ ] **Startup:** lazy-load the AWS SDK, `marked-terminal` and `zod`. CI budget for
  `--version` ≤ 150 ms.

### Phase 2: Directory refs (UC-2)

Smallest cut:
- [ ] Directory targets in the ref format.
- [ ] `add <dir>` (create/update), `add --prune`, `rm`/`mv` of rows, `pull --include`,
  `status` counts and `--all`.
- [ ] One ignore line per ref.
  `doctor --fix` regenerates the managed block.
- [ ] The validator also runs in `doctor --ci`.

Deferred within the phase:
- [ ] The per-path merge driver (`merge-driver`, `.gitattributes`, `setup`
  registration), `blobsy resolve`, and the jj merge-tool mode.
  Plain text merge is safe; ship these when a real collection hits clustered-add
  conflicts, or with Phase 2 if cheap.
- [ ] `blobsy diff`.

### Phase 3: Snapshots (UC-3, UC-5)

Smallest cut:
- [ ] Tree walk with fidelity (`f`, `x`, `l:`, `d`); deterministic `tar.zst`; manifest;
  create-only `ref.yaml`.
- [ ] `snap publish`, `snap restore` (verify + atomic swap), `snap ls`.
- [ ] Cache stanzas with pure name templates.
- [ ] Local and S3 backends first.

Then:
- [ ] Pin refs (`t` rows; `--pin`; `pull` of a pin restores it).
- [ ] `--fallback`, `--only`, `snap show`, `gc --snapshots`, the lifecycle-rule check in
  `doctor`.
- [ ] Validate on `target/` and model directories; run the cargo mtime experiment before
  fixing the mtime default.

### Phase 4: Content cache and restore hooks

- [ ] Content cache (design §4.6): pull and push fill it; `cache.on_add` opt-in;
  reflink-or-copy; `cache status|prune`. The recoverability rule consults it.
- [ ] Restore hooks: `setup --hydrate` → `post-checkout`, `post-merge` and
  `post-rewrite` run `pull --cache-only --quiet`.

The cache could move earlier, into Phase 1, if worktree re-downloads or offline
switching matter sooner.
It is independent of the ref format.

### Phase 5: Lifecycle and adoption

- [ ] `blobsy gc`, using the reachability set over all refs, with a grace period and
  `--dry-run`.
- [ ] `blobsy import lfs`. It rehashes when `hash: blake3`; no rehash with `sha256`.

Phase order between 2 and 3 is decision K7. Phase 4 can run in parallel with either.

## Testing Strategy

**Unit tests:**
- ref parse/serialize/validate (sorting, escaping, prefix collisions, markers, strict
  version and algorithm);
- the key derivation vectors;
- the recoverability decision table;
- the merge algorithm (every per-path case, including prefix collisions);
- the racy-clean hash skip;
- `putIfAbsent` per backend;
- tar determinism (same tree → same bytes);
- tree_id vectors.

**Golden tryscripts** (all rewritten for v3, since the old goldens encode v2 output):
1. **One-commit flow:** `add` → commit → `git push` (hook uploads) → clean tree → fresh
   clone `pull`.
2. **Dedup:**
   - restoring old bytes uploads nothing;
   - the same bytes at two paths are stored as one object;
   - `mv` re-uploads nothing.
3. **B-1 variants all refused:**
   - `add` + `stash` + `pull`;
   - `checkout -- x.bref`;
   - pushed-but-uncommitted;
   - `commit` + `revert` + `pull` (red team).
4. **Teammate update, revert and cherry-pick** pull without `--force` (H-3).
5. **B-2:** commit on `feature`, check out `main`, `git push origin feature` → the hook
   uploads from the cache or working tree, or aborts naming the path.
6. **B-3:** `git mv` + `mv` + `git add -A` is refused by the large-file guard.
7. **Directory refs:**
   - `add`;
   - add 40 files → a 40-line diff;
   - partial `pull --include`;
   - `--prune`;
   - an adjacent-add merge with and without the driver;
   - `resolve`.
8. **Snapshots:**
   - publish/restore round trip preserving symlinks, exec bits and empty dirs;
   - a concurrent publish where the second reports “already published”;
   - a pin ref pull;
   - a fallback restore.
9. **Validator:** a hand-merged ref with markers is rejected in pre-commit and
   `doctor --ci`.
10. **Strict reader:** a v2 YAML pointer fails fast with “re-run `blobsy add`”.
11. **jj:** a colocated repo with `jj git push` (no hooks); `doctor --ci` catches the
    missing objects; the `merge-driver --jj` tool resolves a directory-ref merge.

**Benchmarks** (CI-tracked):
- `--version`;
- `status` on 10k entries;
- `add` of 1 GiB and of 10k × 100 KB;
- snapshot publish/restore of a 15k-file tree.

Run the golden suite against both the npm build and a `bun build --compile` binary.

## Rollout Plan

- **Releases.** One breaking release per phase.
  No migration, no aliases.
- **Docs.** README, SKILL and user docs are rewritten with Phase 1. Design docs move
  under the round 9 §7.5 structure:
  - spec;
  - roadmap;
  - reviews.

## Open Questions

- The design’s open decisions K1–K9 (design §18).
- Should Phase 4’s content cache move into Phase 1? It makes `pull --force` after a
  refusal, and worktrees, cheaper.
- Should the merge driver ship in Phase 2’s first cut?
  It is ~50 lines plus setup wiring.

## References

- [Design v3](../../design/current/blobsy-design.md)
- [Round 9 review](../../design/current/blobsy-design-review-round9-use-cases.md) and
  `round9-subreviews/`
- Research: `docs/project/research/current/research-2026-10-22-*.md`
- `.tbd/docs/guidelines/backward-compatibility-rules.md`

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
