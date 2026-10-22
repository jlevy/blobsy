# Research: Tree Manifests, Immutable Snapshots, and Cache-Key Patterns

**Date:** 2026-10-22

**Status:** Reference (input to future design; no decisions made here)

**Related:**

- [blobsy-design.md](../../design/current/blobsy-design.md) — per-file `.bref` model
  (“one file, one `.bref`, one blob”)
- [blobsy-design-review-round8-run-sync-workflows.md](../../design/current/blobsy-design-review-round8-run-sync-workflows.md)
  — mirror mode (attach points + `blobsy-receipt/0.1` with `tree_hash`)
- [research-2026-02-19-sync-tools-landscape.md](research-2026-02-19-sync-tools-landscape.md)
  and
  [research-2026-02-19-backing-store-features.md](research-2026-02-19-backing-store-features.md)

**Evidence key:** **[V]** = verified against a primary source (spec, official docs, or
source code) fetched on 2026-10-22, or by a local experiment recorded here.
**[I]** = inferred, from prior knowledge not re-checked today, or a design judgment.
Prices and limits drift; re-check before quoting them in user docs.

* * *

## 1. Summary

The owner wants blobsy to cover five use cases.
This doc focuses on three:

- **UC-2:** one git-committed manifest for a collection of hundreds to thousands of
  files, with meaningful PR diffs and workable merges (UC-4).
- **UC-3:** very large derived trees (`node_modules`, `target/`, venvs, build caches),
  from tens of thousands to millions of files, cached externally with no manifest in
  git.
- **UC-5:** fixed, immutable, immutably-named assets, which are the likely substrate for
  UC-3.

Seven findings matter most for design:

1. **Every serious tree format has the same core.** Directory entries are sorted by name
   and each entry is `(name, content digest, size, small mode set)`. The tree digest is
   a hash over a canonical serialization.
   Git trees, Bazel REAPI `Directory`, NAR, DVC `.dir`, UnixFS, and restic trees all
   follow it **[V]**. Formats that hash for identity drop mtime, uid, and gid and keep
   only the executable bit and the symlink target (NAR, REAPI, git) **[V]**. Blobsy
   should adopt this core unchanged.
   It already matches the round-8 receipt’s `tree_hash` idea.
2. **Git can merge a sorted, one-line-per-file manifest, with two caveats I verified
   locally.** Changes separated by at least one unchanged line merge cleanly.
   Inserts into the *same gap*, or edits to *adjacent* lines, conflict even when the
   paths differ. `merge=union` silently produces **duplicate paths** when both sides
   modify the same entry **[V, git 2.43 experiment, §4.2]**. So a line format is
   necessary but not sufficient.
   A key-wise merge driver plus a validator that rejects duplicates and unsorted lines
   makes it robust.
3. **Never put aggregates in a committed manifest.** A file count, total bytes, a tree
   hash, or a timestamp in the header changes on *every* edit, so concurrent branches
   always conflict. DVC records the `.dir` hash and counts in the `.dvc` file, and so
   needs a custom merge driver that only unions additions
   **[V for the driver’s behavior; I for the counts-cause-conflicts framing]**.
   Aggregates should be computed, or kept in receipts that are not merged.
4. **Immutable publishing has converged on “blobs first, manifest last.”** Restic writes
   packs, then index and snapshot.
   OCI pushes blobs, then the manifest.
   Iceberg swaps a metadata pointer atomically.
   Nix publishes `.narinfo` after the NAR. All three major object stores now support
   create-if-absent: S3 `If-None-Match: *` (2024-08) and GCS `ifGenerationMatch=0`
   **[V]**, plus Azure `If-None-Match: *` **[I]**. A conditional PUT of the manifest is
   therefore a portable first-writer-wins commit point with no lock service.
5. **Cache keys are input hashes, and keys are write-once.** Examples are
   `actions/cache` (“If the provided `key` matches an existing cache, a new cache is not
   created”), rust-cache (rustc version, `Cargo.lock`, env), Bazel AC/CAS, sccache, and
   Turborepo **[V]**. Prefix fallback (`restore-keys`) and 7-day last-access eviction
   are GitHub-specific conveniences **[V]**. Plain object stores have no last-access
   time, so blobsy can only offer age-based lifecycle **[I]**.
6. **At millions of small files, per-file objects lose badly.** Request cost and latency
   dominate. Every backup and cache system packs: kopia 20–40 MB packs **[V]**, restic
   pack files **[V]**, Xet 64 MiB xorbs **[V]**, OCI tar layers **[V]**, and
   `actions/cache` tarballs **[V]**. Packs plus a per-file table of contents (eStargz,
   restic index) keep partial restore and per-file verification possible **[V]**.
   Content-defined chunking (casync, Xet, restic) wins for incremental updates of
   *large* files and OS images.
   For lockfile-keyed dependency trees, packing deterministically by package boundary
   gets most of the dedup at a fraction of the complexity **[I]**.
7. **One canonical entry format can serve UC-1, UC-2, UC-3, and UC-5.** The entry is
   `path, size, sha256, mode`. Location data (per-file CAS key versus pack and offset)
   is excluded from the tree id.
   A tree id defined once then means the same thing in a receipt, a committed collection
   manifest, a remote snapshot manifest, and a `.bref`-style pointer to a snapshot
   (§6c).

* * *

## 2. Per-system notes

Each entry covers: **format**, **keying**, **transfer unit**, **mergeability**, and
**immutability**.

### 2.1 Git tree objects

- **Format [V]:** binary entries `mode SP name NUL <20-byte sha>`, each with mode
  `100644`, `100755`, `120000` (symlink), or `040000` (tree).
  The object hash is `sha1("tree <size>\0" + entries)`, and blobs are
  `sha1("blob <size>\0" + content)`. Entries are sorted by name.
  Git’s quirk is that directories sort as if they had a trailing `/` **[I]**.
- **Keying:** content-addressed Merkle DAG. Unchanged subtrees share their hash.
- **Transfer:** packfiles (delta-compressed) negotiated over the wire.
- **Mergeability:** git merges trees path-wise, and conflicts only occur per path.
  This is the gold standard UC-2 should emulate *inside* one text file.
- **Immutability:** all objects are immutable.
  Refs are the only mutable pointers.
- **Lesson:** record only the executable bit and symlinks, never mtimes.
  One tree object per directory keeps changes local.

### 2.2 DVC (`.dvc` + `.dir` manifests)

- **Format [V]:** a `.dir` object is a JSON array of `{"md5": ..., "relpath": ...}`. The
  source code sorts entries by `relpath` and serializes with
  `json.dumps(..., sort_keys=True)`. The tree id is `md5(bytes) + ".dir"`, and the id is
  computed *without* meta fields.
  The `.dir` object lives in the CAS next to file blobs
  (`.dvc/cache/files/md5/6f/db53….dir`).
- **Git side [I]:** the committed `.dvc` file records the directory’s `md5: <h>.dir`
  plus aggregate `size` and `nfiles`. The per-file list is *not* in git, so PR diffs
  show only “hash changed.”
- **Merging [V]:** the custom driver
  (`git config merge.dvc.driver 'dvc git-hook merge-driver --ancestor %O --our %A --their %B'`,
  `.gitattributes: *.dvc merge=dvc`) combines data from both branches.
  It fails if the same file was added or changed differently on both sides, or deleted
  on both.
- **Lesson:** DVC keeps the manifest out of git and puts aggregates in.
  That is the opposite of what UC-2 needs (reviewable diffs), and it is why DVC must
  have a merge driver to merge at all.
  Blobsy should commit the per-file list and keep aggregates out.

### 2.3 git-annex

- **Format [V]:** each annexed file is a symlink or pointer to a key such as
  `SHA256E-s86558--e79a….jpg` (backend, size, hash, extension).
  Objects are stored in `.git/annex/objects/aa/bb/<key>/<key>`.
- **Location tracking [V]:** a separate `git-annex` branch holds log files of
  `timestamp presence uuid` lines.
  The design states: “The files stored in this branch are all designed to be auto-merged
  by simply concatenating them together.”
  Timestamps let readers resolve the latest state.
- **Lesson:** you get conflict-free merges by making the merge a union and moving
  resolution to *read time* (last timestamp wins).
  That works for append-only logs.
  It is wrong for a manifest of desired content (§4.2). The key format, which embeds
  size and extension, is a nice human-debuggable touch **[V]**.

### 2.4 OCI image manifests and layers

- **Format [V]:** a manifest (`application/vnd.oci.image.manifest.v1+json`) has a
  `config` descriptor and an ordered `layers[]` of descriptors
  `{mediaType, digest, size}`. Layers are `tar`, `tar+gzip`, or `tar+zstd`. Applying the
  layers in order to an empty directory yields the filesystem.
  An index lists per-platform manifests.
- **Keying:** all blobs are addressed by digest.
  Tags are mutable names that point at manifest digests **[I]**.
- **Transfer unit:** whole layer blobs.
  eStargz adds per-file gzip members and a JSON TOC (`stargz.index.json`) at the end,
  with a footer giving the TOC offset.
  Runtimes can then range-GET single files and verify each with `chunkDigest`. The TOC
  digest is pinned in a manifest annotation **[V]**.
- **Immutability:** registries push blobs first and then the manifest that references
  them. Pushing by digest is idempotent **[I]**.
- **Lesson:** the **descriptor triple `(mediaType, digest, size)`** and **manifest-last
  publish** are the pattern.
  Also, partial restore of a packed archive only needs a TOC with offsets plus HTTP
  Range.

### 2.5 BuildKit / Docker layer cache

- **[V]** `--cache-to type=registry|local|gha|s3|azblob` with `mode=min` (final-image
  layers only) or `mode=max` (all intermediate layers).
  Refs look like `ref=<registry>/<cache-image>:<branch>`. A caution from the docs: “No
  location can be written to twice, without overwriting the previously cached data.”
  Use a separate ref per branch scope.
  Since BuildKit v0.21, `image-manifest=true` is the default.
- **Keying [I]:** cache keys chain instruction text, parent key, and checksums of `COPY`
  inputs. The exported cache is an OCI artifact with a cache-config blob plus layer
  blobs.
- **Lesson:** a *mutable* per-branch ref pointing at *immutable* content-addressed
  blobs. This is the “restore-keys” pattern expressed as a moving pointer.

### 2.6 Bazel REAPI (`Directory` / `Tree`) and remote cache

- **Format [V]:** a `Directory` holds `files[]` (name, digest, `is_executable`),
  `directories[]` (name, digest of the child `Directory`), and `symlinks[]` (name,
  target), each “sorted in lexicographical order by path,” with unique single-segment
  names. That is “canonical form.”
  The digest of a proto is the hash of its deterministic binary encoding.
  A `Digest` is `(hash hex, size_bytes)`, and a request with a wrong size must be
  rejected even if the hash matches.
  `Tree` packs a root `Directory` plus all descendants into one message for single-fetch
  transfer.
- **Cache [V]:** the action cache maps an action digest to an `ActionResult`, and
  non-`OK` results “MUST NOT be cached.”
  The CAS is keyed by content digest.
  `FindMissingBlobs` lets the client upload only what is missing.
  The HTTP cache uses `/ac/<sha256>` and `/cas/<sha256>`. Eviction is up to the server,
  with GCS lifecycle rules as one suggested option.
  “Take care in who has the ability to write to the remote cache.”
- **Lesson:** this is the clearest spec for a deterministic Merkle directory with `size`
  in the digest, and for a **two-tier key** (input-hash → result manifest → CAS blobs).
  `Tree` shows the value of a flattened, single-object manifest for transfer even when
  the canonical form is per-directory.

### 2.7 Nix store paths, NAR, and binary caches

- **NAR [V]:** `nix-archive-1` grammar.
  Directory entries “must be ordered by their names.”
  Only regular file contents plus an `executable` marker, symlink `target`, and
  directory entries are recorded.
  Timestamps and owners are absent (inferred from the grammar).
  NAR exists because tar and zip “do not have a canonical serialisation.”
- **Binary cache [V]:** `<storehash>.narinfo` is line-oriented `Key: Value` with
  `StorePath`, `URL` (e.g. `nar/<filehash>.nar.xz`), `Compression`, `FileHash`,
  `FileSize`, `NarHash`, `NarSize`, `References`, `Deriver`, `Sig` (repeatable), and
  `CA`. A client asks for `<hash>.narinfo` to learn whether the cache has a path.
- **Keying:** an *input-addressed* store path (a hash of the derivation, so all build
  inputs) points to *content-addressed* NAR files.
  A signature on the narinfo establishes trust.
- **Lesson:** this is the closest existing analogue to UC-5. The **lookup object is
  named by the input hash**, the **payload is named by the content hash**, the lookup
  object is tiny, line-oriented, signed, and written after the payload, and it records
  both compressed and uncompressed hashes and sizes.
  A whole tree is a single NAR, which suits immutable trees but rules out partial fetch.

### 2.8 casync / desync (`.caidx`, `.caibx`, `.castr`)

- **[V]** A tree is serialized to a `.catar` stream, which is then content-defined
  chunked with buzhash.
  The chunk index (`.caidx` for trees, `.caibx` for blobs) lists chunk digests
  (SHA512/256 or SHA256) and sizes.
  Chunks are individually zstd-compressed `.cacnk` files in a `.castr` store.
  Everything is static-file and CDN friendly.
  Local data can act as a `--seed`. Desync is a byte-compatible Go reimplementation with
  S3/GCS/HTTP/OCI stores, chained caches, and `prune`. The desync benchmark (six Debian
  image builds) holds all six in 832 MB versus 1,753 MB as separate copies.
  A client holding a 2-day-old build downloads 109.8 MB instead of 292.2 MB.
- **[I]** casync’s default average chunk size is about 64 KiB.
- **Lesson:** CDC over a whole-tree stream removes file boundaries, which “groups small
  files and splits large ones.”
  It is excellent for OS images that change slightly between versions.
  Extracting one file costs more, because you need the stream index and must parse the
  catar.

### 2.9 restic / kopia / borg

- **restic [V]:** every repository file is write-once and named by the sha256 of its
  contents. Pack files contain blobs with the **header at the end**, so a pack can be
  streamed. Tree blobs are JSON with a `nodes[]` list that includes mtime, uid, and other
  metadata, and “must be deterministic” for dedup.
  Snapshots are JSON pointing to a root tree.
  Index files (< 8 MiB, with `supersedes`) map each blob to (pack, offset, length).
  CDC uses Rabin with a random per-repo polynomial: files under 512 KiB are not split,
  and chunks run 512 KiB–8 MiB (about 1 MiB average).
  Locks are files, and a lock older than 30 minutes is stale.
  **[I]** The default pack size is about 16 MiB and is tunable.
- **kopia [V]:** blocks of ≤ 20 MB are combined into **20–40 MB packs** (`p` data, `q`
  metadata, `x` index).
  Pack names are random, and “a local index is also stored at the end of each pack” for
  recovery. Snapshot manifests are small labeled JSON objects.
- **borg [I]:** buzhash CDC (target about 2 MiB), archives as metadata item streams, and
  a single-writer repo lock.
- **Lesson:** packs plus an index is the universal answer for many small objects.
  Snapshots are tiny manifests written last.
  Backup trees record mtime because restore fidelity matters, so the *identity* hash and
  the *restore metadata* need to be separate concepts (§6c).

### 2.10 Xet / Hugging Face

- **[V]** Gearhash CDC (target 64 KiB, min 8 KiB, max 128 KiB) packs chunks into **xorbs
  (≤ 64 MiB)**. **Shards** are binary files holding file-reconstruction info (file →
  list of xorb + chunk-range terms) and CAS info.
  The spec’s stated goal is that “independent implementations MUST produce the same
  hashes.” Git holds pointer files, and `git-xet` is an LFS custom transfer agent.
  Dedup is global and chunk-level.
- **Lesson:** this is the state of the art for *large* binary files that are edited a
  little. It is overkill for UC-3 trees of small immutable files.
  Its separation of *file identity* (merkle hash) from *physical layout* (xorb terms) is
  the same split recommended in §6c.

### 2.11 IPFS UnixFS / CAR

- **[V]** A directory is a `dag-pb` node with named links.
  Encoders should sort links by name, but decoders accept any order.
  Large directories become **HAMT shards**, usually above about 256 KiB–1 MiB per block,
  with fanout a power of 2 and at most 1024. The spec warns that CIDs depend on chunk
  size, DAG width, HAMT fanout and threshold, and on optional mode and mtime, so “the
  same input can produce different CIDs across implementations.”
  It now defines named **profiles** (`unixfs-v0-2015`, `unixfs-v1-2025`) to pin those
  parameters.
- **[I]** CAR files concatenate blocks for bulk transfer.
- **Lesson:** a tree id is only portable if *every* layout parameter is pinned by a
  versioned profile. Blobsy’s tree id must not depend on packing, chunking, or
  compression (§6c).

### 2.12 mtree(5)

- **[V]** A line-oriented spec.
  The first line is a `#mtree` signature.
  Each line after it is `path keyword=value…`, with `type`, `mode`, `uid`, `size`,
  `sha256digest`, `time`, `link`, and others.
  `/set` and `/unset` set defaults, and both relative and full-path entry styles exist.
- **Lesson:** this is prior art for a human-readable, greppable, diffable tree manifest
  with optional columns.
  Blobsy could offer `blobsy manifest --format mtree` export for interop **[I]**.

### 2.13 Dolt prolly trees

- **[V]** Chunk boundaries are content-defined over sorted keys (target about 4 KB), so
  “No matter which order you insert, update, or delete values, the Prolly tree is the
  same.” A diff skips any subtree with an identical hash, and its cost “scales with the
  size of the differences, not the size of the tree.”
- **Lesson:** this is how to shard a very large sorted manifest so the shards stay
  stable under edits: split at content-defined boundaries, not at fixed counts.
  It is relevant if UC-2 manifests ever need sharding beyond per-directory files
  **[I]**.

### 2.14 Iceberg manifest lists

- **[V]** Table metadata points to snapshots.
  Each snapshot points to a manifest list (v4: root manifest), which points to Avro
  manifests (v4: Parquet).
  Manifests list data files with status ADDED, EXISTING, or DELETED plus per-file stats,
  and are reused across snapshots.
  Commits use optimistic concurrency: “All changes to table state create a new metadata
  file and replace the old metadata with an atomic swap.”
  A writer whose base is stale retries.
- **Lesson:** this is a two-level manifest where unchanged sub-manifests are reused by
  reference, and the only mutable thing is one pointer.
  That is the model for sharded snapshot manifests (§6b).

* * *

## 3. Cache-key systems (UC-3 / UC-5)

| System | Key composition | Write semantics | Fallback | Eviction |
| --- | --- | --- | --- | --- |
| `actions/cache` **[V]** | user `key` (typically `hashFiles('**/lock')` + OS). Hidden *version* = paths + compression tool. | Existing key ⇒ no new cache (“You cannot change the contents of an existing cache”). | `restore-keys` prefix match in order, newest wins. Branch → default-branch scoping, PR caches scoped to the merge ref. | 7 days since last access. 10 GB/repo default (raisable, billed). 200 uploads/min. |
| Swatinem/rust-cache **[V]** | `prefix-key` (`v0-rust`) + job id + rustc release/host/hash + env vars + `Cargo.lock`/`Cargo.toml`/toolchain/config hashes. | `save-if` (e.g. main only). `cache-on-failure` is off by default. | via actions/cache. | Prunes before save: workspace crates, incremental artifacts, artifacts with mtime > 1 week, `registry/src`. |
| Bazel remote cache **[V]** | Action digest (command, inputs, `--action_env`-allowed env). | AC + CAS. Only `OK` results cached. | none (exact). | Server-defined (bazel-remote GC, GCS lifecycle). |
| sccache **[V]** | blake3 of compiler binary, args, preprocessed source (C) or rustc sysroot + args + inputs (Rust). | Per-compilation object. | none. | Backend-defined. |
| Turborepo **[V]** | Task hash (inputs, env, deps) **[I for exact composition]**. | HTTP API (`v8` endpoints). Optional HMAC-SHA256 signature: unverified artifacts are treated as a miss. | none. | Server-defined. |
| Nx self-hosted cache **[V/I]** | Task hash. OpenAPI spec since Nx 20.8. | `PUT/GET /v1/cache/{hash}`, read-only tokens get 403. Overwrite semantics not confirmed. | none. | Server-defined. |
| Nix binary cache **[V]** | Store-path hash (input-addressed). | Narinfo plus signatures. | Multiple substituters. | Operator-defined. |
| pnpm store **[V]** | Per-file content address. `node_modules` is built from hard links plus a symlinked `.pnpm` virtual store. | Append-only CAS **[I]**. | n/a | `pnpm store prune` **[I]**. |
| uv cache **[V]** | Versioned buckets (wheels, sdists, git). Git deps keyed by resolved commit. `tool.uv.cache-keys`. | “Multiple concurrent readers and writers”, never modify by hand. | n/a | `uv cache prune --ci` keeps only wheels built from source. |
| BuildKit **[V]** | Layer chain keys. | Mutable ref per branch scope over immutable blobs. | Multiple `--cache-from`. | Registry GC. |

Cross-cutting patterns:

- **Key = namespace/version prefix + toolchain + platform + lockfile hash.** The version
  prefix (`v0-rust`, actions’ hidden version) is the escape hatch for format changes
  **[V]**.
- **Write-once keys.** Concurrent writers race and one wins.
  GitHub declines re-creation.
  Bazel and Nix are content- or input-addressed, so duplicates are identical by
  construction **[V/I]**.
- **Prune before save.** rust-cache strips workspace crates and stale artifacts, and uv
  drops re-downloadable wheels.
  Caches should hold what is *expensive to rebuild*, not everything **[V]**.
- **Cache the content-addressed store, not the materialized tree, when the tool has
  one.** The pnpm store and uv cache are relocatable and dedup across projects.
  A materialized `.venv` embeds absolute paths, and `node_modules` holds symlinks and
  hard links **[V for the pnpm/uv mechanisms; I for the relocatability conclusion]**.
- **Trust is the weak point.** Shared write access means cache poisoning risk.
  Mitigations: write only from trusted CI (`save-if`), separate read and write tokens
  (Nx 403), and signed manifests (Turborepo HMAC, Nix `Sig`) **[V]**.

* * *

## 4. Manifest representation trade-offs for git

### 4.1 Options

| Representation | PR diff | Git 3-way merge | Size at 10k files | Tooling |
| --- | --- | --- | --- | --- |
| Sorted TSV, one line per file (`path\tsize\tsha256\tmode`) | One line per changed file: ideal. | Clean unless the changes are adjacent (§4.2). | ~1 MB **[I]** | `sort`, `grep`, `awk`, `join`, `comm` |
| YAML/JSON list of objects (DVC `.dir`, restic tree) | 3–5 lines per entry, noisy; `{}` and `,` churn in JSON. | Hunks span entry boundaries, so conflicts are frequent and markers break JSON validity. | 2–4× larger | jq/yq |
| YAML map keyed by path | Diff OK. | Better than a list, but indentation and quoting make it fragile. | ~2× | yq |
| Binary (REAPI proto, Xet shard, git tree) | Opaque. | None without a driver. | Smallest | Custom |
| Hash-only pointer (DVC `.dvc`, LFS pointer) | “Hash changed.” | Always conflicts on concurrent change. | Tiny | n/a |

### 4.2 Git merge behavior on a sorted line manifest (local experiment, git 2.43) [V]

Base `a,c,e,g`, with one entry per line, sorted:

1. Side A inserts `b`, side B inserts `d` (one unchanged line, `c`, between them):
   **clean merge**, and the result is correctly sorted.
2. Side A inserts `b1`, side B inserts `b2` (same gap between `a` and `c`):
   **conflict**, although the paths are distinct.
3. Side A edits `c`, side B edits `e` (adjacent lines): **conflict**.
4. `merge=union` with both sides editing the hash of `c`: **exit 0 with two `c` lines**.
   The duplicate path is silent corruption.

Implications:

- The default text merge is **safe but conservative**. It never produces a wrong
  manifest silently, and its conflict markers sit on whole lines that a tool can repair.
  This matters because GitHub’s web merge button and merge queues do not run locally
  configured merge drivers **[I]**, and drivers are configured in `.git/config` or
  `~/.gitconfig`, never in the repo **[V]**.
- In big collections the false conflicts (cases 2 and 3) are uncommon.
  With N entries, two random independent edits are adjacent with probability about 2/N
  **[I]**. They are common in *append-heavy* sequences such as `run-0001`, `run-0002`:
  every concurrent append lands in the same gap.
  Use tie-free names or let the driver handle them.
- **`merge=union` must never be the default** for manifests.
  If it is used, a validator must reject duplicate paths.
- **A custom driver** (`blobsy merge-driver %O %A %B %P`) can do the merge DVC does, but
  key-wise and with full semantics.
  It parses all three sides as maps `path → (size, hash, mode)` and applies per-path
  3-way rules: a change on one side wins, an identical change on both sides is fine, and
  only a differing change to the same path conflicts.
  It writes sorted output and exits non-zero only on true conflicts.
  Set `merge.blobsy.recursive` to the driver itself so criss-cross merges work too
  **[V for the `.recursive` semantics]**.
- **Header aggregates guarantee conflicts.** Any line that changes on *every* commit
  (`files:`, `bytes:`, `tree_hash:`, `updated_at:`) conflicts on every concurrent pair
  of edits. Keep the committed header static (format and options only).

### 4.3 Sharding

- **Per-directory manifest files** (a git-tree-like split) keep diffs and merges local
  and cap file size. The cost is many small committed files, which is what UC-2 wants to
  avoid. A middle ground is **one shard per top-level subdirectory, only above a
  threshold** (for example more than 20k entries) **[I]**.
- **Content-defined sharding** (Dolt-style) keeps shard boundaries stable but makes file
  names opaque. That is bad for reviewers **[I]**.
- **Recommendation [I]:** one file until it hits a threshold, then path-prefix shards.
  The tree id is defined over the logical entry set, so sharding never changes it.

### 4.4 Deterministic tree digest

Choose between a **flat hash** (sha256 of the canonical sorted entry lines) and a
**Merkle per directory** (git, REAPI, NAR-equivalent).
Flat is simple, matches DVC and the round-8 receipt, and can be computed with
`LC_ALL=C sort | sha256sum`. Merkle allows subtree equality checks and partial
verification, but needs a canonical per-directory encoding.
**Recommendation [I]:** define the v1 tree id as flat, and leave room for an optional
Merkle index later. Pinning matters more than the choice (lesson of UnixFS profiles).
Pin path normalization, sort order (bytewise UTF-8), line format, the hash algorithm,
and the set of columns that participate.

* * *

## 5. Transfer granularity

| Approach | Per-file cost | Partial restore | Incremental update | Dedup | Best for |
| --- | --- | --- | --- | --- | --- |
| Per-file objects (blobsy today, DVC, LFS) | 1 PUT/GET per file. S3 GET $0.0004/1k **[V]**, PUT about $0.005/1k **[I]**, plus latency per object. | Trivial | Per file | Whole-file CAS | ≤ ~10k files, mostly large (UC-1, UC-2) |
| Whole-tree tar+zstd (actions/cache, NAR) | 1 object | None (must stream from the start) | None: any change re-uploads all | Whole tree only | Small-to-medium trees that change wholesale |
| Grouped packs + TOC (restic, kopia, eStargz, OCI layers) | 1 object per ~16–64 MB | Range-GET by TOC offset | Changed groups only | Per pack, or per file with an index | **UC-3 trees**, millions of files |
| CDC over stream or files (casync, Xet, restic chunks) | 1 object per chunk, or packed into xorbs | Via index | Excellent, even within files | Chunk-level, global | Large files with small edits, OS images |

Order-of-magnitude reasoning **[I]**:

- One million files as per-file PUTs costs about $5 in requests.
  It also takes about 1M round trips: at 256 in flight and about 50 ms each, roughly 3–4
  minutes best case, and much worse with real per-request overheads and throttling (S3
  prefix limits).
- The same tree as about 100 packs of 64 MB transfers at bandwidth speed.
  Listing, existence-checking, and GC also scale with object count, so packs help every
  operation, not just upload.
- `node_modules` and venvs are dominated by files under 4 KB. Packing plus zstd also
  wins on compression ratio, because small files compress poorly alone.
- Partial restore matters less for UC-3 caches (you restore all of it) than for UC-2
  collections (fetch a subset).
  That points to per-file objects for UC-2 and packs for UC-3.

* * *

## 6. Patterns for blobsy

### 6a. UC-2: a git-committed, mergeable collection manifest

**Proposal:** a committed `<dir>.btree` file adjacent to a gitignored directory.
This mirrors the `.bref` convention: `data/images/` is gitignored and
`data/images.btree` is committed.

```text
# blobsy tree manifest — https://github.com/jlevy/blobsy (do not edit by hand; run `blobsy track`)
#format blobsy-tree/0.1
#hash sha256
#remote cas
# path	size	sha256	mode
cats/001.jpg	48213	9f2c…e1	-
cats/002.jpg	51877	07ab…3c	-
scripts/fetch.sh	912	c4d1…77	x
```

Rules:

- **One entry per line**, tab-separated, sorted by bytewise UTF-8 path (`LC_ALL=C`). The
  `mode` column is `-` (regular), `x` (executable), or `l:<target>` (symlink, optional).
- Paths are POSIX, relative, NFC-normalized, never `..`, and percent-escape `\t`, `\n`,
  and `%`.
- The **header is static** (format and options only), with **no counts, totals, tree
  hash, or timestamps**. `blobsy status` computes those.
  Receipts record them (round 8, Option C), and receipts are written per push and not
  merged.
- **Remote layout:** per-file CAS objects under the existing `key_template` machinery,
  for example `sha256/<hash>`. There is no per-tree object, so no two-phase `remote_key`
  problem exists for collections.
  Dedup works across versions and branches for free.
- **Merging:**
  1. Text merge works by default and is always safe (§4.2).
  2. `blobsy setup` installs `merge.blobsy.driver` (path-wise 3-way, sorted output,
     `recursive` set to itself) and `.gitattributes: *.btree merge=blobsy`.
  3. `blobsy manifest resolve <file>` repairs a conflicted file outside git’s driver
     path (GitHub UI conflicts, rebase).
     It takes the conflict-marked text, re-parses both sides, and applies the same
     rules.
  4. `blobsy doctor` and pre-commit validate sorted order, no duplicates, and no
     conflict markers.
- **PR review:** a diff shows exactly the added, removed, or changed files with their
  sizes. Optionally, `blobsy diff A..B` summarizes counts and bytes.
  The size column lets reviewers spot a 4 GB accident.
- **Scale:** single file up to a threshold (for example 20k entries or about 2 MB), then
  optional per-top-level-directory shards (`data/images.btree.d/cats.btree`, …), with
  the same tree id.

**Alternative considered:** a YAML list (consistent with `.bref`). Rejected: it merges
and diffs worse (§4.1), and YAML adds nothing for homogeneous rows.
A middle path is a YAML header plus a TSV body, but the `#key value` header lines above
are simpler to parse and to keep static.

### 6b. UC-3 / UC-5: an immutable tree snapshot with no git metadata

**Primitive:** a *snapshot* is an immutable, content-identified tree stored in the
backend. A *name* (cache key or asset name) is a write-once pointer to a snapshot.

```text
<prefix>/snapshots/<tree-id>/manifest.btree.zst   # entries + pack locations (+ restore meta)
<prefix>/snapshots/<tree-id>/packs/<pack-sha256>.tar.zst
<prefix>/names/<namespace>/<key>.ref               # tiny, write-once: tree-id, created, signer
```

- **Naming and keying.** UC-3 names come from a declared input hash:
  `<cache-name>/<blobsy-cache-version>-<platform>-<toolchain>-<sha256(lockfiles)>`. For
  example: `node_modules/v1-linux-x64-glibc-node24.3-<h(pnpm-lock.yaml)>`. The recipe is
  declared in committed config, so **git holds no per-key metadata**, only a static
  stanza:

  ```yaml
  caches:
    node_modules:
      path: node_modules
      key: [pnpm-lock.yaml, {cmd: 'node --version'}, {platform: true}]
      restore_prefix: true    # actions/cache-style fallback (optional)
      ttl_days: 30            # becomes a bucket lifecycle rule on names/ + snapshots/
  ```

  UC-5 names are user-chosen and immutable (`assets/model-weights/2026-10-v3`).
  Alternatively, they can be referenced directly by tree id (below).

- **Write-once commit point (manifest-last).**
  1. Hash the tree to get the entries and the tree id.
  2. If `names/…/<key>.ref` exists, stop (hit, or someone else won).
  3. Upload packs with conditional PUTs (idempotent, since they are content-named).
  4. Upload the snapshot manifest (also content-named).
  5. **Conditional-create the name `.ref`** with `If-None-Match: *` on S3,
     `ifGenerationMatch=0` on GCS, or `If-None-Match: *` on Azure
     **[V S3, GCS; I Azure]**.

  A loser on step 5 discards its result, and its orphan packs are reclaimed by GC. A
  reader treats “`.ref` exists and its manifest exists” as complete.
  Partial uploads are invisible.
  For backends without conditional writes (rclone remotes, command backends), fall back
  to check-then-put with a documented race.
  The race is harmless when the two writers’ contents are identical.
  It is unsafe only for non-deterministic builds **[I]**.

- **Packing.** Use deterministic tar (sorted entries, zeroed uid/gid, fixed mtime *in
  the tar*, with real mtimes in the manifest) plus zstd.
  **Group by path prefix at a natural package boundary**, configurable per cache.
  Examples: `node_modules/.pnpm/<pkg>@<ver>/`, `site-packages/<dist>/`,
  `target/*/deps/<crate>-*`. Size-bounded groups (merge small packages and split huge
  ones) target about 16–64 MB.

  Packs are named by content hash, so a lockfile bump that changes three packages
  uploads three packs, and other snapshots reuse the rest.
  This gets OCI-layer-style dedup without CDC **[I]**. CDC (FastCDC/gearhash) is a
  possible v2 for trees dominated by large, slowly-changing files.

- **Partial restore.** The manifest maps each file to `(pack, offset, length)`, like the
  restic index or the eStargz TOC. That enables range-GET of single files and restoring
  a subtree (`blobsy restore node_modules --only .pnpm/react@*`) **[I]**.

- **Restore fidelity.** UC-3 build caches need **mtime** (cargo and make freshness
  checks), **exec bits**, **symlinks** (pnpm, venv `bin/python`), and possibly **hard
  links**. Record mtime in the manifest as *restore metadata*, excluded from the tree
  id. Warn that venvs and `node_modules` embed absolute paths: either key on the absolute
  path, or prefer caching the relocatable store (pnpm store, uv cache,
  `~/.cargo/registry`) and rebuild the tree locally
  **[V for the uv and pnpm mechanisms; I for the recommendation]**.

- **Verification without download.**
  - *Local vs snapshot:* stat-then-hash the tree against the manifest.
    Use a size+mtime fast path, with full hashing behind `--verify`.
  - *Remote integrity:* HEAD each pack and compare size (and checksum headers where the
    backend exposes sha256). This is the analogue of `FindMissingBlobs`.
  - *Authenticity:* an optional signature in the `.ref`, using HMAC (Turborepo-style) or
    ed25519 (Nix-style).

- **How a repo refers to a snapshot.** There are two complementary modes:

  - **Derived (UC-3):** nothing committed per snapshot.
    The key is recomputed from the lockfile and toolchain at restore time.
    Use this for caches, where loss is acceptable.

  - **Pinned (UC-5, or a cache that must be reproducible):** a tiny committed pointer
    with the same shape as a `.bref`:

    ```yaml
    # blobsy snapshot ref — run `blobsy restore` to materialize
    format: blobsy-bref/0.2
    kind: tree
    hash: sha256:<tree-id>
    size: 734003200          # total bytes (pointer is per-snapshot, not merged line-wise)
    files: 48211
    remote_key: snapshots/<tree-id>/manifest.btree.zst
    ```

    Because a snapshot pointer is replaced wholesale, aggregates are fine *here*, unlike
    in §6a.

- **Eviction.** Caches get bucket lifecycle rules on their prefix (age-based, since
  object stores lack last-access time **[I]**). An optional `blobsy cache gc` deletes
  names older than the TTL and then packs unreferenced by any live manifest
  (mark-and-sweep, like `desync prune` or restic `prune`). Assets never expire.
  Round 8’s R12 (“no remote deletion”) holds for assets and runs, and caches are the
  explicit exception, as in the trading repo’s 90-day `tool-caches/` rule.

### 6c. One canonical format across `.bref`, `.btree`, snapshots, and receipts

Define a single **entry** and a single **tree id**, and let each use case add only
columns that do *not* participate in the id.

| Artifact | Where | Entries | Extra columns (not in id) | Aggregates |
| --- | --- | --- | --- | --- |
| `.bref` (UC-1) | git | 1 (implicit path = sibling file) | `remote_key`, `compressed*` | n/a |
| `.btree` (UC-2) | git | N, sorted TSV | none (location is derived: `sha256/<hash>`) | **none** (merge safety) |
| Snapshot manifest (UC-3/5) | remote only | N, sorted TSV, zstd | `pack`, `offset`, `length`, `mtime` | header OK (immutable) |
| Snapshot pointer (UC-5 pinned) | git | 0 (references a tree id) | `remote_key` | OK (replaced wholesale) |
| Mirror receipt (round 8) | dir + optionally git | 0 | `dest`, `verified` | `files`, `bytes`, `tree_hash` |

The canonical id is computed as follows.
`entry_line = path "\t" size "\t" sha256hex "\t" mode "\n"` over NFC, bytewise-sorted
paths, and `tree_id = "sha256:" + sha256(concat(entry_lines))`. A `.btree` file stripped
of its comment lines *is* that byte stream, so `grep -v '^#' x.btree | sha256sum`
reproduces the id **[I]**.

Consequences:

- **Promotion is free.** A UC-2 collection can be published as a packed snapshot (UC-5),
  and the tree id is unchanged.
  The round-8 receipt’s `tree_hash` should adopt this exact definition, so “the receipt
  matches the manifest” is a string compare.
- **The `.bref` relationship.** A per-file `.bref` is the 1-entry degenerate case:
  `hash` and `size` are the entry’s `sha256` and `size`. No migration of existing
  `.bref` files is needed.
  `kind: tree` (§6b) is the only new field, gated by a `blobsy-bref/0.2` minor bump.
  The design already accepts minor bumps.
- **Disciplines stay separate, as round 8 requires.** Path-mirrored keys remain the rule
  for run trees (R9), and CAS or pack keys apply to `.btree` and snapshots.
  They share an *entry format*, not storage layout or lifecycle.

* * *

## 7. Comparison matrix

| System | Manifest form | Sort / canonical | Tree digest | Transfer unit | Git-mergeable | Immutable publish | Partial restore |
| --- | --- | --- | --- | --- | --- | --- | --- |
| git tree | binary per dir | name-sorted **[V]** | Merkle sha1/sha256 | packfile | yes (path-wise) | objects immutable | sparse checkout |
| DVC `.dir` | JSON list | relpath-sorted **[V]** | md5 of JSON + `.dir` | per file | via driver: additions only **[V]** | CAS | per file |
| git-annex | symlink + key | n/a | per file | per file | union logs **[V]** | CAS keys | per file |
| OCI | JSON manifest + layers | layer order | sha256 per blob | layer tar(+gz/zstd) | no | blobs then manifest | eStargz TOC **[V]** |
| BuildKit cache | OCI artifact | n/a | layer keys | layers | no | mutable ref, immutable blobs | per layer |
| Bazel REAPI | proto `Directory`/`Tree` | lexicographic **[V]** | hash of canonical proto | per blob (CAS) | no | CAS + AC | per blob |
| Nix | NAR + narinfo | name-sorted **[V]** | NarHash | whole NAR (compressed) | no | narinfo after NAR | none |
| casync/desync | `.caidx` chunk index | stream order | chunk digests | CDC chunks | no | chunks then index | via catar parse |
| restic | JSON trees, snapshots | deterministic **[V]** | sha256 of blob | packs + index | no | packs → index → snapshot | yes (index) |
| kopia | JSON dir objects | **[I]** | content id | 20–40 MB packs **[V]** | no | packs → manifest | yes |
| Xet | binary shards | n/a | merkle per file | 64 MiB xorbs **[V]** | no (pointer files in git) | xorbs → shard | chunk ranges |
| UnixFS | dag-pb (+HAMT) | sorted (encoders) **[V]** | CID (profile-dependent) | blocks / CAR | no | CAS | per block |
| mtree | text lines | none mandated | none | n/a | text | n/a | n/a |
| Dolt | prolly tree | key-sorted | root chunk hash | ~4 KB chunks | yes (cell-wise) | CAS | per chunk |
| Iceberg | JSON + Avro/Parquet | n/a | none (pointer) | data files | no (OCC retry) | atomic pointer swap **[V]** | manifest pruning |
| actions/cache | none | n/a | key string | tar(+zstd) **[V]** | n/a | key write-once **[V]** | none |
| **blobsy `.btree` (proposed)** | sorted TSV | bytewise UTF-8 | flat sha256 | per file CAS | yes (text, plus driver) | per-file CAS | per file |
| **blobsy snapshot (proposed)** | sorted TSV + pack cols | bytewise UTF-8 | same tree id | grouped packs | n/a (not in git) | packs → manifest → cond. `.ref` | range GET |

* * *

## 8. Open questions

1. **Path normalization and case.** Should NFC normalization be mandatory, or should
   blobsy refuse NFD paths?
   macOS case-insensitive collisions (`A.txt` and `a.txt`) could be rejected at track
   time or allowed with a warning.
2. **Empty directories.** Git ignores them, while NAR and REAPI include them.
   Should `.btree` support a `d` mode for UC-3 fidelity (some tools expect empty dirs)?
3. **Hard links** in the pnpm store and `node_modules`. Options are to record a link
   group in restore metadata or to restore as copies or reflinks.
4. **Tree id hash.** sha256 matches `.bref`. blake3 is much faster for million-file
   hashing, as sccache uses.
   Pick one per format version, and never mix within an id.
5. **Flat vs Merkle id.** Is subtree verification (“only `.pnpm/react@19` changed”)
   worth a per-directory Merkle index in v1, or can the flat id plus a diff of the
   manifest serve?
6. **Restore-prefix fallback** needs LIST on `names/<ns>/`. Is that acceptable on all
   backends (rclone and command backends)?
   Should fallback restore merge with a subsequent install (like actions/cache), with
   blobsy then publishing a new key?
7. **Trust.** Should snapshot `.ref` files be signed by default when shared across CI
   and laptops? Which key management fits blobsy’s “no server” principle: HMAC from an
   env secret (Turborepo) or ed25519 keys in config (Nix)?
8. **Conditional-write fallback.** For `command` and `rclone_remote` backends without
   create-if-absent, is check-then-put acceptable, or should snapshot publish require a
   capable backend?
9. **GitHub-side merges.** Should blobsy ship a CI check that fails a PR whose merged
   `.btree` is unsorted, has duplicates, or has conflict markers?
   That would catch web-UI merges that bypass the local driver.
10. **Sharding threshold** for `.btree`, and whether shards are per-top-level-dir or
    content-defined (§4.3).
11. **Relationship to mirror mode.** Is a mirror-mode `--manifest` (round 8, Option C)
    simply a `.btree` written next to the receipt?
    If yes, one format covers all four artifacts.

* * *

## 9. Sources

Primary sources fetched 2026-10-22 unless marked.

- Git objects (Pro Git): https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
- gitattributes `merge` / custom drivers: https://git-scm.com/docs/gitattributes
- DVC internal files (`.dir`, cache layout):
  https://doc.dvc.org/user-guide/project-structure/internal-files
- DVC merge conflicts / merge driver:
  https://doc.dvc.org/user-guide/how-to/resolve-merge-conflicts
- dvc-data tree serialization (source):
  https://github.com/iterative/dvc-data/blob/main/src/dvc_data/hashfile/tree.py
- git-annex internals: https://git-annex.branchable.com/internals/
- OCI image manifest spec:
  https://github.com/opencontainers/image-spec/blob/main/manifest.md
- eStargz: https://github.com/containerd/stargz-snapshotter/blob/main/docs/estargz.md
- Docker/BuildKit cache backends: https://docs.docker.com/build/cache/backends/
- Bazel REAPI proto:
  https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto
- Bazel remote caching: https://bazel.build/remote/caching
- Nix content addressing of file system objects:
  https://nix.dev/manual/nix/2.24/store/file-system-object/content-address
- NAR format: https://nix.dev/manual/nix/2.28/protocols/nix-archive
- narinfo format: https://nix.dev/manual/nix/2.35/protocols/binary-cache/narinfo
- casync: https://github.com/systemd/casync
- desync: https://github.com/folbricht/desync
- restic design: https://github.com/restic/restic/blob/master/doc/design.rst
- kopia architecture: https://kopia.io/docs/advanced/architecture/
- Xet protocol spec: https://huggingface.co/docs/xet/index ; chunking:
  https://huggingface.co/docs/xet/chunking ; Hub overview:
  https://huggingface.co/docs/hub/xet/index
- IPFS UnixFS spec: https://specs.ipfs.tech/unixfs/
- mtree(5): https://man.freebsd.org/cgi/man.cgi?query=mtree&sektion=5
- Dolt prolly trees:
  https://www.dolthub.com/docs/architecture/storage-engine/prolly-tree
- Apache Iceberg spec: https://iceberg.apache.org/spec/
- FastCDC (USENIX ATC ’16):
  https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia
- GitHub Actions dependency caching:
  https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching
- actions/cache README: https://github.com/actions/cache/blob/main/README.md
- Swatinem/rust-cache: https://github.com/Swatinem/rust-cache
- sccache caching: https://github.com/mozilla/sccache/blob/main/docs/Caching.md
- Turborepo remote caching: https://turborepo.dev/docs/core-concepts/remote-caching
- Nx self-hosted cache (search snippets only; page 404’d at fetch):
  https://nx.dev/docs/guides/tasks--caching/self-hosted-caching
- pnpm node_modules structure: https://pnpm.io/symlinked-node-modules-structure
- uv cache: https://docs.astral.sh/uv/concepts/cache/
- S3 conditional writes (2024-08-20):
  https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes/
- GCS request preconditions:
  https://docs.cloud.google.com/storage/docs/request-preconditions
- S3 pricing (GET price verified; PUT price from memory):
  https://aws.amazon.com/s3/pricing/
- Local experiment: git 2.43.0 merges of a sorted TSV manifest (four cases, §4.2), run
  2026-10-22 in a scratch repo.
