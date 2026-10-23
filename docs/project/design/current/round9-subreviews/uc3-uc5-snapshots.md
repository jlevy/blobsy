# UC-3 / UC-5 design review and proposal: immutable snapshots for large trees

**Reviewer:** Fable (round 9 sub-review) · **Date:** 2026-10-22 · **Repo state:** `main`
@ 04a3d1a

**Evidence key:** **[V]** verified today against source code, a primary doc, or a local
experiment recorded in the appendix.
**[I]** inference or design judgment.
**[R]** taken from the parallel research doc
`research-2026-10-22-tree-manifests-and-cache-patterns.md` (itself marked V/I); I
re-verified the items that matter for the decision and say so.

* * *

## 0. Verdict in six sentences

1. Round 8’s run-output workload and UC-3’s build-tree workload are **different
   workloads with different lifecycles**, and they should not share a primitive.
   Round 8 mirror mode (path-mirrored, copy-only, never deleted, receipts) stays for
   runs. UC-3 needs a **snapshot** primitive: an immutable, content-identified tree
   published under a write-once name, packed, restorable by atomic swap, TTL-able.
2. **UC-5 is the snapshot primitive**, not a separate thing.
   UC-3 is UC-5 with a *derived* name (input hash) and a *finite* retention; a pinned
   model/dataset is UC-5 with a *chosen* name and *infinite* retention; the round-8 R10
   “shared tool cache” is UC-5 at single-file granularity.
   One primitive, three naming/retention policies.
3. Git holds **nothing per snapshot** for caches (only a config stanza), and **one small
   committed pointer** for pinned assets.
   Both are line-level merge problems: the owner’s hypothesis that UC-5 lets UC-3 avoid
   file-level git merges is correct, with the precise statement being *the merge surface
   collapses to the key inputs (lockfile) or to one pointer line* (§6).
4. The store holds, **under each name**, one deterministic `tar.zst` (split into parts
   only for transfer), a manifest, and a **tiny `ref.yaml` written last with a
   create-only PUT**. That is the commit point: no lock service, no two-phase
   `remote_key`, and cache expiry is a bucket lifecycle rule on the prefix, not blobsy
   logic. Create-only writes are supported by S3, GCS, Azure, R2 **[V]**, by the SDK
   already in `node_modules` **[V]**, by `aws s3 cp --no-overwrite` and rclone-to-S3
   **[R: V]**; not by rclone-to-GCS/Azure, B2, or command backends, which get a
   documented check-then-put fallback and a `doctor` probe.
5. Versus actions/cache, Turborepo, sccache, Bazel: blobsy’s defensible value is *the
   same cache on laptops, VMs, and any CI, on any bucket you already own, declared in
   the repo, with immutable names and verifiable contents*. Blobsy should **stop** at
   publish/restore/ls/gc of whole snapshots.
   Bidirectional “sync” of derived trees is a trap; action-level caching is someone
   else’s job.
6. Complexity is roughly 1.5–2x round 8’s mirror-mode estimate, most of it reusable
   (tree walk with modes/symlinks, canonical manifest and tree id shared with UC-2,
   `Backend.list`/`putIfAbsent`). It also surfaces three gaps in file mode that UC-3
   would trip over anyway: symlinks skipped, exec bits lost on pull, no `list` on
   backends.

* * *

## 1. Evidence base (what I actually checked)

### 1.1 Blobsy today, run against a UC-3-shaped tree [V]

Scratch repo, local backend, `tree/` containing a 244 KB executable script, a 300 KB
file under `pkg/dist/`, a symlink `pkglink -> pkg`, a dot-directory `.bin/` containing a
symlink, and an empty directory (appendix A.1):

| Observation | Result |
| --- | --- |
| `blobsy add --verbose tree` | tracked **1** file. `pkglink` reported “Skipping symlink” (verbose only); `.bin/` skipped silently (dot-dir rule); `pkg/dist/big.bin` skipped because the default `ignore` list contains `dist/**`, which `walkDir` also matches against the bare entry *name*, so any directory named `dist`, `build`, or `node_modules` is ignored at any depth |
| exec bit after `rm tree/pkg/cli.sh; blobsy pull` | `-rwxr-xr-x` → `-rw-r--r--` (bit **lost**; `.bref` has no mode field) |
| empty dir, symlinks after pull | not represented at all |
| remote key | `20261022T151121Z-50cbfd9b075e/tree/pkg/cli.sh.zst` (timestamped, so not content-addressed) |

So file mode’s *defaults* deliberately exclude the directories UC-3 targets, and its
*fidelity* (no symlink, no mode, no empty dir) cannot restore a `node_modules` or
`target/` tree at all.
That is not a bug to fix in file mode; it is the clearest signal these are different
primitives.

### 1.2 A real pnpm `node_modules` (this repo’s own) [V]

| Metric | Value |
| --- | --- |
| entries / regular files / symlinks / dirs | 19,922 / 14,711 / 1,550 / 3,661 |
| executables / empty dirs | 217 / 3 |
| files with `nlink > 1` (hardlinked to the pnpm store) | **14,598 of 14,711** |
| bytes (regular files) | 171.4 MB |
| sha256 of every file (Node, sync reads, warm cache) | **0.99 s** |
| `tar --format=posix` | 0.5 s, 191 MB |
| zstd-3 via `node:zlib` stream, single thread | **2.76 s → 39.9 MB** (4.8×) |
| decompress + untar | **4.8 s** total; 1,550 symlinks, 217 exec bits, intra-archive hardlinks all preserved |

Takeaways: (a) whole-tree hashing is cheap at this scale (`O(bytes)`, not `O(files)`);
(b) a single deterministic tar.zst is a fully adequate v1 pack: 5 s to restore 171 MB
from local disk, and the archive is 4.8× smaller than per-file objects would sum to; (c)
per-file objects would be 14,711 PUTs/GETs for the same payload; the lead reviewer
measured 23 s to push **1,000** files to a *local-disk* backend in file mode.

### 1.3 Conditional (create-only) writes, by provider and by tool [V unless marked]

| Target | Mechanism | Failure | Notes |
| --- | --- | --- | --- |
| AWS S3 | `If-None-Match: *` on `PutObject`, `CompleteMultipartUpload`, `CopyObject` | `412`; `409` if a concurrent delete raced | first finisher wins; in-flight MPUs are not considered; requires SigV4 |
| GCS | `ifGenerationMatch=0` / `x-goog-if-generation-match: 0` | `412` | **XML-API multipart uploads reject preconditions (`400 NotImplemented`)**; `gcloud storage cp --if-generation-match=N` exists (0 not shown in the doc example — [I] that it works) |
| Azure Blob | `If-None-Match: *` on `Put Blob`, `Put Block List` | `412` | long-standing |
| Cloudflare R2 | `If-None-Match: *` on `PutObject` ("create-once"), atomic with commit | `412` | `CompleteMultipartUpload` **not documented** as conditional |
| MinIO | `If-Match`/`If-None-Match` on `PutObject`, `CopyObject` (since 2023) | `412` | search-level verification only |
| `@aws-sdk/client-s3` 3.995 (installed) | `IfNoneMatch` on `PutObjectRequest` and `CompleteMultipartUploadRequest` |  | `lib-storage` 3.1096 `Upload` spreads `...this.params` into `CompleteMultipartUploadCommand`, so `IfNoneMatch: '*'` in `Upload` params reaches both paths (read from `dist-cjs/index.js:454-461`; **not executed**) |
| aws CLI | `s3api put-object --if-none-match "*"` (2.17.34, 2024-08); `complete-multipart-upload` same; `copy-object` (2.31.24). High-level **`aws s3 cp/mv --no-overwrite` (≥ 2.33.0)** sends `If-None-Match: *` on PutObject, CompleteMultipartUpload, CopyObject; for `aws s3 sync` the flag degrades to a listing-based skip **[R object-store: V, source]** |  | so the aws-cli backend can do create-only without switching to `s3api` |
| rclone | S3 backend: `--header-upload "If-None-Match: *"` reaches PutObject and CompleteMultipartUpload since **v1.72.0 (2025-11-21)** (changelog [V]; **[R: V source]**); `--immutable` / `--ignore-existing` are *client-side* check-then-act, not atomic |  | **GCS and Azure backends map no conditional headers [R: V source]**, so blobsy’s `gs://`/`azure://` path cannot do an atomic create-only write today |
| Backblaze B2 | **rejects** `If-None-Match` (`400`) **[R: S]**; Wasabi undocumented |  | treat as “unsupported”, fall back |
| MinIO | upstream community repo archived 2026 **[R: V]**; a reported bug let conditional PUTs proceed without read quorum |  | do not make it the test target |
| local backend | `open(O_EXCL)` / `link()` | `EEXIST` | trivial |

Conclusion: **a create-only commit object is portable** across S3, R2, Azure, GCS
(native), local, and S3-compatibles that honor the header, with caveats to design
around: GCS XML multipart (keep the commit object a single small PUT so this never
matters), rclone-to-GCS/Azure (no preconditions: either a thin native SDK write for the
small commit object only, or exists-then-put with a documented race — the object-store
research recommends the former **[R: I]**), B2/Wasabi/command backends (fallback), and
**silent ignore** on unknown S3-compatibles, which only a `doctor` probe (write a
sentinel twice, expect `200` then `412`) can detect **[R: I, agreed]**.

### 1.4 Existing cache systems [V]

- `actions/cache`: key write-once ("If the provided `key` matches an existing cache, a
  new cache is not created"), `restore-keys` prefix fallback, 10 GB/repo, eviction after
  7 days without access, branch-scoped with default-branch fallthrough, tar(+zstd).
- Bazel remote cache: `/ac/<hash>` (action → result) and `/cas/<hash>`; “any HTTP/1.1
  server that supports PUT and GET” incl.
  GCS and (user-reported) S3; eviction is the server’s problem.
- sccache: per-*compilation* cache keyed by blake3 of compiler, args, preprocessed
  source; backends S3, R2, GCS, Azure, Redis, memcached, GHA, WebDAV, OSS, COS.
  Explicitly cannot cache linking or incremental compilation — so it does **not**
  replace a `target/` cache.
- Backend interface today (`types.ts`): `push/pull/exists/delete/healthCheck` only.
  **No `list`, no conditional put.** Both are needed for snapshots (and `list` for GC in
  any design).

* * *

## 2. Taxonomy

### 2.1 Four workloads, not one

|  | **A. Repo files** (UC-1/2) | **B. Run archives** (round 8) | **C. Derived caches** (UC-3) | **D. Pinned assets** (UC-5) |
| --- | --- | --- | --- | --- |
| Example | `data/model.bin`, `images/` | `runs/local/<cohort>/` (thousands of logs) | `node_modules`, `target/`, `.venv`, preprocessed datasets | `models/llama-3-8b@v2`, a dataset release, a tool-cache entry |
| Identity | path in repo at a commit | path-shaped prefix (browsable) | **input hash** (lockfile, toolchain, platform) | **chosen immutable name** |
| Writers | many, via git | one per prefix | many CI jobs racing on the same key | one publisher per name |
| Mutability | versioned by git | append-mostly until done, then frozen | immutable per key; safe to lose | immutable forever |
| Git holds | `.bref` / manifest | receipt (optional) | **config stanza only** | **one pointer line** (optional) |
| Store layout | key_template (today timestamped) | path mirror | content-addressed snapshot + name | same as C |
| Fidelity | content only | content only (logs) | symlinks, exec bits, empty dirs, (mtime?) | same as C |
| Restore | per file | per file, partial by glob | **whole tree, atomic swap, fast** | whole tree or file |
| Deletion | GC by reachability (deferred) | **never** (R12) | **TTL** (R10 analog, 90-day rule) | never |
| Merge problem | git merges pointers | none (single writer) | none: key derived from lockfile | none: one line |

A and B are already decided (file mode; mirror mode pending blobsy-s2tr). C and D share
every column except *who picks the name* and *how long it lives*. That is the whole case
for one primitive with policies, and against stretching either A or B to cover them:

- Stretching **A** (per-file brefs, or bead `aad8`’s one-bref-per-directory) fails on
  fidelity (§1.1), on per-file transfer cost (§1.2), and on git footprint (tens of
  thousands of pointer lines nobody will review).
  Round 8 already rejected Option A for runs; the argument is stronger for caches.
- Stretching **B** (mirror a `node_modules` to a path-shaped prefix) fails on identity
  (a cache is addressed by *inputs*, not by where it sits), on concurrency (two CI jobs
  mirroring into the same prefix is last-writer-wins; the trading R10 “union merge” only
  works because entries are content-keyed), on restore speed (14,711 GETs), and on
  lifecycle (mirrors never delete; caches must).

### 2.2 Naming the sub-cases crisply

- **Snapshot** (the primitive): an immutable tree (or single file) identified by a
  `tree_id`, stored packed, and reachable through one or more write-once **names**.
- **Cache snapshot** (UC-3): name derived from a declared key recipe; retention finite;
  nothing committed; fallback-to-nearest optional.
- **Asset snapshot** (UC-5): name chosen by a human (`assets/<thing>/<version>`);
  retention infinite; optionally **pinned** by a committed pointer.
- **Entry asset** (UC-5, file granularity): a single-file asset under a name such as
  `tool-caches/serpapi/<request-hash>.json`; this is round 8’s R10 class, and it is
  exactly “create-only put of a content-keyed object”, not a mirror.

I would stop using “UC-3” and “UC-5” in the design doc and use *cache snapshot* / *asset
snapshot* / *entry asset*; the primitive is one.

* * *

## 3. Design of the snapshot primitive

### 3.1 Identity: one canonical entry format and tree id (shared with UC-2)

Adopt the research doc’s canonical entry **[R, agreed]** with one amendment: the id must
cover everything a snapshot restores *structurally*, so entry kinds are part of it.

```
entry_line := path "\t" kind "\t" size "\t" sha256hex "\n"
kind       := f | x | l:<target> | d          # regular, executable, symlink, empty dir
tree_id    := "sha256:" + sha256(concat(sorted entry_lines))   # bytewise UTF-8 sort, NFC paths
```

- `mtime`, uid/gid, hardlink groups are **restore metadata**, carried as extra columns
  in the *stored* manifest and excluded from the id (git/NAR/REAPI convention
  **[R: V]**).
- UC-2’s committed `.btree` is the same byte stream minus the extra columns; a UC-2
  collection can therefore be published as a snapshot with the *same* id.
  Round 8’s receipt `tree_hash` should adopt this exact definition so “receipt matches
  manifest” is a string compare.
  (Research §6c; I agree and would make it a normative appendix.)
- Amendment vs research: research keeps `d` and `l:` optional.
  For snapshots they are not optional (1,550 symlinks and 3 empty dirs in one
  `node_modules`); make them first-class in the format and let `.btree` simply rarely
  contain them.
- Hash choice: stay with sha256 (consistent with `.bref`, 1 s per 171 MB measured).
  blake3 is a v2 format-version question, not a v1 one.

### 3.2 Naming and keying

Two name sources, one namespace:

```yaml
snapshots:
  node_modules:                       # a cache snapshot: name is derived
    path: node_modules
    key: "cache/node_modules/{os}-{arch}/{hash:pnpm-lock.yaml}"
    fallback: prefix                  # on miss, restore newest under the parent prefix
    retention: 30d
  llama:                              # an asset snapshot: name is chosen at publish time
    path: models/llama-3-8b
    name: "assets/llama-3-8b/{version}"   # `blobsy snap publish llama --version v2`
    pin: models/llama-3-8b.bref       # commit a pointer (UC-5 pinning)
    retention: forever
```

Rules:

- Template variables are **pure**: `{hash:<repo-file>}` (sha256 of a committed file,
  short form), `{os}`, `{arch}`, `{env:NAME}`, `{version}` (CLI-supplied).
  **No `{cmd:...}`**: a committed `.blobsy.yml` must never choose an executable
  (threat-model rule 1). Toolchain versions enter through `{env:...}` set by CI, or
  through a hash of a committed `rust-toolchain.toml` / `.nvmrc`. The research doc’s
  `{cmd: 'node --version'}` suggestion should be rejected on this ground.
- Names are **immutable once created**. There is no “update” verb; a different tree
  needs a different name.
  For caches that is automatic (different inputs → different hash); for assets it is
  `--version v3`.
- Add a format-version prefix to derived keys by default (`cache/<stanza>/v1/...`) so a
  change in blobsy’s packing or id definition cannot restore stale shapes (the
  `actions/cache` hidden “version” and rust-cache `v0-rust` lesson **[R: V]**).

### 3.3 What git holds

| Case | Committed | Not committed |
| --- | --- | --- |
| Cache snapshot | the `snapshots:` stanza only | everything else; the key is recomputed at restore time |
| Asset snapshot, pinned | a `.bref`-shaped pointer (`kind: tree`, `name`, `hash: <tree_id>`, `files`, `bytes`) | the manifest and data |
| Asset snapshot, unpinned | nothing (name is quoted in docs/scripts) | — |
| Entry asset | nothing (or the name in a status file, as the trading repo does) | — |

Pointer sketch (one file per pinned asset; aggregates are fine here because the file is
replaced wholesale, unlike a line-merged manifest **[R: V for the merge argument]**):

```yaml
# blobsy -- https://github.com/jlevy/blobsy
# Run: blobsy snap restore models/llama-3-8b
format: blobsy-bref/0.2
kind: tree
name: assets/llama-3-8b/v2
hash: sha256:3c1f…9a          # tree_id; verified on restore
files: 3
bytes: 16060000000
```

The pointer records the **name**, not only the tree id, so humans and `doctor` can see
what the repo depends on, and `restore` can fetch without a listing; the `hash` is what
is verified. `kind: file` is the degenerate single-file asset.
This is a minor bump of the existing `.bref` schema (`brefSchema` gains optional
`kind`/`name`/ `files`), and `blobsy status` already knows how to show a pointer’s
state.

### 3.4 What the store holds

```
<prefix>/snap/<name>/data.tar.zst               # deterministic tar, zstd (written first)
<prefix>/snap/<name>/data.tar.zst.NNN           # only when split for transfer (>5 GB or parallelism)
<prefix>/snap/<name>/raw                        # single-file assets: the bytes as-is (no tar)
<prefix>/snap/<name>/manifest.tsv.zst           # entries + restore metadata (+ header)
<prefix>/snap/<name>/ref.yaml                   # tiny, written LAST, create-only: the commit point
```

where `<name>` is `cache/target/v1/linux-x64/<h>/<h>` or `assets/llama-3-8b/v2`.

- **Everything lives under the name** (layout “G2”). This is the actions/cache, Nix
  narinfo, and trading `tool-caches/` shape, and it is what makes the lifecycle story
  trivial (§3.9): a bucket rule on `snap/cache/` expires a snapshot’s objects together
  by creation age, and no object is shared between names.
- **`ref.yaml` is the commit point**: data parts → manifest → ref, with the ref written
  create-only. A reader treats “ref exists” as complete; partial uploads are invisible
  (OCI/restic/Nix “manifest-last” pattern **[R: V]**). The ref is a single small PUT, so
  GCS’s multipart-precondition gap never applies to it.
- **Manifest is stored separately from the archive** so `ls`, `verify`, `diff`, and
  partial-extract decisions need a few hundred KB (≈ 1.5 MB raw / ~300 KB zstd for a
  14k-entry `node_modules` [I from line size]), not the archive.
- **Idempotent re-publish**: a `412` on `ref.yaml` is followed by a GET of the existing
  ref; equal `tree_id` → success ("already published"), different `tree_id` → hard error
  for assets, “someone else won with a different tree” warning for caches (which should
  only happen for non-deterministic builds).
- **What G2 gives up**: whole-tree dedup across names (the same tree published under two
  keys is stored twice).
  For caches that is rare (different lockfile → different tree) and cheap; for assets it
  is a non-issue. The content-addressed alternative ("G1": `snap/<tree_id>/…` plus
  `names/<name>` refs) buys dedup at the price of mark-and-sweep GC in blobsy and makes
  bucket lifecycle rules unsafe on their own.
  G1 is the v2 option if dedup proves to matter; the manifest and ref formats are
  identical under both, so the switch is a layout change only.
- This layout is **not** driven by `remote.key_template`. Snapshots have a fixed,
  derivable layout, so the two-phase `remote_key` problem (bead `pqyt`) does not exist
  here; nothing has to be written back to git after a push.

**Pack format decision (where I differ from the research doc).** Research §6b proposes
package-boundary packs (16–64 MB) with per-file `(pack, offset, length)` for range
restore and cross-snapshot dedup.
I recommend **one deterministic `tar.zst` per snapshot in v1**, with the manifest
reserving `pack`/`offset`/`length` columns, because:

1. The hot path for caches is *restore*, and restore is whole-tree: 4.8 s for 171 MB
   locally **[V]**. Package packs do not speed that up; they only reduce *upload* bytes
   on a lockfile bump, which is the cold path.
2. Deterministic grouping needs per-ecosystem boundary rules (`.pnpm/<pkg>@<ver>`,
   `site-packages/<dist>`, `target/*/deps/<crate>-*`) — ecosystem knowledge blobsy
   should not own.
3. A single archive is what every production cache does (`actions/cache`, NAR).
4. The manifest format leaves the door open: v2 can add packs without changing the tree
   id or the name layout.

Deterministic tar needs: sorted entries, uid/gid 0, fixed in-archive mtime, POSIX
format, real mtimes in the manifest.
Node has no tar builtin; `tar` (node-tar) is the obvious dependency, with
`portable: true` plus a fixed `mtime` [I: not tested]. Zstd streams are in `node:zlib`
**[V, Node 22.22 here; the project targets Node 24]**.

### 3.5 Restore semantics

1. Resolve name → GET `snap/<name>/ref.yaml` → `tree_id`; on a pinned pointer also check
   the pointer’s `hash` equals the ref’s `tree_id` (**refuse** on mismatch: the name was
   not mutable, so this is tampering or corruption).
2. Fetch manifest; recompute `tree_id` from its canonical columns; refuse on mismatch.
3. Fetch `data.tar.zst` into the **local snapshot cache** (§3.7) unless present.
4. Extract into a sibling temp dir `<path>.blobsy-restore-<rand>` on the same
   filesystem; apply symlinks, exec bits, empty dirs; apply mtime policy (§3.6).
5. **Verify**: hash every regular file against the manifest (≈1 s / 171 MB;
   `--no-verify` exists for the impatient, but the default is verify, matching
   threat-model rule 4).
6. **Atomic swap**: `rename(<path>, <path>.blobsy-old-<rand>)`, `rename(temp, <path>)`,
   then delete the old tree.
   Two renames, microsecond window, same as package managers do;
   `renameat2(RENAME_EXCHANGE)` is not reachable from Node [I].
7. Refuse to swap if `<path>` is a tracked file-mode path or inside a mirror (round 8
   non-goal 3 extended: one discipline per path, `doctor` errors on overlap).

Partial restore in v1 is `--only <glob>`: extract a subset from the single archive
(download is still whole).
True range restore is v2 with packs.

Miss behavior for caches: exit 0 with “miss” (and `--fallback` → restore newest name
under the parent prefix, like `restore-keys`, then the caller runs `pnpm install` and
`blobsy snap publish` writes the exact key).
Miss for assets: error.

### 3.6 Fidelity

| Property | Snapshot v1 | File mode today |
| --- | --- | --- |
| symlinks | recorded (`l:<target>`), restored; **absolute or escaping targets refused at publish** (`..` out of the tree) unless `--allow-escaping-symlinks` | skipped |
| exec bit | recorded (`x`), restored | lost |
| other mode bits, uid/gid | not recorded (git/NAR convention) | — |
| empty dirs | recorded (`d`), restored | impossible |
| hardlinks | restored as independent files in v1; intra-archive link groups preserved by tar as a bonus. The pnpm case (14,598 links into a store *outside* the tree) cannot be preserved by any tree-local format; `pnpm install` re-links | — |
| mtime | stored in manifest; restore policy `mtime: preserve \| now` per stanza, default **`now`** | — |

The mtime default needs an owner decision and an experiment (§7, Q7): cargo’s freshness
check compares output mtimes with source mtimes, so a restored `target/` whose files are
*older* than a fresh `git checkout` can trigger a full rebuild; `actions/cache` + GNU
tar preserve archive mtimes and rust-cache users hit exactly this class of problem [I].
I could not settle this today; it is the single biggest “does `target/` caching actually
work” risk and should be validated against cargo before the stanza default is fixed.

### 3.7 Local cache

- `~/.cache/blobsy/snap/<tree_id>/data.tar.zst` (+ manifest), shared across clones and
  worktrees, keyed by content so it is safe to share.
  Entries are read-only.
- Bounded by size with LRU on blobsy-maintained access times
  (`blobsy snap cache prune`).
- v1 caches the **archive**, not an extracted tree.
  Extracted-tree cache with reflink/hardlink restore (`cp --reflink` on btrfs/xfs/APFS;
  instaclone-style symlink farms) is a v2 optimization once someone measures that the 5
  s extract is the bottleneck rather than the download.

### 3.8 Concurrency: first writer wins

- The **ref** object is created with a conditional PUT (`If-None-Match: *`,
  `ifGenerationMatch=0`, `O_EXCL`). Loser gets `412`, GETs the winner’s ref, and reports
  “already published by <created_at/by>”: exit 0 for caches when the `tree_id` matches
  (someone else did the work), warning when it differs, non-zero for assets (a human
  must pick a new version).
- Data parts and manifest under a name are written create-only too; two racing writers
  of the same deterministic tree write the same bytes, so a `412` there is skipped, not
  failed. `exists` first avoids re-uploading large parts.
- **`412` on retry of your own write** (lost response, SDK retry) must be handled the
  same way: GET/HEAD and compare, never treat as fatal **[R: I, agreed]**.
- **Delete markers**: on a versioned S3 bucket a create-only PUT succeeds over a delete
  marker **[R: V]**; combined with R12 (no remote deletes outside `gc`) this is
  acceptable, but it is why cache expiry should run as lifecycle rules on prefixes, not
  as per-object deletes a human might run by hand.
- Backends without conditional PUT (command backends, B2/Wasabi, rclone to GCS/Azure):
  **exists-then-put**, with the race documented.
  It is benign when the two writers produced identical trees (deterministic installs)
  and only wrong for non-deterministic builds — which should not be cached under a
  derived key anyway. For `gs://`/`azure://` the object-store research’s option (b) — a
  thin native SDK write for the *ref only*, since it is one small object — closes the
  gap without re-plumbing transfers **[R: I]**.
- Expose this as `Backend.capabilities.conditionalPut`, **set by a `doctor` probe**
  (write a sentinel twice; expect `200` then `412`; `400`/`501` or `200`/`200` means
  unsupported) rather than by backend type, because S3-compatibles silently ignore the
  header **[R: I, agreed]**.
- No cross-machine locking, no daemon (keeps the “no lock files” principle).

### 3.9 Eviction, TTL, and GC

- **Primary mechanism: bucket lifecycle rules on the cache prefix** (`snap/cache/`, or
  per-stanza `snap/cache/target/`), age-based.
  Under layout G2 every object of a snapshot sits under its name and was created within
  minutes of the others, so a creation-age rule retires a snapshot as a unit; a reader
  that finds a ref but no data (the few-minute skew) treats it as a miss.
  This is R10’s “growth bounded by a lifecycle rule, not tooling” and the object-store
  research’s P5 **[R]**. S3 and GCS rules are creation-age based; Azure can also use
  last-access; GCS can add size bounds **[R: V]**.
- `retention:` in the stanza is therefore **documentation plus a `doctor` check** ("no
  lifecycle rule found on `snap/cache/target/`; here is the rule to add"), not a timer
  blobsy enforces.
- `blobsy snap gc [--dry-run] [--older-than]` exists for backends with no lifecycle
  (local, command) and for explicit cleanup; it lists `snap/cache/**/ref.yaml`, deletes
  expired name prefixes, and uses conditional delete (`If-Match`/`ifGenerationMatch`)
  where available so it removes only what it judged **[R: V for the primitives]**. It
  never touches `snap/assets/`.
- Assets: no lifecycle rule; optionally Object Lock / R2 bucket lock on `snap/assets/`
  for WORM **[R: V]**. The pointer records the name (§3.3) so a human can see what a
  repo depends on; nothing automated deletes assets.
- Round 8’s R12 (no remote deletion) stands for mirrors and assets.
  Cache snapshots are the explicit, config-declared exception, as the trading repo’s
  90-day `tool-caches/` rule already is.

### 3.10 Listing and discovery

- `blobsy snap ls [name-prefix]` lists `**/ref.yaml` under the prefix and, with
  `--long`, GETs each tiny ref for `tree_id`, created, files, bytes.
  `--json` for agents.
- `fallback: prefix` needs the same `list`. Pick by `created_at` in the ref, not by
  LastModified, so behavior is identical across backends.
- Single-file assets stored `raw` can additionally be verified without download on S3 by
  uploading with `x-amz-checksum-sha256` and reading it back via `HeadObject`
  (single-part only) **[R: V]**; trees are verified through the manifest instead.
- `blobsy snap show <name>` fetches the manifest (few KB) and prints entries or a diff
  against the working tree (`blobsy snap status <stanza>`: hit / miss / local-differs).
- `Backend.list(prefix)` is new and trivial on every backend: `ListObjectsV2`,
  `aws s3api list-objects-v2`, `rclone lsf`, `readdir`. Command backends get an optional
  `list_command`, and `ls`/`gc`/`fallback` are unavailable without it.

* * *

## 4. Reconciling with round 8 mirror mode

**Keep it, narrow it, and share the entry format.**

| Round 8 element | Recommendation |
| --- | --- |
| Attach points `mirrors:` + path-shaped prefixes | **Keep** for run archives (workload B). Nothing in UC-3/5 needs path-mirrored keys; nothing in B needs packing or write-once names |
| Receipts `blobsy-receipt/0.1` with `tree_hash` | **Keep**, but define `tree_hash` as the canonical `tree_id` of §3.1 (research §6c). A receipt then *is* a degenerate store-side manifest, and `--manifest` writes the full `.btree` next to it. Yes to the lead’s hypothesis 2 |
| Non-goal 1: no two-way merge | **Stands**, for both modes |
| Non-goal 2: no hooks | **Stands**; snapshot ops never run in git hooks either (a 2 GB `target/` publish inside `git push` is the same mistake as a 40 GB cohort) |
| Non-goal 3: one discipline per path | **Stands, extended** to three disciplines; `doctor` errors on a snapshot path that is tracked or mirrored |
| Non-goal 4: no compression bookkeeping | **Stands for mirrors**; snapshots compress by construction (tar.zst) with nothing to book-keep per file |
| Non-goal 5: verbs dispatch by path (`push`/`pull`) | **Do not extend to snapshots** (§5.3 below). Acceptable for mirrors since mirror push/pull really are one-way copies; snapshot publish/restore are not copies and have different safety properties |
| R10 shared tool caches (union-merge, add-only, 90-day lifecycle) | **Move out of mirror mode** into the snapshot primitive as *entry assets*: each entry is a create-only object under a content/request-derived name; “union merge” becomes “first writer wins per entry”, which is what the trading tool’s content-keyed union actually is. Round 8 itself flagged that receipts don’t fit an always-growing tree; this resolves it without an “add-only mirror flavor” |
| R11 receipt-verified prune | **Stands**, and snapshots get the same protocol for free: `blobsy snap status` says “local tree matches published `tree_id`”, so deleting a local `target/` is safe |
| R12 never delete remote | **Stands** for mirrors and assets; **explicit exception** for cache snapshots with `retention:` |
| Beads: `aad8` superseded, `4vpk` drop, `pqyt` file-mode-only | **Agree**; add that `pqyt` is structurally absent from snapshots because their layout is derivable |

Could receipts and UC-2 manifests be the same format?
Yes at the **entry** level (one line per file, same columns, same id), **no** at the
header level: committed manifests must carry no aggregates (they conflict on every
concurrent edit **[R: V, git 2.43 experiment]**), while receipts and snapshot manifests
are never merged and should carry `files`, `bytes`, `tree_id`, `created_at`. The design
doc should say “one entry format, three containers” rather than “one format”.

* * *

## 5. Build vs integrate, honestly

### 5.1 What exists and what it does not do

| Tool | Scope | Where it stops |
| --- | --- | --- |
| `actions/cache` | tar+zstd of paths, key write-once, prefix fallback | GitHub-hosted only (or self-hosted with GitHub’s service); 10 GB/repo; 7-day eviction; no laptop/VM use; no verifiability; no chosen names |
| Turborepo / Nx remote cache | task-output caching keyed by task hash | monorepo task graphs; needs their server or a self-hosted implementation; not a general tree cache |
| sccache | per-compilation cache (C/C++/Rust); S3/GCS/Azure/R2 backends | cannot cache linking or incremental builds, so `target/` restore is still needed for fast rebuilds; not for `node_modules`/venvs |
| Bazel remote cache | AC + CAS over HTTP/gRPC | Bazel |
| rust-cache | `actions/cache` + cargo-specific pruning | GitHub Actions only |
| BuildKit cache backends | OCI layer cache to registry/S3/azblob/gha | Docker builds |
| pnpm store / uv cache | relocatable content-addressed stores | the *right* thing to cache for JS/Python; blobsy’s job is moving those directories, not replacing them |

### 5.2 Blobsy’s differentiated value (and only this)

1. **Same cache everywhere**: laptop, dev VM, Filestore-mounted worker, any CI vendor.
   The trading org’s producers are moving to GCP VMs (R11); `actions/cache` is useless
   there.
2. **Any bucket you already own**, with blobsy’s backend abstraction and credential
   neutrality; no 10 GB cap, no 7-day eviction, retention you choose.
3. **Repo-declared config** (`snapshots:` stanza) and an agent-friendly CLI with
   `--json`, `status`, `doctor`, and refusal semantics.
4. **Verifiable immutability**: tree ids, hash-verified restore, write-once names.
   None of the CI caches give a laptop user “this is byte-for-byte the tree CI built”.
5. **Chosen immutable names + pins** (UC-5), which no cache product offers at all.

Context from the landscape refresh **[R]**: `runs-on/cache` is an S3-backed
`actions/cache` fork with no 10 GB cap, but still GitHub-Actions-shaped; Nx has
deprecated its bucket caches after CREEP; GitHub Immutable Releases covers
release-shaped UC-5 assets only; and the new competitor Gat (sharded lockfile + semantic
merge driver, OpenDAL backends) has a strong UC-2/UC-4 story but **no UC-3/UC-5 story**.
The snapshot primitive is where blobsy is not crowded.

### 5.3 Where blobsy should stop

- **No bidirectional sync of derived trees.** “Sync `node_modules`” implies merging two
  materializations of a derived artifact; the correct operation is *replace from
  inputs*. Publish/restore is the whole API. (The owner’s word “sync” in UC-3 should be
  read as “publish/restore”.)
- **No action-level caching**, no task graphs, no compiler wrappers.
- **No ecosystem rules** in v1 (what to prune from `target/`, how to group packs).
  Users declare `path` and `exclude`; rust-cache-style pruning is a documented recipe,
  not code.
- **No CDC / sub-file dedup**; no range restore (v2 at most).
- **No signing in v1**; trust is bucket IAM, as in every CI cache.
  The Nx “CREEP” advisory (CVE-2025-36852) is the cautionary tale: any shared,
  input-keyed, first-writer-wins bucket can be poisoned by whoever reaches the key
  first, and the fix is **write segregation and provenance**, not checksums
  **[R landscape: S]**. So: the docs recommend write credentials only for
  protected-branch CI and read-only for PRs and laptops; `ref.yaml` records provenance
  (`by`, branch, commit, run id); a `sig` field is reserved for a later HMAC/ed25519
  scheme. A pinned asset is safe regardless, because the pointer’s `tree_id` is verified
  on restore.
- **No mutable names, ever.** Not even “latest”.
  `fallback: prefix` is the only moving pointer, and it is computed at restore time, not
  stored.
- **Not a replacement for pnpm/uv stores.** The docs should say plainly: for JS and
  Python, cache the store (`pnpm store path`, `uv cache dir`) and let the package
  manager relink; cache `node_modules`/`.venv` directly only when the absolute path is
  stable. `target/`, model directories, and preprocessed datasets are the clean wins.

* * *

## 6. Interaction with git: does UC-5 let UC-3 avoid file-level merges?

Yes, and more precisely than the hypothesis states:

- **Caches**: git never sees the tree, the manifest, or the name.
  The only merge is the one the package manager already handles (`pnpm-lock.yaml`), and
  the key follows the merged lockfile automatically.
  There is nothing left for git to merge because the *identity* of the tree is a
  function of committed inputs.
  Branch `feature/x` with its own lockfile gets its own key; after merge the key is the
  merged lockfile’s. No branch scoping machinery needed (contrast `actions/cache`’s
  branch rules, which exist only because its keys are not pure functions of inputs).
- **Pinned assets**: upgrading is a one-line change to `name:`/`hash:` in a small file.
  Two branches upgrading to different versions conflict on that one line, which is the
  correct and trivially resolvable outcome.
  Two branches pinning different *trees* under the same name cannot happen because names
  are write-once. Compare UC-2 manifests, which need a merge driver because they carry N
  lines.
- **Where the hypothesis needs a caveat**: the tree is not in git, so git also cannot
  *diff* it. “What changed in `node_modules`?” is answered by `blobsy snap diff
  <name-a> <name-b>` over manifests, not by `git diff`. That is the right trade for
  caches and probably for assets; it would be the wrong trade for UC-2 collections,
  which is why UC-2 stays a committed manifest.
- **Agents**: an agent that needs the tree runs `blobsy snap restore <stanza>`; a
  post-checkout convenience hook is tempting but violates non-goal 2 and the design
  doc’s own “pull has unbounded cost” reasoning.
  Keep it explicit; make it one command.

Principle 9 ("one primitive… there is no second kind of thing") and “there are no
manifests” are no longer true once UC-2 exists, regardless of this review.
Suggested rewording: *one storage contract (immutable objects, create-only writes) and
three reference disciplines: per-file pointers, committed manifests, store-side
snapshots reached by names.* That matches the lead’s hypothesis 1 and gives round 8 and
this proposal a common sentence.

* * *

## 7. Complexity budget, non-goals, sketches, and open questions

### 7.1 Budget (relative to round 8’s “one mid-size round-7 batch”)

| Piece | New? | Shared with | Rough size |
| --- | --- | --- | --- |
| Tree walk capturing kind/size/hash/symlink/mtime, excludes | new (file mode’s `walkDir` skips symlinks and dotfiles by design) | UC-2, receipts | small |
| Canonical manifest reader/writer + `tree_id` | new | UC-2 `.btree`, receipts | small |
| Deterministic tar.zst writer/reader (node-tar + `node:zlib`) | new dep + code | — | medium |
| `Backend.putIfAbsent`, `Backend.list`, `capabilities` | new, 5 backends | GC in file mode, mirror `status` | medium |
| Snapshot store layout, publish (manifest-last, name-last), restore (swap, verify), local cache | new | — | medium-large |
| `ls`, `status`, `gc`, `fallback` | new | — | medium |
| Pointer `kind: tree` in `.bref` schema + `status` integration | small | file mode | small |
| Config stanza, `doctor` overlap checks, skill text, golden tests | new | — | medium |

Estimate: 1.5–2x mirror mode, with the first two rows paying for themselves twice (UC-2
and receipts). Phasing that keeps each step shippable:

1. **Entry format + tree id** (normative appendix; adopt in receipts).
   Zero risk, highest leverage — the trading repo wants the receipt schema first anyway.
2. **`snap publish/restore/ls`** with a single archive, create-only refs on S3/GCS/
   Azure/local, exists-then-put elsewhere.
3. **`fallback`, `gc`, `status`**.
4. **Pins** (`kind: tree`).
5. (Maybe never) package-grouped packs, range restore, signing, extracted-tree cache.

### 7.2 Explicit non-goals (to write into the design doc)

Bidirectional sync of snapshot paths; mutable names; hooks; per-file remote objects for
snapshots; cross-snapshot pack dedup (v1); CDC; range restore (v1); signatures (v1);
branch-scoped keys; ecosystem-specific pruning/grouping rules; executing commands from
key templates; uid/gid/full-mode fidelity; hardlink fidelity outside the tree.

### 7.3 CLI sketch

I evaluated three surfaces:

- **Reuse `push`/`pull` with path dispatch** (round 8’s non-goal 5): rejected for
  snapshots. `pull node_modules` would silently mean “replace this directory wholesale”,
  `push` would mean “publish under a derived name and refuse if it exists” — opposite
  safety profiles to file mode under the same verb, and no place for `--version`,
  `--fallback`, `ls`, `gc`.
- **Two nouns `cache` and `asset`**: rejected; they are one primitive and the split
  would duplicate every verb.
- **One noun, immutable verbs** (recommended):

```
blobsy snap publish <stanza|path> [--version v2] [--dry-run]   # pack, upload, create name; exit 0 "exists" for caches
blobsy snap restore <stanza|name> [--fallback] [--only <glob>] [--no-verify] [--to <dir>]
blobsy snap status  [stanza]           # hit / miss / local-differs vs published tree_id (offline if cached)
blobsy snap ls      [name-prefix] [--json]
blobsy snap show    <name> [--diff <name>|--diff-local]
blobsy snap pin     <stanza> <name>    # write/update the committed pointer
blobsy snap gc      [--dry-run] [--older-than 30d]
blobsy snap cache prune [--max-size 20G]
```

`publish`/`restore` rather than `push`/`pull` is deliberate: the words say “immutable”.
Mirror mode can keep `push`/`pull` because those really are copies.

### 7.4 Config sketch

```yaml
snapshots:
  target:
    path: target
    key: "cache/target/v1/{os}-{arch}/{hash:rust-toolchain.toml}/{hash:Cargo.lock}"
    exclude: ["**/incremental/**", "**/*.d"]
    fallback: prefix          # newest name under cache/target/v1/{os}-{arch}/{hash:rust-toolchain.toml}/
    retention: 30d
    mtime: now                # or preserve (see Q7)
  llama:
    path: models/llama-3-8b
    name: "assets/llama-3-8b/{version}"
    pin: true                 # writes models/llama-3-8b.bref (kind: tree)
    retention: forever
```

### 7.5 Store-side manifest and name-object sketch

```
# manifest.tsv (zstd on the wire)
#format blobsy-tree/0.1
#tree_id sha256:3c1f…9a
#files 14711   #bytes 171355937   #created_at 2026-10-22T15:11:21Z   #by ci@runner-7
#pack data.tar.zst
# path	kind	size	sha256	mtime_ns	pack	offset	length
.bin/eslint	l:../eslint/bin/eslint.js	0	-	1761145383000000000	-	-	-
.pnpm/zod@4.4.3/node_modules/zod/package.json	f	1420	9f2c…e1	1761145383000000000	data.tar.zst	-	-
scripts/run.sh	x	912	c4d1…77	…	data.tar.zst	-	-
tmp/	d	0	-	…	-	-	-
```

```yaml
# snap/cache/target/v1/linux-x64/ab12…/cd34…/ref.yaml   (write-once, written last)
format: blobsy-snap-ref/0.1
tree_id: sha256:3c1f…9a
created_at: 2026-10-22T15:11:21Z
by: ci@runner-7
provenance: { branch: main, commit: 04a3d1a, run: gh-123456 }
files: 14711
bytes: 171355937
archive: data.tar.zst
archive_bytes: 39895989
archive_sha256: 8e7a…
```

The committed `.btree` (UC-2) is the same first four columns minus the header
aggregates; the round-8 receipt is the header without the rows.

### 7.6 Open questions requiring the owner’s decision

1. **Three disciplines or two?** Accept file / mirror / snapshot as the model (and
   reword principle 9), or fold mirrors into snapshots by giving snapshots a
   path-mirrored “unpacked” layout?
   (I recommend three; the unpacked variant re-creates round 8’s R9/R12 constraints
   inside a primitive that otherwise wants packing and TTL.)
2. **Verbs**: `snap publish/restore` (recommended) vs reuse of `push/pull`.
3. **Target workloads for v1 validation**: `target/` and model/dataset directories
   (recommended), or `node_modules`/`.venv` directly (relocatability problems; the
   package-manager store is the better unit).
4. **Pin format**: extend `.bref` with `kind: tree` (recommended; one pointer concept)
   or a new extension.
5. **Trust**: is “anyone with bucket write access can poison a cache snapshot”
   acceptable for v1 with IAM guidance and write segregation, or must v1 ship
   HMAC/ed25519 signatures on `ref.yaml`?
6. **Conditional-write requirement**: hard-require a probe-verified capable backend for
   `publish`, or allow exists-then-put with a documented race (recommended, surfaced by
   `doctor`)? And for `gs://`/`azure://`: add thin native SDK writes for the ref object
   (two new dependencies) or accept the race there?
7. **mtime policy default** (`now` vs `preserve`) — needs a cargo fingerprint experiment
   before fixing; this decides whether `target/` caching is actually useful.
8. **Layout and GC**: G2 “everything under the name, lifecycle-expired” (recommended; no
   dedup across names, no blobsy GC logic) vs G1 “content-addressed snapshots + name
   refs” (dedup, needs mark-and-sweep `gc`, lifecycle rules unsafe alone).
9. **Tree-id definition**: include `l:`/`d` kinds in the id (recommended) and keep mtime
   out; sha256 vs blake3; this must be pinned once since UC-2, receipts, and snapshots
   all depend on it.
10. **R10 tool caches**: agree to model them as entry assets (create-only per entry)
    rather than an add-only mirror flavor?
11. **Pack strategy**: single archive in v1 (recommended) vs package-grouped packs from
    the start as the research doc suggests.
12. **File-mode fixes surfaced here** (exec bit lost on pull; symlink skip is
    verbose-only; `dist/**` matching by bare name at any depth): fix in file mode now,
    or document as “file mode is for data, snapshots are for trees”?

* * *

## 8. Where I disagree with the lead’s notes and the research doc

- **Lead hypothesis 3** (pure CAS default key template fixes `pqyt`): true for file mode
  but orthogonal here; snapshots sidestep `pqyt` by having a fixed derivable layout.
  Do not couple the two decisions.
- **Lead hypothesis 4** (UC-3 splits into run archives and reproducible caches): agree,
  and go one step further — the second half *is* UC-5, and R10 tool caches belong there
  too, which lets mirror mode stay strictly “copy a directory to a path”.
- **Research §6b packing** (package-boundary packs + offsets in v1): defer (§3.4).
- **Research §6b `{cmd: ...}` key inputs**: reject on threat-model rule 1 (§3.2).
- **Tree-manifest research §6b layout** (`names/<key>.ref` → `snapshots/<tree-id>/`,
  with a lifecycle rule on both): lifecycle alone is unsafe on a shared `snapshots/`
  prefix under live names.
  The object-store research’s P5 ("expiry by lifecycle rule, never by blobsy delete
  logic") is the better v1 stance, and it only works if nothing is shared between names
  — hence layout G2 (§3.4, §3.9). The two research docs pull in different directions
  here; I side with P5 for v1.
- **Research §8 Q2/Q3** (empty dirs, hardlinks optional): empty dirs and symlinks must
  be in the id for snapshots; hardlinks stay out (§3.6).
- **Round 8 non-goal 5** (verb dispatch by path): fine for mirrors, wrong for snapshots
  (§7.3).

* * *

## Appendix A. Experiment log (all under the session scratchpad)

**A.1 Fidelity run** (`scratchpad/exp3/`): `git init`;
`blobsy setup --auto local:../remote`; tree with `pkg/cli.sh` (chmod +x, 250,018 B
random), `pkg/dist/big.bin` (300,000 B), `pkglink -> pkg`, `.bin/cli -> ../pkg/cli.sh`,
`emptydir/`. `blobsy add --verbose tree` → “Skipping symlink: tree/pkglink”, 1 file
tracked (`cli.sh`); `.bin/` and `dist/` not mentioned.
`blobsy push` → key `20261022T151121Z-50cbfd9b075e/tree/pkg/cli.sh.zst`.
`rm tree/pkg/cli.sh; blobsy pull` → `-rw-r--r-- 250018 tree/pkg/cli.sh` (was
`-rwxr-xr-x`). `blobsy add --dry-run tree/pkg/dist/big.bin` → “Would track” (single-file
path skips ignore rules); `blobsy add tree` → still not scanned (`walkDir` matches
`dist/**` against the bare entry name `dist`). `git check-ignore` → not git-ignored.

**A.2 node_modules profile** (`/home/user/blobsy/node_modules`, pnpm): counts via
`find -type f/l/d`, `-perm -u+x`, `-links +1`, `-empty`; sizes via a Node walk summing
`statSync().size` while hashing (171,355,937 B, 14,711 files, 0.991 s).

**A.3 Pack/unpack** (`scratchpad/exp2/`): `tar --format=posix -cf nm.tar node_modules`
(0.52 s, 190,965,760 B); `zlib.createZstdCompress` level 3 (2.76 s, 39,895,989 B);
`createZstdDecompress` (2.31 s) + `tar -xf` (4.82 s total).
Restored tree: 1,550 symlinks, 217 executables, 3,544 files in intra-archive hardlink
groups.

**A.4 Source reads**: `types.ts` `Backend` interface (no `list`, no conditional put);
`paths.ts` `walkDir` (symlink → `onSymlink` only; dot entries skipped; ignore matcher
applied to `relPath`, `entry.name`, and `relPath + '/'`); `transfer.ts` `pushFile` (key
template evaluated at push; `remote_key` written back to `.bref`); `backend-s3.ts`
(`Upload` with no `IfNoneMatch`); `config.ts` default `ignore`;
`@aws-sdk/client-s3@3.995.0` `models_0.d.ts` (`IfNoneMatch` on `PutObjectRequest` and
`CompleteMultipartUploadRequest`); `@aws-sdk/lib-storage@3.1096.0` `dist-cjs/index.js`
(`...this.params` spread into `CompleteMultipartUploadCommand`).

**A.6 Parallel research incorporated**:
`research-2026-10-22-tree-manifests-and-cache-patterns.md` (entry format, cache-key
table, git-merge experiment), `research-2026-10-22-object-store-capabilities-refresh.md`
(aws-cli `--no-overwrite`, rclone GCS/Azure gap, B2, doctor probe, P4/P5, risks), and
`research-2026-10-22-large-file-tools-landscape-refresh.md` (Gat, runs-on/cache, CREEP,
Immutable Releases).
Items taken from them are marked **[R]**; where I re-verified (S3/GCS/Azure/R2 docs, SDK
source, rclone/aws changelogs) they are marked **[V]**.

**A.5 Primary docs fetched 2026-10-22**: AWS “How to prevent object overwrites with
conditional writes”; GCS “Request preconditions”; Azure “Specifying conditional headers
for Blob service operations”; Cloudflare R2 “S3 API extensions”; `actions/cache` README;
Bazel “Remote caching”; mozilla/sccache README; MinIO conditional-write blog and
compatibility page (search-level).
Changelogs in scratchpad: `awscli-changelog.rst` (2.17.34 / 2.22.5 / 2.31.24 entries),
`rclone-changelog.md` (v1.72.0 S3 `If-None-Match`).
