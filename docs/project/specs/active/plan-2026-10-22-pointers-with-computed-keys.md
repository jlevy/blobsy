---
title: Pointers with Computed Keys (Blobsy pointers + Gat-style storage names)
description: Keep blobsy's per-file .bref pointers and get Gat's one-commit flow, real dedup, local content cache, hydration, and a fast hash
author: Claude (round 9 follow-up) with Joshua Levy
---
# Feature: Pointers with Computed Keys

**Date:** 2026-10-22

**Author:** Claude (round 9 follow-up)

**Status:** Draft — needs decisions K1–K5 before implementation

## Overview

Blobsy and Gat each get something right that the other doesn’t (round 9 review §4.3,
§9.1; `research-2026-10-22-competitor-gat.md`):

- **Blobsy:** a per-file pointer next to the payload, which merges correctly on any host
  (GitHub, jj, fresh clones).
  It also has guard hooks, readable state, any-storage backends, and `--json`.
- **Gat:** storage names computed from content, so `add` writes the final reference and
  there is no second “record the key” commit.
  It also has real dedup, create-only uploads, a local content cache shared across
  branches and worktrees, hydration after git operations, and a fast hash (BLAKE3).

This plan keeps blobsy’s pointer model and adopts Gat’s storage and cache model.
It is the concrete version of round 9 decisions D2 and D3 and the core of Phase 1. It
also resolves bead `blobsy-pqyt` (two-phase `remote_key`).

## Goals

Benefits to keep from blobsy, and to gain from Gat:

| Keep (blobsy) | Gain (Gat) |
| --- | --- |
| One `.bref` per file, next to the payload | **One commit per change**: the pointer is final at `add` time |
| Merges with plain git on any host; no driver needed | **Real dedup**: identical bytes stored once, across paths, branches and time |
| Pre-commit / pre-push guards | **Create-only uploads**: the server refuses overwrites |
| Any backend (S3, rclone, local, command) | **Local content cache**: offline branch switches, no worktree re-downloads, a recovery copy of local bytes |
| `--json`, skill, self-describing pointers, size recorded | **Hydration hooks** after checkout/merge/rebase (opt-in) |
| SHA-256 interop where it matters (LFS import) | **Fast hash** for new content (BLAKE3), if K3 approves |

Additionally:
- fix B-1/H-3 (unsafe overwrites) via the recoverability rule;
- fix B-2 (pre-push uploads the wrong thing);
- record the exec bit.

## Non-Goals

- Collection manifests (UC-2) and snapshots (UC-3/UC-5): later phases.
  This plan only makes sure they can share the key function, the hash, and the cache.
- A repo-wide lock file like `gat.lock`. Per-file pointers stay; collections get
  per-directory manifests later.
- Smudge/clean filters, file locking, merge drivers for `.bref`.
- Single-binary distribution (round 9 §7.4; independent of this work).
- Rewriting history or re-homing existing objects automatically (`migrate-keys` is a
  separate, explicit command).

## Background

### Why a second commit exists today

The default key template is
`{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}` (`config.ts:50`,
`transfer.ts:295`). It contains the push time, so the key cannot be known until push:

- `pushFile` returns `refUpdates` (`transfer.ts:278–343`), which callers write back into
  the `.bref` at four sites (`commands-stage2.ts:334–343, 719–724, 747–754,
  2112–2120`).
- The pre-push hook writes keys into the working tree *after* the outgoing commits are
  fixed, so teammates receive pointers without keys (bead `pqyt`).
- `track` must clear `remote_key` whenever content changes (`cli.ts:938–945,
  1065–1075`), so restoring old bytes re-uploads them.
- About a dozen call sites treat “`remote_key` present” as “pushed” (`stage2:181, 245,
  251, 288, 419, 456, 558, 1062, 1922, 1961, 2077`), so status is wrong whenever the key
  exists but the blob doesn’t, or vice versa.

### How Gat avoids it

The key is a pure function of the content ID (`blake3/xx/yy/<oid>`) and is never stored.
`gat add` writes the final lock row before any upload.
Push is “upload if absent”, with a create-only write.
There is nothing to write back.

### Measured hash speed (this machine, 2026-10-22)

The test machine is an Intel cloud VM with AVX-512 but **no SHA-NI** (no SHA-256
hardware acceleration), on Node 22. These are the lead reviewer’s measurements
(scratchpad `hashbench/`).

| Hash (Node) | In-memory, 256 MB | File, 1 GiB, page cache |
| --- | --- | --- |
| `crypto` SHA-256 (OpenSSL) | 341 MB/s | 3.0–3.2 s/GiB (~330 MB/s) |
| `crypto` SHA-512 | 560 MB/s | — |
| `hash-wasm` BLAKE3 (WASM) | 482 MB/s | — |
| `@napi-rs/blake-hash` BLAKE3 (native, v1.4.0, 14 prebuilt platforms) | 4.46 GB/s | 0.40–0.53 s/GiB (~2.0–2.6 GB/s) |
| `hash-wasm` xxh128 (non-cryptographic, reference only) | 2.8 GB/s | — |
| `cat` (read only) | — | 0.16 s/GiB |

So:
- **Native BLAKE3 is 6–8× faster** than SHA-256 per file here, and close to disk read
  speed.
- **WASM BLAKE3 is only ~1.4× faster**, so the win requires the native addon.
- **On CPUs with SHA hardware acceleration** (Apple M-series, AMD Zen, recent Intel),
  OpenSSL SHA-256 is typically 1.5–2 GB/s per core, so the gap should shrink to roughly
  1.5–2.5× [I — measure before deciding].
- **The `blake3` npm package is unusable**: it pins a nonexistent `blake3-wasm` version.

Hashing matters for:
- the first `add` of large data;
- `verify`;
- pull verification on fast links;
- snapshot publish/restore (later phases).

Once the hash cache is wired in (Step 2), unchanged files are not rehashed at all.
So the fast hash speeds up *new and changed bytes*, not steady-state `status`.

## Design

### Approach

**1. Compute the key at `add` time and record it in the pointer.** It is never assigned
at push and never written back afterwards.

```yaml
# blobsy -- https://github.com/jlevy/blobsy
# Run: blobsy status | blobsy --help

format: blobsy-bref/0.2
hash: blake3:9f2c0e7b…            # or sha256:… (algorithm prefix, see K3)
size: 300000
remote_key: blake3/9f/2c/9f2c0e7b….zst
compressed: zstd                  # decided at add time; absent = stored as-is
executable: true                  # only when the exec bit is set
```

Why record the key rather than derive it on every read, as Gat does (decision K1):

|  | Record at add (recommended) | Derive on read (Gat-style) |
| --- | --- | --- |
| One commit per change | yes | yes |
| Plain `git mv` of a pointer | still pulls (key travels with the pointer) | breaks if the template uses `{filename}`/`{repo_path}` |
| Changing the template or hash later | old pointers keep working | every old pointer’s derived key changes; old objects become unreachable |
| Legacy 0.1 pointers | same field, same code path | a second code path forever |
| GC reachability | the set of `remote_key` strings in history | must re-derive per pointer, plus handle legacy keys |
| Pull needs repo config to locate the object | no | yes |
| Cost | one more line in the pointer and in diffs | none |
| Untrusted pointer names an arbitrary key | content is hash-verified on pull; key containment already enforced (threat model rule 2) | n/a |

The invariant that matters is unchanged from round 9: **no push-time state is ever
written into a committed file.** A key computed at add time satisfies it.

**2. Pure content keys by default, with the filename as metadata** (decision K2).

- Default template: `{hash_algo}/{h0}/{h1}/{hash}{compress_suffix}`, e.g.
  `blake3/9f/2c/9f2c….zst`. This gives maximum dedup, free renames, and the same object
  whether a file lives in a pointer or (later) in a collection manifest.
  Moving between the two never re-uploads.
- **Revision to round 9 D2:** round 9 leaned toward `{content_sha256}/{filename}` for
  bucket readability. With collections deriving keys per line, a filename in the key
  would make a rename inside a collection change its key.
  Readability moves instead to:
  - **object metadata** at upload (`x-amz-meta-blobsy-path`, and `Content-Disposition:
    attachment; filename=…` on S3/GCS/Azure), so consoles show and download the original
    name;
  - `blobsy ls --remote`, which renders a path view from the pointers.
  - Backends that can’t set metadata (command, some rclone remotes) simply skip it.
- **Allowed template variables:** only entry-derived ones — `{hash}`, `{hash_algo}`,
  `{h0}`, `{h1}`, `{hash_short}`, `{compress_suffix}`, `{filename}`, `{repo_path}`.
  `{iso_date_secs}` is rejected.
  A custom template is evaluated once, at add, and recorded.

**3. Compression is decided at `add` time.** Apply the existing rules (`compress.ts`
`shouldCompress`). For candidate files, compress once and keep the result only if it is
≥5% smaller.
The decision determines the key suffix, so it must be made before the key is
recorded. If the local cache is on, the compressed bytes go there, so push doesn’t
compress again.

**4. Upload is “put if absent”.**

- **Create-only writes where the backend supports them:**
  - S3 SDK: `IfNoneMatch: '*'` on `PutObject` and on `CompleteMultipartUpload` via
    `lib-storage` params;
  - local: `link()`/`O_EXCL`;
  - aws-cli ≥ 2.33: `s3 cp --no-overwrite`.
- **Everywhere else** (rclone GCS/Azure, command backends): `exists` then `put`.
- **Outcomes:** HTTP 412 or “exists” both count as success.
  An object that exists but fails a sampled size check is reported, never overwritten.
- **Probe:** `doctor` checks that the backend actually honors create-only writes by
  writing a sentinel object twice.

**5. “Pushed” is remote state, recorded locally.**

- A successful push or pull records `{hash, key, at}` in the hash cache.
- `status`, offline, shows: `pushed` (recorded on this machine), `not pushed` (no record
  and no evidence), or `unknown` (a teammate’s pointer, never synced here).
- `status --remote`, `doctor --remote` and the pre-push check verify existence in batch:
  - `list` on the key prefix when there are many keys;
  - `HEAD` per key when there are few.

**6. The recoverability rule** (round 9 §5.2) replaces the merge base.
`pull` overwrites a local file only if its bytes are recoverable.
That means at least one of:
- (a) the hash cache records that this hash was pushed or pulled here;
- (b) the local content cache holds the bytes;
- (c) `exists(key-of-local-hash)` on the backend.

Otherwise it refuses, naming the two explicit choices.
`sync` becomes `pull` then `push`, with no decision logic of its own.

**7. Local content cache** (Gat’s best idea; decision K4).

- **Location:**
  `$(git rev-parse --git-common-dir)/blobsy/objects/<algo>/<h0>/<h1>/<hash>`, shared by
  all worktrees of a clone.
  Optionally a user-level cache (`~/.cache/blobsy/objects`) shared across clones.
- **Contents:** original (uncompressed) bytes, read-only files.
  Optionally the compressed upload form alongside.
- **Populated on:**
  - pull: download → verify → cache → materialize;
  - push: copy before upload;
  - add: when the opt-in `cache.on_add: true` is set.
    This doubles disk use, but unpushed edits then always have a recovery copy.
- **Materialization:** reflink (`cp --reflink` / `copyFile` with `COPYFILE_FICLONE`)
  when the filesystem supports it, else a copy.
  **Never hardlinks by default** — an edit would corrupt the cache, which Gat warns
  about too.
- **Eviction:** `blobsy cache status | prune [--max-size 20G] [--older-than 30d]`. The
  cache is never a GC root and never required for correctness.
- **Effects:**
  - branch switches and `pull --force` after a refusal work offline for cached content;
  - a second worktree costs reflinks, not downloads;
  - B-1-class losses become recoverable.

**8. Hooks: keep the guards, add opt-in hydration.**

- **Pre-commit (kept):** staged pointers match their payloads (using the hash cache, so
  it’s fast), plus a **large-file guard** that refuses a staged payload with a sibling
  `.bref` (B-3).

- **Pre-push (rewritten):**
  1. read the `<local ref> <sha> <remote ref> <sha>` lines from stdin;
  2. list the `.bref` files changed in `<remote sha>..<local sha>` and read each from
     the *commit* (`git show <sha>:<path>`);
  3. upload each key the backend lacks, from the local cache or the working tree, after
     verifying the bytes match the pointer’s hash;
  4. **abort the push**, naming the path and commit, if neither has the bytes (B-2).

  It no longer writes to the working tree, and there is no “commit your keys” message.

- **Hydration (new, opt-in):** `blobsy hooks install --hydrate` adds `post-checkout`,
  `post-merge` and `post-rewrite` hooks that run `blobsy pull --cache-only --quiet`.
  - No network access unless `hydrate.fetch: true`.
  - They always exit 0, printing one line on failure.
  - Installed via `git rev-parse --git-path hooks`, so `core.hooksPath` (husky,
    lefthook) is honored; Gat gets this wrong.
  - `cherry-pick`, `stash`, `reset` and `restore` fire no hooks.
    `status` prints “N files behind their pointers: run `blobsy pull`”.

- **Correctness never depends on any of these** (round 9 X-1). The CI check
  (`blobsy doctor --remote --ci`) is the backstop for jj, `--no-verify` and hosted
  merges.

**9. Hash algorithm agility** (decision K3).

- Pointers already carry an algorithm prefix (`sha256:`), and keys get an algorithm
  namespace (`sha256/…`, `blake3/…`). Both algorithms are readable forever.
- `hash.algorithm` in the committed `.blobsy.yml` selects the algorithm for *new*
  content: `blake3` (recommended default for new repos) or `sha256`.
- **Implementation:** `@napi-rs/blake-hash` native BLAKE3 as an optional dependency,
  with a `hash-wasm` BLAKE3 fallback.
  The fallback is correct but only ~1.4× faster than SHA-256. SHA-256 stays on Node’s
  built-in `crypto`.
- **`import-lfs` keeps SHA-256:** LFS oids are SHA-256, so imported pointers stay
  `sha256:` with no rehash or download.
  A repo may mix algorithms.
  The same bytes added under both algorithms are stored twice, which is acceptable.
- **Lost with BLAKE3:**
  - S3’s server-side `x-amz-checksum-sha256` verify-without-download.
    Transfer integrity still comes from the provider’s default CRC64NVME/CRC32C, and
    identity is verified on download as today.
  - `sha256sum` as the manual check; it becomes `b3sum`.
- **Gained besides speed:** Gat also uses BLAKE3, so a future `import-gat` needs no
  rehash.

### Components

| File | Change |
| --- | --- |
| `types.ts` | `Bref` adds `executable?`; `BREF_FORMAT = 'blobsy-bref/0.2'`; `compressed_size` read-only (still parsed, no longer written) |
| `hash.ts` | Algorithm-agile `computeHash(path, algo)`, `parseHash` accepting `sha256:`/`blake3:`; native BLAKE3 with WASM fallback |
| `template.ts` | One `deriveKey(entry, config)`; new variables; reject `{iso_date_secs}`; new default template |
| `config.ts`, `config-schema.ts` | `hash.algorithm`, `cache.*`, `hydrate.*`; new default template; drop the timestamp default literal (also in `transfer.ts:295`) |
| `compress.ts` | Add-time decision with keep-if-smaller trial |
| `cli.ts` (`trackSingleFile`, `trackDirectory`, `mv`) | Compute hash, compression, key and exec bit at add; never clear `remote_key`, recompute it; `mv` keeps the key |
| `transfer.ts` | `pushFile` uploads to `ref.remote_key` (or derives one for keyless 0.1 pointers) and returns no `refUpdates`; `pullFile` consults the local cache first and restores the exec bit; object metadata on upload |
| `backend-*.ts`, `types.ts` `Backend` | `putIfAbsent`, `list(prefix)`, `capabilities.conditionalPut`, optional `setMetadata` |
| `commands-stage2.ts` | Delete the 4 write-back sites; replace “`remote_key` present = pushed” (~12 sites) with `isPublished()` (local record ∨ batched remote check); `decideSyncAction` → recoverability rule; rewrite the pre-push hook; add hydration hook handlers |
| `stat-cache.ts`, `paths.ts` | Move under `$(git rev-parse --git-path blobsy)`; add the pushed/pulled record; wire `getCachedHash` (size + mtime, racy-clean rule: re-hash when mtime ≥ the cache entry’s write time) |
| new `cache.ts` | Local content cache: put/get/materialize (reflink → copy)/prune |
| `hooks.ts` | `--hydrate` hook set |
| docs, `SKILL.md`, README | One-commit flow; remove two-phase guidance; dedup claim becomes true |

### API changes (user-visible)

- **The `add` → commit → `git push` flow is complete** (the hook uploads).
  No second commit.
- **`blobsy status`:** new `pushed` / `not pushed` / `unknown` wording; `--remote` flag.
- **New:** `blobsy cache status|prune`, `blobsy hooks install --hydrate`,
  `blobsy pull --cache-only`.
- **New config keys:** `hash.algorithm`, `cache.enabled` (default on), `cache.on_add`,
  `cache.max_size`, `hydrate.fetch`.
- **Removed:** the `{iso_date_secs}` template variable; the “commit the remote_key
  update” messaging; `check-unpushed`’s key-presence semantics (folded into
  `status --remote` per round 9 S3).

## Implementation Plan

Steps 1 and 2 are the core.
Each step is shippable on its own.

### Step 0: Decisions (owner)

- [ ] **K1:** record the key at add time (recommended), or derive it on read.
- [ ] **K2:** default template: pure content key + filename as object metadata
  (recommended), or `{hash}/{filename}`.
- [ ] **K3:** default hash for new content: BLAKE3 native with WASM fallback
  (recommended, subject to the cross-hardware benchmark below), or stay SHA-256.
- [ ] **K4:** local cache on by default (populated on pull and push; `on_add` opt-in).
- [ ] **K5:** hydration hooks opt-in (recommended) or on by default.
- [ ] **Benchmark before K3 is final:** SHA-256 vs native BLAKE3 on Apple M-series, AMD
  Zen, AWS Graviton, and an Intel CI runner (GitHub `ubuntu-latest`). Keep the plan’s
  default if BLAKE3 is ≥3× faster on at least two of the four; otherwise stay on SHA-256
  and rely on the hash cache plus parallel hashing across files.

### Step 1: Pointer 0.2 with computed keys (closes `pqyt`)

- [ ] `deriveKey` + allowed-variable validation; new default template.
- [ ] Algorithm-agile hashing (BLAKE3 behind `hash.algorithm`, if K3).
- [ ] Add-time compression decision with keep-if-smaller.
- [ ] `track`/`add` write `remote_key`, `compressed` and `executable` at add; `mv` keeps
  the key.
- [ ] `pushFile` without `refUpdates`; delete the 4 write-back sites and the `track`
  key-clearing.
- [ ] `putIfAbsent` on local and S3 SDK; aws-cli `--no-overwrite` with a version check;
  exists-then-put elsewhere; `doctor` probe.
- [ ] Object metadata (path, filename) on S3/GCS/Azure uploads where supported.
- [ ] Reader accepts 0.1 (keyed or keyless) and 0.2. Keyless 0.1 pointers derive a key
  with the current template on push and pull.

### Step 2: Pushed record and recoverability rule (fixes B-1, H-3)

- [ ] Move the hash cache under the git dir; `doctor --fix` runs `git rm --cached` on
  committed `.blobsy/stat-cache`.
- [ ] Wire the size + mtime hash skip (racy-clean) into status, verify, push, pull and
  the hooks.
- [ ] Record pushed/pulled `{hash, key, at}`; `isPublished()` with batched remote
  checks.
- [ ] Replace `decideSyncAction`’s merge base with the recoverability rule; `sync` =
  `pull` then `push`.
- [ ] Replace ~12 “`remote_key` present” checks.

### Step 3: Pre-push hook reads pushed refs (fixes B-2) and the large-file guard (B-3)

- [ ] Parse stdin ref lines; diff `.bref` files per range; read pointers from commits.
- [ ] Upload from cache or working tree after a hash check; abort with path and commit
  otherwise.
- [ ] Pre-commit large-file guard; `doctor --remote --ci` for CI.

### Step 4: Local content cache

- [ ] `cache.ts` with put/get/materialize (reflink → copy) and prune; worktree-shared
  location.
- [ ] Pull reads the cache first; push and (opt-in) add populate it; the recoverability
  rule consults it.

### Step 5: Hydration hooks (opt-in)

- [ ] `hooks install --hydrate`; `pull --cache-only`; hook handlers that never fail the
  git operation.
- [ ] `status` hint for operations that fire no hooks.

Rough size [I]:
- Steps 1–2 change ~900–1,200 LOC and are net negative (the write-back paths, merge
  base, key clearing and timestamp handling go away).
- Steps 3–5 add ~500–700 LOC.

## Testing Strategy

**Unit tests:**
- `deriveKey` vectors for both algorithms;
- 0.1/0.2 pointer parsing;
- the recoverability decision table;
- `putIfAbsent` semantics per backend (local and the s3rver mock);
- cache put/get/materialize/prune;
- the racy-clean hash skip.

**New golden tryscripts** (they run the CLI from `$PATH`):
1. **One-commit flow:** `add` → `git commit` → `git push` (hook uploads) → the working
   tree is clean → a fresh clone runs `blobsy pull` successfully.
2. **Dedup:** restore old bytes → `add` → push uploads nothing; the same bytes at two
   paths are stored as one object.
3. **Plain `git mv`:** `git mv a.bref b.bref && mv a b` → a fresh clone pulls `b` (the
   key travels with the pointer).
4. **B-2:** commit on `feature`, check out `main`, `git push origin feature` → the hook
   uploads from the cache, or aborts with the path named.
5. **B-1 and red-team variants** are all refused:
   - `track` + `stash` + `sync`;
   - `checkout -- f.bref`;
   - pushed-but-uncommitted;
   - `commit` + `revert` + `pull`.
6. **Teammate update / revert / cherry-pick:** `pull` succeeds without `--force` (H-3).
7. **Cache:** a second worktree pulls with the network disabled (unreachable local
   backend path); `cache prune --max-size`.
8. **Hydration:** `checkout` of another branch materializes from cache; `core.hooksPath`
   respected.
9. **Mixed algorithms:** an imported `sha256:` pointer next to new `blake3:` pointers;
   both pull.
10. **Create-only:** a second push of the same key is a no-op.
    A pre-existing object with different bytes under the key is reported, not
    overwritten.

**Existing goldens:** the `REMOTE_KEY` pattern in `tryscript.config.ts` and ~20 goldens
change shape (budget for it).
Run the golden suite against both the npm build and a `bun build --compile` binary.

**Benchmarks:** `add` of 1 GiB and 10k × 100 KB; no-op `status` and `sync` on 10k files
(target ≤1 s warm); recorded in the PR.

## Rollout Plan

- **One release** ships Step 1 and Step 2 together.
  Shipping the new default template without derive-when-absent and the new pushed
  semantics would let mixed clients disagree.
- **Mixed teams (old + new blobsy):**
  - Old clients keep writing timestamped `remote_key`s, which new clients read as-is.
  - Old clients reading 0.2 pointers see `remote_key` and assume “pushed”, so their
    status is optimistic but pull fails clearly if a blob is missing.
  - `.blobsy.yml` gains an optional `min_version`, which old clients ignore and new ones
    enforce.
- **Existing objects stay where they are.** `blobsy migrate-keys` (explicit, later)
  re-homes them to content keys with create-only copies.
- **Existing repos keep their hash algorithm** unless they opt in.
  New repos get the K3 default.

## Open Questions

- K1–K5 above.
- Should `executable` generalize to Gat-style `kind` (`f|x|l`) now, ahead of UC-3
  snapshots, or stay a boolean in pointers?
- Should native BLAKE3 also hash in parallel *within* a large file (BLAKE3’s tree mode;
  ~4× more on 4 cores in Rust)?
  Check `@napi-rs/blake-hash` support before relying on it.
- Should the cache store compressed upload forms as well, so pushes never recompress, or
  only original bytes?
- Should the user-level cache (shared across clones) default on, given disk use?

## References

- Round 9 review: `docs/project/design/current/blobsy-design-review-round9-use-cases.md`
  (§4.3, §5.1–§5.2, §6.2 invariants, §9.1, D2/D3)
- Gat deep dive: `docs/project/research/current/research-2026-10-22-competitor-gat.md`
  (§3 data model, §4 lifecycles, §5 hooks, §12 comparison)
- Object-store capabilities:
  `docs/project/research/current/research-2026-10-22-object-store-capabilities-refresh.md`
  (create-only writes, checksums, metadata)
- Language review:
  `docs/project/design/current/round9-subreviews/language-typescript-vs-rust.md` (hash
  benchmarks; native addon distribution)
- Bead `blobsy-pqyt` (two-phase `remote_key`)

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
