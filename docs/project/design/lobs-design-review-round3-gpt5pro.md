# Senior Technical Review: LOBS (Large Object Storage for Git Repos)

**Docs reviewed:**

* Sync tools + architecture landscape research
* Atomic file write behavior across transports
* LOBS design doc (draft)
* Prior review notes: checksums/integrity (round 2)
* Prior review notes: general (round 1)

* * *

## 1) Market placement, “does this fill a room?”, and strategic focus

### Where LOBS sits in the ecosystem

From the landscape research, there are broadly two families of solutions for “git + big
data” workflows:

1. **Git-native large file systems** (Git LFS, git-annex, etc.)

   * Strength: commit-level reproducibility and generally correct “time travel”
     semantics (a commit references immutable content).
   * Cost: hooks/filters, server/protocol coupling, more magic, and often
     hosting/provider coupling.

2. **Data workflow tools** (DVC, Pachyderm-like patterns, lakeFS-like systems)

   * Strength: richer dataset semantics, caches, pipelines, and usually CAS/dedup.
   * Cost: heavier conceptual load, different ergonomics than “simple CLI + S3,”
     sometimes opaque remote layouts.

Separately there are **raw sync engines** (rclone/rsync/aws-cli) with no
pointer/manifest coordination layer.

LOBS explicitly chooses a hybrid position:

* It is **not** Git hooks/filters + transparent checkout (unlike Git LFS).
* It is **not** a pipeline / dataset orchestration framework (unlike DVC).
* It is a **small coordination layer**: pointer files in git + a namespace model +
  manifests + delegated transfer engines.

That’s a coherent niche: “a lightweight, explicit, CLI-first system for syncing
gitignored directories/files with remote object storage.”

### Does it fill a room?

**Yes, but only if you’re very crisp about what it does *not* guarantee by default.**

It fills a genuine gap described in the research: teams frequently want “plain
directories on disk + S3/R2 remote + incremental sync + share with a team” without
standing up a server, adopting a heavy framework, or relying on provider-specific LFS
infrastructure.

Where the room gets fuzzy is that many users implicitly expect one of these behaviors:

* **Commit-level immutability / time travel** (“I can checkout an old commit and fetch
  the exact matching data bytes”), which CAS-based systems deliver.
* **Merge semantics** (“when I merge a PR that updated dataset pointers, other users can
  pull and it works without extra ceremony”).

Your current design *sounds like* it provides the first (there’s an explicit claim about
restoring old versions), but the core remote layout is **path-mirrored mutable objects**
under a branch namespace, which by itself does **not** provide commit-level
immutability.

**Strategic recommendation:** Pick a crisp product promise for V1:

* **V1 Promise A (simple):** “LOBS is a branch-isolated *sync* layer.
  Remote holds the *latest* state per namespace.
  Use `version` mode or bucket versioning for history.”
  This matches the transparent remote layout and avoids building CAS + GC.

* **V1 Promise B (stronger):** “LOBS makes commits reproducible: pointers reference
  immutable remote content.”
  This requires a design shift (snapshots/CAS or equivalent).

Right now the doc leans toward Promise B language while implementing Promise A
mechanics. That mismatch will create user confusion and correctness complaints.

* * *

## 2) Architectural review: what’s strong and makes sense

### The core mental model is good

The “`.lobs` pointer file adjacent to a gitignored path” is a clean, explicit
convention:

* It keeps Git clean (small pointers in Git history; large blobs out-of-band).
* It avoids smudge/clean hooks and makes “getting large data” an explicit action
  (`lobs pull`).
* It is agent-friendly (a `.lobs` file is discoverable and self-documenting).

This is one of the strongest design choices.

### Namespace modes are the right axis of flexibility

The namespace concept (“branch/fixed/version”) is exactly the knob users need, and it’s
easy to teach:

* `branch`: isolation to avoid overwrites across checkouts.
* `fixed`: shared canonical data.
* `version`: explicit pinned releases/runs.

A key strength is that the resolved namespace is computed at runtime and not stored as a
literal remote path in pointers (avoids embedding branch names in pointers).

### Delegating transfers is sensible

Letting mature tools do the heavy lifting (`aws-cli`, `rclone`, fallback SDK) keeps LOBS
small and leverages battle-tested retry/parallelism behavior.

Also: your atomic write research supports this delegation story—AWS CLI and rclone
already provide per-file atomic downloads in common cases, reducing the number of tricky
edge cases you have to own.

### Remote manifests for directories are the right “coordination primitive”

The landscape research calls out “Option A: manifest-based sync” as the simplest robust
approach for local-first directory bundles.
Your design essentially implements that for directory targets.

The round-2 checksum review correctly reframed integrity: transport verifies transfer
integrity; manifests + hashes solve change detection and local verification.

### Config hierarchy is powerful (but must be constrained carefully)

Directory/repo/global layering is a good affordance, and per-pointer overrides are
useful.

However, hierarchy also risks “two users produce different remote representations” if
representation-affecting defaults live outside the repo.
I’ll get into that under gaps.

* * *

## 3) The biggest architectural gaps and what I would change (P0/P1)

### P0-1: Versioning semantics are inconsistent with the proposed remote layout

The design claims you can restore an older version by checking out an older pointer and
running `lobs pull`, because “the current namespace still contains the data” and LOBS
“never deletes remote objects during normal sync operations.”

But the remote layout shown is *mutable path-based keys* (e.g.,
`branches/main/data/prices.parquet.zst`). Pushing new data to the same path overwrites
the object; you lose prior bytes unless:

* bucket/object versioning is enabled, or
* objects are stored under immutable keys (hash/snapshot ids), or
* you never overwrite (store every version under a new key and keep a ref).

Additionally, the push semantics for directories explicitly include “remove deleted
files from remote,” which contradicts “never deletes remote objects.”

**Recommendation: make this a first-class decision and reflect it everywhere.**

**Option A (simplest, aligns with transparent path mirror):**

* Define remote semantics as **“latest mirror per namespace”**.

* Update the docs to explicitly state:

  * overwrites happen,
  * old commits are not guaranteed retrievable,
  * to get history you must use `namespace.mode: version` (versions are immutable by
    convention), or enable bucket versioning.

* Make deletion behavior explicit and conservative:

  * default `push` does **not** delete remote objects (unless `--prune-remote`),
  * default `pull` does **not** delete local files (unless `--prune-local`).

**Option B (stronger, makes “git commit ⇒ data retrievable” true):**

* Adopt a snapshot identifier:

  * for single file: already have `sha256` as the object id; store data under
    `objects/sha256/<hash>` (or `blobs/<hash>`).
  * for directory: compute `manifest_sha256` (or a tree hash) and store the manifest and
    files under `snapshots/<manifest_sha256>/...`.

* Then “branches/…” becomes a *ref* to a snapshot, not the storage location itself.
  This is essentially Option B/CAS from the landscape.

You don’t need to jump fully to “opaque CAS everywhere” if you want browsability: you
can keep “path-mirrored” *within* a snapshot, while still using immutable snapshot ids
at the top level.

If you want LOBS to feel correct in Git terms (checkout old commit → get the right
data), you’ll eventually need something like Option B.

* * *

### P0-2: Branch mode breaks merge workflows unless you define “promotion” clearly

In `branch` mode, the same pointer resolves to different remote prefixes depending on
current branch.

That solves the overwrite problem—but introduces a core workflow question:

**What happens when a feature branch updates data, then you merge that pointer change
into `main`?** The pointer change lands on `main`, but the data it references is still
physically in `branches/feature-x/...`, not `branches/main/...`.

If nothing else happens, users pulling `main` will see updated pointers but may not be
able to pull the data from `main`’s namespace.

**You need an explicit “promotion” story.
Recommended V1 contract:**

* Branch namespaces are *workspaces*.
* When merging data changes into another branch, you must **publish/promote** them into
  the target branch’s namespace before other users can pull.

**Concrete design changes to support this:**

1. Add a command (even if V1 is minimal):

   * `lobs promote --from <source-namespace> --to <target-namespace> [paths...]`
   * or `lobs ns copy <from> <to> [paths...]` For S3 this can use server-side
     CopyObject, which is fast and avoids re-downloading.

2. Add a CI/verifier command:

   * `lobs check-remote` that verifies that for the current commit’s pointers, the
     expected objects/manifests exist in the resolved namespace.
     This directly addresses the “pointer committed but data not pushed” failure mode
     called out in the earlier review.

3. Make `lobs push` semantics robust to “remote missing”:

   * Even if local bytes match the pointer hash, if the remote object is missing in the
     current namespace, `push` should upload it (without changing the pointer).

Without these, `branch` mode is dangerously easy to use incorrectly in a normal PR/merge
workflow.

* * *

### P0-3: Directory pointers need a content identifier, not just an `updated` timestamp

For single files, the pointer contains `sha256` and `size`, so the Git diff shows a
meaningful change and a merge has semantic content.

For directories, the pointer example mostly has:

* `type: directory`
* `manifest: true`
* `compression: zstd`
* `updated: <timestamp>`

That means:

* A directory change is represented in Git by *only* a timestamp bump.
* Merge conflicts become meaningless (“take left timestamp or right timestamp?”).
* You can’t do commit-level directory verification without pulling the remote manifest
  and hoping it matches.

**Recommendation:** add one of:

* `manifest_sha256: <hash-of-manifest-json>` (best)
* or `tree_sha256: <Merkle-root>` (harder but very powerful)
* plus optionally `file_count` and `total_size` for UX.

This one change greatly improves:

* “does this directory version exist remotely?”
* correctness of merge conflicts and diffs
* ability to do cheap remote sanity checks (HEAD the manifest key and compare digest
  once fetched)

DVC’s success here is instructive: directory tracking works because Git stores a stable
identifier for the directory snapshot.
LOBS needs the same idea, even if the remote store is path-mirrored.

* * *

### P0-4: Single-file conflict detection is underspecified (“remote hash Z”)

The design defines conflict for single files as:

* pointer hash X, local hash Y, remote hash Z; if Y != X and Z != X, conflict.

But how do you obtain Z without downloading the object?
With S3 you can HEAD and get ETag, but ETag is not SHA-256 and is often not MD5 for
multipart uploads. If you compress, it’s a checksum of the compressed bytes anyway.

**Make a decision:**

* **If you truly need remote-vs-local-vs-pointer conflict detection:** You must store a
  comparable remote-side digest:

  * as object metadata (e.g., `x-amz-meta-lobs-sha256: <uncompressed-sha256>`) *or*
  * as a sidecar object `file.ext.lobsmeta.json` containing `{sha256, size, ...}`.
    Sidecar is more transport-agnostic (works with any backend and any sync tool).

* **If you don’t need this in V1:** Lean into the “Git is the coordination layer” model:

  * conflict is detected at merge-time of `.lobs` pointers in Git and/or at
    directory-manifest concurrency checks,
  * single-file remote conflicts are handled by “pull first, then push” discipline.

Given your stated “single-writer model (V1)” and the complexity of portable metadata
setting across aws-cli/rclone/custom backends, I would **drop single-file remote
conflict detection from V1** and rely on pointer workflow + optional `lobs check-remote`
in CI. Keep the pointer-level common ancestor logic as a *future* enhancement once you
have a universal metadata/sidecar story.

* * *

### P0-5: Compression + delegated sync needs explicit mechanics

Your design promises:

* per-file compression before upload and decompression after download,
* “user never sees compressed files locally,”
* and delegated transfer engines including `aws s3 sync` / `rclone sync`.

Those don’t automatically compose unless you add one of these mechanisms:

1. **Staging directory representation:**

   * lobs materializes a “remote view” directory with `.zst` files,
   * then runs `aws s3 sync` on that staging directory.
   * pull does the reverse: sync into a staging directory then decompress into working
     dir.

2. **File-by-file transfer orchestration:**

   * lobs decides exactly which files to upload/download (via manifest diff),
   * compresses each file to a temp file (or streams) and calls `aws s3 cp` /
     `rclone copy` for that file,
   * no `sync` used for compressed representations.

The design doc currently implies both “manifest-driven decisions” and “transport sync
handles incremental,” but doesn’t lock down which approach is used when.

**Recommendation (maintainable and correct):**

* When `manifest: true` (directory), treat transfer tools as **copy engines**, not diff
  engines. LOBS owns diffing using manifest hashes; transfer tool only moves bytes for a
  known list of objects.
* When `manifest: false`, allow “pure delegation mode” using `aws s3 sync` /
  `rclone sync` (and probably require `compression: none` for that mode, unless you do
  staging).

This keeps the code coherent: one mode is “LOBS-coordinated,” the other is
“tool-coordinated.”

* * *

## 4) Detailed design review by subsystem

### 4.1 Pointer file format & format versioning

**What’s good**

* Small human-readable pointer files with an explicit `format: lobs/0.1`.
* Including `sha256` + `size` for single files is correct and makes diffs meaningful.

**Gaps / improvements**

1. **Define canonical encodings and types.** The prior review called this out: specify
   sha256 format (lowercase hex, 64 chars), size units (bytes), timestamp format
   (ISO-8601 Z).

2. **Add directory content identifiers.** Add `manifest_sha256` (or equivalent).
   (Discussed above.)

3. **Clarify what is “versioned metadata” vs “local preferences.”** Anything that
   affects how the remote bytes are stored must be in Git-tracked state (pointer and/or
   repo config), otherwise two users can’t reliably pull the same object set:

   * compression algorithm
   * whether a file was compressed (skip list decisions)
   * checksum algorithm and whether hashes exist in manifest

   Today, some of these live in config hierarchy (including global).
   That’s risky.

4. **Stability of formatting matters.** If LOBS rewrites pointer YAML, enforce stable
   key ordering and minimal diffs.
   Don’t reorder keys or emit different quoting on each run.

**Proposed pointer schema changes (illustrative)**

Single file:

```yaml
format: lobs/0.1
type: file
sha256: <64-lower-hex>
size: <bytes>
compression: zstd|gzip|lz4|none
stored_as: "<relative-remote-filename>"   # optional but helpful for stability
updated: <iso-utc>
```

Directory:

```yaml
format: lobs/0.1
type: directory
manifest: true
manifest_sha256: <64-lower-hex>           # or tree hash
file_count: <int>
total_size: <bytes>
compression: zstd|gzip|lz4|none
updated: <iso-utc>
```

* * *

### 4.2 Manifest design (directories)

**What’s good**

* Remote-only manifests avoid Git noise.
* Per-file SHA-256 in the manifest is the right change detection primitive (and aligns
  with the round-2 integrity analysis).

**Key gaps / corner cases**

1. **Manifest must encode enough to reconstruct remote object names.** If compression is
   enabled and you sometimes skip compression by extension, you need stable rules across
   time. If those rules live only in config, then checking out an old commit (with
   different config) might work—but if global config overrides creep in, it breaks.

   The most robust approach is:

   * include `stored_as` (remote relative key) per file entry, or at least
     `compressed: true/false` per entry.

2. **Manifest canonicalization.** If you adopt `manifest_sha256`, the manifest
   serialization must be canonical and stable (sorted keys, stable ordering of files,
   consistent newline).
   Otherwise the same logical manifest produces different hashes.

3. **Conflict detection “ETag or timestamp” is underspecified.** Design says: “If the
   remote manifest changed since the last pull (detected via ETag or timestamp), push
   fails.” But:

   * where is “last seen ETag” stored?
   * what if user never pulled (fresh clone)?
     what’s the baseline?
   * what if the backend doesn’t provide strong etags?

   If you store `manifest_sha256` in the pointer, you can use that as the baseline
   without maintaining extra local state.

4. **Deletion semantics are a big deal.** If push removes deleted files from remote, you
   lose history and can’t reconstruct older directory states.
   If you want history, deletion must be either:

   * disabled by default, or
   * implemented as “tombstones” in manifest + separate GC.

* * *

### 4.3 Namespace resolution and branching workflows

**What’s good**

* Detached HEAD fallback is considered.

**What needs tightening**

1. **Branch name normalization/sanitization** The prior review called this out as
   significant. Branch names can contain slashes and other characters; S3 keys tolerate
   many but tooling and shell quoting suffer.

   Recommendation:

   * Preserve `/` (keeps remote browsing aligned with branch structure).
   * Percent-encode or otherwise escape anything outside a conservative charset like
     `[A-Za-z0-9/._-]`.
   * Specify max length and fallback to a hash suffix for long names.

2. **Detached HEAD namespace explosion (CI)** In CI you can create many `detached/<sha>`
   namespaces that never get cleaned by `branches/` GC. Prior review flagged this.
   Recommendation:

   * Use a longer SHA (12+ or full) to avoid collisions.
   * Add GC coverage for `detached/` with TTL.
   * Consider a `namespace.mode: ci` option (or document best practice: do not push from
     detached unless using `fixed` or `version`).

3. **`version` mode must be fully specified** Prior review flagged this.
   Decide:

   * If mode is `version` and no version id is set, is it an error?
     (It should be.)
   * Do versions accumulate forever?
     If yes, provide explicit `lobs ns rm versions/<id>` or optional GC policy.

4. **Per-pointer namespace overrides and mixed namespaces** This is powerful but will
   complicate:

   * output grouping
   * partial failures
   * concurrency limits

   The prior review suggested “group operations by resolved namespace and treat each
   group independently.”
   I agree. In practice:

   * `status` should group by namespace when multiple exist.
   * `push` should report per-namespace success/failure and not block unrelated
     namespaces.

* * *

### 4.4 Sync semantics: push, pull, status, diff

**Push**

* Good: “manifest written after upload” is the right idempotency pattern.
* Missing: explicit guarantees about partial failure and reruns.

**Recommendation:** define push as:

1. compute diff (based on pointer/manifest ids, not mtimes)
2. upload missing/changed objects
3. write manifest last (atomic as a single object PUT on S3-compatible stores)
4. only then update pointer file locally

Also define: if remote already has the expected object, upload is skipped; if remote is
missing, upload occurs even if pointer matches local (important for merge/promotion
workflows).

**Pull**

* You should explicitly decide:

  * Does pull overwrite local modifications?
    (Default should be “no, error unless `--force`”.)
  * Does pull delete local files not in manifest?
    (Default should be “no.”)

* For directories: incremental pull can leave a mixed state if interrupted; that’s okay
  if per-file atomic and rerunnable.

**Status / diff**

* If you want agent and CI usability, define “offline vs online” clearly:

  * `status` might require fetching remote manifest.
  * Provide `status --offline` that only compares local files to pointer (single file)
    or cached manifest (if you add caching).

* * *

### 4.5 Atomic file writes and interrupted operations

The atomic writes research is directly relevant:

* AWS CLI and rclone do per-file atomic downloads by default; the built-in AWS SDK
  streaming path does not, so LOBS must implement temp+rename for built-in downloads.
* Pointer files and any local manifest caches must also be written atomically
  (temp+rename).
* Per-file atomicity ≠ transactional directory sync; idempotency + rerun is the right
  approach.

**Concrete recommendations**

1. Implement a consistent atomic write utility in LOBS:

   * small files: write-file-atomic / atomically
   * streaming large files: stream to temp file in same directory and rename

2. Add a cleanup story:

   * `lobs clean` or startup cleanup of `.lobs-tmp-*` remnants.

3. Document expected interrupted-state behavior:

   * partial set of files may exist; rerun fixes.
   * manifest written last ensures remote manifest never references missing objects.

* * *

### 4.6 Transport/tool selection and robustness

**Auto tool selection** The prior review flagged fragility: “aws-cli installed” ≠
“aws-cli configured for this endpoint/bucket.”
Recommendation:

* `auto` should perform a lightweight capability check (credentials + endpoint
  reachability) and fall through to the next tool on failure.

* Add `lobs doctor` to print:

  * resolved backend + endpoint
  * selected sync tool and why
  * resolved namespace and remote prefix

**Add s5cmd as a future candidate** The landscape research likely mentions that sync
engines vary in performance; if you end up orchestrating per-file uploads
(manifest-driven), a batching tool like s5cmd can be a big win.
(This is a “nice to have” but worth keeping in mind given your “don’t implement
transfers” principle.)

* * *

### 4.7 Compression system

**What’s good**

* zstd default is a solid choice for mixed text/binary directories; skip list for
  already-compressed formats is sensible.

**Where it needs more spec**

1. **Where does compression occur?** You should explicitly define whether LOBS:

   * streams compression into upload (only possible with built-in SDK / custom
     pipeline), or
   * compresses to temp files and then invokes external upload commands.

2. **Skip list must not be a “local preference” if it affects remote keys.** Either:

   * treat skip list as part of repo config (committed) and discourage global overrides,
     or
   * record the per-file “stored_as” in manifest.

3. **Suffix ambiguity** Prior review flagged `.zst` ambiguity (native `.zst` vs
   LOBS-compressed). The simplest path is to accept it and rely on pointer/manifest
   metadata. If you want remote clarity, consider `.lobs.zst`.

4. **Small-file thresholds** (optional) Compression overhead on tiny files can be
   counterproductive. Consider a default threshold (e.g., don’t compress < 4KB) or at
   least make it configurable.

* * *

### 4.8 Gitignore management and mixed directories

**What’s good**

* Managing a clearly marked section in `.gitignore` is user-friendly and idempotent.

**Needs resolution**

1. **Which .gitignore is modified?** Git supports nested `.gitignore`. Prior review
   suggests following DVC: modify/create `.gitignore` in the same directory as the
   tracked path. That’s usually the least surprising.

2. **Mixed directories are a sharp edge** Your scenario explicitly requires manual
   `.gitignore` adjustments.
   For V1, I would either:

   * strongly recommend “keep LOBS-managed data in dedicated directories,” or
   * flip the model from “ignore patterns” to “include patterns” (so LOBS can generate
     ignore entries for the included large files and leave the rest normal).

* * *

### 4.9 CLI surface, automation, and the “no prompts” contradiction

There’s a direct contradiction between:

* “No interactive prompts” in Agent Integration, and
* the interactive `lobs init` example.

**Recommendation:** Clarify policy as:

* `init` may be interactive when run without flags, but must support fully
  non-interactive usage via flags/env.
* all sync operations (`push/pull/status/diff/verify/gc`) are non-interactive.

Also consider a **schema version** for `--json` output so automation isn’t brittle.

* * *

### 4.10 Security and trust model (missing in doc, important in practice)

This is a big maintainability and adoption issue that isn’t currently addressed:

* Repo-level config can include `type: command` backends and custom compression
  commands. If those configs are committed, then **running `lobs pull` can execute
  arbitrary commands from a repo you cloned**.

That’s a serious supply-chain footgun.

**Recommendation (V1):**

* Disallow `command` backend and custom compress/decompress commands from repo config by
  default. Allow them only in user-level config, or require an explicit
  `--allow-unsafe-config` / `lobs trust` action per repo.
* At minimum: print a loud warning the first time a repo tries to execute repo-specified
  commands.

This one change dramatically improves safety and makes it easier to recommend LOBS
broadly.

* * *

## 5) Suggested “simplified but flexible” V1 scope (to improve maintainability)

If you want a maintainable V1 that still has flexibility:

### Keep (core differentiators)

* `.lobs` pointers + `track/untrack`
* `push/pull/status/verify`
* namespace modes: `branch` and `fixed` (ship `version` only if fully specified)
* directory manifests with SHA-256 and `manifest_sha256` in pointer
* S3-compatible backend + local backend
* transport selection: `aws-cli` + built-in (add rclone as P1)

### Defer or narrow

* `lobs sync` (bidirectional) → defer until you have clear delete semantics and conflict
  handling (prior review called it dangerous/underspecified).
* `command` backend → defer or restrict to user config (security)
* advanced namespace GC (`ns ls` with sizes) → can be slow/expensive; start with minimal
  `gc --dry-run` + safe checks

This keeps the surface area tight, while keeping room to expand.

* * *

## 6) Specific errors / inaccuracies / contradictions found

1. **“Never deletes remote objects” vs “remove deleted files from remote”** These
   conflict and must be reconciled.

2. **Time-travel claim likely false under current remote layout** With path-mirrored
   keys that get overwritten, checking out an old pointer does not guarantee the old
   bytes still exist unless bucket versioning or immutable storage is implemented.

3. **Single-file conflict detection references a “remote hash” without a retrieval
   mechanism** Needs metadata/sidecar design or should be deferred.

4. **“No interactive prompts” contradicts the init example** Clarify “no prompts for
   sync operations” or provide non-interactive flags.

5. **Transfer delegation statement conflates “incremental sync” with “manifest-driven
   correctness”** If compression and SHA-256 manifest diffing are core, you cannot rely
   on `aws s3 sync` semantics alone; you need explicit orchestration or staging.

6. **Minor wording in S3 endpoint section** Saying `@aws-sdk/client-s3` “supports
   `--endpoint-url`” is CLI wording; SDK supports endpoints via config, not flags.

* * *

## 7) Priority checklist (actionable)

### P0 (must resolve before implementation hardens)

* Decide and document remote versioning semantics (latest mirror vs immutable
  snapshots).
* Add `manifest_sha256` (or tree hash) to directory pointers.
* Define branch merge/promotion workflow (and ideally add `lobs promote` or `ns copy`).
* Resolve delete semantics (local prune, remote prune, default safety).
* Either implement remote hash metadata/sidecar for single-file conflict detection or
  remove from V1.
* Lock down how compression interacts with transfer tools (staging vs file-by-file).
* Implement atomic writes for built-in transport and pointer/manifest writes; add
  cleanup.

### P1 (should do for V1 ship quality)

* Branch name sanitization spec.
* `gc` safety: check remote branches, detached namespaces, TTL.
* Auto tool detection robustness + `lobs doctor`.
* Security model: restrict repo-specified command execution.

### P2 (nice-to-have / later)

* Compression suffix clarity (`.lobs.zst`) and dictionary compression future-proofing.
* Export/import spec details.

* * *

## Closing assessment

The backbone of LOBS—**explicit pointer files, namespace-based separation, remote
manifests, and delegated transfer**—is a strong and market-relevant architecture for the
“plain directories + S3 sync” gap identified in your research.

To make it production-grade and maintainable, you primarily need to:

* **tighten versioning semantics** (and remove contradictory claims),
* **make directory pointers as semantically meaningful as file pointers** (manifest
  digest),
* **define branch merge/promotion and delete behavior**, and
* **be explicit about compression + transfer mechanics and security boundaries**.

If you want, I can also provide a “redlined” rewrite of the design doc sections that
should change (Versioning, Conflict Detection, Sync Semantics, Compression/Transport)
using your existing headings and tone.
