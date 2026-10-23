# blobsy: Large File Storage for Git Repos (Design v3)

**Status:** Target design, proposed 2026-10-22, for owner review.
**Not yet implemented.** The shipped code implements v2
([archive/blobsy-design-v2-per-file.md](../archive/blobsy-design-v2-per-file.md)). The
implementation plan is
[plan-2026-10-22-blobsy-v3-redesign.md](../../specs/active/plan-2026-10-22-blobsy-v3-redesign.md).

**Date:** 2026-10-22

**Basis:** the round 9 review
([blobsy-design-review-round9-use-cases.md](blobsy-design-review-round9-use-cases.md)),
its sub-reviews, the October 2026 research (including the Gat deep dive and the hash
benchmarks), and the owner’s policy of **no backward compatibility** (pre-alpha).

**Companion docs:**
- [blobsy-threat-model.md](blobsy-threat-model.md) (trust boundaries; still normative);
- [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md) (URL
  parsing, error categories and health checks remain useful; its key-template, aws-cli
  and compression sections are superseded by this document).

* * *

## 1. Summary

Blobsy keeps large files out of git while keeping their *versions* in git.
It is a standalone CLI: no server, no smudge/clean filters, and storage in any bucket or
tool you choose.

- **One storage contract.** File contents are stored once, under a name computed from
  their hash. Every write is create-only, and every read is hash-verified.
- **One reference format.** A small committed `.bref` text file sits next to the thing
  it describes. It can describe:
  - a **file** (UC-1);
  - a **whole directory** (UC-2: one line per file, one file in git);
  - a **pinned snapshot** (UC-5: one line naming an immutable tree in the store).
- **Snapshots for trees that git shouldn’t see** (UC-3): build caches and environments,
  published and restored by name, with nothing committed per tree.

Git merges the `.bref` files.
Blobsy moves the bytes, never changes a committed file after the fact, and never depends
on hooks being installed for correctness.

**What v3 takes from Gat** (`research-2026-10-22-competitor-gat.md`):
- storage names computed from content (one commit per change, real dedup);
- a manifest with per-path merging for collections;
- a local content cache;
- restore-after-checkout hooks;
- a fast hash.

**What it keeps from blobsy:**
- a reference that sits next to the payload;
- references that merge on any host with plain git;
- commit and push guards;
- readable storage, and any backend;
- `--json`, and agent-first UX;
- immutable snapshots for big trees, which no other tool reviewed offers.

* * *

## 2. Problem and Use Cases

| ID | Pain |
| --- | --- |
| PAIN-1 | No individual file over a few MB should be in git: it is a permanent performance penalty. |
| PAIN-2 | Huge numbers of files are slow to manage and cause noisy diff churn in PRs. |
| PAIN-3 | Large files tied into git’s hash tree make retroactive removal very hard. |
| PAIN-4 | Git LFS is disliked, for PAIN-3 and for GitHub’s LFS cost. |
| PAIN-5 | Storage isn’t pluggable (S3, GCS, custom), so it doesn’t fit other tools. |

| ID | Use case | Blobsy v3 answer |
| --- | --- | --- |
| UC-1 | A few large files, versioned; PRs show the metadata. | **File ref:** `model.bin.bref` holds one line. |
| UC-2 | A collection of hundreds–thousands of files; git holds one manifest, not a placeholder per file. | **Directory ref:** `images.bref` holds one line per file; the directory is ignored by a single gitignore line. |
| UC-3 | A very large tree (node_modules, `target/`) cached externally with nothing in git. | **Cache snapshot:** a named, packed, immutable tree. The name is derived from inputs (e.g. the lockfile hash); git holds only a config stanza. |
| UC-4 | Standard git merges over externalized files. | Git merges `.bref` text. A per-path merge driver removes false conflicts in directory refs; plain git stays safe without it; a validator catches bad merges. |
| UC-5 | Fixed assets with immutable names, separate from git workflows. | **Asset snapshot:** a chosen immutable name, optionally pinned by a one-line ref. |
| UC-6 | Run/output archives, path-browsable (from round 8). | Deferred (§17). |
| UC-7 | Adopting blobsy in repos that already have large files or LFS. | `blobsy import lfs`; history import later (§17). |

* * *

## 3. Principles

1. **Simple things are one command.** `blobsy add`, `git commit`, `git push`. A clone
   needs `blobsy pull`. Nothing else is required.
2. **Committed files are final when written.** No command writes back into a committed
   file after push. Every `.bref` change is one commit.
3. **Content identity is the hash.** Storage names are computed from it.
   Identical bytes are stored once, across paths, branches, collections and time.
4. **The store is immutable.** Writes are create-only.
   Deletion happens only through explicit GC or lifecycle rules for caches.
5. **Never destroy unrecoverable bytes.** Blobsy overwrites or deletes a local file only
   when its exact bytes are known to be recoverable (§10).
6. **Correctness never depends on hooks or drivers.** Plain git, GitHub merges, jj and
   fresh clones must all be safe.
   Hooks and the merge driver only add convenience.
   CI checks are the backstop.
7. **One discipline per path.** Every path is plain git, inside exactly one ref’s
   target, or a snapshot path.
   Overlaps are errors.
8. **Explicit over automatic.** Network transfers happen only in commands that name them
   (`push`, `pull`, `snap …`) and in the opt-in pre-push upload.
   Removal is never implied.
9. **Transparent and pluggable.** `.bref` files are plain text with a self-describing
   header. The store keeps original filenames as metadata.
   Any S3-compatible store, anything rclone reaches, a local directory, or a custom
   command can be the backend.
10. **Agent-first.** Every command is non-interactive, supports `--json` and
    `--dry-run`, refuses ambiguous destructive actions with an actionable message, and
    is documented by `blobsy docs`.
11. **No backward compatibility while pre-alpha.** Readers accept exactly the current
    format and fail fast on anything else.

* * *

## 4. Core Model

### 4.1 Entries

An **entry** describes one filesystem object:

| Field | Values |
| --- | --- |
| `path` | Relative to the ref’s target; `.` means the target itself. Paths use POSIX `/`, are NFC-normalized, contain no `.` or `..` segments, and escape control characters as `\xhh`. |
| `kind` | `f` regular file · `x` executable file · `t` pinned snapshot tree · `l:<target>` symlink (snapshots only) · `d` empty directory (snapshots only) |
| `size` | Bytes of the original content (for `t`, total bytes of the tree). |
| `hash` | Lowercase hex digest of the original bytes (for `t`, the `tree_id`). The algorithm is named once in the ref header. |
| `extra` | For `f`/`x`: storage encoding, `-` (as-is) or `zstd`. For `t`: the snapshot name. |

**Canonical entry line** (used for `tree_id` and in refs): `path ⇥ kind ⇥ size ⇥ hash`,
with `extra` appended as a fifth column where needed.

**Tree identity:** `tree_id = hash(sorted canonical lines, first four columns only)`.
The extra column is excluded, so the same bytes give the same id however they are
stored. Lines sort bytewise by `path`.

### 4.2 Ref files (`.bref`)

A ref file is named after its **target** with `.bref` appended, and sits next to it.

```text
data/model.bin          <- target (gitignored)
data/model.bin.bref     <- ref (committed)
```

**Format:**

```text
# blobsy ref -- https://github.com/jlevy/blobsy -- run: blobsy status <target>
#blobsy-ref 1 blake3
<path>	<kind>	<size>	<hash>	<extra>
…
```

- **Header.** Line 1 is a free comment.
  Line 2 (`#blobsy-ref <version> <algo>`) is required and **static**: it holds no
  counts, totals, tree hash or timestamps.
  Values that change on every edit would make every concurrent edit conflict.
- **Body.** One TSV row per entry, sorted bytewise by path.
  No duplicates. No file/directory prefix collisions (`a` and `a/b`). No blank lines.
- **Strict reader.** Exactly version `1`, and the repo’s configured hash algorithm.
  Anything else fails with an actionable message (“re-run `blobsy add <target>`”).

**Three target shapes**, all in the same format:

| Shape | Target | Rows | Example ref | Gitignore line |
| --- | --- | --- | --- | --- |
| **File ref** (UC-1) | a file | exactly one, path `.`, kind `f`/`x` | `.	f	300000	9f2c…	zstd` | `model.bin` |
| **Directory ref** (UC-2) | a directory | one per file (kind `f`/`x`), paths relative to the directory | `cats/001.jpg	f	48213	07ab…	-` | `images/` |
| **Pin ref** (UC-5) | a directory or file materialized from a snapshot | exactly one, path `.`, kind `t`, extra = snapshot name | `.	t	16060000000	3c1f…	assets/llama-3-8b/v2` | `llama-3-8b/` |

Examples:

```text
# data/model.bin.bref
# blobsy ref -- https://github.com/jlevy/blobsy -- run: blobsy status data/model.bin
#blobsy-ref 1 blake3
.	x	300000	9f2c0e7b…	zstd
```

```text
# data/images.bref
# blobsy ref -- https://github.com/jlevy/blobsy -- run: blobsy status data/images
#blobsy-ref 1 blake3
cats/001.jpg	f	48213	07ab13c9…	-
cats/002.jpg	f	51877	c4d1aa02…	-
tables/2026-10.parquet	f	734003200	a81c4f3e…	zstd
```

```text
# models/llama-3-8b.bref
# blobsy ref -- https://github.com/jlevy/blobsy -- run: blobsy status models/llama-3-8b
#blobsy-ref 1 blake3
.	t	16060000000	3c1f9a…	assets/llama-3-8b/v2
```

**Why one format for all three:**
- one parser, one validator, one merge driver;
- one gitignore rule per ref, so `git status` stays fast;
- reviewers see path, size and hash on one line;
- promoting files into a collection, or demoting them out, is a metadata edit, because
  the storage keys are the same.

**Rules:**
- A ref’s target must not contain another ref’s target.
  Refs don’t nest.
- A directory ref covers *every* file in its directory (minus `ignore` patterns).
  Mixed directories — some files in git, some external — use file refs (`add --each`,
  §6).

### 4.3 Store

**Object key** (fixed layout; there are no templates):

```text
<backend prefix>/<algo>/<h0h1>/<h2h3>/<hash>[.zst]
e.g.  s3://bucket/project/blake3/9f/2c/9f2c0e7b….zst
```

- **The key is a pure function of** `(algo, hash, encoding)`. It is never stored in a
  ref, never depends on a path, and never changes on rename.

- **Encoding (zstd or none)** is decided at `add` by the compression rules.
  A candidate is compressed once and the result kept only if ≥5% smaller.
  The decision is recorded in the `extra` column, so every machine derives the same key.

- **Create-only writes.**
  - S3 SDK: `If-None-Match: *`.
  - GCS/Azure: native preconditions where the backend reaches them.
  - Local: `O_EXCL`/`link`.
  - Otherwise: exists-then-put.

  “Already exists” counts as success.
  An existing object whose size mismatches is reported, never overwritten.

- **Metadata.** On upload, blobsy sets `blobsy-path` (repo path) and
  `Content-Disposition: attachment; filename=<name>` where the backend supports it, so
  consoles show and download original names.
  `blobsy status --remote --keys` prints path → key mappings.

- **Integrity.** Transfers rely on the provider’s checksums; blobsy verifies identity by
  hashing on download, before anything is replaced.

### 4.4 Snapshots

A **snapshot** is an immutable tree, or single file, stored packed under a name.

```text
<prefix>/snap/<name>/data.tar.zst      deterministic tar (sorted, uid/gid 0, fixed in-archive mtime), zstd
<prefix>/snap/<name>/manifest.tsv.zst  canonical entry lines (§4.1) + restore metadata (mtime) as extra columns
<prefix>/snap/<name>/ref.yaml          written LAST, create-only: the commit point
```

```yaml
# ref.yaml
format: blobsy-snap/1
tree_id: 3c1f9a…
algo: blake3
files: 14711
bytes: 171355937
archive_bytes: 39895989
created_at: 2026-10-22T15:11:21Z
provenance: { by: ci@runner-7, branch: main, commit: 04a3d1a, run: gh-123456 }
```

- **Two kinds of name**, one primitive:
  - **Cache snapshot (UC-3).** The name is derived from a stanza in `.blobsy.yml`, e.g.
    `cache/target/linux-x64/{hash:Cargo.lock}`. Template variables are pure:
    `{hash:<file>}`, `{os}`, `{arch}`, `{env:NAME}`; there is no `{cmd:…}`. These
    snapshots expire, by bucket lifecycle rule or `blobsy gc --snapshots`, and nothing
    is committed per tree.
  - **Asset snapshot (UC-5).** The name is chosen at publish time, e.g.
    `assets/llama-3-8b/v2`. It never expires, and a **pin ref** can record it in git.

- **Publish:**
  1. walk the tree, recording symlinks, exec bits and empty dirs;
  2. write the archive, then the manifest, then a create-only `ref.yaml`;
  3. if the ref write returns 412, read the existing ref.
     A matching `tree_id` means already published; a different one is an error for
     assets and a warning for caches.

- **Restore:**
  1. read the ref, then the manifest, and verify the tree id (and the pin, if any);
  2. fetch the archive through the local cache;
  3. extract to a sibling temp directory and hash-verify every file;
  4. swap into place with two renames.

  `--fallback` restores the newest name under the parent prefix (actions/cache-style).
  `--only <glob>` restores part of the tree.

- **Names are write-once.** There is no “latest” and no mutation.

### 4.5 Hashing

- **One algorithm per repo,** set by `hash:` in the project config.
  The default is `blake3`; `sha256` is the alternative.
  - **BLAKE3** uses the native addon `@napi-rs/blake-hash`, falling back to WASM
    (`hash-wasm`; correct but slow).
  - **SHA-256** uses Node’s built-in `crypto`.
- **Why BLAKE3.** Measured on a cloud VM without SHA hardware acceleration, native
  BLAKE3 hashes files ~8.5× faster than SHA-256 in Node, Bun and Rust alike.
  Node and Bun match Rust single-threaded once reads use 1 MB buffers.
  (`research-2026-10-22-hash-performance-node-bun-rust.md`.)
  - The gap should be smaller on CPUs with SHA hardware.
    The default is confirmed by a cross-hardware benchmark (decision K3).
  - A repo that will run `import lfs` at scale may choose `sha256`. LFS object ids are
    SHA-256, so import then needs no rehashing.
- **Implementation rules:**
  - read via `fs.read` into 1 MB buffers, never `Bun.file().stream()`;
  - hash files in parallel through a bounded worker pool;
  - never re-hash a file whose size, mtime and ctime match the hash cache.
    The racy-clean rule re-hashes when mtime ≥ the cache entry’s write time.

### 4.6 Local state

All machine-local state lives under the git directory.
Nothing is ever committable, nothing needs a gitignore line, and jj never snapshots it.

| State | Location | Contents |
| --- | --- | --- |
| Hash cache | `$(git rev-parse --git-path blobsy)/hashcache/` (per worktree) | path → size, mtime, ctime, hash; plus **synced records**: which hashes this machine pushed or pulled |
| Content cache | `$(git rev-parse --git-common-dir)/blobsy/objects/<algo>/<h0h1>/<h2h3>/<hash>` (shared by all worktrees), or `cache.dir` | read-only original bytes; snapshot archives keyed by `tree_id`; optional compressed forms |
| Local config | `$(git rev-parse --git-dir)/blobsy/config.yml` | machine-specific settings (§11) |

**The content cache:**
- is filled on pull (download → verify → cache → materialize) and on push (copied before
  upload), and on `add` when `cache.on_add: true`;
- materializes by reflink when the filesystem supports it, otherwise by copy, and never
  by hardlink;
- is never required for correctness and never a GC root;
- is pruned by `blobsy cache prune --max-size/--older-than`.

* * *

## 5. Invariants

1. **The store is create-only.** No command overwrites an object.
   Only `gc` deletes, and only objects no ref in history reaches.
   Lifecycle rules may expire `snap/cache/`.
2. **Keys are a function of committed content facts.** No push-time state is written to
   any committed file.
3. **A path belongs to at most one discipline.** `doctor`, `add` and `snap` refuse
   overlaps.
4. **Bytes are verified before they replace anything.** Pulled and restored bytes are
   hash-verified in a temp file, then renamed into place.
5. **Local bytes are destroyed only if recoverable** (§10).
6. **Hooks are optional.** Every guard a hook provides also exists as a command
   (`doctor --ci`) for CI.

* * *

## 6. Commands

Global flags: `--json`, `--dry-run`, `--quiet`, `--verbose`, `--color`.

Exit codes:
- `0`: success;
- `1`: error (network, config, validation);
- `2`: refused to protect data, or an unresolved conflict.

| Command | What it does |
| --- | --- |
| `blobsy setup [<backend>] [--no-hooks] [--hydrate]` | Idempotent. It writes `.blobsy.yml` on first run, installs the guard hooks (and restore hooks with `--hydrate`), registers the merge driver in local git config, adds `*.bref merge=blobsy` to `.gitattributes`, and installs agent docs. `--remove-hooks` reverses the hook steps. |
| `blobsy add <path>…` | A **file** becomes a file ref. A **directory** becomes a directory ref (it creates the ref or updates its entries; it never removes entries). `--each <dir>` creates file refs for files matching the `externalize` rules, keeping the rest in git. `--prune` drops entries whose files are gone. `add` hashes, decides encoding, writes the ref and the gitignore line, and runs `git add` on both. No network. |
| `blobsy rm <path>… [--keep-local]` | Removes a ref (or entries from a directory ref) and the ignore line, and deletes local files. `--keep-local` keeps the files and stops tracking them. Stored objects are untouched; `gc` reclaims them. |
| `blobsy mv <src> <dst>` | Moves files and rewrites refs: file ref ↔ file ref, rows within or between directory refs, or a file into or out of a collection. Keys never change, so nothing is re-uploaded. |
| `blobsy push [<path>…]` | Uploads objects that the backend lacks for the given refs (default: all). It verifies each file against its entry first, prefers the content cache, and never edits refs. |
| `blobsy pull [<path>…] [--include <glob>] [--cache-only] [--force]` | Materializes entries (and pinned snapshots) that are absent or differ. It overwrites only under the recoverability rule (§10); `--force` overrides. `--cache-only` makes no network calls. |
| `blobsy sync [<path>…]` | `pull`, then `push`. It has no logic of its own. |
| `blobsy status [<path>…] [--remote] [--verify] [--all]` | Per-ref and per-entry state (§10). `--remote` batch-checks object presence. `--verify` re-hashes everything, ignoring the hash cache. Directory refs show counts unless `--all`. |
| `blobsy diff [<rev>[..<rev>]] [<path>…]` | A semantic diff of refs between revisions: files added, removed and changed, with sizes. Suitable as a PR comment. |
| `blobsy resolve <ref> [--ours\|--theirs] [<path>…]` | Finishes a conflicted ref merge from git’s index stages, or from conflict markers, using the per-path rules of §8. |
| `blobsy snap publish <stanza\|path> [--name <name>] [--pin]` | Publishes a snapshot. With `--name`, it is an asset; `--pin` writes or updates the pin ref. |
| `blobsy snap restore <stanza\|name\|pin-path> [--fallback] [--only <glob>]` | Restores a snapshot by atomic swap. |
| `blobsy snap ls [<prefix>]` / `snap show <name>` | Lists snapshots, or shows one’s manifest summary or diff. |
| `blobsy gc [--dry-run] [--older-than 30d] [--snapshots]` | Deletes objects unreachable from every ref in every branch and tag (§14). |
| `blobsy cache status\|prune` | Inspects or trims the content cache. |
| `blobsy import lfs [<paths>]` | Converts Git LFS pointers in the working tree into blobsy refs and copies their objects into the store. |
| `blobsy doctor [--fix] [--ci]` | Checks config, backend health and create-only support (probe), hooks and driver, ref validity, overlaps, ignore lines and the large-file guard. `--ci` also verifies that every object referenced at HEAD exists remotely. `--fix` makes safe repairs only (regenerating ignore blocks, installing the driver config). |
| `blobsy config [<key> [<value>]] [--global\|--local] [--show-origin]` | Gets or sets config at a scope. |
| `blobsy docs [<topic>] [--skill]` | Bundled docs; `--skill` prints the agent skill. |

Hidden plumbing:
- `blobsy hook <name>` (called by installed hooks);
- `blobsy merge-driver %O %A %B %P`, also usable as a jj merge tool via
  `blobsy merge-driver --jj $base $left $right $output`.

**Removed from v2:** `init`, `track`, `untrack`, `verify`, `health`, `check-unpushed`,
`pre-push-check`, `hooks`, `readme`, `skill`. Each is folded into the table above; there
are no aliases.

* * *

## 7. Workflows

### 7.1 UC-1: a few large files

```bash
blobsy setup s3://my-bucket/my-project?region=us-east-1     # once per repo
blobsy add data/model.bin          # writes data/model.bin.bref, ignores the payload, git-adds both
git commit -m "Add model"
git push                           # pre-push hook uploads the object (or run `blobsy push`)

# Another machine
git clone … && cd … && blobsy setup     # installs hooks/driver; config already committed
blobsy pull

# Change it
python train.py                    # rewrites data/model.bin
blobsy add data/model.bin          # one-line change in the ref
git commit -am "Retrain" && git push
```

The PR shows one changed line: `.	f	300000	9f2c…` → `.	f	312004	1a7e…`. Restoring an old
version (`git checkout <old> -- data/model.bin.bref && blobsy pull`) downloads nothing
if the cache holds those bytes.
Pushing it again uploads nothing, because the object exists.

### 7.2 UC-2: a collection

```bash
blobsy add data/images             # writes data/images.bref (one line per file), ignores images/
git commit -m "Add image set" && git push

# Add 40 new files
cp new/*.jpg data/images/cats/
blobsy add data/images             # +40 lines in images.bref
git commit -am "More cats" && git push

blobsy pull data/images --include 'cats/**'    # partial working set
blobsy add --prune data/images                 # explicit removal of entries whose files are gone
blobsy diff HEAD~1 data/images                 # "+40 files (+2.1 MB)"
```

**`add` never removes entries implicitly.** A user who pulled only `cats/**` must not
lose the rest of the collection on the next `add`.

**Choosing a shape:** file refs (or `add --each`) for up to ~50 files per directory; a
directory ref above ~300 files, or for any directory that receives files in batches.
`add --each` prints a suggestion when it would create more than 200 refs in one
directory.

### 7.3 UC-3: build caches

```yaml
# .blobsy.yml
snapshots:
  target:
    path: target
    name: "cache/target/{os}-{arch}/{hash:rust-toolchain.toml}/{hash:Cargo.lock}"
    exclude: ["**/incremental/**"]
    fallback: true
```

```bash
blobsy snap restore target || true     # hit, fallback, or miss
cargo build
blobsy snap publish target             # exit 0 "already published" if another job won
```

- **Write credentials.** Only protected-branch CI gets them for `snap/cache/`; PR builds
  and laptops are read-only.
- **Expiry.** A bucket lifecycle rule on `snap/cache/` expires old caches; `doctor`
  warns when it is missing.
- **JS and Python.** Cache the package-manager store (pnpm store, uv cache) rather than
  `node_modules` or `.venv`.

### 7.4 UC-5: pinned assets

```bash
blobsy snap publish models/llama-3-8b --name assets/llama-3-8b/v2 --pin
git commit -m "Pin llama v2" models/llama-3-8b.bref .gitignore

blobsy pull models/llama-3-8b          # restores the pinned snapshot, verifying tree_id
```

Upgrading means publishing `v3` and committing a one-line change to the pin.

### 7.5 Teams and branches

- **Feature branch:** `blobsy add` → commit → push → merge.
  Objects already exist, so merging needs no transfer.
- **After `git pull`, `checkout`, `merge` or `rebase`:** run `blobsy pull`, or install
  restore hooks (`setup --hydrate`) to do this from the cache automatically.
  `cherry-pick`, `stash`, `reset` and `restore` fire no hooks; `status` reports “N files
  behind their refs”.
- **A teammate changed a file you hadn’t touched:** `pull` replaces it.
  Your old bytes were synced, so they are recoverable.
- **You changed it too:** `pull` refuses with exit 2, offering `blobsy add` (keep yours)
  or `pull --force` (take theirs).

### 7.6 CI

```bash
blobsy doctor --ci        # refs valid, no markers or overlaps, every object at HEAD exists remotely
blobsy pull --include 'test-fixtures/**'
```

`doctor --ci` is what makes hooks optional.
It catches pushes made with `--no-verify`, from jj, or from clones without hooks.

### 7.7 Agents

`blobsy docs --skill` gives the full operating guide.
The rules an agent needs:
- `add`, then commit, then push;
- after any git operation that changes refs, run `blobsy pull`;
- never pass `--force` without reading the refusal message;
- use `--json` for state.

`--dry-run --json` prints the exact plan, with resolved keys, before any transfer.

* * *

## 8. Merging

| Ref | Plain git (no driver) | With the blobsy driver |
| --- | --- | --- |
| File ref | One row. One side changed → clean. Both changed → a real conflict on one line. | Same. |
| Directory ref | Safe but conservative: hunks with no unchanged line between them conflict, so adjacent adds and edits give **false conflicts** (P≈1 for batch adds with date-prefixed names). | Per-path three-way merge, with no false conflicts. |
| Pin ref | One row; a conflict only when both sides re-pin differently. | Same. |
| Gitignore block | Lines for file refs only (few). A false conflict is possible on adjacent adds. | Not merged: `doctor --fix` regenerates the block from the refs present. |

**Per-path rules** (the same as Gat’s; `merge.rs:80-95`). For each path across base,
ours and theirs:
- identical on both sides → keep it;
- changed on one side only → take that side;
- changed differently on both, or modified on one side and deleted on the other →
  **conflict**.

The merged file always contains every clean change.
Conflicting paths get `<<<<<<< / ======= / >>>>>>>` markers around that one row only.
Prefix collisions (`a` vs `a/b`) are conflicts.
The header is taken from ours (it is static).

This differs from Gat deliberately.
Gat leaves the file as *ours* with no markers; in testing, a naive `git add` then
silently dropped the other side’s clean additions.

**Installation and fallback:**
- `.gitattributes` (committed) holds `*.bref merge=blobsy`. `setup` also writes
  `merge.blobsy.driver` into local git config.
- **Without the driver config** (a fresh clone, a GitHub web merge, jj), git silently
  uses its text merge.
  That is safe, and only conservative.
- **Repairs:**
  - `blobsy resolve <ref>` re-runs the per-path merge from index stages after a local
    driverless merge;
  - jj calls `merge-driver --jj` as a merge tool;
  - **hosted merges** are covered by the validator.
- **The validator** checks format, sort order, duplicates, prefix collisions and
  markers. It runs in pre-commit, `doctor` and `doctor --ci`, so a bad hand-merge or web
  merge can’t reach main unnoticed.
- **No network in merges.** Hydration happens afterwards (`pull`, or restore hooks).
- **No content-level merges inside `git merge`.**

* * *

## 9. Hooks

Installed by `setup` into `git rev-parse --git-path hooks`, so `core.hooksPath` (husky,
lefthook) is honored.
Each managed hook is identified by an exact marker line, and user hooks are never
modified. `BLOBSY_NO_HOOKS=1` disables them at runtime.

| Hook | Default | Action |
| --- | --- | --- |
| `pre-commit` | on | Validate staged refs (§8 validator) and check they match local payloads (fast path via the hash cache). **Large-file guard:** refuse staged files that sit inside a ref target, or exceed `git_max_file_size` (default 5 MB; PAIN-1). |
| `pre-push` | on | Read `<local ref> <sha> <remote ref> <sha>` from stdin. For refs changed in each pushed range (read from the commits), upload objects the backend lacks, from the cache or the working tree, after hash verification. **Abort the push** naming the commit and path if the bytes are unavailable. |
| `post-checkout`, `post-merge`, `post-rewrite` | off (`--hydrate`) | `blobsy pull --cache-only --quiet` (with `hydrate.fetch: true`, plain `pull`). Never fails the git operation; prints one line on problems. |

* * *

## 10. Status and the Recoverability Rule

**Entry states:**

| Symbol | State | Meaning | Next action |
| --- | --- | --- | --- |
| `✓` | ok | Local bytes match the entry | — |
| `~` | modified | Local bytes differ from the entry | `blobsy add` (keep) or `blobsy pull --force` (discard) |
| `↓` | absent | Not materialized locally | `blobsy pull` |
| `↑` | unpushed | Matches, but this machine has no record of the object in the store | `blobsy push` |
| `!` | conflict | Ref has conflict markers or is invalid | `blobsy resolve` / edit |
| `?` | unknown remote | Matches; not synced from this machine (a teammate’s) | `status --remote` to check |

With `--remote`, every entry also shows `remote: present|missing` (batched `list`/HEAD).

**Recoverability rule.** `pull` (and `rm`, which deletes files) destroys a local file
only if its current bytes are recoverable, meaning at least one of:
- (a) the hash cache records that this exact hash was pushed or pulled on this machine;
- (b) the content cache holds the bytes;
- (c) the object for the local hash exists in the store.

Otherwise the command refuses with exit 2 and prints the explicit choices.
Git history is never treated as proof that bytes exist remotely: a commit can exist
without its object ever having been pushed.

This rule replaces v2’s stat-cache merge base.
It has no ambiguous state, and needs no history of what blobsy last did beyond the
synced records.

* * *

## 11. Configuration

Three scopes, merged field by field (local > project > global > built-in):

| Scope | File | Committed | Use |
| --- | --- | --- | --- |
| Global | `~/.blobsy.yml` (or `$BLOBSY_HOME`) | no | Personal defaults: cache dir, parallelism, trust grants for command backends |
| Project | `<repo>/.blobsy.yml` | **yes** | Backend, hash, compression and externalize rules, ignore patterns, snapshot stanzas, `git_max_file_size` |
| Local | `$(git rev-parse --git-dir)/blobsy/config.yml` | no | Machine overrides: a different backend URL or profile, `cache.on_add`, `hydrate.fetch` |

Settings that affect stored bytes or keys are **project-only**; blobsy rejects them at
other scopes. These are: `hash`, `compress.*`, and the backend prefix when it changes
object location.

```yaml
# .blobsy.yml (project)
backend: s3://my-bucket/my-project?region=us-east-1   # or gs://…, azure://…, rclone:remote:path, local:../store
hash: blake3
compress:
  min_size: 100kb
  always: ["*.json", "*.csv", "*.jsonl", "*.txt"]
  never: ["*.zst", "*.gz", "*.zip", "*.parquet", "*.png", "*.jpg", "*.mp4"]
externalize:            # used by `add --each`
  min_size: 200kb
  always: ["*.parquet", "*.bin", "*.safetensors", "*.onnx", "*.pt"]
  never: ["*.md"]
ignore: [".DS_Store", "__pycache__/", "*.pyc"]
git_max_file_size: 5mb
snapshots:
  target: { path: target, name: "cache/target/{os}-{arch}/{hash:Cargo.lock}", fallback: true }
```

- **Backend forms.** `backend` is a URL string.
  The command-backend form is an object (§12).
- **Removed from v2:**
  - subdirectory configs;
  - `backends:` maps and named backends;
  - `remote.key_template`;
  - `sync.tools`;
  - `checksum`.

* * *

## 12. Backends

| URL | Implementation |
| --- | --- |
| `s3://bucket/prefix?region=…&endpoint=…&profile=…` | Built-in AWS SDK v3: S3, R2, B2, Tigris, MinIO and other S3-compatibles; create-only via `If-None-Match` |
| `gs://bucket/prefix`, `azure://container/prefix` | rclone (later, optionally, native OpenDAL npm bindings for in-process preconditions) |
| `rclone:<remote>:<path>` | Any rclone remote (70+ providers) |
| `local:<path>` | A directory outside the repo; create-only via `O_EXCL`/`link` |
| `{type: command, get, put, exists, list?, delete?}` | Custom commands, executed without a shell, with per-token expansion of `{local}`, `{key}`, `{path}`. Repo-supplied command backends need an out-of-repo trust grant. |

**Interface:**
- `get(key, dest)`
- `putIfAbsent(src, key, meta)`
- `exists(keys[])` (batched)
- `list(prefix)`
- `delete(key)` (gc only)
- `health()`
- `capabilities` = `{ conditionalPut, metadata, list }`

`conditionalPut` is **set by a doctor probe** (write a sentinel twice; expect success,
then 412), not assumed from the backend type, because some S3-compatibles silently
ignore the header.

**Transfers are batched:** a concurrency pool for the SDK, `--files-from0` for rclone,
and per-file processes only for command backends.

**Removed from v2:** the aws-cli backend (the SDK covers S3) and per-file synchronous
process spawning.

* * *

## 13. Security

[blobsy-threat-model.md](blobsy-threat-model.md) remains normative.
v3 changes:

- **Refs can no longer name arbitrary keys.** Keys are derived from hex hashes, and
  snapshot names in pin refs are validated (`[A-Za-z0-9._/-]`, no `..`, no leading `/`).
- **Local state can’t be committed:** it lives under the git directory.
- **Shared caches need write segregation** (CVE-2025-36852 “CREEP”). Snapshot refs
  record provenance; a signature field is reserved.
- **Unchanged:**
  - repo config is untrusted;
  - command backends need an out-of-repo grant;
  - user paths are confined to the repo;
  - pulled bytes are verified before use;
  - `--quiet` and `--json` never change a safety decision.

* * *

## 14. Retention and GC

- **Content objects:** `blobsy gc [--dry-run] [--older-than 30d]` works as follows.
  - **Reachable:** every key derived from every entry in every `.bref` in every commit
    reachable from all branches and tags, plus the working tree.
  - **Deleted:** listed objects outside that set that are older than the grace period.
  - Dry-run is recommended first.
    Bucket versioning or Object Lock gives a recovery window.
  - GC refuses to run if any ref in the scanned history fails to parse, rather than
    treating its objects as orphans.
- **Cache snapshots:** bucket lifecycle rules on `snap/cache/` (preferred), or
  `gc --snapshots --older-than`.
- **Asset snapshots** are never deleted by blobsy.
- **History removal (PAIN-3):** delete the ref from history with `git filter-repo`, then
  `gc` reclaims the objects.
  No repository recreation is needed.

* * *

## 15. Performance Targets

| Operation | Target |
| --- | --- |
| `blobsy --version`, hooks, merge driver | ≤ 150 ms (lazy imports; CI budget) |
| `status` / no-op `sync` on 10k entries | ≤ 1 s warm (hash cache; no rehash) |
| `add` of 10k × 100 KB | dominated by hashing at disk speed; one ignore write and one `git add` per command |
| Hashing | ≥ 2 GB/s per file with native BLAKE3 (measured 2.85 GB/s, Node) |
| Snapshot publish/restore, 15k files / 170 MB | ≤ 10 s each (measured ~5 s restore, local) |

* * *

## 16. What v3 Removes from v2

| Removed | Why |
| --- | --- |
| Timestamped key templates; `remote_key` in refs; the two-commit flow | Keys are derived; refs are final at `add` |
| `remote_key`-presence as the “pushed” signal (3 audits) | Pushed is remote state, recorded locally and checked in batch |
| Stat-cache merge base; 9-state `sync` | The recoverability rule |
| `.blobsy/` in the working tree; the trash directory | State lives under the git dir; git history is the undo |
| YAML `.bref` per file only; “no manifests” principle | One TSV ref format for files, collections and pins |
| Per-file gitignore lines for collections | One line per ref |
| Five-level config hierarchy; subdirectory configs; named backend maps | Three scopes; one backend URL |
| 22 commands (8 hidden) | 18 public commands, mostly phased (§6), plus 2 plumbing |
| aws-cli backend; per-file synchronous spawns | SDK + batched transfers |
| gzip/brotli | zstd or none |
| Compression decided at push; compressed output kept when larger | Decided at add; kept only if ≥5% smaller |

* * *

## 17. Non-Goals and Deferred Work

**Non-goals:**
- a server;
- smudge/clean filters;
- file locking;
- network inside git operations;
- mutable names;
- bidirectional sync of derived trees;
- sub-file delta / CDC;
- multiple backends per repo;
- content-level merges inside `git merge`;
- backward compatibility (pre-alpha).

**Deferred (designed later, if demand appears):**
- **Run archives (UC-6, round 8 mirrors).** Start with a `blobsy receipt write|verify
  <dir>` (`tree_id` + receipt) and an rclone recipe. Fold into
  `snap publish --unpacked` if needed (round 9 D8).
- **History import:** `blobsy import history` (filter-repo based).
- **Routes:** different paths to different backends, as in Gat.
- **Package-grouped snapshot packs** with range restore.
- **Snapshot signatures.**
- **Multi-threaded hashing within one file**, through a small native binding.
- **Single-binary distribution** (`bun build --compile`) alongside npm.

* * *

## 18. Open Decisions

From the round 9 review §11 and the implementation plan:

| # | Decision | Proposed default |
| --- | --- | --- |
| K1 | Keys derived, never stored | Yes |
| K2 | Fixed key layout, filename as metadata | Yes |
| K3 | Hash: BLAKE3 or SHA-256 | BLAKE3, pending a cross-hardware benchmark (≥3× on 2 of 4 platforms) |
| K4 | Content cache on by default; restore hooks opt-in | Yes |
| K5 | One ref format (TSV) for file, directory and pin refs | Yes |
| K6 | Directory refs never remove entries implicitly (`--prune` to remove) | Yes |
| K7 | Phase order: directory refs before snapshots, or the reverse | By whichever pain is pressing; snapshots first if build trees are the need |
| K8 | Run archives: receipts only for now | Yes |
| K9 | Language: TypeScript through Phase 3 (switch per the round 9 §7.4 rule) | Yes |

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
