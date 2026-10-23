# blobsy: Large File Storage for Git Repos (Design v3)

**Status:** Target design, revised 2026-10-23 after four senior reviews, for owner
review. **Not yet implemented.** The shipped code implements v2
([archive/blobsy-design-v2-per-file.md](../archive/blobsy-design-v2-per-file.md)). The
implementation plan is
[plan-2026-10-22-blobsy-v3-redesign.md](../../specs/active/plan-2026-10-22-blobsy-v3-redesign.md).

**Date:** 2026-10-23

**Basis:**
- the round 9 review
  ([blobsy-design-review-round9-use-cases.md](blobsy-design-review-round9-use-cases.md))
  and its sub-reviews;
- the October 2026 research (Gat deep dive, competitor refresh, jj, object stores, tree
  manifests, hash benchmarks);
- four reviews of the first v3 draft: simplicity, flexibility, usability, and data
  safety. The data-safety review reproduced its key findings in experiments.
- the owner’s policy of **no backward compatibility** (pre-alpha, `CLAUDE.md`).

**Companion docs:**
- [blobsy-threat-model.md](blobsy-threat-model.md) (trust boundaries; normative, updated
  for v3);
- [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md) (URL
  parsing, error categories and health checks remain useful; its key-template, aws-cli
  and compression sections are superseded).

* * *

## 1. Summary

Blobsy keeps large files out of git while keeping their *versions* in git.
It is a standalone CLI. It needs no server and no smudge/clean filters, and it stores
bytes in any bucket or tool you choose.

The whole design rests on four ideas:

1. **One storage contract.** Bytes are stored once, under a name computed from their
   hash. Writes are create-only, and reads are hash-verified.

2. **One manifest format.** A `.bref` file is a small sorted text table with one line
   per file: path, kind, size, hash, storage.
   It sits in **git** next to what it describes:
   - a **file** (UC-1);
   - a **directory** (UC-2);
   - a **pin** naming a snapshot (UC-5).

   The *same format* also sits in the **store** as a **snapshot**: a named, immutable
   tree with nothing in git (UC-3, UC-6).

3. **Never destroy unrecoverable bytes.** Blobsy replaces or deletes a local file only
   when the store, or this machine’s record of what it synced, proves the bytes can come
   back. Even then, it first moves the old bytes into the local cache.

4. **Plain git is always safe.** Hooks, the merge driver and auto-pull are conveniences.
   A validator in pre-commit and a read-only `doctor --ci` are the backstop.

Everything else follows from these.
Moving a directory between git-versioned and store-named never re-uploads a byte,
because both use the same objects and the same rows.

* * *

## 2. Design at a Glance: Gat’s Simplicity, Blobsy’s Flexibility

Gat (`research-2026-10-22-competitor-gat.md`) is simple because it has one idea:
content-addressed storage plus a manifest in git.
v3 keeps that idea and changes only *where manifests live* and *how bytes are packed*.

| Dimension | Gat | Blobsy v3 | Why |
| --- | --- | --- | --- |
| Storage names | derived from the hash | **same** | one commit per change; dedup; free renames |
| Manifest | one repo-wide `gat.lock` | one `.bref` per file or directory, *or* in the store | edits stay local; no repo-wide conflict hotspot; works with no merge driver |
| Merges | per-path driver; on parse failure leaves *ours* with no markers | per-path driver with markers only on conflicting rows; inner driver for criss-cross merges; validator; `resolve` | the other side’s clean changes are never silently dropped |
| Trees git shouldn’t see | none | **snapshots**: the same manifest format, stored under a name | build caches, environments, versioned outputs |
| Packing | none | per snapshot: one archive (caches) or per-file objects (incremental data) | tiny-file trees and incremental data both work |
| Safety | relies on hooks | recoverability rule, guard hooks, validator, `doctor --ci` | correct with plain git, GitHub merges, jj and fresh clones |
| Local cache | yes | **same**, also the safety net for displaced bytes | offline switches; reversible pulls |
| Backends | OpenDAL (closed set) | S3 SDK, rclone (70+), local, custom command, read-only `https://` | any store; public read |
| Hash | BLAKE3 | BLAKE3 default, SHA-256 option, named in each ref | speed; LFS import |
| Distribution | single binary | npm + `npx` + single binary | category norm for hooks and CI |

**What v3 deletes from v2:** key templates, push-time write-back, the stat-cache merge
base, `.blobsy/` in the working tree, YAML pointers, three config scopes, and nine
commands. Details are in §18.

* * *

## 3. Problem and Use Cases

| ID | Pain |
| --- | --- |
| PAIN-1 | No individual file over a few MB should be in git: it is a permanent performance penalty. |
| PAIN-2 | Huge numbers of files are slow to manage and cause noisy diff churn in PRs. |
| PAIN-3 | Large files tied into git’s hash tree make retroactive removal very hard. |
| PAIN-4 | Git LFS is disliked, for PAIN-3 and for GitHub’s LFS cost. |
| PAIN-5 | Storage isn’t pluggable (S3, GCS, custom), so it doesn’t fit other tools. |

| ID | Use case | v3 answer |
| --- | --- | --- |
| UC-1 | A few large files, versioned; PRs show the metadata | **File ref:** `model.bin.bref`, one row |
| UC-2 | A collection of hundreds to tens of thousands of files; git holds one manifest | **Directory ref:** `images.bref`, one row per file; one gitignore line |
| UC-3 | A very large derived tree (`target/`, a package store) cached externally, nothing in git | **Cache snapshot:** packed, named from inputs (e.g. the lockfile hash), expired by lifecycle |
| UC-4 | Standard git merges over externalized files | Git merges `.bref` text. A per-path driver removes false conflicts; plain git stays safe; a validator catches bad merges |
| UC-5 | Fixed assets with immutable names, outside git workflows | **Asset snapshot** under a chosen name, optionally **pinned** by a one-row ref |
| UC-6 | Versioned directories (datasets, run outputs) synced incrementally, with no manifest in git | **Per-file snapshot** under a new name each version; only changed files move (§8.6) |
| UC-7 | Adopting blobsy where large files or LFS already exist | `blobsy import lfs`; history import later (§19) |
| UC-8 | Public or credential-free read (open data, CI on forks) | Read-only `https://` backend (§13) |
| UC-9 | One asset used by several repos | Pins to asset snapshots in a shared store (§8.5) |

* * *

## 4. Principles

1. **Simple things are one command.** `blobsy add`, `git commit`, `git push`. A clone
   runs `blobsy pull`.
2. **Correctness needs nothing per clone.** A clone can pull and push with plain git.
   `blobsy setup` adds guards, the merge driver and auto-pull; CI’s `doctor --ci`
   catches what unguarded clones miss.
3. **Committed files are final when written.** No command writes back into a committed
   file. Every `.bref` change is one commit.
4. **Content identity is the hash.** Storage names are computed from it.
   Identical bytes are stored once, across paths, branches, collections, snapshots and
   time.
5. **The store is create-only.** Only `gc`, lifecycle rules, and the two explicit
   repairs in invariant 1 delete or overwrite content.
6. **Never destroy unrecoverable bytes** (§11).
7. **One discipline per path.** Every path is plain git, inside exactly one ref’s
   target, or a snapshot path.
   Overlaps are errors.
8. **Network only in commands that name it.** `push`, `pull`, `clean`, `snap …`, `gc`,
   `import lfs`, `status --remote`, `doctor`, first-run `setup` and the pre-push upload
   use the network. No other hook does, and neither do `add`, `rm`, plain `status`,
   `resolve` or `diff`.
9. **Transparent and pluggable.** `.bref` files are plain text.
   The store keeps original filenames as metadata.
   Any S3-compatible store, anything rclone reaches, a local directory, a custom
   command, or a read-only HTTPS server can be the backend.
10. **Agent-first.** Commands are non-interactive and support `--json` and `--dry-run`.
    Ambiguous destructive actions are refused with the choices listed.
    Everything is documented by `blobsy docs`.
11. **No backward compatibility while pre-alpha.** Readers accept exactly the current
    format and fail fast on anything else.

* * *

## 5. Core Model

### 5.1 Entries

An **entry** describes one filesystem object.
Every manifest, in git or in the store, is a sorted list of entries.

| Column | Meaning |
| --- | --- |
| `path` | Relative to the manifest’s target. `.` means the target itself (only as the sole row). |
| `kind` | One character: `f` file · `x` executable file · `l` symlink · `d` empty directory · `t` pinned snapshot |
| `size` | Bytes of the original content |
| `hash` | Lowercase hex digest of the original content; the algorithm is named in the header |
| `storage` | Where the bytes are kept. Never part of identity. |

**Kind-specific values:**

| kind | size | hash | storage |
| --- | --- | --- | --- |
| `f`, `x` | file bytes | hash of the bytes | `-` own object, raw · `zstd` own object, compressed · `pack` inside the snapshot’s archive (store manifests only) |
| `l` | byte length of the link target | hash of the target string | the target, escaped |
| `d` | `0` | `-` | `-` |
| `t` | total bytes of the tree | `tree_id` of the snapshot | `snap:<name>` |

**Kind rules:**
- The `.` row is the sole row, with kind `f`, `x` or `t`.
- `t` appears only in git refs, as the `.` row.
  Store manifests never contain `t`, so snapshots never nest.
- **Symlink targets are confined.** A target is relative and, resolved lexically against
  the link’s own directory, stays inside the manifest’s target: no absolute targets, and
  no escape through `..` (`../pkg/bin/x` inside the tree is fine).
  The validator, `parseManifest()` and archive extraction all enforce this.
  Before a link is created, `hash(target)` is compared with the row’s hash.

**Tree identity.**
`tree_id = hash(each row’s first four columns, tab-joined, each line ending in \n, in
manifest order)`. Storage is excluded, so the same tree has the same id whether it is
stored raw, compressed or packed.
A symlink’s target is covered through its hash.

**Paths are pinned so that every implementation agrees:**
- UTF-8, `/` separators, no empty, `.` or `..` segments (except the sole `.` row).
- `\` is escaped as `\\`. Every byte below 0x20, plus 0x7F, is escaped as `\xhh`
  (lowercase hex). So is a leading `#`, `<`, `=`, `>` or `|`. Symlink targets use the
  same escaping.
- Rows sort bytewise on the escaped `path` column.
- No normalization is applied.
  `add` refuses a directory containing invalid UTF-8 names, or two names that are equal
  after NFC normalization or case folding: they cannot be restored portably.
- Test vectors live in the repo (`tests/vectors/`) and gate every implementation.

### 5.2 Ref files in git (`.bref`)

A **ref** is named after its **target** with `.bref` appended, and sits next to it:

```text
data/model.bin          <- target (gitignored)
data/model.bin.bref     <- ref (committed)
```

**Format:**

```text
#blobsy-ref 1 blake3 https://github.com/jlevy/blobsy
<path>	<kind>	<size>	<hash>	<storage>
…
```

- **Header.** Exactly one line: `#blobsy-ref <version> <algo> <url>`. It is static: it
  never holds counts, totals, timestamps or the target’s name, so two sides of a merge
  never differ in the header unless the algorithm changed.
- **Body.** One TSV row per entry, sorted, LF line endings.
  No duplicates, no blank lines, and no prefix collisions (`a` and `a/b`).
- **Strict reader.** Version must be `1`. The algorithm must be `blake3` or `sha256`,
  and readers use the algorithm the ref names.
  A `\r`, conflict marker, unknown kind or unsorted row fails with “run
  `blobsy add <target>` to rewrite” or “`blobsy resolve <ref>`”.

**Three shapes, one format:**

| Shape | Target | Rows | Gitignore line |
| --- | --- | --- | --- |
| **File ref** (UC-1) | a file | one: `.	f	300000	9f2c…	zstd` | `/model.bin` |
| **Directory ref** (UC-2) | a directory | one per file, symlink or empty directory | `/images/` |
| **Pin ref** (UC-5) | a directory restored from a snapshot | one: `.	t	16060000000	3c1f…	snap:assets/llama-3-8b/v2` | `/llama-3-8b/` |

```text
# data/images.bref
#blobsy-ref 1 blake3 https://github.com/jlevy/blobsy
cats/001.jpg	f	48213	07ab13c9…	-
cats/002.jpg	f	51877	c4d1aa02…	-
tables/2026-10.parquet	f	734003200	a81c4f3e…	zstd
tools/run.sh	x	812	5be0…	-
```

**Rules:**
- **Refs don’t nest.** No ref’s target contains another ref or its target.
- **A directory ref owns every file in its directory**, minus `ignore` patterns.
  `add <dir>` refuses a directory that git tracks files in (§7.2).
- **Ignore lines** live in a managed block in the `.gitignore` of the directory holding
  the ref. They are anchored (`/model.bin`, not `model.bin`). The block is delimited by
  `# >>> blobsy (managed) >>>` and `# <<< blobsy <<<`. `doctor --fix` regenerates it
  from the refs present.
- **`.gitattributes`** (written by `setup`) holds `*.bref merge=blobsy text eol=lf`.
- **Splitting huge collections** means finer directory refs (`data/images/cats.bref`,
  `data/images/dogs.bref`). `add` prints a hint above 50k rows.

### 5.3 Store

**Content objects** (fixed layout; no templates):

```text
<prefix>/<algo>/<h0h1>/<h2h3>/<hash>[.zst]
e.g.  s3://bucket/project/blake3/9f/2c/9f2c0e7b….zst
```

- **The key is a pure function of `(algo, hash, storage)`.** It is never stored, never
  depends on a path, and never changes on rename.

- **Compression** is decided once, when `add` first sees a hash:
  - files under `compress.min_size` (default 100 KB) are stored raw;
  - so are names on a built-in incompressible list (`.zst .gz .zip .parquet .png .jpg
    .mp4 …`), which `compress.never` extends;
  - otherwise the file is compressed once, and the result kept only if it is at least 5%
    smaller.

  `add` on an unchanged hash keeps the existing row, so a rule change causes no churn.

- **Readers tolerate both encodings.** `pull`, `exists` and `status --remote` try the
  recorded encoding first, then the other.
  A hit under either counts as present.
  This makes encoding disagreements between machines harmless.

- **Create-only writes:**
  - S3 SDK: `If-None-Match: *`.
  - GCS: `ifGenerationMatch=0` where reachable.
  - Local: write a temp file in the destination directory, `fsync`, then `link()` to the
    key (EEXIST means it already exists).
    The key is never opened for writing.
  - rclone and command backends: exists-then-put, plus a size check after put.

  “Already exists” counts as success.
  Where create-only is unavailable, two writers of one content key write identical
  bytes, so last-writer-wins is harmless.

- **Uploads read immutable bytes only.** `push` uploads the content-cache copy, which
  was hashed as it was copied.
  With the cache disabled for a file, it uploads a stream hashed in flight, and commits
  it only if the hash matches:
  - multipart: complete the upload only on a match;
  - local: `link()` only on a match;
  - command backends: upload from a verified temp copy.

  A file rewritten during upload can never poison a key.

- **Metadata.** Uploads set `blobsy-path` (repo path) and a sanitized
  `Content-Disposition: attachment; filename=<name>`, where the backend supports it, so
  consoles show original names.

- **Verification.** Every download is hash-verified before it replaces anything.
  Decompression stops at `size` bytes.
  An existing raw object whose size differs from the entry counts as missing.

- **Store marker.** `_blobsy/store.yaml` holds `layout: 1` and the probed capabilities
  (`conditional_put`).

- **Repository markers.** `_blobsy/repos/<id>.yaml` is written create-only, when absent,
  by every command that holds write credentials (`setup`, `push`, `snap publish`).
  `<id>` is a short hash of the normalized `origin` URL (or the root commit when there
  is no origin), and the file holds that URL. `gc` uses these markers to detect sharing
  (§16). They detect cooperating repositories, not hostile ones; the recovery window is
  the real backstop.

### 5.4 Snapshots in the store

A **snapshot** is an immutable tree stored under a **name**. Its manifest is a `.bref`
file in the store:

```text
<prefix>/snap/<name>/manifest.bref       the commit point: written last, create-only
<prefix>/snap/<name>/<tree_id>.tar.zst   archive of the `pack` rows (packed snapshots only)
```

```text
# snap/cache/target/linux-x64/5e1c…/manifest.bref
#blobsy-ref 1 blake3 https://github.com/jlevy/blobsy
#tree 3c1f9a…
#files 14711
#bytes 171355937
#created 2026-10-22T15:11:21Z
#by ci@runner-7 main 04a3d1a gh-123456
debug/build/libc-3e1/out/x.rs	f	1820	4be2…	pack
…
```

- **Store manifests may carry `#key value` lines** after the header, because they are
  immutable and never merged.
  Git refs may not. Readers recompute `tree_id` and compare it with `#tree`.

- **Two storage modes**, chosen per snapshot:

| Mode | Rows | Best for | Default for |
| --- | --- | --- | --- |
| **packed** | `pack`: all files in one `tar.zst` | 10k–1M tiny files restored whole | names under `cache/` |
| **files** | `-`/`zstd`: each file is an ordinary content object | large files; incremental updates; dedup across versions | all other names |

Files mode reuses `push`’s transfer and `pull`’s entry loop unchanged.
A directory ref and a files-mode snapshot of the same directory share every object.

- **Why the archive is keyed by `tree_id`.** Two publishers of different trees under one
  name each write their own archive.
  Only one manifest wins the create-only write, and it names its own archive.
  Name, manifest and archive are consistent by construction, even on backends without
  conditional writes. The loser’s archive is an orphan that `gc` removes.

- **The archive** is a tar with real mtimes, uid/gid 0, sorted entries, zstd.
  It is not byte-deterministic, and does not need to be: identity is the manifest’s
  `tree_id`. Each `pack` row’s hash is computed from the bytes written into the archive,
  and `tree_id` after packing, so a file that changes during publish can’t make the
  manifest and archive disagree.

- **Names:**
  - characters `[A-Za-z0-9._-]` in `/`-separated segments;
  - no empty segment, no `..`, no leading or trailing `/`;
  - no segment equal to `manifest.bref`, and none of exactly 64 lowercase hex
    characters.

  A name’s objects are exactly the keys listed above, so operations on `cache/a` never
  touch `cache/a/b`. “Latest” means the newest name under a prefix by listing
  (`--latest`), never a mutable pointer.

- **Names are write-once.** When the manifest write finds a manifest already there (a
  412, or an existing object on exists-then-put backends), the publisher reads its
  `#tree`:
  - the same tree → success (“already published”);
  - a different tree under `cache/` → exit 0 with `result: lost-race`;
  - a different tree under any other name → `E_NAME_TAKEN`, exit 1, and no pin is
    written.

  The loser’s archive is an orphan for `gc`.

**One rule decides cache vs asset: the name.** A name under `cache/` is a cache: packed
by default, a miss exits 0, and it is expirable.
Any other name is an asset.

- **Cache snapshots (UC-3)** take their name from a stanza in `.blobsy.yml`, which must
  start with `cache/`. Names are built from pure inputs:
  - `{hash:<file>}`: the first 16 hex characters of the configured hash of the file’s
    working-tree bytes;
  - `{os}`: `linux`, `darwin` or `windows`;
  - `{arch}`: `x64` or `arm64`;
  - `{env:NAME}`: only names starting with `BLOBSY_` (repo content never chooses which
    environment variables are read); an unset variable is an error.

  There is no `{cmd:…}`. Caches expire by bucket lifecycle rule on `snap/cache/` or by
  `gc --expire`.

- **Asset snapshots (UC-5, UC-6)** have a name chosen at publish, e.g.
  `assets/llama-3-8b/v2` or `results/2026-10-23T1402`. They never expire.
  A pin ref may name one.

### 5.5 Hashing

- **Algorithm per ref.** `hash:` in `.blobsy.yml` (default `blake3`) applies when `add`
  *creates* a ref. Existing refs keep their algorithm.
  To convert one, run `blobsy rm <target> && blobsy add <target>` with every entry
  present locally. Keys embed the algorithm, so mixed algorithms in one store are fine.
- **BLAKE3** uses `@napi-rs/blake-hash` (native), falling back to `hash-wasm`.
  **SHA-256** uses Node `crypto`.
  - Measured on a VM without SHA hardware, native BLAKE3 runs at ~2.85 GB/s in Node,
    about 8.5× SHA-256. Node and Bun match single-threaded Rust with 1 MB reads.
  - The WASM fallback is slower than SHA-256 on Bun (213 MB/s), so blobsy makes it
    visible. `doctor`, `setup` and `--version --json` print `hasher: native|wasm`. `add`
    warns once when the WASM path hashes more than 256 MB.
  - Trade-off, recorded for decision K3: SHA-256 allows S3 server-side checksums
    (verification without download, for raw single-part objects) and zero-rehash LFS
    import. `setup --hash sha256` selects it.
- **Rules:**
  - read with `fs.read` into 1 MB buffers;
  - hash files in parallel through a bounded worker pool;
  - stat before and after hashing, and re-hash if size, mtime or ctime changed (torn
    reads);
  - skip re-hashing when size, mtime, ctime and inode match the hash cache, unless the
    file’s mtime is at or after the cache file’s own filesystem mtime (racy-clean, as in
    git).

### 5.6 Local state

All machine-local state lives under the git directory.
None of it can be committed, none of it needs an ignore line, and jj never snapshots it.

| State | Location | Contents |
| --- | --- | --- |
| **Hash cache** | `$(git rev-parse --git-path blobsy)/hashcache/` (per worktree, one file per target: a ref target or a snapshot path) | path → size, mtime, ctime, inode, hash, and `here` (materialized in this worktree); per target, the snapshot name and `tree_id` it was last restored from |
| **Content cache** | `$(git rev-parse --git-common-dir)/blobsy/objects/<algo>/<h0h1>/<h2h3>/<hash>` (shared by worktrees), or `blobsy.cacheDir` | read-only (0444) original bytes; snapshot archives under `snap/<tree_id>.tar.zst`; every store manifest read, under `snap/<tree_id>.bref` |
| **Known logs** | `…/blobsy/known/<store-id>.txt` (shared) | append-only list of hashes pushed to or pulled from that store by this machine |
| **Lock** | `$(git rev-parse --git-path blobsy)/lock` | held by commands that write refs, ignore blocks or the working tree; reports the holder’s pid |

- **`store-id`** is a short hash of the canonical backend location: scheme, endpoint or
  host, bucket and prefix.
  It excludes only credentials and the profile.
  Evidence recorded for one store never counts for another.
- **The content cache is filled by** `add` (by reflink, else copy; turn off per machine
  with `blobsy.cacheOnAdd false`), `push`, `pull`, `snap restore`, and every displaced
  file (§11).
- **Materializing from the cache** uses `blobsy.materialize` (default `reflink,copy`;
  `hardlink` is opt-in and relies on 0444 objects).
  Materializing re-hashes the bytes, and evicts and refetches an object on mismatch.
- **Pruning** happens automatically after writes, down to `blobsy.cacheMaxSize` (default
  20 GB), least recently used first.
  It **never removes bytes that are not in the current store’s known log**, because
  those may exist only here.
  When pruning can’t reach the target for that reason, commands print the unsynced total
  and name `blobsy clean --cache --unsynced`, which prunes on demand.

* * *

## 6. Invariants

1. **The store is create-only.** No command overwrites a content object or a snapshot
   name, with two exceptions:
   - `push --repair <path>` replaces an object only after downloading it and proving its
     bytes don’t match the key;
   - `gc --purge` deletes immediately and writes a tombstone (§16).

   Otherwise, only `gc` deletes, and only what no root reaches.

2. **Keys are a function of committed content facts.** No push-time state is written to
   any committed file.

3. **A path belongs to at most one discipline.** `add`, `snap`, the pre-commit validator
   and `doctor --ci` refuse overlaps.
   That includes overlaps created by clean git merges.

4. **Bytes are verified before they replace anything.** Downloads, cache materialization
   and snapshot extraction are verified in a temp location and renamed into place.

5. **Local bytes are destroyed only if recoverable, and are displaced into the cache
   first** (§11).

6. **Hooks are optional.** Every hook check also runs in `doctor --ci`.

7. **One writer per store prefix by default.** A prefix shared by several repositories
   is detected, and `gc` refuses unless it is told about every other repository (§16).

* * *

## 7. Commands

### 7.1 Surface

Global flags: `--json`, `--dry-run`, `--quiet`, `--verbose`, `--fail-fast`, `--ascii`,
`--color=auto|always|never` (and `NO_COLOR`).

Paths are cwd-relative on input and repo-root-relative on output.
A path inside a ref’s target scopes the command to matching entries.
A `.bref` path means its target.
`--only` globs are always repo-root-relative.

| Command | What it does |
| --- | --- |
| `blobsy setup [<backend>] [--hash sha256] [--no-hooks] [--auto-pull]` | **First run** (no `.blobsy.yml`): writes and stages `.blobsy.yml`, `.gitattributes` and the agent skill, probes the store, and writes the store markers. **Join** (config exists): touches only the git dir (hooks, driver config, and the jj merge-tool stanza when `.jj/` exists), writes the repository marker if it has write credentials, and prints backend, credential posture and hasher. |
| `blobsy add <path>… [--prune]` | A file becomes a file ref; a directory becomes a directory ref (created, or entries updated). Hashes, decides storage, caches the bytes, writes the ref and ignore line, and stages both. No network. Never removes entries unless `--prune`. |
| `blobsy rm <path>…` | Removes refs or entries and their ignore lines, and stages the result. **Keeps the files**, which are now untracked; the large-file guard stops them reaching git. Never touches the store. |
| `blobsy clean <path>… \| --cache [--unsynced]` | Frees disk. Deletes materialized payloads whose bytes the store holds (online only), keeps refs, and clears their `here` mark so `add --prune` and `status` treat them as never materialized. `--cache` prunes the content cache. |
| `blobsy push [<path>…] [--repair]` | Uploads missing objects for the given refs (default: all), from the content cache. Never edits refs. `--repair` replaces a proven-corrupt object. |
| `blobsy pull [<path>…] [--only <glob>] [--all] [--offline] [--force]` | Materializes entries and pins that are absent or stale. Applies the recoverability rule (§11). `--offline` uses only the cache. `--force` replaces modified files (displacing them into the cache). |
| `blobsy status [<path>…] [--remote] [--verify] [--entries]` | Per-ref counts and entry states (§11). `--remote` batch-checks the store. `--verify` re-hashes. `--entries` lists every entry. |
| `blobsy diff [<rev>[..<rev>]] [<path>…] [--markdown] [--fail-above <size>]` | Semantic diff of refs between revisions, for PR comments and CI gates. |
| `blobsy resolve <ref> [--ours\|--theirs] [<path>…]` | Finishes a conflicted ref merge from git’s index stages or markers (§9). |
| `blobsy snap publish <path> [--name <n>] [--pin] [--packed\|--files]` | Publishes a snapshot of a directory. Without `--name`, uses the stanza whose `path:` matches. |
| `blobsy snap restore <path> [--name <n>\|--latest <prefix>] [--only <glob>] [--require] [--force]` | Restores a snapshot into `<path>` (§8.4, §8.6). Cache misses exit 0 (`--require` makes them exit 1); other misses exit 1. `--force` overrides the restore guard. |
| `blobsy snap ls [<prefix>]` | Lists names with tree id, size, age and provenance. |
| `blobsy gc [--dry-run] [--older-than 30d] [--expire <glob>] [--also-repo <url>…] [--no-recovery-window] [--purge <hash\|name>]` | Deletes store objects no root reaches (§16). |
| `blobsy import lfs [<path>…]` | Converts LFS pointers in the working tree into refs and copies their objects. |
| `blobsy doctor [--fix] [--ci [--range <a>..<b>]] [--probe]` | Checks config, refs, overlaps, ignore lines, hooks, driver, credentials and hasher. `--ci` is read-only and needs no local setup. `--probe` tests store capabilities (writes a sentinel). `--fix` makes safe repairs only. |
| `blobsy docs [<topic>] [--skill]` | Bundled docs. `--skill` prints the agent skill with this repo’s context. |

Hidden plumbing:
- `blobsy hook <name>`;
- `blobsy merge-driver [--inner] %O %A %B %P`;
- `blobsy merge-driver --jj $base $left $right $output`.

**Deleted, with no aliases:** `init`, `track`, `untrack`, `verify`, `health`,
`check-unpushed`, `pre-push-check`, `hooks`, `readme`, `skill`, `sync`, `config`,
`cache`. `mv` is deferred, because `mv && blobsy rm && blobsy add` covers it.

### 7.2 `add` rules

- **`add <dir>` refuses** if git tracks any file inside, if the directory is the repo
  root, if it contains a ref, if it overlaps another ref or snapshot path, or if it
  holds special files (sockets, devices) or symlinks pointing outside it.
  The refusal names the alternatives:

  ```text
  refused: data/ contains 14 files tracked by git (data/README.md, data/schema.json, …)
    A directory ref owns every file in its directory.
    externalize only some files:   blobsy add data/*.parquet data/*.bin
    move the whole directory:      git rm -r --cached data/ && blobsy add data/
  exit 2
  ```

- **`add` on a pinned target refuses** and names
  `blobsy snap publish <path> --name <new> --pin`.

- **`add` on an LFS-tracked path refuses** (`git check-attr filter`) and names
  `blobsy import lfs`.

- **Under jj** (`.jj/` present), `add` writes the ignore line first and runs
  `jj file untrack` if jj already tracks the payload.
  It skips `git add` and prints the jj next steps.
  The root is `$JJ_WORKSPACE_ROOT` when set.

- **`--prune`** drops entries only if the hash cache marks them `here` (materialized in
  this worktree) and they are now gone.
  Entries never pulled here are kept, and the count is printed.

### 7.3 Results, exit codes and machine output

- Every verb does all the safe work it can, collects refusals and errors per entry, and
  prints a summary.
- **Exit codes:** `0` for success; `1` if anything errored; `2` if anything was refused
  to protect data, or a conflict is unresolved.
  `--fail-fast` stops at the first problem.
- **One JSON envelope** for every command:

```json
{ "blobsy": 1, "command": "pull", "ok": false,
  "refs": [ { "ref": "data/images.bref", "shape": "dir", "target": "data/images",
              "counts": { "ok": 10250, "stale": 3, "modified": 1, "absent": 44, "unsynced": 12 } } ],
  "problems": [ { "code": "E_MODIFIED", "path": "data/images/cats/009.jpg",
                  "message": "local file differs from the ref and its bytes exist nowhere else",
                  "choices": [ { "cmd": "blobsy add data/images/cats/009.jpg", "effect": "keep yours" },
                               { "cmd": "blobsy pull --force data/images/cats/009.jpg", "effect": "discard yours (saved in the cache)" } ] } ] }
```

- **`--dry-run --json`** prints
  `{"plan":[{"op":"upload|download|place|replace|delete|refuse|skip","path":…,"hash":…,"key":…,"size":…,"reason":…}],"totals":{…}}`.
  `pull --dry-run` lists the refusals it would make.

- **Error codes** form a published list:

| Code | Code | Code |
| --- | --- | --- |
| `E_MODIFIED` | `E_CONFLICT` | `E_INVALID_REF` |
| `E_OVERLAP` | `E_TRACKED_IN_GIT` | `E_LARGE_FILE` |
| `E_OBJECT_MISSING` | `E_PURGED` | `E_NO_CREDENTIALS` |
| `E_READ_ONLY` | `E_OFFLINE` | `E_LOCKED` |
| `E_CASE_COLLISION` | `E_SHARED_PREFIX` | `E_NOT_A_CACHE` |
| `E_NAME_TAKEN` | `E_PIN_MISMATCH` | `E_CONFIG` |

Codes never change meaning.

* * *

## 8. Workflows

### 8.1 First ten minutes

```bash
npm install -g blobsy                      # or: npx blobsy@1 …, or the release binary
blobsy setup local:../blobsy-store         # try it with no credentials; later: blobsy setup s3://bucket/prefix
blobsy add data/model.bin                  # data/model.bin.bref + /model.bin in data/.gitignore, both staged
git commit -m "Add model"
git push                                   # pre-push hook uploads the object (or run blobsy push first)

# a teammate
git clone … && cd … && blobsy setup        # join: hooks + driver only
blobsy pull
```

Moving from `local:` to a bucket: `rclone copy ../blobsy-store s3:bucket/prefix`, edit
`backend:`, commit. Keys don’t depend on the backend, so nothing else changes.

### 8.2 UC-1: a few large files

```bash
python train.py                    # rewrites data/model.bin
blobsy add data/model.bin          # one-row change in the ref
git commit -am "Retrain" && git push
```

The PR shows one changed row: `.	f	300000	9f2c…	zstd` → `.	f	312004	1a7e…	zstd`.
Checking out an old version and running `blobsy pull` downloads nothing if the cache
holds those bytes. Re-pushing it uploads nothing.

### 8.3 UC-2: a collection

```bash
blobsy add data/images             # data/images.bref, one row per file; /images/ ignored
cp new/*.jpg data/images/cats/
blobsy add data/images             # +40 rows
git commit -am "More cats" && git push

blobsy pull --only 'data/images/cats/**'   # partial; remembered in git config blobsy.only
blobsy add --prune data/images             # drops entries deleted here; keeps never-pulled ones
```

- **Working sets.**
  - `--only` persists per clone (`blobsy.only` is multi-valued), and later plain `pull`s
    and auto-pull honor it.
  - `pull --all` clears it.
  - When `git sparse-checkout` is active, entries outside the sparse cone are skipped
    too (`git sparse-checkout check-rules`).
  - `status` reports “N entries outside the working set” instead of N rows.
- **Choosing a shape:** file refs for a handful of files; a directory ref above a few
  dozen, or for any directory that receives files in batches.

### 8.4 UC-3: build caches

```yaml
# .blobsy.yml
snapshots:
  cargo-target:
    path: target
    name: "cache/target/{os}-{arch}/{hash:rust-toolchain.toml}/{hash:Cargo.lock}"
    ignore: ["**/incremental/**"]
    fallback: true                    # on a miss, restore the newest name under the parent prefix
```

```bash
blobsy snap restore target         # hit, fallback or miss: all exit 0 (--require makes a miss exit 1)
cargo build
blobsy snap publish target         # "already published" exits 0 if another job won
```

**Restore of a packed snapshot:**
1. Read the manifest, and verify `tree_id` (and the pin, if any).
2. Fetch the archive through the content cache.
3. Extract into a sibling temp directory, without following symlinks.
   - Reject any absolute path, any `..` segment in a path, and any link target that
     breaks the confinement rule of §5.1.
   - Create symlinks only after every file is verified.
4. Swap it in by renaming the old tree to `<path>.blobsy-old-<rand>`, then deleting that
   only after success. On failure, reverse the renames.
   `doctor --fix` cleans up leftover temp and old directories.

**Restore guard.** `snap restore` refuses (`E_NOT_A_CACHE`) to replace a path that:
- contains a git-tracked file, a ref or a ref target;
- or is not ignored by git.

`--force` overrides.
A typo’d or hostile stanza can’t delete real work.

- **Write credentials.** Only protected-branch CI publishes to `snap/cache/`. PR builds
  and laptops are read-only.
- **Expiry.** A bucket lifecycle rule on `snap/cache/` (`doctor` warns when it is
  missing), or `gc --expire 'cache/**' --older-than 14d`. A manifest whose archive has
  expired is a miss.
- **JS and Python.** Cache the package-manager store (pnpm store, uv cache), not
  `node_modules` or `.venv`.

### 8.5 UC-5 and UC-9: pinned assets

```bash
blobsy snap publish models/llama-3-8b --name assets/llama-3-8b/v2 --pin   # files mode: shards are content objects
git commit -m "Pin llama v2" models/llama-3-8b.bref models/.gitignore
blobsy pull models/llama-3-8b              # restores the pin; verifies tree_id
```

- **Upgrading** means publishing `v3` (only changed shards upload) and committing a
  one-row change to the pin.
- **Cross-repo use (UC-9).** Another repository using the same store pins the same name.
  Nothing is cloned or copied.
- **`push` and pre-push verify pins:** the named manifest must exist, with the same tree
  id (otherwise `E_PIN_MISMATCH`).

### 8.6 UC-6: versioned directories with no manifest in git, synced incrementally

The answer is a **files-mode snapshot**, published under a new name for each version.
The manifest lives in the store, not in git, and nothing is archived as a whole.

```bash
echo '/results/' >> data/.gitignore           # nothing in git, so git must ignore the tree
blobsy snap publish data/results --name results/2026-10-23T1402
blobsy snap restore data/results --latest results/
```

`snap publish` without `--pin` refuses (`E_NOT_A_CACHE`) a path that git does not
ignore, and prints the line to add.

**Publish is incremental.**
1. Walk the tree. The hash cache means only changed files are re-hashed.
2. Run one batched `exists` against the content keys.
3. Upload only missing objects.
4. Write the new manifest last (create-only).

Unchanged files are never re-sent, even across names.
Cost scales with the changed bytes.

**Restore is incremental.**
1. Compare the local tree (via the hash cache) with the target manifest.
2. Download only missing or different files.
3. Apply them per file, atomically.

Files not in the manifest are deleted under the recoverability rule, and their `here`
marks are cleared.
Paths matching the stanza’s `ignore` patterns are neither compared nor
deleted. Placement is atomic per file, not per tree; whole-tree swaps are for packed
snapshots. A `--latest` miss exits 0; a `--name` miss exits 1.

**Versions are immutable and cheap.** Each is one small manifest; the objects are
shared.

**Git holds nothing**, or a one-row pin if a commit should name an exact version.

**Scale:**
- One flat manifest is fine up to about 100k rows (roughly 3 MB compressed).
- For tens of thousands of tiny files that are always restored whole, use `--packed`.
- For more, see the deferred sharded manifests and grouped packs (§19).

**If no manifest is wanted anywhere** (bucket browsable by path), that is the deferred
mirror mode (§19). It gives up immutable versions, atomic publish and dedup.

### 8.7 Teams and branches

- **After `git pull`, `checkout`, `merge`, `rebase` or `stash pop`,** run `blobsy pull`.
  `setup --auto-pull` does this from the cache after checkout, merge and rewrite.
- **Payloads are gitignored, so git never stashes, resets or checks them out.** After
  any git operation, `blobsy status` says whether each file is `⇣ stale` (run `pull`) or
  `~ modified` (your bytes; `pull` refuses).
  `git stash pop` restores the ref, and nothing is lost.
- **A teammate changed a file you hadn’t touched:** your copy is `⇣ stale`, and `pull`
  replaces it.
- **You changed it too:** `pull` refuses that file and lists `blobsy add` (keep yours)
  first, `--force` last.
- **Big pushes.** The pre-push hook prints the total before uploading (“Ctrl-C aborts
  the push, not the commit”). For anything over ~1 GB, run `blobsy push` before
  `git push`.

### 8.8 CI

```yaml
- uses: actions/checkout@v4
- uses: aws-actions/configure-aws-credentials@v4        # read role via OIDC
- uses: actions/cache@v4
  with: { path: .git/blobsy/objects, key: blobsy-${{ hashFiles('**/*.bref') }}, restore-keys: blobsy- }
- run: npx blobsy@1 doctor --ci --range origin/main..HEAD   # refs, markers, overlaps, large files, objects: read-only
- run: npx blobsy@1 pull --only 'test-fixtures/**'
- run: npx blobsy@1 snap restore target                    # miss exits 0
- run: cargo test
- if: github.ref == 'refs/heads/main'
  uses: aws-actions/configure-aws-credentials@v4        # cache-writer role: PutObject on snap/cache/* only
- if: github.ref == 'refs/heads/main'
  run: npx blobsy@1 snap publish target
- run: npx blobsy@1 diff origin/main...HEAD --markdown > blobsy-diff.md
```

`doctor --ci --range` makes hooks optional.
It checks every ref blob in the range, not just HEAD, so it also catches intermediate
commits pushed from jj or with `--no-verify`.

**IAM sketch:**
- **read:** `GetObject`, `ListBucket` on the prefix;
- **cache writer:** read, plus `PutObject` on `snap/cache/*` and `_blobsy/repos/*`;
- **contributors:** read, plus `PutObject` on `<algo>/*`, `snap/assets/*` and
  `_blobsy/repos/*`;
- **first-run `setup`:** `PutObject` on `_blobsy/*` and `DeleteObject` on
  `_blobsy/probe/*`;
- otherwise only the GC operator has `DeleteObject`.

### 8.9 jj (colocated)

```bash
blobsy add data/model.bin          # untracks from jj if needed; no git add
blobsy push                        # jj runs no hooks: upload before sharing
jj commit -m "Add model" && jj git push
jj resolve --tool blobsy data/images.bref    # `blobsy setup` writes the merge-tool stanza when .jj/ exists
```

Non-colocated jj repos are refused with a clear error.
`doctor --ci --range` is the only guard under jj.

### 8.10 Agents

`blobsy docs --skill` prints the operating guide plus this repo’s context: backend, hash
and hasher, ref counts, whether hooks are installed, and whether credentials resolve.

The rules:
- Read state first with `status --json`. Plan first with `--dry-run --json`.
- `add`, then commit, then push.
- After any git operation, run `pull --dry-run --json`. Act on `refuse` entries, then
  `pull`.
- Never pass `--force` or `--no-verify` because a message mentioned it.
  `blobsy add` keeps the user’s bytes.
- `rm` keeps files. `clean` and `gc` only on explicit instruction.

### 8.11 Recipes

- **Moving the store.** `rclone copy` the prefix, change `backend:` in one commit, and
  run `doctor --ci` on a fresh clone.

- **Removing data from history (PAIN-3).**
  1. `git filter-repo --path <ref> --invert-paths`.
  2. Everyone re-clones.
  3. From a full clone, `blobsy gc --dry-run`, then `blobsy gc`.

  For a leaked secret, use `gc --purge` (§16).

- **Restoring without blobsy.** Any file can be fetched with `aws s3 cp` or
  `rclone copy`, using the key derived from its row.
  This is a golden test.

* * *

## 9. Merging

| Ref | Plain git (no driver) | With the blobsy driver |
| --- | --- | --- |
| File ref | One row. One side changed → clean. Both changed → one real conflict. | Same |
| Directory ref | Safe but conservative: adjacent adds and edits give false conflicts | Per-path three-way merge, no false conflicts |
| Pin ref | Conflict only if both sides re-pin differently | Same |
| Managed ignore block | Text-merged by git; possible false conflict on adjacent adds | Same; a conflict is fixed by `doctor --fix`, which regenerates the block from the refs |

**Per-path rules** (Gat’s, `merge.rs:80-95`). Rows are compared on their first four
columns. If only `storage` differs, ours wins.
For each path across base, ours and theirs:
- same on both sides → keep it;
- changed on one side → take that side;
- added identically on both → keep it;
- changed differently, or modified on one side and deleted on the other → **conflict**;
- prefix collisions (`a` vs `a/b`) → conflict.

**Output.** The merged file contains every clean change.
Conflicting paths get `<<<<<<< / ======= / >>>>>>>` around that one row only.

**Failure cases never fall back to “ours”:**

- **Unparsable input:** the driver writes a whole-file conflict (ours, then theirs) and
  exits 1.

- **Headers differ** (algorithms changed on one side): whole-file conflict.

- **Criss-cross merges.** Git builds a virtual ancestor by calling the driver
  recursively. `setup` registers `merge.blobsy.recursive = blobsy-inner`, which runs
  `merge-driver --inner`.
  - For each conflicting path, the inner merge writes the **base row** when one exists,
    and nothing for an add/add conflict, then exits 0.
  - Both sides then differ from the virtual ancestor (or one deleted the row), so the
    real merge reports the conflict.
  - If an inner input is unparsable or the headers differ, the inner driver writes the
    header only and exits 0. Every row then becomes add/add in the real merge.

  No marker reaches a parser, no clean row is lost, and no modify/delete conflict is
  hidden. (Verified: without an inner driver, git used the driver’s marker output as the
  base, and the other side’s clean addition silently disappeared, exactly as in Gat.
  Omitting conflicting paths instead of writing the base row resurrected a deleted row.)

**Installation and fallback:**

- `.gitattributes` (committed) holds `*.bref merge=blobsy text eol=lf`. `setup` writes
  the driver commands into local git config.
  A repo can name a driver but never choose the executable.

- **Without the driver** (a fresh clone, a GitHub web merge, jj), git uses its text
  merge. That is safe, only conservative.

- **Repairs:**
  - `blobsy resolve <ref>` re-runs the per-path merge from the index stages (a base
    stage that fails to parse is treated as absent);
  - on a file ref, it prints both candidates and exits 2 until `--ours` or `--theirs`;
  - jj calls `merge-driver --jj` as a merge tool.

- **The validator** runs on staged content in pre-commit, and in `doctor` and
  `doctor --ci`. It checks:
  - format, sort order, duplicates, prefix collisions and markers (including jj styles
    and markers longer than seven characters);
  - that no ref nests in another;
  - that git tracks no file inside a ref target;
  - that every ref has its ignore line.

  So a clean git merge that creates an overlap is caught too.

- **Rename detection** can move a ref away from its payload, for example when one side
  ran `git mv` on the ref.
  `doctor` reports orphaned payloads (ignored files with no ref).
  The ignore block keeps their lines until they are deleted or re-added.

- **No network inside merges.** Bytes arrive afterwards, through `pull` or auto-pull.

* * *

## 10. Hooks

`setup` installs hooks into `git rev-parse --git-path hooks`, so `core.hooksPath`
(husky, lefthook) is honored.
It refuses a hooks path inside the working tree, which would be repo-chosen code.

Each managed hook carries an exact marker line, and user hooks are never modified.
`BLOBSY_NO_HOOKS=1` disables every hook, leaving CI as the only check.

**The shim** is POSIX `sh`:
1. Run `blobsy`, or `npx -y blobsy@1` if blobsy isn’t on PATH.
2. If neither exists, exit 0 unless the operation touches a `.bref`. In that case, print
   the install line and block.

A missing blobsy never blocks unrelated git work.

| Hook | Default | Action |
| --- | --- | --- |
| `pre-commit` | on | Runs the validator on staged refs (§9), the payload check and the large-file guard. |
| `pre-push` | on | Uploads what the pushed commits need (steps below) or aborts. |
| `post-checkout`, `post-merge`, `post-rewrite` | off (`setup --auto-pull`) | `blobsy pull --offline --quiet`. No network, never fails the git operation, prints one line naming what is still absent. |

**Pre-commit checks:**

- **Payload check:** refuses only when a local file exists, differs from its staged row,
  and the staged hash is neither cached nor known.
  Merge, revert and cherry-pick commits pass.
  Pin rows are skipped; pre-push verifies them.

- **Large-file guard:**
  - refuses newly staged files inside a ref target;
  - refuses newly staged files over `max_git_file_size` (default 5 MB) unless they match
    `max_git_file_size_allow`;
  - refuses newly staged files whose hash matches an entry in any ref (an escaped
    payload).

  It prints the exact `blobsy add <paths>` to run.

**Pre-push steps.** For each stdin line with a non-zero local sha:
1. Enumerate every distinct `.bref` blob in the range with
   `git rev-list --objects <local> --not <remote sha | --remotes=<remote>>`. This covers
   every intermediate version, not just the endpoint.
2. Parse each blob, then batch `exists`.
3. Upload what is missing from the content cache, or from the working tree when its hash
   still matches (through the cache).
4. Verify that pinned manifests exist.
5. If bytes are unavailable, abort, naming the commit and path.

Deletions are skipped.
Shallow history below the graft counts as already pushed.

* * *

## 11. Recoverability rule and status

### 11.1 Entry states

| Symbol | State | Meaning | Next action |
| --- | --- | --- | --- |
| `✓` | ok | Local bytes match the entry | — |
| `⇣` | stale | Local bytes are an older *recoverable* version; the ref moved | `blobsy pull` (safe) |
| `~` | modified | Local bytes differ and are not known to exist anywhere else | `blobsy add` (keep) · `pull --force` (discard) |
| `↓` | absent | Not materialized here (never pulled, deleted, or outside the working set) | `blobsy pull` |
| `↑` | unsynced | Matches, but this machine has no evidence the store has it | `blobsy push`, or `status --remote` |
| `!` | invalid | The ref has markers or fails validation | `blobsy resolve` / edit |

- **Offline** (the default), `stale` and `unsynced` use the known log.
  With `--remote`, they are refined by a batched `exists`, and every entry also shows
  `remote: present|missing|purged`.
- `status` exits 2 if any ref is invalid.
- Human output prints counts per ref, and entries only for file refs, pins or
  `--entries`:

```text
data/model.bin.bref     file  300 MB          ✓ ok
data/images.bref        dir   10,324 · 4.2 GB  ✓ 10,250  ⇣ 3  ~ 1  ↓ 44  ↑ 12   (working set: cats/**)
models/llama-3-8b.bref  pin   assets/llama-3-8b/v2 · 16 GB  ✓ ok
next: blobsy pull (3 stale) · blobsy add or pull --force (1 modified) · blobsy push (12 unsynced)
```

`--ascii` (or a non-UTF-8 locale) prints the state words instead of the glyphs.

**Pins.** A pin’s state is the worst state of its manifest’s rows, using the cached
manifest:
- `ok` when every row matches;
- `stale` or `modified` according to the rows;
- `absent` when no row is materialized or the manifest isn’t cached.

After `pull --only`, rows outside the working set are `absent`, and the pin is reported
as `partial (N of M)`.

### 11.2 The rule

These commands may replace or delete a local file:
- `pull` (including pins and auto-pull);
- `clean`;
- `snap restore` in files mode.

(`add --prune` only edits refs and never deletes bytes; see §7.2.)

When they do, two steps apply.

1. **Decide.** Proceed only if the current bytes are **recoverable**: they can be
   re-fetched from the current store, or this machine saw that store hold them.
   Concretely:
   - **online:** the store holds them, either as a content object (batched `exists`
     under either encoding, with a size check for raw objects) or inside the snapshot
     the file was placed from (the hash cache names it; one `exists` on its
     `manifest.bref`);
   - **offline** (`--offline`, auto-pull hooks, or an unreachable store): the current
     store’s known log lists the hash, or the file was placed from a snapshot whose
     archive is in the content cache.

   Otherwise, refuse that entry (exit 2, `E_MODIFIED`) and list the choices, with
   `--force` last. Git history never counts as proof: a commit can exist without its
   object ever being pushed.

2. **Displace.** Before replacing a file, move its bytes into the content cache (a
   rename on the same filesystem, else reflink or copy).
   If the cache already holds that hash, the file is simply deleted.
   With `--force`, print the displaced hash and its cache path.
   Every replacement is therefore reversible until the cache is pruned, and pruning
   never removes unsynced bytes.

`clean` frees disk, so it deletes without displacing.
It is therefore online-only: it refuses (`E_OFFLINE`) when the store is unreachable.

**Edge rules:**
- `pull` never follows a symlink at a target path.
- It never removes a directory to place a file (or the reverse) unless every file inside
  passes the rule.

This replaces v2’s merge base.
It needs no history of what blobsy last did, and stale evidence can’t cause loss.
A garbage-collected object fails the online check, and the displaced copy survives
either way.

* * *

## 12. Configuration

**Two places:**

| Where | Committed | Holds |
| --- | --- | --- |
| `.blobsy.yml` | **yes** | Everything that affects bytes, keys or what gets tracked: `backend`, `hash`, `compress`, `ignore`, `max_git_file_size`, `snapshots` |
| `git config blobsy.*` (global or repo-local) | no | Machine settings and connection options |

`git config` gives global/local layering, `--show-origin` and environment overrides for
free, and it puts trust grants out of the repo by construction.
`doctor` prints the effective configuration.

```yaml
# .blobsy.yml, as written by `setup` (unknown keys are errors)
backend: s3://my-bucket/my-project?region=us-east-1    # gs://…  azure://…  rclone:remote:path  local:../store  https://…
hash: blake3                                            # applies to new refs
# compress: { min_size: 100kb, never: ["*.npz"] }
# ignore: [".DS_Store", "__pycache__/"]
# max_git_file_size: 5mb
# max_git_file_size_allow: ["pnpm-lock.yaml"]
# snapshots: { cargo-target: { path: target, name: "cache/target/{os}-{arch}/{hash:Cargo.lock}", fallback: true } }
```

**Backend location is project-owned.** `backend:` is a literal URL; there is no
environment interpolation.
A different store on one machine or in one environment is `blobsy.backendOverride`.

**Machine keys:**

| Key | Default | Meaning |
| --- | --- | --- |
| `blobsy.profile` | — | Connection option (S3 profile); never in the project URL |
| `blobsy.backendOverride` | — | A different store (replica, scratch, the writable bucket behind a public `https://` backend). Commands the user runs print it on every run, and `doctor` reports it loudly. **Hooks and `doctor --ci` ignore it** and always use the project backend. Evidence is per store, so `↑ unsynced` reflects whichever store is in use. |
| `blobsy.cacheDir` | under the git common dir | Content cache location |
| `blobsy.cacheMaxSize` | 20 GB | Prune target |
| `blobsy.cacheOnAdd` | true | Cache bytes at `add` |
| `blobsy.materialize` | `reflink,copy` | Materialization strategies, in order |
| `blobsy.jobs` | — | Transfer concurrency |
| `blobsy.only` | — | Persisted working set (multi-valued, repo-root-relative globs) |
| `blobsy.trustCommandBackend` | false | Out-of-repo trust grant for command backends; `BLOBSY_TRUST_COMMAND_BACKEND=1` is the CI equivalent |

An endpoint is part of the location, so it belongs in the URL (`?endpoint=`), not in
machine config. `setup` warns if `profile=` appears in the committed URL.

* * *

## 13. Backends

| URL | Implementation |
| --- | --- |
| `s3://bucket/prefix?region=…&endpoint=…` | Built-in AWS SDK v3 (S3, R2, B2, Tigris, MinIO), with the standard credential chain (env, profiles, SSO, OIDC, IMDS); create-only via `If-None-Match` |
| `gs://bucket/prefix`, `azure://container/prefix` | rclone at first; native preconditions later (OpenDAL npm spike) |
| `rclone:<remote>:<path>` | Any rclone remote (70+ providers), batched with `--files-from0` |
| `local:<path>` | A directory outside the repo; temp + `link()` |
| `https://host/prefix` | **Read-only**: `GET`, batched `HEAD`. No `list`, so `--latest`, stanza fallback and `gc` refuse. `push` fails with `E_READ_ONLY`. |
| `{type: command, get, put, exists, list?, delete?}` | Custom commands, run without a shell, with per-token `{local}`, `{key}` expansion; needs `blobsy.trustCommandBackend` |

**Interface:**

```ts
interface Backend {
  get(key: string, dest: string): Promise<void>;
  putIfAbsent(src: string, key: string, meta?: Meta): Promise<'created' | 'exists'>;
  exists(keys: string[]): Promise<Map<string, number /* size */>>;
  list(prefix: string): AsyncIterable<{ key: string; size: number; mtime: Date }>;
  delete(key: string, ifMatch?: string): Promise<void>;     // gc only
  readonly capabilities: { conditionalPut: boolean; list: boolean; write: boolean };
}
```

- **Probing.** `conditionalPut` comes from a probe, because some S3-compatibles silently
  ignore `If-None-Match`. The probe writes `_blobsy/probe/<rand>` twice, expecting
  success then 412, and deletes it.
  It runs in first-run `setup` and in `doctor --probe`, and records the result in
  `_blobsy/store.yaml`. `doctor` and `doctor --ci` never write.
- **Permissions are diagnosed separately** (list, read, write, delete), so a read-only
  credential reports “read-only: pull works, push will fail”.
- **Credentials** come from each tool’s own chain (AWS SDK, `rclone.conf`). A missing
  credential says which sources were checked and points to `blobsy docs credentials`.
- **Consistency.** S3, GCS, Azure and R2 give strong read-after-write consistency.
  rclone and command backends are assumed to be consistent.

* * *

## 14. Installation and Platforms

| Path | For |
| --- | --- |
| `npm install -g blobsy` | Humans; hooks find `blobsy` on PATH |
| `npx blobsy@1 <cmd>` | Agents and CI; nothing installed; pin the major |
| Release binary (`bun build --compile`, checksum-verified installer) | Sandboxes without Node; hooks and CI. Released once the golden suite passes against it and the native hash addon is embedded. |

- **Node.** Node ≥ 22.15 at runtime (`node:zlib` zstd); ≥ 24 for development.
- **Native addon.** The BLAKE3 addon is a normal dependency with a WASM fallback.
  Installation never fails when the addon is missing (tested with `--no-optional` and
  `--ignore-scripts`).
- **Startup.** `--version`, hooks and the merge driver load lazily (no AWS SDK, markdown
  renderer or schema library until needed).
  Budget: ≤ 150 ms, enforced in CI.

**Windows:**
- Hooks are `sh` scripts (Git for Windows ships `sh`).
- `.bref` files are written with LF, and `eol=lf` protects them from `autocrlf`.
- Symlinks in snapshots or directory refs fall back to copies with a warning when
  Developer Mode is off, and the restore summary reports the fidelity loss.
- Reflink is available only on ReFS and Dev Drive; elsewhere it falls back to copy.
- Long paths use `\\?\`.
- The local backend uses `link()` (NTFS supports hard links).
  Only on filesystems without hard links does it fall back to rename, accepting
  last-writer-wins for identical bytes.
- Case collisions are refused on every platform.
- The golden suite runs on `windows-latest`.

* * *

## 15. Security

[blobsy-threat-model.md](blobsy-threat-model.md) is normative.
The v3 points:

- **Refs can’t name arbitrary keys.** Keys are derived from validated hex.
  Snapshot names are validated (§5.4).
- **Store manifests are untrusted** until their `tree_id` is verified.
  Archives are extracted under the hardening rules of §8.4, pinned or not.
  Cache restores (including fallback) use unpinned content by design.
- **Shared caches need write segregation** (CVE-2025-36852 “CREEP”). Only trusted CI
  writes `snap/cache/`. Manifests record provenance; a signature line is reserved.
- **Repo content never chooses which environment variables are read.** Only `{env:…}`
  names starting with `BLOBSY_` are expanded.
- **Repo content never chooses an executable.** A command backend needs an out-of-repo
  grant. `.gitattributes` only names the driver, and the command comes from local git
  config. Hooks are never installed into a repo-supplied hooks directory.
- **Local state can’t be committed**, because it lives under the git dir.
  A `blobsy.cacheDir` shared between users is untrusted, which is one reason
  materialization verifies.
- **Unchanged:** user paths are confined to the repo, and `--quiet` and `--json` never
  change a safety decision.

* * *

## 16. Retention and GC

`blobsy gc` deletes content objects and orphaned snapshot archives that no root reaches.

**Roots:**
- every key derived from every `.bref` blob reachable from any ref: branches, tags,
  remote-tracking refs, `refs/stash`, reflogs and `refs/jj/*`;
- the index and the working tree;
- every manifest under `snap/` in the store, plus its archive and the objects of its
  files-mode rows.

**Preconditions** (each refusal names its fix):
1. `git fetch --all --tags --prune` succeeds against every remote.
2. Every ref in the scanned history parses.
3. The store has a recovery window (bucket versioning, soft delete or Object Lock), or
   the operator passes `--no-recovery-window`.
4. `_blobsy/repos/` lists only this repository, or `--also-repo <url>` names every other
   one, whose histories are then scanned too (Gat’s `--repository`). An empty listing
   refuses too. The refusal prints the exact `--also-repo` flags.

**Deleting:**
- Only objects older than `--older-than` (default 30 days) are deleted, which protects
  unmerged work on other machines.
- Refs are re-read immediately before each delete batch.
- Deletes are conditional (`If-Match` or `ifGenerationMatch`), so a concurrent re-upload
  survives.
- `--dry-run` is recommended first.

**Known gap:** re-adding long-unreferenced bytes doesn’t refresh their age, because the
push sees “already exists”.
A gc running while that commit is still unpushed can delete the object.
The recovery window and `doctor --ci` cover this, and a plain `blobsy push` from a
machine with the bytes re-uploads it.

**Cache snapshots:** a bucket lifecycle rule on `snap/cache/` (preferred), or
`gc --expire 'cache/**' --older-than 14d`. Asset snapshots are never expired.

**Emergency purge:** `gc --purge <hash|name>` is for a leaked secret or licence problem.
- It deletes immediately, with no grace period.
- It requires the target to be absent from HEAD. It can’t see other repositories’ pins
  (UC-9), so it lists the `_blobsy/repos/` entries to notify.
- It writes a tombstone (who, when, reason), so later pulls report `E_PURGED` instead of
  a bare 404: `<key>.purged` for an object, `snap/<name>/manifest.bref.purged` for a
  snapshot.

* * *

## 17. Performance Targets

| Operation | Target |
| --- | --- |
| `--version`, hooks, merge driver | ≤ 150 ms |
| `status` on 10k entries, warm | ≤ 1 s, with no re-hashing |
| `status` on 100k entries, warm | ≤ 5 s |
| `add` of 10k × 100 KB | hashing at disk speed; one ignore write and one `git add` per command |
| Hashing | ≥ 2 GB/s per file, native BLAKE3 |
| Packed snapshot publish/restore, 15k files / 170 MB | ≤ 10 s each |
| Files-mode publish with 1% changed | dominated by the walk and one batched `exists` |

* * *

## 18. Architecture

```text
cli/      commander wiring; one file per verb: plan(args) → Plan; execute(Plan); one reporter (human | --json | --dry-run)
core/     config (yaml + git config), paths, git, errors (codes), hash (1 MB reads, worker pool), hashcache, lock
ref/      Entry, parse/serialize/validate, treeId, merge3, walk(dir) → Entry[]
store/    Backend + s3 / local / rclone / https / command; objectKey(); ObjectStore (cache-through, known log)
sync/     the entry loop: plan(entries, local, store, mode) → Action[]; apply(Action[]) with the recoverability rule
snap/     names and templates, pack/unpack, publish (objects → archive → manifest), restore (guard, extract, swap)
doctor/   check registry; each module registers its checks
```

```ts
type Kind = 'f' | 'x' | 'l' | 'd' | 't';
interface Entry { path: string; kind: Kind; size: number; hash: string; storage: string }
interface Manifest { algo: 'blake3' | 'sha256'; entries: Entry[]; meta: Record<string, string> }  // meta: store manifests only
parseManifest(text, where: 'git' | 'store'): Manifest;  serialize(m): string;  validate(m): Issue[];  treeId(entries): string
merge3(base, ours, theirs, opts: { inner: boolean }): { merged: Manifest; conflicts: string[] }
walk(dir, ignore, hashcache): Promise<Entry[]>          // add and snap publish
objectKey(algo, hash, storage): string                   // pure
type Action = { op: 'upload' | 'download' | 'place' | 'replace' | 'delete' | 'refuse' | 'skip'; entry: Entry; reason?: string };
```

**Code reuse:**
- `push`, `pull`, `status`, `clean`, the pre-push hook, auto-pull, `doctor --ci`, and
  files-mode publish and restore all call the one entry loop.
- `add` and `snap publish` share `walk()`.
- Every manifest, in git or in the store, goes through `parseManifest()`.
- The only snapshot-specific code is pack/unpack, names, the restore guard and the swap.

**What v3 removes from v2:**

| Removed | Replaced by |
| --- | --- |
| Timestamped key templates; `remote_key` write-back; two-commit flow | Derived keys; refs final at `add` |
| `remote_key` presence as “pushed” | Known logs + batched `exists` |
| Stat-cache merge base; 9-state sync | Recoverability rule with displacement |
| `.blobsy/` in the working tree; trash directory | State under the git dir; displaced bytes in the content cache |
| YAML per-file pointers; the “no manifests” principle | One `.bref` manifest format, in git and in the store |
| Per-file ignore lines; the gitignore pattern-rewriting machinery | One anchored line per ref in a managed block |
| Five config levels, subdirectory configs, named backends | `.blobsy.yml` + `git config` |
| 22 commands | 16 (incl. `snap` sub-verbs), 9 in Phase 1 |
| aws-cli backend; per-file synchronous spawns | SDK + batched transfers |
| gzip/brotli; compression at push | zstd or none, decided at `add` |

* * *

## 19. Non-Goals and Deferred Work

**Non-goals:**
- a server;
- smudge/clean filters, FUSE or VFS mounts;
- file locking;
- network inside merges or restore hooks;
- mutable names;
- bidirectional or union-merged sync of shared tool caches (cache the package store as a
  snapshot instead);
- sub-file delta or CDC (target scale is MB to a few GB per file);
- client-side encryption (use backend SSE);
- multiple backends per repo;
- backward compatibility (pre-alpha).

**Deferred, designed later if demand appears:**
- **Mirror mode (path-browsable run archives, round 8).** Start with an rclone recipe
  and `blobsy receipt write|verify <dir>`.
- **Grouped packs for files-mode snapshots.** Small files are packed per directory,
  under a content-addressed pack id (the hash of the member rows), so unchanged
  directories dedup and request counts stay bounded.
- **Sharded manifests** for million-file trees: one manifest per subdirectory, as in git
  trees and restic, so a publish rewrites only the changed path.
- **`mv`, `blobsy cat [--range]`, ordered fallback lists** for caches, and whole-tree
  atomic restore for files-mode snapshots.
- **Range restore of packed archives.** `snap restore --only` on a packed snapshot still
  downloads the whole archive.
- **Routes** (paths to different backends) and cross-store read-only pins.
- **History import** (`import history`, filter-repo based).
- **Snapshot signatures.**
- **Multi-threaded hashing within one file** (a small native binding).

* * *

## 20. Open Decisions

| # | Decision | Proposed |
| --- | --- | --- |
| K1 | Derived keys, never stored | Yes |
| K2 | Fixed key layout; filename as metadata | Yes |
| K3 | Default hash | BLAKE3 now. Re-benchmark on Apple M, Graviton and SHA-NI x86 when convenient, weighing SHA-256’s server-side checksums and LFS import. Not a Phase 1 gate. |
| K4 | Content cache on by default, filled at `add`; auto-pull hooks opt-in | Yes |
| K5 | One manifest format for refs and snapshots | Yes |
| K6 | `add` never removes entries implicitly; `--prune` only drops entries deleted here | Yes |
| K7 | Names under `cache/` are caches (packed, miss exits 0, expirable); all other names are assets (files mode) | Yes |
| K8 | Restore mtime for packed caches: archive mtimes or now | Decide after the cargo experiment (Phase 3) |
| K9 | `rm` keeps files; `clean` deletes recoverable ones | Yes |
| K10 | Language: TypeScript, with a single binary; reconsider Rust per the round 9 §7.4 rule | Yes |

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
