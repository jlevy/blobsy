# Research: Large-File Tools Landscape Refresh (Oct 2026)

**Last Updated**: 2026-10-22

**Status**: Reference (refresh of the Feb 2026 survey)

**Related**:

- [research-2026-02-19-sync-tools-landscape.md](research-2026-02-19-sync-tools-landscape.md)
  -- the original landscape survey (Parts 1 and 6 are what this doc updates)
- [blobsy-design.md](../../design/current/blobsy-design.md) -- goals and Related Work
- [blobsy-design-review-round8-run-sync-workflows.md](../../design/current/blobsy-design-review-round8-run-sync-workflows.md)
  -- proposed “mirror mode” (attach points + receipts)

**Verification legend.** Every factual claim below is tagged:

- **[V]** verified in this session against a primary source (release notes, changelog,
  official docs, the project’s own README or repo), fetched 2026-10-22
- **[S]** from a secondary source (news write-up, forum, search-engine excerpt of a
  primary page); probably right but not checked against the original
- **[I]** inferred by the author (from absence of evidence, prior knowledge, or
  reasoning); treat as a hypothesis

* * *

## Framework

The project owner frames the problem as five pains and five use cases.
Every tool below is assessed against these.

| ID | Statement |
| --- | --- |
| PAIN-1 | No individual file over a few MB should be in git (permanent perf penalty) |
| PAIN-2 | Very large numbers of files are slow to manage and cause noisy diff churn in PRs |
| PAIN-3 | Tying large files into the git hash tree makes retroactive removal very hard |
| PAIN-4 | Git LFS is disliked (partly PAIN-3, partly GitHub’s LFS cost) |
| PAIN-5 | Backend storage isn’t pluggable (S3, GCS, custom), so it doesn’t fit other tools |
| UC-1 | A few files stored externally, versioned via per-file references in git (PR diffs show metadata) |
| UC-2 | Collections of 100s-1000s of files referenced via a single manifest in git, not one placeholder per file |
| UC-3 | Very large trees (node_modules, cargo `target/`, build caches) synced/cached externally with no manifest in git |
| UC-4 | Standard git merge workflows for externalized files (merges happen in git on metadata) |
| UC-5 | Fixed, immutable assets with immutable names, separate from git workflows (likely underpins UC-3) |

The key structural question for each tool: **what lives in git?** Either (a) the bytes
themselves (native git, partial clone, LOP), (b) one pointer per file (LFS, git-annex,
DVC file outs, blobsy `.bref`), (c) one manifest per collection (Gat `gat.lock`, DVC
directory outs, lakeFS `.lakefs_ref.yaml`, Quilt top hash), or (d) nothing (caches,
buckets, registries, mirror mode).
PAIN-3 is only fully solved by (b)-(d); UC-2 needs (c); UC-3 needs (d).

* * *

## Summary: What Changed Since Feb 2026

1. **Native git is getting better at *not downloading* big blobs, not at *keeping them
   out of history*.** The large-object-promisor (LOP) protocol landed piecewise: the
   `promisor-remote` capability in Git 2.49 (2025-03-14), server-advertised filter +
   token in 2.52 (2025-11-17), `--filter=auto` and `promisor.storeFields` in 2.54
   (2026-04-20), `promisor.acceptFromServerURL` plus `git repack --drop-filtered` (evict
   local promisor blobs over a size limit) in 2.56 (released ~2026-09-27) [V]. No forge
   ships server-side offload of large blobs to S3-style storage yet
   [I; GitLab Gitaly offload epics remain open per S]. LOP’s own design doc admits a
   large blob already pushed “might not be possible to remove … without rewriting
   history” [V]. **PAIN-3 is untouched by native git.** PAIN-1 is mitigated only for
   clone cost.
2. **Git’s object database (ODB) is being made pluggable** (refactors across 2.53-2.56;
   GitHub calls it “not user-visible today”) [V]. A future S3-backed ODB is plausible,
   but blobs would still be in the hash tree [I].
3. **History-editing UX improved, purge did not.** Experimental `git history`
   (`reword`/`split` in 2.54, `fixup` in 2.55, `drop` in 2.56; no merge commits),
   `git replay` with atomic ref updates (2.54) and `--linearize` (2.56) [V]. None of
   these purge blobs; `git filter-repo` (2.47.0) remains the purge tool [V for version].
4. **Git LFS: incremental releases, no architectural change.** 3.7.0 (2025-06-26), 3.7.1
   (2025-10-16, CVE-2025-26625 symlink write-outside-worktree fix), 3.8.0 (2026-08-27,
   zstd-compressed downloads, refs on stdin for fetch) [V].
5. **GitHub LFS billing: metered, with a larger free tier than the Feb doc said.**
   Free/Pro/Free-org: 10 GiB storage + 10 GiB bandwidth per month; Team/Enterprise
   Cloud: 250 GiB each [V]. Overage is $0.07/GiB-month storage and $0.0875/GiB bandwidth
   [S, docs excerpt]. A $0 budget blocks LFS for the rest of the month [V]. **Removing
   LFS objects still requires deleting and recreating the repository** (GitHub docs,
   verbatim) [V]. This is PAIN-3/PAIN-4 in one sentence.
6. **DVC changed hands.** lakeFS (Treeverse) acquired the DVC open-source project from
   Iterative on 2025-11-18 [V]. It promised no license change; repos are moving to
   `treeverse/` [V]. The latest PyPI release is `dvc 3.67.1` (2026-03-31), with nothing
   in the seven months since [V for dates; I that this signals maintenance mode].
7. **Hugging Face added a non-git, non-versioned storage tier.** Storage Buckets
   (2026-03-10): mutable, S3-like, Xet-deduplicated, with
   `hf buckets sync --dry-run/--plan/--apply` [V]. This is HF conceding that
   intermediate artifacts (checkpoints, logs, agent traces) don’t belong in git, which
   is UC-3 in HF’s words [V for the quote’s substance]. The Xet protocol spec is public
   (v1.1.0) and an independent IETF draft exists (draft-denis-xet) [S]. No self-hostable
   CAS server was found [I].
8. **New direct competitor: Gat** (getgat.dev; Show HN 2026-09-08 and 2026-09-27; Rust,
   Apache-2.0, ~628 stars) [V]. It is “LFS without a server” with no clean/smudge
   filters, a single `gat.lock` manifest (path → BLAKE3 content ID, shardable into a
   `gat.lock/` dir), a semantic three-way merge driver for the lock, git hooks that sync
   after checkout/merge/rewrite, and OpenDAL backends (s3, azblob, gcs, oss, file) [V].
   It overlaps heavily with blobsy UC-1/UC-2/UC-4.
9. **New non-git VCS for big binaries: Epic Games’ Lore** (announced 2026-06-17; Rust,
   MIT, ~9k stars, pre-1.0). It is centralized, uses chunked content-addressed storage,
   and has sparse/lazy workspaces [V]. It is not git-compatible
   [V: no interop mentioned], so it is relevant only as a signal that game/media shops
   are leaving git for binaries.
10. **Build-cache security became a design input for UC-3.** CVE-2025-36852 ("CREEP")
    shows that bucket-based remote caches with first-writer-wins keys are poisonable
    from untrusted PR builds.
    Nx deprecated all its bucket cache plugins (S3, GCS, Azure, shared-fs) as of
    2026-05-21, calling the flaw unpatchable by design [S/V]. GitHub Actions cache can
    now exceed 10 GB per repo, pay-as-you-go (2025-11-20) [V].
11. **Immutable-asset primitives matured (UC-5).** GitHub Immutable Releases is GA
    (assets and tag locked after publish) [V for semantics; S for GA]. S3 conditional
    writes (`If-None-Match`, 2024-08-20) were extended to CopyObject (2025-10) [V]. ORAS
    1.3.0 (2025-10) adds backup/restore and full OCI distribution-spec 1.1.1 compliance
    [S].
12. **Sentiment.** Tyler Cipriani’s “The future of large files in Git is Git”
    (2025-08-15) and its HN thread capture the mood: LFS is a “kludge”, it locks you in,
    and migrating to it rewrites history.
    Several commenters want “native S3” backends.
    Many are skeptical that promisors fix old checkouts [S]. Nothing since suggests the
    sentiment has reversed [I].

**Corrections to the Feb 2026 doc:** GitHub Free LFS quota is 10 GiB, not 1 GB [V].
Quilt is actively developed (7.0 2025-08, 8.0 2026-08-04, 8.1 alphas), not “less active”
[V]. The XetHub GitHub integration mentioned in Feb no longer exists, since the XetHub
platform was folded into HF [S]. DVC *does* offer a browsable layout via `version_aware`
cloud-versioned remotes, which the design doc’s “non-browsable” gap statement overlooks
[S]. “Git LFS has no pluggable backends” is too strong: the custom-transfer-agent
ecosystem (lfs-s3, lfs-dal/OpenDAL) gives client-side pluggability [V, Feb doc].

* * *

## Per-Tool Entries

Each entry: status, what’s new, model (what lives in git), merge behavior, removal,
backends and layout, then fit against PAIN/UC.

### Git core: partial clone, LOP, bundle-uri, sparse checkout, replay/history

- **Status:** Git 2.56.0 is current (Homebrew) [V]. Releases: 2.48 (2025-01), 2.49
  (2025-03-14), 2.50 (2025-06-16), 2.51 (2025-08-18), 2.52 (2025-11-17), 2.53
  (2026-02-02), 2.54 (2026-04-20), 2.55 (2026-06-29), 2.56 (~2026-09-27) [V]. Git 3.0 is
  unreleased. It is planned to default to SHA-256 and reftable, use `main` as the default
  branch, and require Rust [V, 2.51/2.52 posts].
- **LOP / promisor timeline [V, RelNotes + GitLab epic 15972]:**
  - 2.49: “Large-object promisor protocol extension has been introduced” (client/server
    agree on a promisor remote; name + URL advertised).
  - 2.52: the server can communicate `partialCloneFilter` and a `token`.
  - 2.54: “auto filter” logic (`--filter=auto`) and `promisor.storeFields`.
  - 2.56: `promisor.acceptFromServerURL`, so a client can accept new promisor remotes by
    URL pattern.
  - 2.56: `git repack -a --filter=blob:limit=1m --drop-filtered` deletes local copies of
    large promisor blobs (manual; `blob:limit` only; refuses index-referenced blobs).
  - Open as of 2026-10-22: lazy fetch through a server serving a partial clone is
    restricted unless `GIT_NO_LAZY_FETCH=0`; the fix (`uploadpack.lazyFetchTrusted`) is
    in `next`, not `master`.
- **LOP design intent [V, technical/large-object-promisors]:** LOPs are promisor remotes
  holding only large blobs, “implemented using object storage, like an Amazon S3 or GCP
  Bucket or MinIO”, via remote helpers.
  They are explicitly *not* a full LFS or git-annex replacement.
  Client-side chunking and dedup are out of scope.
- **Other large-file-adjacent changes [V]:** `git backfill` (2.49; pathspec/revision
  args in 2.54; sparse auto-detect) batch-fetches missing blobs.
  Path-walk packing (2.49+, more filters in 2.55). Geometric repack works in partial
  clones (2.53). `git sparse-checkout clean` (2.52). bundle-uri got only fixes (2.50
  advertises all bundle refs; 2.53 diagnoses URI-less bundles).
- **Model:** bytes in git (a). Merge: native, binary conflicts unresolvable.
  Removal: history rewrite (filter-repo) plus a forge-side GC. Backends: git servers.
  LOP/remote helpers are future.
  Layout: opaque packfiles.
- **Fit:** PAIN-1 partial (clone/checkout cost drops with `blob:limit`; repo size and
  history do not). PAIN-2 no.
  **PAIN-3 no** (LOP doc says so).
  PAIN-4 yes in spirit (this is the “LFS replacement” story).
  PAIN-5 not yet. UC-4 yes but on bytes, not metadata.
  UC-1/2/3/5 no.

### Git LFS (plus GitHub/GitLab hosting)

- **Status:** 3.8.0 (2026-08-27) [V]. 3.7.0 added `fetch --refetch` and JSON output of
  object URLs and HTTP metadata “for external tools to consume” [V]. 3.7.1 fixed
  CVE-2025-26625 [V]. 3.8.0 added zstd-compressed object downloads, reading refs from
  stdin, and a retry-delay cap [V].
- **GitHub:** metered billing has replaced data packs.
  The free tier is 10/10 GiB (Free, Pro, Free-org) and 250/250 GiB (Team, Enterprise
  Cloud) [V]. “To remove Git LFS objects from a repository, delete and recreate the
  repository” [V]. Repo limits are unchanged: warn at 50 MiB, block at 100 MiB [S].
- **GitLab.com:** 10 GiB per project (repo + LFS) on Free, 500 GiB on Premium and
  Ultimate. Namespace-level limits are still described as planned [S].
- **Model:** one pointer per file (b): `version`, `oid sha256:`, `size`. Merge: git
  merges pointers; content conflicts are whole-file.
  Removal: possible in protocol terms (pointer history is tiny), but GitHub requires
  repo deletion. Backends: the hosting provider.
  Pluggable only via custom transfer agents (lfs-s3, lfs-dal on OpenDAL) or self-hosted
  servers (giftless, rudolfs, git-lfs-s3-proxy), all covered in the Feb doc.
  Layout: oid-keyed, not browsable.
- **Fit:** UC-1 yes. UC-4 yes.
  UC-2 no (one pointer per file, so PAIN-2 churn).
  UC-3 no. UC-5 weak. PAIN-3 no on GitHub.
  PAIN-4 *is* this tool.
  PAIN-5 only via third-party shims.

### git-annex

- **Status:** very active, with roughly monthly releases.
  Latest is 10.20261020 (2026-10-20) [V]. 2026 work includes `IMPORTKEY` in the external
  special remote protocol (2026-09), group-based preferred-content syntax,
  git-credential use in more remotes, and export/import-tree fixes [V]. Earlier:
  `p2phttp` HTTP API with clusters and proxies (2024), and compute special remotes /
  `addcomputed`, which store “how to recompute” a file [S].
- **Model:** per-file symlink or pointer (b), plus a `git-annex` branch tracking which
  remote has which key.
  Merge: git merges symlinks; the location log union-merges.
  Removal: `drop`/`unused`/`dropunused` deletes content from remotes, leaving only key
  names in history [I, long-standing behavior]. Backends: the broadest set of any tool
  (S3, rsync, WebDAV, rclone, external protocol).
  Layout: key-hashed by default; **`exporttree=yes` gives a browsable path-mirrored
  remote** [I, long-standing].
- **Fit:** UC-1 yes. UC-4 yes.
  PAIN-3 yes. PAIN-5 yes.
  UC-2 no (per-file). UC-3 no.
  UC-5 partial. The barrier is UX complexity and Windows symlinks, unchanged since Feb.

### DVC (now Treeverse/lakeFS)

- **Status:** acquired by lakeFS 2025-11-18. DVC stays “100% open source under the same
  license”, no breaking changes, repos moving to Treeverse [V, DVC FAQ]. Positioned for
  “smaller datasets” while lakeFS takes enterprise [S]. Latest is `dvc 3.67.1`
  (2026-03-31) and `dvc-s3 3.3.0` (2026-01-16) [V, PyPI]. DataChain stayed with
  Iterative and ships very fast (0.62.0 on 2026-10-21) [V].
- **Model:** per-file `.dvc` (b) for file outs.
  A **directory out is one `.dvc` file holding the tree’s hash + count, with the `.dir`
  manifest stored in cache/remote, not in git** (c, but the manifest is not reviewable
  in git) [I, long-standing behavior]. Merge: DVC ships a git merge driver for directory
  `.dvc` files (append-style) [I]. Removal: `dvc gc` plus deleting from the remote;
  history keeps only hashes.
  Backends: 10+ via plugins.
  Layout: content-addressed by default; `version_aware` remotes keep original paths
  using cloud object versioning (S3/GCS/Azure), with version IDs written into `.dvc`
  files [S]. Lifecycle rules can silently delete those versions [V].
- **Fit:** UC-1 yes. UC-2 partial (single pointer, but the manifest lives outside git so
  PR diffs show only a hash change).
  UC-4 yes or partial.
  PAIN-3 yes. PAIN-5 yes.
  UC-3 no. Risk: ownership change plus release slowdown make it a weaker long-term anchor
  than in Feb [I].

### lakeFS (incl. `lakectl local`, Everest mount)

- **Status:** lakeFS 1.x (GA Oct 2024). Security fix CVE-2026-26187 needs ≥1.77.0 [S].
  The Everest mount (v0.10.0, 2026-06-14) needs lakeFS Cloud or Enterprise [S]. It
  raised a $20M round in July 2025 [S].
- **`lakectl local` is the closest analog to UC-2 in this survey [V, docs].** `init` or
  `clone` links a local dir to a lakeFS path and adds the dir to `.gitignore`. Git
  tracks only a `.lakefs_ref.yaml` holding `src` (lakeFS URI) and `at_head` (lakeFS
  commit ID). The recommended order is to commit to lakeFS first, then commit git.
  The practical ceiling is about 15 GB locally, with one remote per directory.
- **Model:** one pinned ref per directory (c); the manifest lives in lakeFS. Merge:
  inside lakeFS, not git.
  Removal: lakeFS GC/retention.
  Backends: S3/GCS/Azure underneath, but **a lakeFS server is mandatory**. Layout:
  physical layout opaque; logical view via the S3 gateway.
- **Fit:** UC-2 yes (with a server).
  UC-3 partial. UC-4 no (merges happen in lakeFS). PAIN-3 yes.
  PAIN-5 partial. This remains overkill for blobsy’s audience, but the ref-file pattern
  validates Round 8’s “receipt” idea.

### Hugging Face Hub: Xet storage, git-xet, Storage Buckets

- **Status:** Xet backs the Hub, with LFS-compatible pointers plus a “Xet backed hash”
  [V]. `hf_xet` ships inside `huggingface_hub` ≥0.32 (now 2.x; hf-xet 1.7.0 on
  2026-10-06) [V]. `git-xet` 0.2.1 is “a Git LFS plugin that uploads and downloads using
  the Xet protocol”, requires git + git-lfs, and is HF-only [V]. Chunking: about 64 KiB
  CDC chunks (8-128 KiB) packed into ≤64 MiB xorbs [S]. The spec is public and an IETF
  individual draft exists (draft-denis-xet-04, 2026-06) [S]. XetHub as a standalone
  product is gone [S].
- **Storage Buckets (2026-03-10) [V]:** “a non-versioned storage container on the Hub”.
  It is mutable and S3-like (but not S3-API-compatible), addressed by
  `hf://buckets/...`, Xet-deduplicated, and billed on deduplicated storage for
  Enterprise. Commands: `hf buckets create/sync/list/cp/remove`, where **`sync` supports
  `--dry-run`, `--plan <file>`, `--apply <file>`**. “The working layer and the
  publishing layer stay separate.”
  Common Crawl mirrors its April 2026 crawl in a bucket [S].
- **Model:** per-file LFS pointers (b) for repos; nothing in git (d) for buckets.
  Removal: HF supports deleting LFS files and squashing history [I]. Backends: HF only.
  Layout: Hub UI browsable; storage opaque (chunked).
- **Fit:** UC-1 yes (on HF). UC-3 yes (buckets).
  UC-5 partial. **PAIN-5 no** (single vendor).
  Lesson: sub-file dedup matters at TB scale, and HF chose to split “versioned publish”
  from “mutable working storage”.
  That is the same split Round 8 makes between file mode and mirror mode.

### Oxen.ai

- **Status:** active. The Rust core + `oxenai` Python package release several times a
  month (0.64.0, 2026-10-20) [V]. Apache-2.0, ~1.2k stars [V].
- **Model:** a separate git-like VCS (not git-compatible) with Merkle trees and
  self-hostable `oxen-server`. It scales to millions of files and supports `oxen merge`
  and web merge requests [V]. Storage backends for the server are not documented on the
  README [V: absent]. Layout: opaque [I].
- **Fit:** solves PAIN-1/2/4 by leaving git.
  UC-4 fails because merges happen in Oxen, not git.
  PAIN-5 unclear. Not an interop target for a git-first tool [I].

### Quilt (quilt3)

- **Status:** active, correcting Feb.
  7.0.0 (2025-08-25) stops copying same-bucket files on push by default.
  7.2.0 (2026-01-28) verifies `crc64nvme` hashes.
  8.0.0 (2026-08-04) requires Python ≥3.10. 8.1.0a3 (2026-10-15) adds `quilt+s3://` URIs
  and top-hash verification on browse/install [V, CHANGELOG].
- **Model:** package = immutable manifest (logical key → physical S3 key + hash),
  identified by a top hash.
  Git integration is not native: you can commit a top hash or URI (c, by convention)
  [I]. Merge: none; parent-revision conflict detection on push [V]. Removal: delete
  package revisions and objects in S3. Backends: S3 only.
  Layout: physical keys stay path-shaped and browsable [I].
- **Fit:** UC-2 partial (manifest in S3, pin in git).
  UC-5 yes (top-hash-pinned immutable packages).
  PAIN-5 no. Ideas to borrow: verify the manifest top hash on every read, and use
  S3-native full-object checksums (CRC64NVME) for remote verification without
  downloading.

### ORAS / OCI artifacts

- **Status:** ORAS CLI 1.3.0 (2025-10; CNCF blog) adds experimental `oras backup` /
  `restore`, recursive referrers, `oras manifest index`, and full distribution-spec
  1.1.1 compliance [S]. 1.3.5 is current (Homebrew) [V].
- **Model:** digest-addressed manifests and blobs in any OCI registry, with mutable tags
  (d, or a digest pinned in git).
  Removal: registry GC. Layout: opaque.
- **Fit:** UC-5 strong (immutable digests, universal registries).
  UC-3 partial (buildx caches, CI artifacts).
  UC-1/2/4 awkward. Interop: a blobsy command backend could push/pull through `oras` [I].

### DataChain (Iterative)

- **Status:** very active (0.62.0, 2026-10-21) [V]. It stayed with Iterative after the
  DVC sale [S].
- **Model:** Python “AI-data warehouse” that versions datasets *by reference* to objects
  in S3/GCS/Azure/local without copying.
  Metadata lives in its own database, not git [S].
- **Fit:** UC-2-like for ML pipelines, but the manifest is a DB table, not a git file.
  Not a git workflow tool.
  Interesting confirmation that “reference in place, don’t copy” is a sought feature, as
  with Quilt 7.0 [I].

### Dolt

- **Status:** Dolt 2.5.1 (Homebrew) [V]. A version-controlled SQL database [S].
- **Fit:** tabular data only.
  Solves “diffable data in a VCS” for tables, not files.
  Out of scope except as a reminder that row-level diff beats blob diff for structured
  data [I].

### Pachyderm (HPE)

- **Status:** acquired by HPE (Jan 2023). No 2025-2026 releases or EOL notice found; the
  repo shows no visible releases [S/I]. Treat it as enterprise-only or dormant for
  open-source purposes [I].
- **Fit:** pipeline-centric data versioning with its own server.
  Not relevant to blobsy’s audience.

### Jujutsu (jj) and Sapling

- **jj:** 0.46.0 (2026-10-07) [V]. The git-compatibility doc says verbatim: “Git LFS:
  No”, “.gitattributes: No”, “Partial clones: No”, while sparse checkouts are native via
  `jj sparse` [V]. Issue #80 “Add support for Git LFS” is still open; 2026
  cross-referenced commits ("git-lfs: add ability to ignore files based on git
  attributes") hint at partial work [V]. jj’s own guardrail is
  `snapshot.max-new-file-size`: large new files aren’t auto-snapshotted unless
  `jj file track --include-ignored` (0.35.0) [V].
- **Sapling:** 0.2.20260929 [V, Homebrew]. Large-file or LFS behavior in git mode was
  not verified [I: unknown].
- **Fit:** jj users with LFS repos are second-class, **which favors tools like blobsy
  that need no clean/smudge filters and no `.gitattributes`.** A `.bref` is a plain text
  file and the payload is a gitignored file, so jj and any git porcelain handle it
  unchanged [I, but follows from the design].

### Epic Games Lore (new, 2026)

- **Status:** announced 2026-06-17 (State of Unreal).
  Rust, MIT, pre-1.0, ~9k stars [V]. It is centralized ("server-of-record"), uses
  content-addressed Merkle trees with fragment-level dedup, has sparse/lazy workspaces,
  and ships SDKs in JS, Python, C#, Go, and C/C++. The repo contains `lore-aws` and
  `lore-hashicorp` dirs [V]. No git bridge is described [V: absent].
- **Fit:** solves PAIN-1/3/4 by not being git.
  Fails UC-4. Relevant as competition for the “game/media repo” audience, not for
  blobsy’s git-first one.

### Gat (new, 2026): the closest competitor

- **Status:** public since ~Sept 2026. Rust (MSRV 1.91), Apache-2.0, ~628 stars, 47
  commits on main, no tagged release visible on GitHub (install script fetches releases)
  [V]. It ships an MCP server for its docs [V].
- **Model [V, docs]:** `gat.yaml` (config) and `gat.lock` (manifest) are committed.
  Each lock entry is “a repository-relative path and a BLAKE3 content ID”, and large
  repos can “shard the lock into a `gat.lock/` directory”.
  There are no clean/smudge filters; `gat sync` reconciles the working tree to the lock,
  and `gat init` installs hooks that sync after checkout, merge, and rewrite (manual
  `gat sync` after `reset --hard`). It keeps a local content-addressed cache in
  `.gat/objects/` and placement state in `.gat/state/`.
- **Merge [V]:** a semantic merge driver keyed by path + content ID handles independent
  paths, identical additions, and one-sided changes automatically.
  Same-path edits and edit-vs-delete conflict, and the lock is left without markers.
  It explicitly rejects `merge=union`.
- **Backends [V]:** OpenDAL 0.58.2 with `s3://`, `azblob://`, `gcs://`, `oss://`, and
  `file://`. No custom-command backend.
  **Layout:** not documented.
  Content-ID keyed is likely [I], so probably not browsable.
- **Removal:** not documented [V: absent]. Bytes are outside git, so deleting remote
  objects should suffice [I].
- **Fit:** UC-1 yes (per-path entries in one file).
  UC-2 yes (that is its native shape).
  UC-4 yes (best-in-class merge driver).
  PAIN-3/4/5 yes. UC-3 no.
  UC-5 partial. **Compared with blobsy** [I]: Gat lacks per-file pointer files (one lock
  file churns in every PR), path-shaped browsable remote keys, custom-command backends,
  compression control, receipts/mirror mode, and an agent-first `--json` / skill
  surface. Blobsy lacks Gat’s single-binary distribution, OpenDAL breadth, and its merge
  driver for a collection manifest.

### git-lfs-fuse (2025) and other small entrants

- **git-lfs-fuse** (Show HN 2025-04-20; Apache-2.0, ~59 stars): FUSE-mounts LFS repos
  and fetches 2 MiB pages on demand [V]. It shows demand for lazy hydration of big
  externalized files.
- **s3lfs** (kmatzen): a Python “like Git LFS but S3” CLI [S]. **GitDelivr** (2026-03):
  a CDN for git clones on Cloudflare Workers/R2 [S].
- No other credible 2025-2026 “LFS replacement” with traction was found beyond Gat and
  Lore [I: based on HN Show HN search since 2025-02 and web search].

### GitHub platform features relevant to UC-3 / UC-5

- **Immutable Releases:** “assets and associated Git tag cannot be changed after
  publication”. Tags cannot be reused even after deletion.
  Releases carry a cryptographic attestation.
  Immutability is all-or-nothing per repo [V for semantics; S that GA was late 2025].
- **Actions cache > 10 GB** (2025-11-20): pay-as-you-go above the free 10 GB at
  $0.07/GiB-month, LRU eviction, 7-day default retention, up to 10 TB per repo [V/S].
- **Releases assets** are still up to 2 GiB per file [I, unchanged].
- **Fit:** UC-5 yes for release-shaped assets.
  UC-3 partial (Actions-scoped cache only).
  PAIN-5 no.

### Build and dependency caches (the real UC-3 incumbents)

- **sccache** stores compiler outputs in S3, R2, GCS, Azure, GHA cache, WebDAV, Redis,
  and more [S, README 0.17]. **runs-on/cache** is a drop-in `actions/cache` fork backed
  by S3. It needs `RUNS_ON_S3_BUCKET_CACHE` (plus an optional endpoint) and has no 10 GB
  cap [S]. **Nx** bucket caches are deprecated (CREEP); Nx now points to Nx Cloud or a
  custom server following its OpenAPI spec [S/V].
- **Model:** nothing in git (d). Keys derive from *inputs* (lockfile hash, toolchain,
  args) and values are tarballs or blobs.
  These tools have no merge story by design.
- **Lesson (CREEP, CVE-2025-36852):** any shared, input-keyed, first-writer-wins bucket
  can be poisoned by an untrusted writer who reaches the key first.
  The fix is *provenance and write segregation* (only protected branches write, PRs
  read), not checksums [S]. This applies directly to blobsy mirror mode for UC-3.

* * *

## Matrix: Tools × Use Cases (and the pains that separate them)

Legend: **Y** = native fit, **P** = partial or by convention/workaround, **N** = no.
“Removal” = can a payload be retroactively removed without rewriting git history
(PAIN-3). “Pluggable” = user-chosen backends incl.
S3/GCS (PAIN-5). “Browsable” = remote keys are path-shaped and readable by standard
tools.

| Tool (Oct 2026) | UC-1 | UC-2 | UC-3 | UC-4 | UC-5 | Removal | Pluggable | Browsable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Git partial clone + LOP | N | N | N | Y¹ | N | N | P² | N |
| Git LFS on GitHub | Y | N | N | Y | P | N³ | N | N |
| Git LFS + S3 agent/server | Y | N | N | Y | P | Y | P | N |
| git-annex | Y | N | N | Y | P | Y | Y | P⁴ |
| DVC | Y | P⁵ | N | Y | P | Y | Y | P⁶ |
| lakeFS `lakectl local` | N | Y⁷ | P | N | P | Y | P⁷ | P |
| HF Hub (Xet) | Y | N | N | P | P | P | N | N |
| HF Storage Buckets | N | N | Y | N | P | Y | N | P |
| Oxen.ai | P⁸ | P | N | N⁸ | P | ? | ? | N |
| Quilt | N | P | N | N | Y | Y | N | Y |
| ORAS / OCI | N | P | P | N | Y | Y | P | N |
| DataChain | N | P | N | N | P | Y | Y | Y⁹ |
| jj / Sapling (native) | N | N | N | Y¹ | N | N | N | N |
| Epic Lore | P⁸ | P | N | N⁸ | P | ? | ? | N |
| Gat | Y | Y | N | Y | P | Y | Y | N? |
| GitHub Immutable Releases | N | N | N | N | Y | N | N | Y |
| Build caches (sccache etc.) | N | N | Y | N | P | Y | P | N |
| **blobsy today** | **Y** | **N¹⁰** | **N** | **Y** | **P** | **Y** | **Y** | **Y** |
| **blobsy + mirror mode (proposed)** | Y | P¹¹ | Y | Y | P | Y | Y | Y |

Notes: ¹ merges bytes, not metadata; binary conflicts unresolvable.
² LOP via remote helper is the design intent, not shipped.
³ GitHub requires deleting the repository.
⁴ `exporttree=yes` remotes.
⁵ directory `.dvc` is one pointer, but the manifest lives in the remote, not git.
⁶ `version_aware` remotes.
⁷ requires a lakeFS server; ref file pins a lakeFS commit.
⁸ separate VCS, so “merge” happens outside git.
⁹ references objects in place.
¹⁰ directories expand to one `.bref` per file.
¹¹ receipt plus optional committed `--manifest` (Round 8 Option C). The UC-2 merge story
is undesigned.

**Reading the matrix:** UC-2 with a manifest *reviewable in git* and *mergeable in git*
is held by only one tool, Gat.
UC-3 with pluggable backends is held by build caches (narrow, input-keyed) and HF
Buckets (single vendor).
No tool covers UC-1 + UC-2 + UC-3 with one config, one backend layer, and a browsable
remote. That is the open niche [I].

* * *

## Implications for blobsy

### Where the niche got stronger

1. **Native git will not solve PAIN-3 in the foreseeable future.** LOP moves bytes off
   the *server’s* hot storage and out of *clients*, but the blob stays in the commit’s
   tree hash. Git’s own design doc says removal may need a history rewrite [V].
   Externalizing bytes behind a small committed pointer is still the only git-compatible
   answer to PAIN-3. With blobsy, removal = delete the remote object.
   History retains about 200 bytes of metadata, and a filter-repo on text files is only
   needed if even the filename or hash is sensitive.
2. **GitHub LFS’s removal story is still “delete the repo”** [V], and free quota is
   still small at scale.
   PAIN-4 is durable.
3. **DVC’s center of gravity moved to an enterprise vendor and its releases slowed**
   [V dates, I meaning]. The “lightweight, git-native, pluggable, non-Python” slot is
   less contested by DVC than in Feb.
4. **jj (and any non-git porcelain) lacks LFS and `.gitattributes`** [V]. Blobsy’s “no
   filters, plain text pointer + gitignored payload” design works there unchanged.
   This is worth stating in docs and Related Work.
5. **HF Buckets validates the Round 8 split** between versioned publish (file mode) and
   mutable working storage (mirror mode), and it exists only on HF. A pluggable,
   bring-your-own-bucket version of that split is unclaimed [I].

### Where the niche got weaker

1. **Gat now occupies “simple, serverless, single-binary LFS alternative with S3/GCS/
   Azure backends”** and already has a better UC-2/UC-4 story (sharded lockfile +
   semantic merge driver) than blobsy [V]. Blobsy must differentiate on: per-file
   pointer diffs (UC-1 PR review), browsable path-shaped remotes, custom-command
   backends, compression, verifiable receipts and mirror mode (UC-3), and agent-first UX
   (`--json`, skill, self-documenting brefs).
   It should not compete on “also an LFS replacement”.
2. **Single-binary distribution** (Gat, Lore, git-xet, jj) is now the norm for this
   category. Blobsy requires Node ≥24. Consider a packaged single executable (Node SEA or
   bun compile) as a distribution goal [I].
3. **Chunk-level dedup** (Xet, Lore) is becoming table stakes at TB scale for frequently
   edited large files (checkpoints).
   Blobsy’s whole-file model is fine for PAIN-1-scale files (MBs to a few GB) but should
   say so explicitly in non-goals [I].

### Ideas to borrow (concrete)

1. **UC-2: a committed collection manifest with a git merge driver.** Gat’s `gat.lock`
   shape is path → content ID (+ size) per entry, sorted, and shardable into a directory
   for very large sets.
   The three-way rules are “same on both sides keep; one side matches base take other;
   else conflict” with no conflict markers, and `merge=union` is rejected [V].
   Recommendation: make the Round 8 receipt’s optional `--manifest` a first-class,
   committable `.bref`-family file, and ship `blobsy merge-driver` registered via
   `.gitattributes` (`merge=blobsy`). This answers UC-2 + UC-4 without Round 8’s
   rejected Option A machinery (stat cache, hooks) and reverses Round 8’s implicit “UC-2
   is out of scope”. **This is the biggest design delta the landscape suggests.**
2. **Pinned per-directory ref file** (lakeFS `.lakefs_ref.yaml`: `src` + pinned commit
   ID; commit data first, then git) [V]. This maps directly onto the Round 8 receipt
   schema (`dest`, `tree_hash`). Adopt the “push before commit” ordering rule and a
   `doctor` check for it.
3. **Plan/apply for sync** (HF Buckets `--dry-run`, `--plan <file>`, `--apply <file>`)
   [V]. It suits agents and reviewed bulk operations in mirror mode: an agent produces a
   plan, a human or CI approves it, then it is applied.
   Blobsy already has dry-run; persisting the plan is cheap.
4. **Enforce remote immutability with conditional writes.** S3 `If-None-Match: *` on
   PutObject/CompleteMultipartUpload (2024-08) and CopyObject (2025-10) [V]. GCS offers
   `ifGenerationMatch=0` [I]. Use these to make design invariant 12 ("remote blobs are
   immutable") atomic instead of HEAD-then-PUT. Bucket policies can even require it [V].
   This is the right UC-5 primitive.
5. **CREEP-proof UC-3.** For no-manifest caches, document and support *write
   segregation*: separate read and write credentials or prefixes per trust level, and
   protected-branch-only writers.
   Include producer provenance (branch/commit/run) in receipts.
   Never let “first writer wins” on an input-derived key be the only trust anchor [S/I].
6. **Remote verification without download**: use S3 full-object CRC64NVME (default since
   late 2024; Quilt now verifies it [V]) in `verify`/receipts.
   Already researched in backing-store-features; the Quilt precedent strengthens it.
7. **Local eviction after verified push**, mirroring git 2.56 `repack --drop-filtered`
   [V] and Round 8’s receipt-verified prune.
   The same idea is now in core git, which validates the UX.
8. **Machine-readable fetch plans**, mirroring LFS 3.7 `fetch --json` with URLs and HTTP
   metadata “for external tools” [V]. `blobsy pull --json --dry-run` should emit
   resolved remote URLs/keys so other tools (CI caches, CDNs, FUSE mounts) can hydrate.

### Interop targets

- **Git LFS (migration on-ramp for PAIN-4).** `blobsy import-lfs` would read LFS
  pointers (`oid sha256`, `size`), fetch via `git lfs fetch --json` URLs, push to the
  blobsy backend, write `.bref`s, and leave `.gitattributes` cleaned.
  Reverse export matters for trust.
  This is the highest-leverage interop [I].
- **Partial clone as complement, not competitor.** Recommend
  `git clone --filter=blob:limit=<N>` in docs for residual mid-size blobs below blobsy’s
  threshold [I].
- **OpenDAL** (as Gat and lfs-dal use) is a candidate built-in backend layer if
  aws-cli/rclone delegation proves limiting.
  Node bindings exist [I: unverified].
- **Command backends to `hf buckets`, `oras`, and GitHub Releases** cover HF, OCI, and
  immutable-release targets without new code [I].
- **DVC `version_aware` and git-annex `exporttree`** produce path-shaped buckets.
  Blobsy’s browsable layout could read them for import [I].

### Suggested doc updates

- **`blobsy-design.md` Related Work:** add Gat (closest competitor), git LOP/partial
  clone (what it does and doesn’t fix), HF Storage Buckets, and Epic Lore (one line).
  Update DVC (lakeFS ownership; `version_aware` browsable remotes).
  Soften “Git LFS: no pluggable backends” to “pluggable only via third-party transfer
  agents/servers”.
- **Feb landscape doc:** fix the GitHub LFS free tier (10 GiB) and the Quilt activity
  note.
- **Round 8:** add UC-2 (committed manifest + merge driver) as an explicit requirement,
  add CREEP-derived write segregation to UC-3, and add the plan/apply idea.

* * *

## Open Questions

1. Should UC-2 manifests be a new file type (`.bref-manifest`?) or a `.bref` with a
   `files:` section? Merge-driver complexity is similar.
   PR readability favors one line per path.
2. Shard threshold for very large manifests (Gat shards into a directory): by count, by
   size, or by top-level directory?
3. Does UC-3 ever need a git-visible artifact, or are bucket-side receipts enough?
   Round 8’s grounding says bucket-side in practice.
4. Is a single-executable build of blobsy worth the effort before 1.0?
5. Gat’s remote layout and removal story are undocumented.
   Re-check when it tags a release.
6. Will GitHub or GitLab ship LOP-backed offload, and does it change the GitHub LFS
   calculus? Re-check at Git 2.57/2.58 (≈ early-mid 2027).

* * *

## Sources

Git core:

- GitHub blog Git index (release dates): https://github.blog/open-source/git/
- Highlights from Git 2.49:
  https://github.blog/open-source/git/highlights-from-git-2-49/
- Highlights from Git 2.50:
  https://github.blog/open-source/git/highlights-from-git-2-50/
- Highlights from Git 2.51:
  https://github.blog/open-source/git/highlights-from-git-2-51/
- Highlights from Git 2.52:
  https://github.blog/open-source/git/highlights-from-git-2-52/
- Highlights from Git 2.54 (covers 2.53+2.54):
  https://github.blog/open-source/git/highlights-from-git-2-54/
- Highlights from Git 2.55:
  https://github.blog/open-source/git/highlights-from-git-2-55/
- Highlights from Git 2.56:
  https://github.blog/open-source/git/highlights-from-git-2-56/
- Git RelNotes 2.49.0-2.56.0:
  https://github.com/git/git/tree/master/Documentation/RelNotes
- Large object promisors design doc:
  https://www.kernel.org/pub/software/scm/git/docs/technical/large-object-promisors.html
- `promisor.*` config docs:
  https://code.googlesource.com/git/+/HEAD/Documentation/config/promisor.adoc
- GitLab epic 15972 (promisor-remote exchange status):
  https://gitlab.com/groups/gitlab-org/-/epics/15972
- GitLab, What’s new in Git 2.53.0:
  https://about.gitlab.com/blog/whats-new-in-git-2-53-0/
- GitLab Gitaly offload epic: https://gitlab.com/groups/gitlab-org/-/epics/9094
- T. Cipriani, “The future of large files in Git is Git” (2025-08-15):
  https://tylercipriani.com/blog/2025/08/15/git-lfs/
- HN discussion: https://news.ycombinator.com/item?id=44916783

Git LFS and hosting:

- Git LFS CHANGELOG: https://raw.githubusercontent.com/git-lfs/git-lfs/main/CHANGELOG.md
- GitHub Git LFS billing:
  https://docs.github.com/en/billing/concepts/product-billing/git-lfs
- GitHub, removing files from LFS:
  https://docs.github.com/en/repositories/working-with-files/managing-large-files/removing-files-from-git-large-file-storage
- GitLab storage quotas: https://docs.gitlab.com/user/storage_usage_quotas

git-annex, DVC, lakeFS, DataChain:

- git-annex news: https://git-annex.branchable.com/news/
- git-annex addcomputed: https://man.archlinux.org/man/git-annex-addcomputed.1.en
- lakeFS acquires DVC: https://lakefs.io/blog/lakefs-acquires-dvc/
- DVC joins lakeFS FAQ: https://dvc.org/blog/dvc-joins-lakefs-your-questions-answered/
- DVC cloud versioning: https://doc.dvc.org/user-guide/data-management/cloud-versioning
  and https://blog.dvc.org/blog/cloud-versioning
- PyPI JSON (dvc, dvc-s3, datachain, oxenai, quilt3, hf-xet, huggingface-hub):
  https://pypi.org/pypi/<name>/json
- lakeFS local checkouts: https://docs.lakefs.io/guides/local-checkouts/
- lakeFS Everest 0.10.0: https://docs.lakefs.io/releases/everest/0.10.0/
- DataChain: https://github.com/iterative/datachain

Hugging Face / Xet:

- Xet overview: https://huggingface.co/docs/hub/xet/overview.md
- Using Xet storage (git-xet): https://huggingface.co/docs/hub/xet/using-xet-storage
- Xet protocol docs: https://huggingface.co/docs/xet/index
- Storage Buckets (2026-03-10): https://huggingface.co/blog/storage-buckets
- Common Crawl in an HF bucket:
  https://blog.commoncrawl.org/blog/april-2026-crawl-archive-now-available-in-a-hugging-face-storage-bucket
- F. Denis, “An introduction to XET” (2026-01-19):
  https://00f.net/2026/01/19/xet-intro-1/
- IETF draft-denis-xet-04: https://datatracker.ietf.org/doc/html/draft-denis-xet-04

Other tools:

- Gat repo: https://github.com/getgat-dev/gat
- Gat docs, how it works: https://getgat.dev/concepts/how-gat-works
- Gat docs, remote providers: https://getgat.dev/references/remote-providers
- Gat docs, branching and merging: https://getgat.dev/guides/branching-and-merging
- Epic Lore repo: https://github.com/EpicGames/lore
- Phoronix on Lore (2026-06-17): https://www.phoronix.com/news/Epic-Games-Lore-VCS
- Oxen: https://github.com/oxen-ai/Oxen
- Quilt CHANGELOG: https://github.com/quiltdata/quilt/blob/master/docs/CHANGELOG.md
- ORAS 1.3.0 (CNCF):
  https://www.cncf.io/blog/2025/10/06/announcing-oras-v1-3-0-elevating-artifact-and-registry-management-workflows/
- jj CHANGELOG: https://github.com/jj-vcs/jj/blob/main/CHANGELOG.md
- jj git compatibility: https://github.com/jj-vcs/jj/blob/main/docs/git-compatibility.md
- jj issue #80 (LFS): https://github.com/jj-vcs/jj/issues/80
- git-lfs-fuse: https://github.com/git-lfs-fuse/git-lfs-fuse
- s3lfs: https://github.com/kmatzen/s3lfs
- Homebrew formula API (current versions):
  https://formulae.brew.sh/api/formula/<name>.json
- HN Algolia search (Show HN since 2025-02): https://hn.algolia.com/api

GitHub platform, caches, S3:

- Immutable releases:
  https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases
- Immutable releases GA discussion: https://github.com/orgs/community/discussions/178351
- Actions cache > 10 GB (2025-11-20):
  https://github.blog/changelog/2025-11-20-github-actions-cache-size-can-now-exceed-10-gb-per-repository/
- Nx CREEP advisory:
  https://nx.dev/blog/cve-2025-36852-critical-cache-poisoning-vulnerability-creep
- NVD CVE-2025-36852: https://nvd.nist.gov/vuln/detail/CVE-2025-36852
- runs-on/cache: https://github.com/runs-on/cache
- sccache README: https://docs.rs/crate/sccache/0.17.0/source/README.md
- S3 conditional writes (2024-08-20):
  https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes
- S3 conditional copy (2025-10):
  https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-s3-conditional-write-functionality-copy-operations
- S3 conditional writes guide:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
