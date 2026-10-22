---
title: Pointers with Computed Keys (Blobsy pointers + Gat-style storage names)
description: Keep blobsy's per-file .bref pointers and get Gat's one-commit flow, real dedup, local content cache, hydration, and a fast hash — with no backward compatibility
author: Claude (round 9 follow-up) with Joshua Levy
---
# Feature: Pointers with Computed Keys

**Date:** 2026-10-22 (revised the same day: no backward compatibility; hash benchmarks
added)

**Author:** Claude (round 9 follow-up)

**Status:** Draft — needs decisions K1–K4 before implementation

## Overview

Blobsy and Gat each get something right that the other doesn’t (round 9 review §4.3,
§9.1; `research-2026-10-22-competitor-gat.md`):

- **Blobsy** has a per-file pointer next to the payload, which merges correctly on any
  host (GitHub, jj, fresh clones).
  It also has guard hooks, readable state, any-storage backends, and `--json`.
- **Gat** computes storage names from content, so `add` writes the final reference.
  There is no second “record the key” commit, and identical bytes are stored once.
  - Uploads are create-only.
  - It keeps a local content cache shared across branches and worktrees.
  - It restores files after git operations, and uses a fast hash (BLAKE3).

This plan keeps blobsy’s pointer model and adopts Gat’s storage and cache model.
It is the concrete form of round 9 decisions D2, D3 and D15, and the core of Phase 1. It
closes bead `blobsy-pqyt` (two-phase `remote_key`).

**Compatibility policy: none.** Blobsy is a pre-alpha proof of concept with no released
users. Per `backward-compatibility-rules` (“DO NOT MAINTAIN”) and the owner’s
instruction, this plan keeps no old pointer formats, config keys, commands, key layouts
or stored objects:
- Readers accept exactly the current pointer format and fail fast on anything else.
- Repos with old pointers re-run `blobsy add`.

## Goals

| Keep (blobsy) | Gain (Gat) |
| --- | --- |
| One `.bref` per file, next to the payload | **One commit per change**: the pointer is final at `add` |
| Merges with plain git on any host; no driver needed | **Real dedup**: identical bytes stored once, across paths, branches and time |
| Pre-commit / pre-push guards | **Create-only uploads**: the server refuses overwrites |
| Any backend (S3, rclone, local, command) | **Local content cache**: offline branch switches, no worktree re-downloads, a recovery copy of local bytes |
| `--json`, skill, self-describing pointers, size recorded | **Restore hooks** after checkout/merge/rebase (opt-in) |
|  | **Fast hash** for content (BLAKE3), if K3 approves |

Also in scope:
- fix B-1 and H-3 (unsafe overwrites) via the recoverability rule;
- fix B-2 (pre-push uploads from the wrong place);
- record the exec bit.

## Non-Goals

- **Backward compatibility of any kind.** No dual readers, migrations, aliases or
  rollout coordination.
- **Collection manifests (UC-2) and snapshots (UC-3/UC-5).** These are later phases.
  This plan only makes sure they can share the key function, the hash and the cache.
- **A repo-wide lock file like `gat.lock`.** Per-file pointers stay; collections get
  per-directory manifests later.
- **Smudge/clean filters, file locking, merge drivers for `.bref`.**
- **Single-binary distribution** (round 9 §7.4).
- **User-configurable key templates.** The layout is fixed (see Design).

## Background

### Why a second commit exists today

The default key template is
`{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}` (`config.ts:50`,
`transfer.ts:295`). It contains the push time, so the key cannot be known until push.
That causes four problems:

- **Write-back.** `pushFile` returns `refUpdates` (`transfer.ts:278–343`), which callers
  write back into the `.bref` at four sites (`commands-stage2.ts:334–343, 719–724,
  747–754, 2112–2120`).
- **Pushed commits lack keys.** The pre-push hook writes keys into the working tree
  *after* the outgoing commits are fixed, so teammates receive pointers without keys
  (bead `pqyt`).
- **No dedup on revert.** `track` must clear `remote_key` whenever content changes
  (`cli.ts:938–945, 1065–1075`), so restoring old bytes re-uploads them.
- **Wrong status.** About a dozen call sites treat “`remote_key` present” as “pushed”
  (`stage2:181, 245, 251, 288, 419, 456, 558, 1062, 1922, 1961, 2077`). Status is wrong
  whenever the key exists but the blob doesn’t, or the reverse.

### How Gat avoids it

The key is a pure function of the content ID (`blake3/xx/yy/<oid>`) and is never stored.
`gat add` writes the final lock row before any upload, and push is “upload if absent”
with a create-only write.
There is nothing to write back.

### Hash performance (measured)

Full results are in
`docs/project/research/current/research-2026-10-22-hash-performance-node-bun-rust.md`.
They were measured on an Intel cloud VM with 4 vCPUs and **no SHA-NI**, hashing a 1 GiB
file from the page cache.

|  | Node 22 | Bun 1.4 | Rust |
| --- | --- | --- | --- |
| SHA-256 | 337 MB/s | 283 MB/s | 315 MB/s (`ring`) |
| BLAKE3, single thread (native addon in JS) | 2.85 GB/s | 2.73 GB/s | 2.95 GB/s |
| BLAKE3, all 4 cores, inside one file | — | — | 11.9 GB/s |
| BLAKE3 WASM | 465 MB/s | 213 MB/s | — |

What this shows:

- **The hash matters ~8.5×; the runtime barely matters.** Node and Bun match Rust once
  files are read with `fs.read` into 1 MB buffers.
  - With `createReadStream`, Node loses ~20%.
  - With `Bun.file().stream()`, Bun loses ~75%: each small chunk crosses into the native
    addon separately.
- **Rust’s only real extra is multi-core hashing within a single file.** It matters for
  single very large files on very fast disks.
- **SHA-NI hardware narrows the gap.** On Apple M-series, AMD Zen and recent Intel,
  SHA-256 likely reaches 1.5–2 GB/s, so the gap is probably ~1.5–2.5× [I]. Measure
  before deciding K3.
- **Hashing only touches new and changed bytes.** Once the hash cache is wired in (Step
  2), unchanged files are not re-hashed.
  The fast hash speeds up first `add`, `verify` and pull verification, not steady-state
  `status`.

## Design

### Approach

**1. The pointer holds only content facts.** The storage key is *derived*, never stored
(Gat-style; decision K1).

```yaml
# blobsy -- https://github.com/jlevy/blobsy
# Run: blobsy status | blobsy --help

format: blobsy-bref/0.2
hash: blake3:9f2c0e7b…        # algorithm is part of the value (K3 picks one)
size: 300000
compressed: zstd              # decided at add time; absent = stored as-is
executable: true              # only when the exec bit is set
```

- **No `remote_key`, no `compressed_size`.** The pointer is complete the moment `add`
  writes it. Push never touches it.
- **The reader is strict.** It accepts exactly `blobsy-bref/0.2` and one hash algorithm.
  Anything else fails with “unsupported pointer format; re-run `blobsy add
  <path>`”.

Why derive rather than record the key at add time:
- with a fixed content-only layout, a key doesn’t depend on path;
- so `git mv`, renames and promotion into a collection never change it;
- with no backward compatibility there are no old keys to preserve.

Deriving gives a smaller pointer, no stored key for a hostile pointer to forge, and GC
reachability equal to the set of hashes in git.
(An earlier draft of this plan recommended recording the key; every reason for that was
a compatibility reason.)

**2. Fixed storage layout; no key templates.**

```
<backend prefix>/<algo>/<h0h1>/<h2h3>/<hash>[.zst]
e.g.  s3://bucket/project/blake3/9f/2c/9f2c0e7b….zst
```

- **Removed:** `remote.key_template`, its eight variables, `sanitizeKeyComponent`, and
  most of `template.ts`. The backend URL prefix is the only placement control.
- **One layout serves everything.** Pointers, future collection manifests, and the local
  cache all use it, so moving a file between a pointer and a collection never
  re-uploads.
- **Readability comes from object metadata.** At upload, blobsy sets
  `x-amz-meta-blobsy-path` and `Content-Disposition: attachment; filename=…` on
  S3/GCS/Azure, so consoles show and download the original name.
  Backends that can’t set metadata skip it.
  `blobsy ls --remote` renders a path view from the pointers.
- **Command backends** receive the derived key as `{remote}`, as today.

**3. Compression is decided at `add` time.**
- Apply the existing rules (`compress.ts` `shouldCompress`).
- For candidate files, compress once and keep the result only if it is ≥5% smaller.
- The decision sets the key suffix, so it is made before the pointer is written.
- If the local cache is on, the compressed form is kept there so push doesn’t compress
  again.
- Only `zstd` and `none` (round 9 S9).

**4. Upload is “put if absent”.**

- **Create-only writes where the backend supports them:**
  - S3 SDK: `IfNoneMatch: '*'`, on `PutObject` and on `CompleteMultipartUpload` via
    `lib-storage` params;
  - local: `link()` / `O_EXCL`;
  - aws-cli ≥ 2.33: `s3 cp --no-overwrite`.
- **Everywhere else** (rclone GCS/Azure, command backends): exists-then-put.
- **Outcomes:** a 412 or “exists” both count as success.
  An existing object whose size doesn’t match is reported, never overwritten.
- **Check:** a `doctor` probe confirms create-only behavior by writing a sentinel twice.

**5. “Pushed” is remote state, recorded locally.**
- A successful push or pull records `{hash, at}` in the hash cache.
- Offline `status` shows `pushed` (recorded here), `not pushed`, or `unknown` (a
  teammate’s pointer never synced here).
- `status --remote`, `doctor --remote` and the pre-push check verify existence in batch:
  `list` on the prefix for many keys, `HEAD` for few.

**6. The recoverability rule** (round 9 §5.2) replaces the merge base.
`pull` overwrites a local file only if its bytes are recoverable.
That means at least one of:
- (a) the hash cache records that this hash was pushed or pulled here;
- (b) the local content cache holds the bytes;
- (c) the derived key for the local hash exists on the backend.

Otherwise it refuses and names the two explicit choices.
`sync` becomes `pull` then `push`, with no decision logic of its own.

**7. Local content cache** (decision K4).

- **Location:**
  `$(git rev-parse --git-common-dir)/blobsy/objects/<algo>/<h0h1>/<h2h3>/<hash>`, shared
  by every worktree of a clone.
  A user-level cache (`~/.cache/blobsy/objects`) shared across clones is optional.
- **Contents:** original bytes in read-only files, plus the compressed upload form when
  one was made.
- **Populated:**
  - on pull: download → verify → cache → materialize;
  - on push: copy before upload;
  - on add: only with the opt-in `cache.on_add: true`, which doubles disk use but gives
    unpushed edits a recovery copy.
- **Materialization:** reflink (`copyFile` with `COPYFILE_FICLONE`) when supported, else
  copy. Never hardlink by default, since an edit would corrupt the cache.
- **Eviction:** `blobsy cache status | prune [--max-size 20G] [--older-than 30d]`. The
  cache is never a GC root and never required for correctness.

**8. Hooks: keep the guards, add opt-in restore.**

- **Pre-commit (kept):**
  - staged pointers match their payloads, checked via the hash cache, so it’s fast;
  - a **large-file guard** refuses a staged payload that has a sibling `.bref` (B-3).

- **Pre-push (rewritten):**
  1. Read the `<local ref> <sha> <remote ref> <sha>` lines on stdin.
  2. List the `.bref` files changed in `<remote sha>..<local sha>`, reading each from
     the *commit* (`git show <sha>:<path>`).
  3. Upload each derived key the backend lacks, from the cache or the working tree,
     after a hash check.
  4. **Abort the push**, naming the path and commit, if neither has the bytes (B-2).

  It never writes to the working tree.

- **Restore (new, opt-in):** `blobsy hooks install --hydrate` adds `post-checkout`,
  `post-merge` and `post-rewrite` hooks that run `blobsy pull --cache-only --quiet`.
  - No network unless `hydrate.fetch: true`.
  - They always exit 0, printing one line on failure.
  - Installed via `git rev-parse --git-path hooks`, so `core.hooksPath` is honored.
  - `cherry-pick`, `stash`, `reset` and `restore` fire no hooks, so `status` prints “N
    files behind their pointers: run `blobsy pull`”.

- **Correctness never depends on any hook** (round 9 X-1). `blobsy doctor --remote --ci`
  is the CI backstop for jj, `--no-verify` and hosted merges.

**9. One hash algorithm** (decision K3). There is no algorithm agility to maintain.

- **BLAKE3 (recommended):** `@napi-rs/blake-hash` native, with a `hash-wasm` fallback
  that is correct but slow.
- **SHA-256 (alternative):** Node’s built-in `crypto`, no dependency.
- **Hashing I/O:** read via `fs.read` with 1 MB buffers, not streams, in both Node and
  Bun.
- **Parallelism:** files are hashed in parallel by a bounded worker pool.
- **If BLAKE3:**
  - `import-lfs` must read each LFS object once to rehash it.
    It is local, from `.git/lfs/objects`, and it copies the object into the store
    anyway.
  - S3’s server-side SHA-256 checksum is lost.
    Transfer integrity uses the provider default (CRC64NVME/CRC32C), and identity is
    verified on download.
  - Manual verification uses `b3sum`.
  - A future `import-gat` needs no rehash, because Gat also uses BLAKE3.

### Components

| File | Change |
| --- | --- |
| `types.ts` | `Bref` = `{format, hash, size, compressed?, executable?}`; `BREF_FORMAT = 'blobsy-bref/0.2'`; remove `remote_key`, `compressed_size` |
| `hash.ts` | One algorithm; large-buffer `fs.read` loop; native BLAKE3 with WASM fallback (if K3) |
| `template.ts` | Replace with a ~20-line `keyFor(hash, compressed)`; delete the template variables and `sanitizeKeyComponent` |
| `config.ts`, `config-schema.ts` | Remove `remote.key_template` and the default literal (also `transfer.ts:295`); add `cache.*`, `hydrate.*` |
| `ref.ts` | Strict reader: exact format, exact hash prefix, fail fast |
| `compress.ts` | Add-time decision with keep-if-smaller; zstd only |
| `cli.ts` (`trackSingleFile`, `trackDirectory`, `mv`) | Write the final pointer at add; delete key clearing; `mv` touches only the path |
| `transfer.ts` | `pushFile`/`pullFile` take the derived key and return no `refUpdates`; pull reads the cache first and restores the exec bit; object metadata on upload |
| `backend-*.ts`, `Backend` interface | `putIfAbsent`, `list(prefix)`, `capabilities.conditionalPut`, optional metadata |
| `commands-stage2.ts` | Delete the 4 write-back sites; replace ~12 “`remote_key` present” checks with `isPublished()`; replace `decideSyncAction`’s merge base with the recoverability rule; rewrite the pre-push hook; add restore-hook handlers |
| `stat-cache.ts`, `paths.ts` | Move under `$(git rev-parse --git-path blobsy)`; pushed/pulled record; wire `getCachedHash` (size + mtime, racy-clean) everywhere |
| new `cache.ts` | Content cache put/get/materialize/prune |
| `hooks.ts` | `--hydrate` set |
| docs, `SKILL.md`, README | One-commit flow; the dedup claim becomes true; remove template docs |

### User-visible changes

- **One commit:** `add` → commit → `git push` (the hook uploads) is complete.
- **New commands and flags:** `blobsy status [--remote]`, `blobsy cache status|prune`,
  `blobsy hooks install --hydrate`, `blobsy pull --cache-only`.
- **New config:** `cache.enabled` (default on), `cache.on_add`, `cache.max_size`,
  `hydrate.fetch`.
- **Removed:** `remote.key_template` and its variables; `remote_key` and
  `compressed_size` in pointers; the “commit the remote_key update” messaging.
  `check-unpushed` is removed outright, with `status --remote` and
  `doctor --remote --ci` covering it (round 9 S3; no alias).

## Implementation Plan

Each step is shippable; Steps 1–2 are the core.

### Step 0: Decisions (owner)

- [ ] **K1:** derive keys on read and store none (recommended), or record them at add.
- [ ] **K2:** the fixed layout `<algo>/<h0h1>/<h2h3>/<hash>[.zst]`, with the filename as
  object metadata (recommended).
- [ ] **K3:** BLAKE3 (recommended, subject to a benchmark) or SHA-256.
  - Benchmark SHA-256 vs native BLAKE3 on Apple M-series, AMD Zen, AWS Graviton and a
    GitHub `ubuntu-latest` runner.
  - Choose BLAKE3 if it is ≥3× faster on at least two of the four; otherwise SHA-256.
- [ ] **K4:** local cache on by default (filled on pull and push; `on_add` opt-in);
  restore hooks opt-in.

### Step 1: Pointer 0.2 with derived keys (closes `pqyt`)

- [ ] `keyFor()` and the fixed layout; delete template machinery and `key_template`.
- [ ] Hashing per K3, with large-buffer reads and a parallel pool across files.
- [ ] Add-time compression with keep-if-smaller.
- [ ] `add` writes the final pointer; delete key clearing.
- [ ] `pushFile` without `refUpdates`; delete the 4 write-back sites.
- [ ] `putIfAbsent` on local and the S3 SDK; aws-cli `--no-overwrite` (require ≥ 2.33);
  exists-then-put elsewhere; `doctor` probe.
- [ ] Object metadata on upload where supported.
- [ ] Strict 0.2 reader; delete 0.1 handling.

### Step 2: Pushed record and the recoverability rule (fixes B-1, H-3)

- [ ] Move the hash cache under the git dir; delete `.blobsy/` from the working tree.
- [ ] Wire the size + mtime hash skip (racy-clean) into status, verify, push, pull and
  hooks.
- [ ] Pushed/pulled record; `isPublished()` with batched checks; replace ~12
  key-presence checks.
- [ ] Recoverability rule; `sync` = `pull` then `push`; delete the merge-base code.

### Step 3: Pre-push from pushed refs (B-2) and the large-file guard (B-3)

- [ ] Parse the stdin ref lines; diff `.bref` per range; read pointers from commits.
- [ ] Upload from cache or working tree after a hash check; otherwise abort, naming the
  path and commit.
- [ ] Pre-commit large-file guard; `doctor --remote --ci`.

### Step 4: Local content cache

- [ ] `cache.ts`; pull reads the cache first; push and opt-in add fill it; the
  recoverability rule consults it.

### Step 5: Restore hooks (opt-in)

- [ ] `hooks install --hydrate`; `pull --cache-only`; non-failing hook handlers.
- [ ] `status` hint for git operations that fire no hooks.

Rough size [I]:
- Steps 1–2 change ~900–1,200 LOC and are clearly net negative.
  The template system, write-back paths, merge base, key clearing and 0.1 handling go
  away.
- Steps 3–5 add ~500–700 LOC.

## Testing Strategy

**Unit tests:**
- `keyFor` vectors;
- the strict pointer reader, including rejection of other formats;
- the recoverability decision table;
- `putIfAbsent` per backend (local, s3rver);
- cache put/get/materialize/prune;
- the racy-clean hash skip;
- hash test vectors for the chosen algorithm.

**New golden tryscripts:**
1. **One-commit flow:** `add` → `git commit` → `git push` (hook uploads); the working
   tree is clean; a fresh clone runs `blobsy pull` successfully.
2. **Dedup:** restoring old bytes → `add` → push uploads nothing; the same bytes at two
   paths are stored as one object.
3. **Plain `git mv`:** `git mv a.bref b.bref && mv a b` → a fresh clone pulls `b`.
4. **B-2:** commit on `feature`, check out `main`, `git push origin feature` → upload
   from the cache, or abort naming the path.
5. **B-1 and the red-team variants are refused:**
   - `track` + `stash` + `sync`;
   - `checkout -- f.bref`;
   - pushed-but-uncommitted;
   - `commit` + `revert` + `pull`.
6. **Teammate update, revert, cherry-pick:** `pull` succeeds without `--force` (H-3).
7. **Cache:**
   - a second worktree pulls with the backend unreachable;
   - `cache prune --max-size`.
8. **Restore hooks:** `checkout` of another branch materializes from cache;
   `core.hooksPath` respected.
9. **Create-only:** a second push is a no-op; an existing mismatched object is reported,
   not overwritten.
10. **Old pointer:** a 0.1 pointer fails fast with the “re-run `blobsy add`” message.

**Existing goldens:**
- Rewrite every golden whose output shows keys or 0.1 pointers.
- Update the `REMOTE_KEY` pattern in `tryscript.config.ts` to the fixed layout.
- Run the suite against the npm build and a `bun build --compile` binary.

**Benchmarks**, recorded in the PR:
- `add` of 1 GiB and of 10k × 100 KB;
- no-op `status` and `sync` on 10k files (target ≤1 s warm);
- Node vs Bun hashing throughput, using the large-read loop.

## Rollout Plan

- Ship as one breaking release.
- No migration, dual reading, or compatibility shims.
- Existing test repos re-run `blobsy add` after deleting old pointers, and objects from
  old layouts are abandoned.
- Docs and the skill describe only the new model.

## Open Questions

- K1–K4 above.
- Should `executable` become Gat-style `kind` (`f|x|l`) now, ahead of UC-3 snapshots?
- Does `@napi-rs/blake-hash` expose multi-threaded hashing within one file?
  If not, is a tiny napi-rs binding over `blake3`’s rayon API worth it for very large
  files?
- Should the user-level cache (shared across clones) default on?

## References

- Round 9 review: `docs/project/design/current/blobsy-design-review-round9-use-cases.md`
  (§4.3, §5.1–§5.2, §6.2, §9.1, D2/D3/D15)
- Hash benchmarks:
  `docs/project/research/current/research-2026-10-22-hash-performance-node-bun-rust.md`
- Gat deep dive: `docs/project/research/current/research-2026-10-22-competitor-gat.md`
- Object-store capabilities:
  `docs/project/research/current/research-2026-10-22-object-store-capabilities-refresh.md`
- `.tbd/docs/guidelines/backward-compatibility-rules.md` (DO NOT MAINTAIN)
- Bead `blobsy-pqyt`

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
