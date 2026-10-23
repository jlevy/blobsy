---
title: Blobsy v3 Redesign — Implementation Plan
description: Phased plan to implement design v3 (one storage contract, one manifest format, snapshots) with no backward compatibility
author: Claude (round 9 follow-up) with Joshua Levy
---
# Feature: Blobsy v3 Redesign

**Date:** 2026-10-23 (revised after the four v3 reviews)

**Author:** Claude (round 9 follow-up)

**Status:** Draft, for owner review together with the design

**Design:** [blobsy-design.md](../../design/current/blobsy-design.md) (v3). This plan
covers order, scope and tests; the design doc is the specification.
Section numbers below refer to it.

## Overview

The plan implements design v3:
- content-addressed, create-only storage with derived keys;
- one `.bref` manifest format, used for file refs, directory refs and pins in git, and
  for snapshots in the store;
- the recoverability rule with displacement into the content cache;
- local state under the git dir;
- guard hooks that never block when blobsy is absent;
- a per-path merge driver with an inner driver for criss-cross merges, plus a validator;
- packed and files-mode snapshots;
- a 16-command surface, with 9 commands in Phase 1.

**No backward compatibility** (`CLAUDE.md`). v2 pointers, config keys, commands and
stored objects are dropped, with no migration.
Test repos are re-created.

## Goals

- Every use case in design §3 works end to end, except UC-7’s history import (deferred).
- The round 9 blockers are fixed by construction:
  - **B-1:** recoverability rule;
  - **B-2:** pre-push enumerates every ref blob in the range;
  - **B-3:** large-file guard.
- The eight data-safety must-fixes are each covered by a named test (Testing, below).
- The source shrinks in Phase 1 before it grows.
  Each phase ships the smallest cut that works.
- The performance targets of design §17 are measured in CI.

## Non-Goals

- Everything in design §19.
- Rust. TypeScript stays, per decision K10.

## Background

- **Reviews:**
  - round 9 (`blobsy-design-review-round9-use-cases.md`) and its sub-reviews;
  - the four v3 reviews (simplicity, flexibility, usability, data safety), whose
    resolutions are folded into the design.
- **Code facts from the complexity sub-review at `04a3d1a`:**
  - write-back sites: `commands-stage2.ts:334–343, 719–724, 747–754, 2112–2120`;
  - about 12 checks that treat `remote_key` presence as “pushed”;
  - `decideSyncAction`’s merge base: `stage2:553–594`;
  - the template system: `template.ts`;
  - the subdir-config walk: `config.ts:159–278`;
  - gitignore rewriting: `gitignore.ts` (326 LOC).
- **Hash benchmarks:** `research-2026-10-22-hash-performance-node-bun-rust.md`.

## Implementation Plan

### Phase 1: New core: file and directory refs, cache, guards

Phase 1 gives UC-1 and UC-2 one-commit flows, safe pulls and pushes, and CI checks.

- [ ] **Delete:**
  - `template.ts` and `remote.key_template`;
  - all `refUpdates` write-back;
  - `track`’s key clearing;
  - `decideSyncAction`’s merge base;
  - `.blobsy/` and `.blobsy/trash/`;
  - the subdir-config walk and `~/.blobsy.yml`;
  - `sync.tools` and `checksum`;
  - the aws-cli backend;
  - gzip/brotli;
  - `gitignore.ts` pattern rewriting;
  - commands `init`, `track`, `untrack`, `verify`, `health`, `check-unpushed`,
    `pre-push-check`, `hooks`, `readme`, `skill`, `sync`, `config`, `mv`, with no
    aliases.
- [ ] **Manifest format** (§5.1–5.2):
  - parser, serializer and validator for the header and the five columns;
  - kinds `f x l d` (reject `t` until Phase 3);
  - pinned escaping and sorting;
  - `tree_id`;
  - test vectors in `tests/vectors/`.
- [ ] **Hashing** (§5.5):
  - BLAKE3 native with WASM fallback, and SHA-256;
  - the algorithm read from each ref;
  - 1 MB reads and a worker pool;
  - torn-read stat check;
  - racy-clean hash cache;
  - hasher visibility in `doctor` and `--version --json`.
- [ ] **Store** (§5.3, §13):
  - derived keys;
  - `putIfAbsent` for the SDK (`If-None-Match`), local (temp + `link`), and rclone and
    command (exists-then-put + size check);
  - batched `exists` returning sizes;
  - readers try both encodings;
  - uploads only from verified immutable bytes;
  - `_blobsy/store.yaml` and `_blobsy/repos/`;
  - probe in `setup` and `doctor --probe` only;
  - per-permission diagnosis.
- [ ] **Local state** (§5.6):
  - hash cache with the `here` flag;
  - content cache (filled at add, push, pull and displacement; 0444; materialize list;
    verify on materialize; LRU prune that never drops unsynced bytes);
  - known logs keyed by store id;
  - repo lock.
- [ ] **Entry loop and the recoverability rule** (§11): decide and displace, online and
  offline.
- [ ] **Commands:** `setup` (first run vs join, `--hash`), `add` (files and directories,
  refusals from §7.2, `--prune`, `--rehash`, jj-aware), `rm` (keeps files), `clean`,
  `push [--repair]`, `pull [--only] [--all] [--offline] [--force]`, `status`,
  `doctor [--fix] [--ci [--range]] [--probe]`, `docs [--skill]`.
- [ ] **Machine output** (§7.3): one JSON envelope, plan schema, error codes, exit
  codes, partial-success semantics.
- [ ] **Hooks** (§10): POSIX shim with `npx` fallback; pre-commit (validator, payload
  check, large-file guard with allowlist and escaped-payload check); pre-push
  (`rev-list --objects` enumeration, upload from cache, abort naming commit and path,
  size notice).
- [ ] **Validator** (§9) in pre-commit and `doctor --ci`, including cross-ref overlap,
  tracked files inside targets, ignore lines and orphaned payloads.
- [ ] **Config** (§12): `.blobsy.yml` with a strict schema and `${VAR}`; `git config
  blobsy.*`; `backendOverride` reported loudly.
- [ ] **Backends:** S3 SDK, local, rclone, command.
  Read-only `https://` too, if the cut allows; otherwise in Phase 4.
- [ ] **Distribution and startup** (§14): lazy imports with a 150 ms CI budget; a
  `bun build --compile` binary built in CI and run against the golden suite (released
  when green and the addon embeds).
- [ ] **Docs:** README, the v3 SKILL (usability review §31 draft), `docs credentials`,
  `docs ci`.

### Phase 2: Merges and review

- [ ] `merge3` with the per-path rules; whole-file conflict on parse failure or header
  mismatch.
- [ ] `merge-driver` and `merge-driver --inner`; `setup` registers
  `merge.blobsy.driver`, `merge.blobsy.recursive = blobsy-inner` and `.gitattributes`.
- [ ] `blobsy resolve` (directory and file refs).
- [ ] `merge-driver --jj` and `setup --jj`.
- [ ] `blobsy diff [--markdown] [--fail-above]`.
- [ ] Auto-pull hooks: `setup --auto-pull`, running `pull --offline --quiet`.
- [ ] `git sparse-checkout` integration and persisted `blobsy.only`.

### Phase 3: Snapshots and pins (UC-3, UC-5, UC-6)

Smallest cut:
- [ ] Store manifests with `#key value` lines; the layout `snap/<name>/manifest.bref` +
  `snap/<name>/<tree_id>.tar.zst`; name validation.
- [ ] `snap publish` (packed and files modes; manifest written last, create-only; 412
  handling).
- [ ] `snap restore` (restore guard, extraction hardening, swap with `.blobsy-old-*`,
  files-mode incremental restore, `--atomic`, `--latest`, `--require`, miss exit 0 for
  caches).
- [ ] Cache stanzas with pure templates.

Then:
- [ ] Pin refs (`t` rows, `--pin`, `pull` restores pins, pre-push verifies pins).
- [ ] `--fallback`, `--only`, and `snap ls`.
- [ ] The lifecycle-rule check in `doctor`.
- [ ] The cargo mtime experiment, which settles K8.

### Phase 4: Lifecycle and adoption

- [ ] `blobsy gc`: the roots and preconditions of §16, conditional deletes, `--expire`,
  `--also-repo`, `--purge` with tombstones.
- [ ] `blobsy import lfs` (verifies LFS hashes while copying; no rehash with `sha256`).
- [ ] Read-only `https://` backend, if not in Phase 1.
- [ ] Windows CI for the golden suite.

Phase 3 may move ahead of Phase 2 if build caches are the pressing need: snapshots don’t
depend on the merge driver.

## Testing Strategy

**Unit tests:**
- manifest parse/serialize/validate (sorting, escaping vectors, prefix collisions,
  markers, `.` row rules, store-only `#` lines);
- `tree_id` vectors;
- the key derivation vectors;
- the recoverability decision table, online and offline, including stale known logs;
- `merge3` for every per-path case, plus header mismatch and unparsable input;
- the racy-clean and torn-read rules;
- `putIfAbsent` per backend, including a crash mid-write on `local:`;
- name templates and name validation.

**Golden tryscripts** (all rewritten for v3):
1. **One-commit flow:** `add` → commit → `git push` (hook uploads) → fresh clone `pull`.
2. **Dedup:** restoring old bytes uploads nothing; the same bytes at two paths are one
   object.
3. **B-1 variants all refused:** `add` + `stash` + `pull`; `checkout -- x.bref`;
   pushed-but-uncommitted; `commit` + `revert` + `pull`.
4. **Stale vs modified:** a teammate update shows `⇣` and pulls without `--force`.
   `--force` displaces into the cache and prints the hash.
5. **gc’d object** (safety F1): a known-but-deleted object fails the online check, and
   `pull` refuses.
6. **B-2 / F24:** two commits pushed together (v2 and v3), with neither checked out →
   the hook uploads both from the cache or aborts naming the path.
7. **B-3 / F18:** `git mv` of a ref + `git add -A` → the guard refuses the escaped
   payload.
8. **Mutable upload** (F8): a file rewritten between `add` and `push` never reaches the
   key.
9. **Directory refs:**
   - `add`;
   - `add <dir>` refusal on git-tracked files;
   - +40 files → a 40-row diff;
   - partial `pull --only` then `add --prune` keeps never-pulled entries (F5).
10. **Criss-cross merge** (F16): reproduce the scenario.
    With the inner driver, no clean row is lost.
    Without it, the test documents the failure.
11. **Clean merge creating nesting** (F17): `doctor --ci` fails.
12. **Snapshots:**
    - packed round trip preserving symlinks, exec bits and empty dirs;
    - two concurrent publishers of different trees (F29) leave a consistent name;
    - `snap restore` refuses a path with tracked files (F30);
    - a malicious archive with `..` and symlink escapes is rejected (F31);
    - files-mode incremental publish and restore move only changed files;
    - a cache miss exits 0.
13. **Hooks without blobsy installed:** unrelated commits pass; a commit touching
    `.bref` is blocked with the install line.
14. **jj colocated:** `jj git push` with no hooks; `doctor --ci --range` catches the
    missing objects; `merge-driver --jj` resolves a directory-ref merge.
15. **Restoring without blobsy:** fetch a file with `rclone copy` using the derived key.
16. **gc safety** (Phase 4): refuses on a shared prefix, without fetch, and without a
    recovery window; spares stash and reflog roots.

**Benchmarks** (CI-tracked):
- `--version`;
- `status` on 10k and 100k entries;
- `add` of 1 GiB and of 10k × 100 KB;
- packed publish/restore of a 15k-file tree;
- files-mode publish with 1% changed.

Run the golden suite against the npm build and the compiled binary, on Linux and macOS
(and Windows from Phase 4).

## Rollout Plan

- One breaking release per phase, with no migration and no aliases.
- README, SKILL and user docs are rewritten with Phase 1.
- The threat model is updated with the design (done).

## Open Questions

- The design’s open decisions K1–K10 (§20).
- Should read-only `https://` land in Phase 1? It is ~80 lines and unlocks public
  datasets.
- Phase order between 2 and 3.

## References

- [Design v3](../../design/current/blobsy-design.md)
- [Threat model](../../design/current/blobsy-threat-model.md)
- [Round 9 review](../../design/current/blobsy-design-review-round9-use-cases.md) and
  `round9-subreviews/`
- Research: `docs/project/research/current/research-2026-10-22-*.md`
- `.tbd/docs/guidelines/backward-compatibility-rules.md`

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
