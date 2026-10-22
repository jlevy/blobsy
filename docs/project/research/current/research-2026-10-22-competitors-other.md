# Research: Competitor Source Review — s3lfs, git-lfs-fuse, Xet, Oxen, Lore (Oct 2026)

**Date:** 2026-10-22

**Status:** Reference (input to design; no decisions made here)

**Related:**

- [research-2026-10-22-large-file-tools-landscape-refresh.md](research-2026-10-22-large-file-tools-landscape-refresh.md)
  — landscape and matrix this doc deepens (and in two places corrects)
- [research-2026-10-22-tree-manifests-and-cache-patterns.md](research-2026-10-22-tree-manifests-and-cache-patterns.md)
  — `.btree` / snapshot proposals that several findings below feed into
- [blobsy-design.md](../../design/current/blobsy-design.md) — the `.bref` model
- Gat is covered in a separate review and appears here only for comparison.

**Method.** I read shallow clones of each project’s default branch under `attic/`
(read-only) as of 2026-10-22, plus READMEs, in-repo docs, changelogs, PyPI, HF docs, and
HN threads. I also ran one local git experiment (§3). Paths are relative to each clone,
e.g. `s3lfs/s3lfs/core.py`.

**Evidence key:** **[V]** = verified against source, in-repo docs, or a primary web page
fetched today, or by the local experiment.
**[S]** = secondary (search excerpt, partial thread read).
**[I]** = inferred or a design judgment.

* * *

## 1. Summary

1. **s3lfs is far closer to blobsy than the landscape doc implied, but it has no
   adoption.** It is not “a Python LFS-but-S3 CLI”. It is a git-first, serverless,
   hook-driven tool with **one committed YAML manifest** (path → sha256), shardable per
   top-level directory, a **key-wise merge driver**, sparse-checkout integration, a
   documented **path-aware CAS layout** (`<prefix>/assets/<sha256>/<path>`), adaptive
   compression, a `doctor`, a `migrate-from-lfs`, and **TLA+ models of its data-loss
   invariants** [V]. It is also one author, 0 GitHub stars, and its ten PyPI releases
   came out within about 21 hours on 2026-08-09/10 [V]. It is the best *design*
   reference in this set for UC-2/UC-4, not a market threat [I].
2. **Per-file `.gitignore` entries scale quadratically, and blobsy uses them.** s3lfs
   measured `git status` going from 17 ms to 70 s at 100k per-file entries.
   I reproduced the effect locally: 5k entries took 0.13 s, 20k took 1.2 s, and 50k took
   10.9 s, versus ≤0.03 s for one wildcard [V, §3]. Blobsy’s `gitignore.ts` writes one
   line per tracked file into each directory’s blobsy block [V], so any directory with
   tens of thousands of tracked files will hit this.
   This is the most actionable finding here (idea #1).
3. **git-lfs-fuse is not an S3 play.** It is a ~1.5k-line Go FUSE overlay that lazily
   reads files from *any* Git LFS server in 2 MiB HTTP-Range pages [V]. It has been
   dormant since 2025-06 [V]. Its only lesson for blobsy is that lazy and partial reads
   of big blobs are wanted.
4. **git-xet is an LFS custom transfer agent that only uploads, and it is HF-only.** The
   Hub’s LFS Batch response selects agent `xet` and supplies `X-Xet-Cas-Url` and a token
   in headers. Downloads fall back to plain LFS HTTP [V]. Using non-HF storage would need
   an LFS server that mints Xet tokens and a CAS server.
   The only open CAS server is a disk-backed dev/test “local server” [V]. **PAIN-5:
   no.**
5. **Xet’s value to blobsy is its separation, not its formats.** A file’s *identity*
   (hash) is separate from its *physical location* (xorb + chunk range, recorded in a
   remote-only shard that is uploaded last) [V]. The tree-manifests doc already proposes
   this split for UC-3 snapshots.
   Xet also has a TypeScript download implementation (huggingface.js) and WASM chunker
   bindings [V], if blobsy ever wants CDC.
6. **Oxen solves PAIN-2 at scale with a sharded Merkle tree, outside git.** Each
   directory is split into “vnodes” of about 10k entries, bucketed by `xxh3(path) %
   n` [V]. Merges are file-level three-way merges that skip subtrees whose hashes are
   shared [V]. But vnode hashes include a **random UUID** when entries change [V], so
   tree hashes are not content-deterministic.
   The file hash is non-cryptographic xxh3-128 [V]. The server stores on local disk or
   S3 only [V]. Not git-compatible.
7. **Lore is a well-documented reference design, not a competitor for git users.** Its
   3k-line system-design doc covers the ideas blobsy should borrow: hash of raw bytes
   with compression orthogonal to identity; “write immutable fragments, then one CAS on
   a mutable pointer” as the only commit point; typed **obliteration tombstones**;
   fixed-size vs CDC chunking trade-offs; and causal locks for unmergeable files [V]. It
   has no git bridge, importer, or interop [V: absent].
8. **On LFS compatibility:** offer `blobsy import-lfs` (an LFS oid *is* the sha256 of
   the raw bytes, which is blobsy’s `hash`), but do **not** offer an LFS-pointer-format
   mode. That mode would bring back filters, server negotiation, and GitHub billing
   semantics, which are the things PAIN-4 rejects [I, §4.1].
9. **Positioning:** with Gat and s3lfs, “serverless git-first externalization” is now a
   crowded *design space* with thin *adoption*. Blobsy’s distinct ground is per-file
   PR-visible refs, browsable path-shaped layout, any backend including command
   templates, and agent-first UX. To close the gap it needs a **mergeable collection
   manifest** (UC-2) and **no-git caches** (UC-3) [I].

* * *

## 2. Per-tool findings

### 2.1 s3lfs (kmatzen/s3lfs) — the closest design to blobsy in this set

**Identity and maturity.** Python ≥3.9, MIT, by Kevin Blackburn-Matzen
[V `pyproject.toml`]. `core.py` (4,226 lines) and `cli.py` (2,961) hold about 7.2k
source lines, with about 20k lines of tests [V]. It has 200 commits, **0 stars, 0
forks**, and 1 open issue [V GitHub page]. PyPI history: 0.1.0 on 2025-12-08, then 0.3.0
through 0.6.3 all between 2026-08-09 04:56 and 2026-08-10 01:49 UTC [V PyPI JSON]. The
last commit is “Release 0.6.3 (#144)”, 2026-08-09 [V]. It has no HN presence
[V Algolia]. The burst suggests one intense (possibly agent-assisted) push rather than
steady maintenance [I]. It ships a GitHub Action (`action.yml`) [V].

**Data model [V].** One committed `.s3_manifest.yaml`, or JSON. It holds config
(`bucket_name`, `repo_prefix`, `endpoint_url`) plus `files: {repo/path: sha256}`, so
there is **no size field** [V `core.py:initialize_repo`, `cli.py` tests]. For example:

```yaml
bucket_name: my-bucket
endpoint_url: null
repo_prefix: my-project
files:
  assets/textures/rock.png: 9f2c…e1
  models/v3.safetensors: 07ab…3c
```

`s3lfs shard` moves entries into `.s3lfs_manifest/<top-level-dir>.yaml`, a flat map per
shard with percent-encoded names, and keeps config in the root file.
Shards are read lazily [V `core.py:shard_for`, `ShardedFiles`]. The README reports that
with 200k entries, opening the manifest drops from 1,103 ms to 20 ms.
Each history copy of a touched shard is about 190 KB, versus 18.8 MB for the flat file
[V README, their benchmark].

Hashing: SHA-256 by default, MD5 optional, using mmap, the CLI, or Python as available.
GNU `sha256sum` output is validated after a Windows escaping bug [V CHANGELOG 0.6.1].
The local hash cache records (size, mtime, inode) and applies **git’s racy-clean rule**.
An entry written less than 1 s after the file’s mtime is not trusted on metadata alone,
and the file is re-stat’ed after hashing to detect concurrent edits
[V `core.py:_entry_is_racy`, `_changed_during_hashing`].

**Remote layout [V, README “Storage Format” plus `_asset_base_key`]:**

```text
<repo_prefix>/assets/<sha256>/<path-in-repo>[.gz][.chunkN]
```

Incompressible files (detected by sampling) are stored **raw under their natural name**.
Compressible files get standard gzip (pigz if present).
Files over 5 GB are split into `.chunk0..N` [V `DEFAULT_CHUNK_SIZE`]. The README
documents an “escape hatch” recipe (`aws s3 cp` + `gunzip` + `sha256sum`), and a test
restores files with plain boto3 and the manifest only [V]. Including the path in the key
is deliberate: it makes “untracking one path never deletes another path’s bytes” hold,
at the cost of cross-path dedup [V `specs/README.md`, `NoCollateralDeletion`].

**Git relationship [V README, `cli.py`].** No filters and no FUSE. `track` adds paths to
a marked `.gitignore` block (a **directory becomes one `/dir/` pattern**, not N entries)
and runs `git rm --cached` on anything already committed.
To compensate for the coarse pattern, `status` and pre-commit report untracked files
hiding under tracked directories.
The check is bounded by directory mtime.
`install` adds hooks:

- **pre-commit** uploads modified tracked files and stages the manifest, and blocks
  commits that stage a tracked file into git
- **post-checkout / post-merge / post-rewrite** run `sync --from <old-rev>`, which diffs
  the old and new manifests.
  These hooks are non-blocking.
- **pre-push** runs `verify --revision <ref> --base <remote-ref>` on the entries each
  pushed ref introduces

The **merge driver** (`s3lfs merge-driver %O %A %B %P`) does a three-way, key-wise merge
of manifest maps and a set-union merge of the `.gitignore` block.
It conflicts only when both sides changed the same key to different values
[V `cli.py:_merge_maps`]. On a parse failure it detects `<<<<<<<` and tells the user to
install the driver [V]. Sparse checkout: `git sparse-checkout check-rules` decides which
tracked files materialize [V README]. Retroactive removal: `remove --purge-from-s3` and
`cleanup` (mark-and-sweep over the *current* manifest only) [V]. Bytes were never in
git, so PAIN-3 holds.

**Backends.** S3 and S3-compatible only, via boto3 with `--endpoint-url`: MinIO, R2, B2,
Wasabi [V]. SSE-AES256 is on by default, and `encryption: false` exists for MinIO
[V CHANGELOG 0.6.2]. There is no GCS/Azure native support, no rclone, and no command
backend [V: absent]. No server.

**Transfer [V].** One shared worker pool runs over all chunks of all files
(`min(32, cpu+4)`). Retries use exponential backoff (2-4-8 s, cap 30 s). Downloads
verify the full-file SHA-256 against the manifest.
Raw uploads stream from the source file with a before/after stat snapshot to refuse torn
uploads, instead of copying to a temp file first [V `_prepare_file_for_upload`]. The
README’s real-S3 comparison: about 1.4× slower than s5cmd on incompressible data and
about 2× faster on compressible data [V README, their benchmark]. Paginated listing is
strict, and a truncated listing is an error, never a short file [V `_list_objects`].

**Atomicity and safety [V].** Manifest writes go to a uniquely named temp file and are
then renamed. A lock file serializes local writers.
An **in-flight claim registry** (`.s3lfs_temp/.s3lfs_inflight.yaml`, 24 h TTL) stops
`cleanup` from collecting objects that a concurrent `track` is about to reference.
**`_recoverable()`**: `sync` deletes or overwrites a local file only if its bytes are
*fetchable from S3*, not merely if they match the recorded hash.
TLC found the counterexample trace (track → commit → remove → cleanup → sync)
[V `cli.py`, `specs/README.md`]. Seven invariants are model-checked in CI, each paired
with a config that must *fail* (`NoDataLoss`, `NoDanglingReference`, `NoLostUpdate`, …)
[V].

**Worth borrowing:** see ideas #1–#7 in §6. **Weaknesses:**

- The manifest has no sizes, so PR diffs can’t flag a 4 GB accident [V].
- Bucket and prefix are committed in the manifest, which couples history to one bucket
  [V].
- S3-only [V].
- Pre-commit *uploads*, which makes commits slow and network-dependent [I].
- Python startup is about 135 ms per hook [V README].
- `cleanup` considers only the current manifest, so older commits’ objects become
  unreachable [V README: “no longer referenced in the current manifest”].
- No adoption [V].

**Fit:**

- PAIN-1 yes. PAIN-2 partial: one manifest is less noisy than N pointers, and shards keep
  per-commit churn small.
  PAIN-3 yes. PAIN-4 yes, and it even migrates.
  PAIN-5 partial (S3 dialects only).
- UC-1 partial (per-path entries live in one shared file).
  UC-2 yes, and UC-4 yes through the driver.
- UC-3 no. UC-5 partial: CAS keys are immutable, but there are no named assets.

### 2.2 git-lfs-fuse (git-lfs-fuse/git-lfs-fuse)

**Identity and maturity.** Go 1.23 [V `go.mod`]. Apache-2.0. About 1.5k non-test lines
(`node.go`, `file.go`, `page.go`, `lru.go`, `lock.go`, `cmd/main.go`) and about 2k test
lines [V]. 59 stars, 185 commits; tags `v0.0.1-alpha.0`–`alpha.6` [V]. The last commit
is 2025-06-18, “docs: update readme” [V], so it has **no 2026 activity**. The Show HN
(2025-04-20) got 4 points and 0 comments [V Algolia].

**What it is [V source].** `git-lfs-fuse mount <url> [dir]`:

1. Runs `git clone` with `GIT_LFS_SKIP_SMUDGE=1` into a hidden sibling `.<name>`, and
   installs LFS filters with `SkipSmudge` [V `node.go:CloneMount`].
2. Mounts a go-fuse loopback filesystem at `<name>` over it.
3. When a file opened through the mount decodes as an LFS pointer, it is served as a
   virtual file of `ptr.Size` bytes.
   Reads fetch **2 MiB pages** (`pagesize`) using the LFS Batch API download action plus
   HTTP `Range` and prefetch 5 pages ahead.
   Pages are cached under `.git/fuse/<oid>/shared/<n>`, with per-inode copy-on-write
   pages for writes [V `file.go`, `page.go`].
4. It checks `.git/lfs/objects` first.
   An LRU evicts pages above `--max-pages` (default 5120, i.e. 10 GiB) [V].
5. `fixGitIndex` rewrites index entry sizes from pointer size to real size, then sleeps
   1 s to dodge git’s racy-timestamp check, so `git status` stays clean [V `node.go`].
6. It retries HTTP 429 using `Retry-After` [V].

**Relationship to blobsy’s niche.** It is **not** “LFS but S3”. It requires an existing
LFS server (GitHub, HF, or self-hosted) whose download hrefs support Range [V, I]. It
competes with `git lfs pull --include` and HF’s `hf-mount`-style tools, not with blobsy.
Backends, transfer batching, merges, and removal are all inherited from LFS. Weaknesses:
FUSE fragility (the README tells users to `fusermount3 -u`), Linux/macFUSE only, and a
single-maintainer alpha [V README].

**Lesson [I]:** lazy, partial reads of large externalized blobs are a recurring want.
Blobsy talks to object stores directly, so a range read needs no batch API.
`blobsy cat <path> --range` or a read-only mount could come later, built on the same
`.bref` + `remote_key`.

**Fit:** PAIN-1/3/4/5 inherit LFS (no / no / no / no).
UC-1 yes (LFS pointers); UC-2/3/5 no; UC-4 as LFS.

### 2.3 Hugging Face xet-core (hf-xet, git-xet)

**Identity and maturity.** Rust, Apache-2.0, about 103k lines of `.rs` in the repo [V].
Workspace version 1.7.0, `git_xet` 0.2.1 [V `Cargo.toml`]. 614 stars, 108 forks, 643
commits [V GitHub page]. Tags include `v1.7.0`, `v1.8.0-dev0`, and
`git-xet-v0.1.0`–`v0.2.1` [V]. hf-xet 1.7.0 shipped 2026-10-06 (per the landscape doc).
The latest commit is from 2026-10-22 [V]. Very active and corporate-backed.

**git integration [V `git_xet/src`].** git-xet registers as a **Git LFS custom transfer
agent** (`lfs.customtransfer.xet`, program `git-xet`)
[V `constants.rs`, `app/install.rs`]. On push, git-lfs sends its agent list in the Batch
request. The Hub answers “xet” and returns `X-Xet-Cas-Url`, `X-Xet-Access-Token`, and
`X-Xet-Token-Expiration` in the action headers [V `app/xet_agent.rs`]. Notable details:

- `init_download` returns *not supported*, so downloads use standard LFS HTTP served by
  the Hub’s LFS bridge [V].
- The LFS custom-transfer protocol is sequential: no batching across files, and SIGKILL
  30 s after terminate.
  git-xet therefore **finalizes (uploads the shard) after every file** rather than
  batching [V comment in `upload_one`].
- A non-HTTP remote with a custom port needs `HF_ENDPOINT` [V].

What lives in git is ordinary LFS pointers (`oid sha256:…`, `size`). The Xet file hash
is a separate Merkle hash, and the shard’s `FileMetadataExt` maps it to the SHA-256
[V `metadata_shard/file_structs.rs`].

**Data model [V `xet_core_structures`].**

- **Chunking:** gearhash CDC with a 64 KiB target, min 8 KiB (target/8), and max 128 KiB
  (target×2) [V `xorb_object/constants.rs`].
- **Hashing:** chunk hashes are keyed BLAKE3 (`DATA_KEY`). Xorb and file hashes are
  Merkle aggregates over (chunk hash, size), and the file hash is salted
  [V `merklehash/`].
- **Xorbs** are up to 64 MiB and up to 8192 chunks, with per-chunk compression [V].
- **Shards** are binary files with a 32-byte magic tag (“HFRepoMetaData…”). Sections:
  file info, where each file hash maps to segments `(xorb_hash, chunk_index_start..end,
  unpacked bytes)` plus per-segment verification hashes and the optional SHA-256; xorb
  info (chunk hashes and offsets); and lookup tables.
  Chunk hashes in published shards can be **HMAC-keyed**, so global dedup queries don’t
  leak which chunks exist [V `shard_format.rs`].
- **CAS API** (OpenAPI in `openapi/cas.openapi.yaml`): `GET /v1/reconstructions/{file}`,
  `GET /v1/chunks/{prefix}/{hash}` (global dedup), `POST /v1/xorbs/…`, `POST
  /v1/shards` [V].

Upload order is xorbs, then the shard.
The shard is the commit point that makes the files exist
[V upload flow; I that this mirrors “manifest last”]. Local cache: a chunk cache (off by
default in hf_xet) and a shard cache (16 GB default, which dedups against roughly 1000×
its size) [V HF docs].

**Non-HF storage?** Not through git-xet.
It needs an LFS server that negotiates `xet` and mints CAS tokens, plus a CAS server.
xet-core ships `local_cas_server`, a disk-backed dev/test server (`xorbs/`, `shards/`, a
redb dedup index) that speaks the same REST API
[V `xet_client/src/cas_client/simulation/local_server/main.rs`]. No production or
S3-backed CAS server is open source [I: none in repo or docs]. **PAIN-5: no**, unless
you write and operate a CAS service.

**For blobsy UC-2/UC-3 [I].**

- *Don’t adopt the formats.* They are binary, HF-specific, and opaque in storage, which
  breaks blobsy principle 6 (browsable).
  CDC at 64 KiB means hundreds of thousands of chunks per large file and a dedup index.
  That pays off for edited multi-GB files, not for UC-2 collections of mostly-immutable
  files or UC-3 trees of small files.

- *Do adopt the shape:*
  1. identity = hash of raw bytes;
  2. a remote-only index maps each file to (pack, range) with verification hashes;
  3. packs of about 16–64 MiB;
  4. the index is uploaded last as the commit point.

  That is exactly the §6b snapshot design in the tree-manifests doc, so Xet validates
  it.

- *Lesson from git-xet’s comment:* a sequential, per-file transfer protocol (LFS custom
  agents) forbids batching.
  Blobsy’s own batch-oriented `push` is an advantage worth keeping.

- If CDC is ever wanted, huggingface.js has a TypeScript Xet download path
  (`XetBlob.ts`), and `wasm/hf_xet_thin_wasm` exports `Chunker`, `compute_file_hash`,
  and related functions to JS [V HF spec page, `wasm/`].

**Fit:** PAIN-1 yes; PAIN-2 no (one pointer per file); PAIN-3 partial (HF can delete and
squash); PAIN-4 partial (it *is* LFS, minus GitHub billing); PAIN-5 no.
UC-1 yes (on HF); UC-2/3 no (Storage Buckets cover UC-3 outside git); UC-4 yes (LFS
pointers merge as text); UC-5 partial.

### 2.4 Oxen (oxen-ai/Oxen)

**Identity and maturity.** Rust (about 153k lines across `crates/`) plus a PyO3 Python
package. Apache-2.0 [V]. Workspace version 0.64.0 [V `Cargo.toml`]. Tags run
`v0.58.1`…`v0.64.0` [V]. 1.2k stars, 6,968 commits [V GitHub page]. The last commit
(2026-10-21) is an “S3 Perf” series [V]. Releases come several times a month (landscape
doc). Commercial hub at oxen.ai plus a self-hostable `oxen-server`.

**Data model [V `crates/liboxen/src`].** It is a separate git-like VCS with a `.oxen/`
directory. Note that `FileStructure.md` describes a pre-Merkle layout and is stale
[I from code]. The current commit tree is a Merkle tree of typed nodes (Commit, Dir,
VNode, File, FileChunk), stored MessagePack-serialized in LMDB-backed node stores under
`.oxen/tree/nodes` [V `model/merkle_tree/node/*`, `core/db/merkle_node/`].

- **FileNode** holds `hash`, `combined_hash` (content + metadata), `num_bytes`, mtime,
  `data_type`, `mime_type`, `extension`, optional typed `metadata`, and
  `last_commit_id`.
- **DirNode** carries aggregates: `num_entries`, `num_bytes`, `data_type_counts/sizes`,
  `last_commit_id`.
- **VNodes:** a directory’s children are split into `ceil(n / vnode_size)` buckets
  (`DEFAULT_VNODE_SIZE = 10_000`), assigned by `xxh3_128(path) % num_vnodes` and sorted
  by path within each bucket
  [V `repositories/commits/commit_writer.rs:726-790`, `constants.rs:222`]. A commit that
  touches one file rewrites one vnode of about 10k entries per ancestor directory, not
  the whole directory listing.
- **Caveat:** if a vnode has changed entries, its hash also mixes in a fresh
  `Uuid::new_v4()` [V `commit_writer.rs`]. Identical trees committed twice therefore get
  different vnode IDs, so tree identity is not content-derived [I consequence].
- **Hash:** xxh3-128 (non-cryptographic) for files and nodes
  [V `util/hasher.rs`, `merkle_hash.rs`].
- **Version store:** `<prefix>/<hash>/data`, with large files as
  `<hash>/chunks/<offset>` plus derived files (thumbnails, etc.)
  beside them [V `storage/s3.rs`]. That is CAS-by-file, not chunk-level dedup.

**Merge [V `core/v_latest/merge.rs`].** It finds the LCA, then compares file nodes
across LCA, base, and merge.
Shared dir and vnode hashes are recorded so unchanged subtrees are skipped entirely.
Conflicts arise when both sides changed the same path differently.
A server-side three-way merge creates merge commits without a working tree (this backs
web merge requests).
Conflicts are tracked in a conflict DB, with `oxen
merge --abort`-style recovery [V]. This is the design blobsy’s `.btree` merge driver
mimics at the file-text level, but Oxen merges in Oxen, not git, so UC-4 fails.

**Backends [V `SelfHosting.md`, `storage/`].** The server config takes `backends =
["local", "s3"]`, a single `s3_bucket`, and `s3_region`. Repos live at
`repo/{repo_uuid}/` in the bucket, so they survive renames.
The docs recommend a lifecycle rule to abort incomplete multipart uploads.
There is no GCS or Azure backend.
`oxen-server` is required for collaboration and does not run on Windows.

**Transfer [V].** Small files upload as gzip-tar multipart batches
(`multipart_batch_upload_with_retry`), with `MAX_CONCURRENT_UPLOADS = 30` and
`MAX_CONCURRENT_VERSION_PROBES = 32` existence probes (`find_missing_versions`). Large
files use chunked multipart.
Its benchmark (vendor-run) claims 202k CelebA images synced in under 6 min, versus 38
min for `aws s3 cp` and over 4 h for GitHub LFS [V `Performance.md`; numbers unaudited].
A “remote mode” (262 references in liboxen) works against server workspaces without a
full local copy [V].

**Borrow [I]:** existence probes in bulk before upload, which blobsy should do too;
tar-batching of small files (the same idea as snapshot packs); path-hash bucketing as an
*alternative* shard key.
Blobsy should prefer path-prefix shards, because they produce readable PR diffs.
**Avoid:** non-deterministic node IDs and a non-cryptographic content hash.

**Fit:** solves PAIN-1/2/4 by leaving git; PAIN-3 unclear for Oxen-hosted data (prune
exists, but history semantics are untested here); PAIN-5 partial (local or S3, server
side). UC-1/2 partial (inside Oxen); UC-3 no; UC-4 no; UC-5 partial.

### 2.5 Epic Games Lore

**Identity and maturity.** Rust, MIT, ©2026 Epic.
About 567k lines of `.rs` excluding `vendor/` [V], spread over ~20 crates
(`lore-storage`, `lore-revision`, `lore-server`, `lore-transport`, `lore-aws`,
`lore-hashicorp`, the latter a Consul client) [V]. 9.0k stars, 464 forks, 853 commits,
83 open issues, 36 open PRs [V GitHub page]. Releases: v0.8.4 Jun 25, v0.8.5 Jul 15,
v0.8.6 Jul 29, v0.9.0 Aug 28, v0.10.0 Sep 17, v0.10.1 Oct 5, v0.11.0 Oct 21 — **one
every 2–3 weeks** [V `docs/release-notes.md`]. The last commit is from 2026-10-22 [V].
It has a public LEP process (11 proposals) [V `docs/proposals/`]. HN launch thread,
2026-06-17: 1,276 points, 680 comments [V Algolia]. Themes from a partial read: LFS
dislike, the need for artist locks, and skepticism about tooling ecosystems.
Git interop was barely discussed [S]. The UEFN build uses a proprietary compression
format that the OSS build can’t read yet [V README].

**Architecture [V `docs/explanation/system-design.md`].** Lore is a centralized
(server-of-record), API-first VCS (C API plus JS/Py/C#/Go SDKs; QUIC + gRPC) built on
two stores:

- **Immutable store:** BLAKE3-addressed fragments of at most 256 KiB, with addresses of
  the form (hash, 16-byte *context*). The context is a stable per-file ID that survives
  renames.
  - Local storage uses packfiles with mmappable indexes.
    The wire format is one fragment per message (independent, parallel, resumable)
    [§7.6].
  - Backends: local packfiles, S3 (one object per fragment), and replica wrappers
    [§20.1].
- **Mutable store:** `load/store/cas/list` (local files or DynamoDB).
  - **The only serialization point is a CAS on a key.** A push writes all fragments,
    then CASes the branch pointer, so an interrupted push is invisible [§9.4].

Other design points:

- **Chunking:** FastCDC (64 KiB average, 32 KiB min, 256 KiB max) *or* fixed-size,
  chosen per content type by the application.
  Lore states the trade-off explicitly: CDC with boundary reuse gives better dedup but
  **non-canonical addresses**, while fixed-size chunking gives canonical addresses
  [§8.3]. Large fragment lists are fragmented recursively.
  The hash covers **uncompressed** bytes, so compression (zstd) is orthogonal to
  identity [§8.6].
- **Locks:** acquire, release, and query on unmergeable files, enforced by rejecting
  pushes. The approved LEP *Successor Locks* adds causal locks: a lock can be acquired
  only on a branch that already contains every prior edit of the file within a “scope”
  [§13.4; `proposals/2026-06-19-…`].
- **Obliteration** removes payloads but keeps addresses, scoped by file-ID context.
  A two-phase flag (`PayloadObliterating` → `PayloadObliterated`) makes readers get a
  *typed* “obliterated” answer instead of a 404 or corrupt bytes.
  Revision hashes stay valid [§19].
- **Verification by source trust:** local reads skip hash checks, and remote fetches
  verify unless `--trust-remote` is set [V release notes v0.11.0].
- **Git:** none. There is no bridge, importer, or interop in the docs, roadmap, or FAQ.
  The FAQ positions Lore *against* git+LFS [V].

**What matters for blobsy (despite no git compatibility) [I]:**

1. *Commit point = one conditional write on a tiny mutable object after all immutable
   bytes are written.* This is the same design as the UC-3/5 snapshot
   `names/…/<key>.ref` with `If-None-Match: *`. Lore runs it in production.
2. *Typed tombstones for removal.* `blobsy purge` could write `<remote_key>.purged`, a
   small JSON object with who, when, and why, so later `pull`s of old commits report
   “purged on 2026-…” instead of a bare 404. That is better PAIN-3 UX at negligible
   cost.
3. *Hash raw bytes; keep compression out of identity* (blobsy already does this).
   Lore makes the case for keeping it.
4. *Chunking choice is per content type, and canonical addressing has value.* If blobsy
   ever chunks large files, fixed-size chunks preserve “one content, one address”, which
   blobsy’s determinism principle (#11) needs.
5. *Locks* for unmergeable binaries are a real artist and game-studio need.
   Blobsy could offer **advisory** locks as conditional-create objects
   (`locks/<path>.lock`), but it can’t enforce them without a server.
   This is low priority for blobsy’s audience.

**Fit:** PAIN-1/3/4 yes (by not being git); PAIN-2 yes (sparse, Merkle); PAIN-5 partial
(local or AWS today, with trait-based backends) [V §20]. UC-4 no (merges in Lore);
UC-1/2 partial (inside Lore); UC-3 no; UC-5 partial.

* * *

## 3. Local experiment: per-file `.gitignore` entries are quadratic [V]

**Setup:** git 2.43.0. One directory holds N untracked empty files, and a committed
`.gitignore` lists each file on its own line (blobsy’s block shape).
The comparison `.gitignore` is `*` plus `!.gitignore`. Each run times
`git status --porcelain`, warm.

| N files (and entries) | per-file entries | single wildcard |
| --- | --- | --- |
| 5,000 | 0.130 s | 0.007 s |
| 20,000 | 1.226 s | 0.008 s |
| 50,000 | 10.945 s | 0.027 s |

The growth is roughly N²: 4× the entries costs about 9.4×, and 2.5× costs about 8.9×.
This matches s3lfs’s report of 70 s at 100k entries [V README].

Blobsy’s `packages/*/src/gitignore.ts` appends one entry per tracked file to the
directory’s blobsy block [V]. Per-directory placement bounds the cost to each
directory’s own N, so mixed trees are fine.
A UC-2-sized directory (thousands to tens of thousands of files) is not fine [I].

**Fix options:**

- When `track` is given a directory, write one pattern.
  That can be `<dir>/*` with negations `!*.bref` and `!.gitignore` in a nested
  `.gitignore`, or ignore the directory and keep `.bref` files elsewhere.
- Alternatively, switch to a block of per-extension globs.
- s3lfs pairs the coarse pattern with a check for *hidden untracked files* (bounded by
  directory mtime) so nothing silently escapes both systems [V].

* * *

## 4. Answers to the specific questions

### 4.1 git-lfs-fuse and s3lfs vs blobsy; should blobsy offer LFS-pointer compatibility or `import-lfs`?

- **git-lfs-fuse** is an *LFS consumer* (lazy reads of an existing LFS server), not an
  alternative to LFS. It does not overlap blobsy’s niche [V/I].

- **s3lfs** overlaps the same niche: serverless, git-first, S3, hooks, browsable layout,
  sha256. It differs on four axes [V/I]:

| Axis | s3lfs | blobsy |
| --- | --- | --- |
| What’s in git | one manifest (optionally sharded); no sizes | one `.bref` per file, with size and remote key |
| Upload hook | pre-commit (commit needs network) | pre-push |
| Backends | S3 dialects | S3, GCS/Azure via rclone, local, command templates |
| Language/ecosystem | Python + boto3 | TypeScript/Node |

  s3lfs answers UC-2 (single manifest + merge driver) today.
  Blobsy does not yet.
  Blobsy answers UC-1’s “PR shows per-file metadata” and PAIN-5 better.

- **LFS-pointer-compatible mode: recommend no [I].** Writing `version
  https://git-lfs.github.com/spec/v1` pointers would:
  1. make `git lfs` and forges treat the files as LFS, so GitHub’s “Stored with Git LFS”
     display, quota logic, and smudge filters engage the moment anyone has `git-lfs`
     installed;
  2. invite clean/smudge filters, the main UX complaint;
  3. require `.gitattributes` `filter=lfs`, so on GitHub, pushes from users with LFS
     installed go to GitHub LFS storage, which is PAIN-4 again.

  The only real benefit is reusing LFS tooling, and the custom-transfer-agent ecosystem
  (lfs-dal, lfs-s3) already serves people who want to *stay* on LFS with their own
  bucket.

- **`blobsy import-lfs`: recommend yes, and it is cheap [I].** An LFS oid is the SHA-256
  of the raw content [V LFS spec], which is exactly blobsy’s `hash`. So:
  1. read `.gitattributes` `filter=lfs` patterns (s3lfs’s `_parse_lfs_patterns` is a
     model [V]);
  2. for each pointer, `git lfs fetch` (or the Batch API) the object, or use the
     existing `.git/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`
     [V path used by git-lfs-fuse];
  3. upload it under the blobsy `key_template`;
  4. write a `.bref` with the same hash and size, replace the pointer, add a gitignore
     entry, and remove the `.gitattributes` line.

  This is forward-only and does not rewrite history.
  Also offer `--rewrite-history` guidance that points to `git lfs migrate export`, since
  only history rewriting frees GitHub LFS storage (the GitHub docs require deleting the
  repo [V landscape doc]). s3lfs requires real content in the working tree; blobsy can
  do better by reading LFS’s local store.

### 4.2 xet-core: git integration, non-HF storage, adoptable formats

- **Integration:** an LFS custom transfer agent, upload only; downloads go through
  standard LFS. The agent is selected by the server in the Batch response, and the CAS
  endpoint and token arrive in response headers [V].
- **Non-HF storage:** only by implementing an LFS server that issues Xet headers plus a
  CAS server. The repo’s `local_cas_server` is for testing and development [V]. In
  practice, no [I].
- **Formats for UC-2/UC-3:** see §2.3. Adopt the *architecture*: content identity vs
  pack location, a remote-only reconstruction index uploaded last, per-range
  verification hashes, and 16–64 MiB packs.
  Don’t adopt xorb or shard binaries or 64 KiB CDC [I]. One more transferable idea: the
  shard cache acts as a *local dedup index* (“16 GB dedups against ~16 TB” [V HF docs]).
  Blobsy’s equivalent is a cached remote-existence index keyed by sha256, which avoids
  HEAD storms on large pushes.

### 4.3 Lore: what matters given no git compatibility

Five design patterns carry over (§2.5): CAS-pointer commit, typed tombstones, raw-bytes
identity with orthogonal compression, canonical vs CDC chunking, and advisory locks.
Strategically, Lore validates that game and media teams with huge unmergeable binaries
may leave git entirely.
Blobsy should not chase them.
It should serve teams that stay on git and want the bytes elsewhere [I].

### 4.4 Oxen: Merkle tree at millions of files, merge model

- **Tree:** dir nodes split into about 10k-entry vnodes by path hash, so commit cost
  scales with touched vnodes.
  Dir nodes carry aggregates, which is fine because they are never text-merged [V].
- **Merge:** a file-level three-way merge over the LCA, skipping shared subtree hashes,
  and runnable server-side [V].
- **Implications for blobsy [I]:**
  - A `.btree` sharded by path prefix gives the same “touch one shard” property while
    staying diff-readable in PRs.
  - The tree-manifests doc’s “no aggregates in committed manifests” rule stands: Oxen
    can keep aggregates only because nothing text-merges its nodes.
  - Blobsy’s tree id must stay content-deterministic, unlike Oxen’s UUID-salted vnodes.

* * *

## 5. Comparison matrix

Legend: **Y** = native fit, **P** = partial / by workaround, **N** = no.
Blobsy columns reflect the current design plus the proposed `.btree` and snapshots where
marked.

### 5.1 Fit against pains and use cases

| Tool | PAIN-1 | PAIN-2 | PAIN-3 | PAIN-4 | PAIN-5 | UC-1 | UC-2 | UC-3 | UC-4 | UC-5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s3lfs | Y | P¹ | Y | Y | P² | P | Y | N | Y | P |
| git-lfs-fuse | Y³ | N | N | N | N | Y | N | N | Y | N |
| git-xet / HF Xet | Y | N | P | P⁴ | N | Y | N | N⁵ | Y | P |
| Oxen | Y⁶ | Y⁶ | ? | Y⁶ | P | P | P | N | N | P |
| Epic Lore | Y⁶ | Y⁶ | Y⁷ | Y⁶ | P | P | P | N | N | P |
| Gat (separate review) | Y | P | Y | Y | Y | Y | Y | N | Y | P |
| **blobsy today** | Y | N⁸ | Y | Y | Y | Y | N | N | Y | P |
| **blobsy + `.btree` + snapshots** | Y | P⁸ | Y | Y | Y | Y | Y | Y | Y | Y |

¹ One manifest with lazily read shards; the flat file churns.
² S3 dialects only. ³ Inherits LFS (bytes outside git, but LFS-bound).
⁴ It is LFS, but with HF billing instead of GitHub’s. ⁵ HF Storage Buckets cover UC-3
outside git, HF-only.
⁶ By replacing git. ⁷ Obliteration with typed tombstones.
⁸ One `.bref` per file is the PAIN-2 trade-off.
Per-file `.gitignore` lines add the §3 cost.

### 5.2 Key properties

| Tool | Git-native? | Server needed | Backends | What’s in git | Content hash | Dedup unit | Browsable remote | Merge model | Transfer notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s3lfs | yes (hooks) | no | S3 + compatibles | 1 YAML manifest (+shards) | sha256 | file (per path) | **yes** (`assets/<sha>/<path>`) | key-wise driver | chunk-pool, adaptive gzip, 5 GB parts |
| git-lfs-fuse | yes (LFS) | LFS server | whatever LFS uses | LFS pointers | sha256 | file | n/a | LFS (text) | 2 MiB Range pages, LRU |
| git-xet | yes (LFS agent) | HF Hub + CAS | HF only | LFS pointers | sha256 + Xet Merkle | 64 KiB CDC chunk | no (xorbs) | LFS (text) | xorbs ≤64 MiB; shard per file |
| Oxen | no | oxen-server | local, S3 (server) | n/a | xxh3-128 | file | no | Oxen 3-way, file-level | tar batches, 30 conc. |
| Lore | no | lore-server | local, S3+DynamoDB | n/a | BLAKE3 | ≤256 KiB fragment | no | Lore 3-way + locks | per-fragment QUIC/gRPC |
| blobsy | yes (plain files) | no | S3, rclone, local, command | 1 `.bref`/file | sha256 | file | **yes** (templated) | git text | external CLIs, batch push |

* * *

## 6. Ranked ideas for blobsy to borrow

Ranked by (pain relieved × confidence) ÷ cost [I].

1. **Stop writing per-file `.gitignore` lines for bulk tracks** (s3lfs; §3)
   [V problem, I fix]. Write one directory pattern with `!*.bref` / `!.gitignore`
   negations, or a glob.
   Add `status`/pre-commit detection of *hidden untracked* files under blobsy-ignored
   directories, bounded by directory mtime.
   Add a regression benchmark at 20k and 50k entries.
2. **`_recoverable` guard everywhere bytes leave disk** (s3lfs) [V source]. Before `rm`,
   `pull --force`, a sync prune, or GC-adjacent operations delete or overwrite a local
   payload, require that its bytes are *fetchable remotely* (HEAD on `remote_key`), not
   just that they match the `.bref` hash.
   Put the counterexample trace (track → commit → untrack → gc → sync) in a test.
3. **Mergeable collection manifest with a key-wise driver** (s3lfs, Oxen; serves UC-2
   and UC-4) [V designs]. Ship the tree-manifests doc’s `.btree`:
   - sorted TSV **with sizes** (s3lfs lacks them);
   - path-prefix shards;
   - a merge driver with the same three-way map rule as `cli.py:_merge_maps`, plus
     conflict-marker detection with an actionable hint on parse;
   - no backend coordinates committed in the manifest (s3lfs couples to a bucket).
4. **Pre-push verification over pushed ranges** (s3lfs `verify --revision --base`) [V].
   Beyond uploading the local payloads, check that every `.bref` (and later every
   `.btree` entry) introduced between the remote ref and the pushed ref exists in the
   remote. This catches refs created in another clone or by an agent that never pushed
   blobs.
5. **Documented layout contract plus an escape-hatch test** (s3lfs) [V]. Blobsy already
   supports `{content_sha256}/{repo_path}`. Make “restore with only `aws s3 cp` /
   `rclone` and the `.bref` files” a README recipe and a CI test.
   Consider *content- sampled* compression (s3lfs’s `compression: auto`) alongside
   blobsy’s extension rules, so incompressible data stays raw and directly usable.
6. **Racy-clean rule in the stat cache** (s3lfs, git)
   [V that blobsy’s stat-cache doc has no racy rule]. Store a cache-write timestamp and
   distrust entries where `written_at − mtime < granularity`. Re-stat after hashing to
   catch edits made during the hash.
7. **`doctor` with live, per-operation permission probes** (s3lfs) [V]. Probe list,
   write, read, and delete separately.
   Mirror real upload headers (SSE) so the probe fails the way real uploads would.
   Print the fixing command for each finding.
8. **Typed purge tombstones** (Lore §19) [I adaptation]. `blobsy purge` leaves
   `<remote_key>.purged` (who, when, why), and `pull` reports it distinctly.
   This makes PAIN-3 removal auditable without touching git history.
9. **Manifest-last / CAS-pointer commit for snapshots** (Lore §9.4, Xet shard-last)
   [V designs]. This confirms the tree-manifests §6b plan: content-named packs, then an
   index, then a conditional-create name `.ref`. Add Xet-style **per-range verification
   hashes** in the snapshot index so partial restores can verify without whole-pack
   hashes.
10. **Bulk existence probing and a local “known-remote” index** (Oxen
    `find_missing_versions`, Xet shard cache) [V]. Before a large push, check existence
    for all hashes concurrently (32-way), and cache positive results locally by sha256
    to avoid HEAD storms on re-runs.
11. **Opt-in, non-blocking post-checkout/merge/rewrite sync that diffs manifests between
    revisions** (s3lfs `sync --from`) [V]. Blobsy deferred auto-pull.
    s3lfs’s diff-only, never-clobber, non-blocking variant answers most objections in
    the design doc. Keep it opt-in.
12. **Sparse-checkout integration** via `git sparse-checkout check-rules` (git ≥2.42),
    so `pull` and `status` respect the user’s cone; fall back to “everything” [V s3lfs].
13. **`blobsy import-lfs`** (§4.1) [I]. Cheap, and it addresses PAIN-4 directly as a
    migration path.
14. **Model-check the data-loss invariants** (s3lfs TLA+, with negative configs that
    must fail) [V]. Worth doing once GC or mirror mode exists.
    Until then, property tests over the same traces are enough.
15. **Range reads / lazy access** (git-lfs-fuse) [I]. `blobsy cat --range` first; a
    mount only on demand.
16. **Advisory locks** via conditional-create lock objects (Lore §13.4) [I]. Low
    priority for blobsy’s audience.

Explicitly **not** recommended: LFS-pointer mode; Xet binary formats or 64 KiB CDC;
path-hash vnode shards (they hurt diff readability); non-cryptographic hashes;
nondeterministic tree IDs [I].

* * *

## 7. Positioning implications [I]

1. **Adoption, not ideas, is the open competitive field.** Gat (about 600 stars, Rust,
   single binary) and s3lfs (0 stars, Python) have between them shipped most of what
   blobsy plans for UC-2/UC-4: a single manifest, a key-wise merge driver, hooks, sparse
   support, a doctor, and LFS migration.
   Blobsy can’t win on novelty.
   It wins on *clarity, safety, and fit*:
   - per-file `.bref` files that PR reviewers can read;
   - a browsable remote that is a tested contract;
   - any backend, including command templates and rclone;
   - agent-first `--json` and skill UX.
2. **Lead with “per-file *and* per-collection, your choice per directory.”** s3lfs and
   Gat force a single manifest, and LFS and Xet force per-file pointers.
   Blobsy can offer `.bref` for a few big files and `.btree` for many-file directories,
   with one entry format and one tree id (tree-manifests §6c). That flexibility is the
   differentiator.
3. **Make the no-server, no-filter, plain-files stance explicit against Xet and LFS.**
   git-xet shows that even HF’s best transfer tech is bottlenecked by LFS’s sequential
   agent protocol and vendor lock-in.
4. **UC-3 (no-manifest caches) is uncontested by everyone in this set.** None of s3lfs,
   git-lfs-fuse, Xet (in git), Oxen, Lore, or Gat do it.
   Shipping snapshots with conditional-create names, informed by the CREEP lesson, would
   give blobsy a feature no git-adjacent competitor has.
5. **Don’t compete with Lore or Oxen.** Position them as “if you’re ready to leave git”.
   Blobsy is for teams that aren’t, and `import-lfs` is the on-ramp for teams already on
   LFS.
6. **Correctness is a marketing surface.** s3lfs’s README sells TLA+ invariants and an
   escape-hatch test. Blobsy’s immutable-key invariant, `_recoverable`-style guards, and
   a published layout contract deserve the same visibility.

**Corrections to the landscape doc:**

- s3lfs is a full manifest-based tool with a merge driver, sparse checkout, and
  migration, not just an “LFS but S3 CLI”.
- git-lfs-fuse is LFS-dependent and dormant since mid-2025.
- Oxen’s server backends *are* documented (`SelfHosting.md`: local and S3).
- Lore’s pluggability is trait-based, with shipped local, S3, and DynamoDB
  implementations.

* * *

## 8. Sources

Local source (shallow clones, default branch, read 2026-10-22):

- `attic/s3lfs` @ 4a885db (2026-08-09): `README.md`, `CHANGELOG.md`, `s3lfs/core.py`,
  `s3lfs/cli.py`, `specs/README.md`, `pyproject.toml`
- `attic/git-lfs-fuse` @ 73ee3a5 (2025-06-18): `node.go`, `file.go`, `page.go`,
  `cmd/main.go`, `go.mod`
- `attic/xet-core` @ d26341d (2026-10-22): `git_xet/src/app/xet_agent.rs`,
  `git_xet/src/constants.rs`, `xet_core_structures/src/{xorb_object/constants.rs,
  metadata_shard/{shard_format.rs,file_structs.rs}, merklehash/}`,
  `xet_client/src/cas_client/simulation/local_server/main.rs`,
  `openapi/cas.openapi.yaml`, `wasm/hf_xet_thin_wasm/src`
- `attic/Oxen` @ 7edd0a2 (2026-10-21): `crates/liboxen/src/{constants.rs,
  model/merkle_tree/, repositories/commits/commit_writer.rs, core/v_latest/merge.rs,
  storage/{s3.rs,version_store.rs}, api/client/versions.rs, util/hasher.rs}`,
  `SelfHosting.md`, `Performance.md`, `FileStructure.md`
- `attic/lore` @ 066feb2 (2026-10-22): `README.md`, `docs/explanation/system-design.md`
  (§§7–9, 13.4, 14.5, 19, 20, 25.1), `docs/release-notes.md`, `docs/faq.md`,
  `docs/proposals/2026-06-19-successor-locks-unmergeable-files.md`,
  `docs/proposals/2026-08-03-fragment-metadata-on-the-s3-object.md`
- Blobsy: `packages/*/src/gitignore.ts`, `docs/project/design/current/blobsy-design.md`,
  `blobsy-stat-cache-design.md`
- Remote tags via `git ls-remote --tags` for all five repos (2026-10-22)

Web (fetched 2026-10-22):

- GitHub repo pages (stars, forks, commits): https://github.com/kmatzen/s3lfs,
  https://github.com/git-lfs-fuse/git-lfs-fuse, https://github.com/huggingface/xet-core,
  https://github.com/oxen-ai/Oxen, https://github.com/EpicGames/lore
- PyPI s3lfs release history: https://pypi.org/pypi/s3lfs/json
- HF docs, Using Xet Storage: https://huggingface.co/docs/hub/xet/using-xet-storage
- Xet protocol spec v1.1.0: https://huggingface.co/docs/xet/index
- HN: Lore launch (item 48571081, 1,276 points / 680 comments, partial read);
  git-lfs-fuse Show HN (2025-04-20, 4 points); no s3lfs threads; Oxen launch (2023-02,
  177 points) — via https://hn.algolia.com/api/v1/
- Lore coverage: https://phoronix.com/news/Epic-Games-Lore-VCS,
  https://itsfoss.com/news/lore-launched/
