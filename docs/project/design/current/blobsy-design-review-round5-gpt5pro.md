# Senior Technical Review: blobsy v2 (Per‑file `.yref` + Content‑Addressable Remote)

This review is based primarily on the **v2 design doc** (`blobsy-design-v2.md`) plus the
attached research notes on the broader sync ecosystem, atomic writes, and backing-store
behavior. I’m treating the older manifest-based designs and earlier review rounds as
*context only* (as you requested), and focusing on whether the **v2 implementation** is
coherent, robust, and maintainable—especially for **versioning + branching workflows**.

* * *

## 1) Executive summary

### What’s working really well (big-picture)

1. **The architectural simplification is a genuine step-function improvement.** Moving
   from “directory manifests + namespace/promotion semantics” to **per-file refs** (“Git
   is the manifest”) removes a whole class of correctness and UX problems (post-merge
   promotion, manifest canonicalization, remote directory conflicts, etc.). The new
   model is clean: **a `.yref` is the truth, and it merges like normal code**.

2. **Git’s strengths are being used correctly.** The design leans on Git where Git is
   strongest: *branching, merging, history, review diffs, and conflict resolution*. A
   per-file ref is the right granularity for Git to do its job.

3. **Content-addressable storage fits the collaboration model.** You get “free”
   immutability semantics (or close to it) and avoid remote overwrites for normal
   workflows. This is the key that makes “feature branch push → merge → no post-merge
   promotion” actually true.

4. **Delegating transfer to established tools is pragmatic.** Treating aws-cli / rclone
   / s5cmd as **copy engines** (not diff engines) is a good separation of concerns.
   Blobsy owns the ref/diff logic; the transfer tool just moves bytes.

5. **Agent/CI friendliness is intentionally designed.** `--json`, non-interactive
   defaults, and idempotency are the right calls for automation-heavy orgs.

### The most important gaps / risks (things I’d fix before shipping)

These are the ones that can create real-world footguns or correctness failures:

**P0 (must clarify / fix in spec):**

1. **Remote key / dedup semantics are inconsistent in the doc.** The doc says “same
   content = same key,” but also shows keys that embed the path
   (`sha256/<hash>/<repo-relative-path>`). Those can’t both be true.
   This impacts dedup expectations, GC correctness, rename behavior, and “browsability”
   claims.

2. **`remote_prefix` + “refs must be committed” is internally contradictory (and creates
   workflow friction).** The doc says sync only operates on committed refs, but later
   describes scenarios that require operating on uncommitted refs, and also says sync
   may modify refs (to set `remote_prefix`). This needs a crisp definition of what git
   state blobsy reads (working tree vs index vs HEAD), and when `.yref` is allowed to
   change.

3. **Garbage collection reachability semantics are underspecified and potentially
   dangerous.** If GC only looks at “current `.yref` on branch heads,” you lose the
   “checkout old commit and pull” promise.
   If GC walks history, `.blobsy/trash` becomes far less necessary (and the doc’s stated
   rationale changes). You need to decide and specify.

4. **Compression/remote representation mapping needs to be explicit.** The doc
   references a “`.zst` suffix convention” but the remote key examples don’t encode it
   clearly. This matters to avoid collisions and to make GC / remote checks
   deterministic.

**P1 (strongly recommended):** 5. **Add a first-class “check remote presence” guardrail
for CI.** Your own “corner cases” section correctly identifies “committed ref but forgot
to push data” as a common failure mode.
A `blobsy check-remote` (or `blobsy verify --remote`) should be part of the minimal V1
experience.

6. **Harden the stat-cache correctness story.** mtime/size caching is fine, but the doc
   currently overstates safety (“mtimeMs is sufficient”) and includes a few questionable
   assumptions. Add a racy-file safety rule and/or more stat fields.

* * *

## 2) Market / ecosystem positioning

### Where blobsy v2 fits

Blobsy v2 is aiming to occupy a very specific “middle ground”:

* **LFS-like ergonomics** (small refs in Git, big blobs elsewhere)
* **Without** Git-provider lock-in and LFS bandwidth pricing traps
* **Simpler than** DVC / git-annex in both dependency footprint and conceptual surface
  area
* **More automation-native** than most alternatives (npx install, `--json`, strict
  non-interactive ops)

The attached landscape research describes a real gap here: teams often end up with
*tarballs on S3 + ad-hoc scripts* or use LFS/DVC with compromises.
Blobsy’s “plain directories + explicit sync + pluggable S3-compatible remotes” can fill
that gap for teams who:

* want **cheap storage + predictable costs** (their own bucket),
* want **Git-native review/merge for references**,
* and can accept that **sync is an explicit command** (not fully transparent like LFS
  filters).

### Key differentiation vs the “big three”

**vs Git LFS**

* Blobsy gives cost control and backend neutrality, and can add compression policy.
* But you give up the killer feature: *transparent* checkout/push/pull integration.
  That’s the core adoption risk.
  If blobsy doesn’t provide an equivalent convenience mechanism (optional hooks,
  wrappers, or CI guardrails), many teams will still default to LFS despite cost issues.

**vs DVC**

* Blobsy can be dramatically simpler (fewer concepts) and friendlier in Node ecosystems.
* But DVC’s long-term advantage is the mature “content cache + cross-workspace dedup +
  big ecosystem.” Blobsy should not try to be DVC. It should win by being **small,
  predictable, and hard to misuse**.

**vs git-annex**

* Blobsy is far simpler and CI-friendly.
* You lose annex’s distributed multi-remote “I know where every copy is” model, but
  that’s fine for the target use case (S3 bucket as the shared source of truth).

### The “does it fill a room?” answer

Yes—*if you lean into the right segment*:

* repos that generate **large artifacts, datasets, or model outputs**, and
* teams that want a **minimal CLI** that works with “just S3/R2 + git,”
* especially where automation/agents/CI are first-class.

The biggest go-to-market/UX risk is “manual sync discipline.”
Your design needs strong guardrails to prevent “refs in git but blob missing” and “blob
uploaded but ref forgotten.”

* * *

## 3) Architectural review of v2

### The core model is solid

The most compelling element of v2 is this invariant:

> **Git stores the desired state (refs), blobsy sync materializes it (data).**

Per-file `.yref` refs:

* make diffs meaningful (per-file hash changes),
* make merges align with Git’s merge model,
* and avoid all directory-manifest merge complexity.

This is a great example of “make the simplest thing the correct thing.”

### Content-addressable remote is the right default (with one caveat)

Content-addressable storage:

* eliminates post-merge promotion,
* avoids “remote overwrite conflicts” for normal workflows,
* enables history semantics (until GC).

**Caveat:** the spec must be consistent about *what is content-addressed*:

* If the remote key includes `/<repo-relative-path>`, you are not purely
  content-addressed; you are “content-addressed *per path*.” That’s still useful, but it
  changes dedup and GC requirements.

### Single-writer-per-file is a reasonable collaboration stance

Your conflict model is realistic:

* Partitioned/multi-writer across *different files* is the common case and works great.
* Same-file concurrent edits become normal Git conflicts in `.yref`.

I’d keep this: it’s simple, teaches the right mental model, and avoids inventing a
custom conflict resolver.

* * *

## 4) Versioning + branching workflows (deep dive)

This is where v2 is strongest conceptually—and where a few details need tightening.

### What v2 gets right

1. **Branch merges don’t require remote promotion** (the old v1 trap).
   With a global CAS namespace, “blob is already there” is true as long as both branches
   push to the same remote backend.

2. **Rebase/cherry-pick semantics are naturally Git semantics.** `.yref` is just a file.
   That’s good.

3. **Old commit checkout is possible** *as long as GC doesn’t remove the blobs.* This is
   the right promise—but it must be backed by a correct GC definition.

### The big unresolved question: what history does GC preserve?

Your doc implies both:

* “Git history of `.yref` files = full versioning,” and
* “GC shouldn’t have to walk the entire git history; trash avoids it.”

Those are in tension.

You need to specify **one of these** as your product contract:

**Option A: Full-history preservation (git-like reachability)**

* GC considers a blob “live” if referenced by any `.yref` in any commit reachable from
  selected refs (`--all`, `--branches`, `--tags`, etc.).
* This preserves the “checkout old commit and pull” promise robustly.
* Downside: GC must walk history (or you maintain an index/cache).

**Option B: Head-state preservation (latest state per branch only)**

* GC only keeps blobs referenced by current branch heads (and maybe tags).
* This is closer to “sync tool” behavior than “versioned artifact store.”
* It breaks “time travel” unless users tag releases or disable GC.

**My recommendation:** **Option A** as the default *contract*, with guardrails:

* It’s consistent with your “Git is the manifest / full versioning” story.
* It avoids surprising users who assume old commits remain usable.
* GC can still be practical with indexing and with `--older-than` policies.

If you truly want to avoid walking history, you must *explicitly downgrade* the
versioning guarantee and document that old commits are not reliably materializable after
GC.

### Branch coordination and safety

The most common real-world failure mode isn’t a merge conflict—it’s **missing blobs**.

You already call out:

* “Committed ref but forgot to push data.”

To make branching workflows reliable, you should add at least one of these:

1. **CI guardrail (recommended minimal):**

   * `blobsy check-remote` (or `blobsy verify --remote`) that ensures every `.yref` in
     the working tree has a corresponding remote object.
   * This should be easy to run in PR checks.

2. **Optional git hook installation (strongly recommended for adoption):**

   * `blobsy install-hooks` that adds a `pre-push` hook to run `blobsy push` for changed
     refs, or fail if remote missing.
   * Make it optional (not required for the design), but it will dramatically reduce
     “human process” failures.

3. **Workflow guidance that is explicit and enforced by tooling:**

   * If you keep the “refs must be committed” rule: enforce “don’t push git until blobs
     uploaded” via a pre-push check.

* * *

## 5) Detailed design review (spec-level)

### 5.1 `.yref` file format

**What’s good**

* Minimal fields: hash + size + (optional) remote metadata.
* Stable key ordering is smart for diff/merge.
* Format versioning (`blobsy-yref/0.1`) is the right direction.

**Gaps / improvements**

1. **Algorithm agility:** Right now the hash field is `sha256: ...`. If you ever want to
   support an alternate hash algorithm, you’ll need either:

   * `oid: sha256:<hex>` (LFS-style), or
   * `hash: { alg: sha256, hex: ... }`, or
   * keep `sha256` but add a `hash_alg` and accept duplication.

   The LFS-style `oid` is compact and future-proof.

2. **Remote representation fields need to be sufficient to compute the remote key
   deterministically.** If compression affects the stored object name (e.g., `.zst`),
   your `.yref` must make it possible to compute:

   * the **exact remote key**, or
   * a deterministic mapping from `(path, sha256, compression)` → key.

   Right now the doc hints at `.zst` suffix but doesn’t specify the mapping.

3. **Avoid storing redundant/derived fields in refs unless you truly need them.**
   `remote_prefix` is suspicious in content-addressable mode, because it’s derivable
   from `sha256` and config.
   If you keep it, it should be for layouts where the location is *not derivable*
   (timestamp mode, future routing).
   Otherwise it creates extra churn and coordination issues.

* * *

### 5.2 Remote key layout and dedup

This is the most important “spec correctness” area to tighten.

#### The doc currently conflicts on this point

* It claims: “Same content = same hash = same remote key.
  Never re-uploaded.”
* But it also defines the key as: `sha256/<hash>/<repo-relative-path>`.

Those two statements can only both be true if `<repo-relative-path>` is constant across
all uses of that content (it isn’t).

#### Decide what dedup you actually want

There are three plausible designs:

**Design 1: CAS per file path (current implied behavior)**

* Key includes `(hash + relative_path)`.
* Dedup works across branches and history for a *given path*.
* Rename/move loses dedup.
* GC must reason about *keys*, not just hashes, if you want to delete old-path
  duplicates.

**Design 2: Pure CAS (max dedup)**

* Key is just `sha256/<hash>` (plus maybe compression suffix).
* Rename/move is free.
* Remote isn’t “path-browsable” without a separate index.

**Design 3: Dual view**

* Canonical object at `sha256/<hash>`.
* Optional “aliases” under `paths/<relative_path>` (either duplicate data or small
  pointers).
* This reintroduces some “manifest-like” behavior but can be optional.

**My recommendation for v2:** Pick **Design 1 or Design 2**, but write the spec so it is
100% consistent. If you keep Design 1, **stop claiming global dedup** and adjust GC
accordingly. If you want the strongest story (“content-addressable = dedup”), use Design
2\.

* * *

### 5.3 Compression: correctness, determinism, and mapping

Your backing-store research is right: client-side compression is the portable approach,
and “Content-Encoding tricks” introduce edge cases.

**What’s good**

* Compression is optional, rule-driven, and recorded in the ref.
* You correctly separate “hash of original bytes” from “stored bytes can be compressed.”

**What needs to be made explicit**

1. **Remote object naming with compression** If you store compressed bytes, you should
   specify something like:

   * if `compressed: zstd`, remote key ends with `.<something>` (e.g., `.zst`)
   * if `compressed: none`, remote key is the plain name

   This prevents collisions and makes debugging easier.
   The spec hints at `.zst` but doesn’t lock the rule.

2. **Compression parameters must be part of the ref contract if they affect bytes.** If
   you expose “compression level” in config, it changes stored bytes.
   Either:

   * freeze it (repo-config only, and recorded per blob), or
   * make stored bytes independent of level (not realistic), or
   * include enough info in `.yref` to interpret the stored blob.

3. **Branch divergence on compression config** If two branches push the same file
   content but with different compression policies, you need to guarantee that:

   * they don’t overwrite the same remote object unintentionally, and
   * `.yref` always matches what’s actually stored.

   The easiest way to guarantee this is: **compression affects the stored object name**
   (suffix) and `.yref` records it.

* * *

### 5.4 Transfer delegation and remote-existence checks

**What’s good**

* Treating external tools as copy engines avoids “sync engine mismatch” when remote
  representation differs from local.
* “auto” selection with capability check + `doctor` is sensible.

**Gaps**

1. **Remote existence checks are not specified.** `blobsy sync` relies on knowing
   whether a blob exists remotely.
   How?

   * `HeadObject` (S3 API) is obvious for built-in.
   * For aws-cli/rclone, you likely still need a `head/ls` query, or accept “just upload
     and overwrite” (which undermines “never re-uploaded” claims).

   You should specify:

   * whether push does a remote existence check,
   * whether pull does (it must, at least via download error),
   * and whether there is a “trust remote_prefix means pushed” shortcut (dangerous).

2. **Per-file subprocess overhead** Spawning `aws s3 cp` for every file can be very slow
   for many files. Even if v2 primarily targets “large files,” directory tracking can
   still create “lots of medium files.”

   If you keep per-file orchestration, I’d strongly recommend:

   * **batch mode for s5cmd** early (it’s a key differentiator),
   * and a built-in engine that can do parallel multipart uploads efficiently.

* * *

### 5.5 Atomic writes and crash safety

Your atomic write research is solid and the v2 doc mostly reflects it.

**What’s good**

* Explicitly calling out that built-in SDK path must do temp+rename is correct.
* Cleaning orphaned temp files is good hygiene.

**Gaps / improvements**

1. **Be precise about overwrite semantics on all OSes.** Atomic rename behavior differs
   across platforms when destination exists.
   Your implementation needs to guarantee:

   * no partial file at final path,
   * and correct replacement semantics (or explicit “must not overwrite unless
     --force”).

2. **Two-stage temp files for compressed pulls** If you download a compressed blob to
   temp, then decompress, you either:

   * decompress into a *second* temp and rename to final, or
   * stream decompress directly into a temp final-path and rename once.

   The spec should pin a single approach to avoid subtle bugs.

* * *

### 5.6 Gitignore management

**What’s good**

* “Blobsy-managed block” markers are excellent.
* Explicit per-file entries avoid glob footguns and negation complexity.

**Issues to fix**

1. **Path relativity is unclear and likely wrong in examples.** The spec says it
   modifies the `.gitignore` in the same directory as the tracked path (DVC-style).
   If so, entries should generally be relative to that directory, not
   repo-root-prefixed.

   Right now, examples show repo-root-prefixed paths inside a per-directory
   `.gitignore`. This will mis-ignore files if implemented literally.

2. **Merge conflict potential on `.gitignore`** Sorting lines helps, but two developers
   tracking different files in the same directory will both touch the same block.
   You’ll get merges; often auto-merge works, but you should ensure:

   * deterministic sort order,
   * and stable formatting.

* * *

### 5.7 `.blobsy/trash` and garbage collection

The “trash” idea is clever as a *paper trail* and an “undo buffer.”
But as currently described it also creates spec tension.

**Key questions to answer**

1. **Is trash required for correctness or just convenience?** If GC walks git history to
   find all referenced `.yref` hashes, trash isn’t needed for correctness.
   If GC does *not* walk history, then your “versioning via git history” claim becomes
   weak.

2. **If trash is committed to git, GC becomes a git-modifying operation.** That means
   running GC produces changes that must be committed (or it will be messy).
   The doc should explicitly state:

   * whether `blobsy gc` modifies git-tracked files,
   * and what the expected workflow is (run on main, commit the GC changes, etc.).

**My recommendation**

* Keep trash, but reframe it as **optional workflow convenience**, not a core GC
  mechanism.
* Define GC reachability primarily in terms of **git history** (Option A above).
* If you later want a faster GC, add a local index/cache rather than making trash the
  primary mechanism.

* * *

### 5.8 Stat cache correctness and maintainability

**What’s good**

* Using stat cache as an optimization, not part of correctness, is right.

**What to harden**

1. **Racy file safety:** The doc says “sub-ms modifications are unlikely,” but they do
   happen in automated pipelines and on filesystems with coarse timestamp resolution.
   A robust pattern:

   * if `(mtime, size)` match cache but `mtime` is “too recent” (within a small window),
     rehash anyway, or
   * store additional stat fields (ctimeMs, inode when available), or
   * store a file-id fingerprint per platform.

2. **The “after git checkout mtime reset on all” claim is suspect** Git checkout doesn’t
   touch gitignored data files.
   If your cache invalidates on checkout, it will be due to other reasons (e.g., files
   actually re-downloaded), not checkout itself.
   The doc should be accurate here to avoid confusing implementers.

* * *

### 5.9 Security / trust model

The `command` backend trust gating is a strong, necessary decision.

**Additional hardening I’d recommend**

* Ensure YAML parsing is done in a “safe schema” mode (no custom tags/functions).
* Treat paths as untrusted: prevent `../` traversal on pull and ensure writes stay
  within repo root.
* Use `execFile` with args arrays (never `shell: true`) for all delegated tool calls;
  handle quoting carefully.

* * *

## 6) Concrete spec inconsistencies / errors to fix in `blobsy-design-v2.md`

These are the ones I would file as “doc correctness” tickets:

1. **Dedup claim vs remote key definition**

   * Claim: “Same content = same key.”
   * Definition: `sha256/<hash>/<repo-relative-path>`. These contradict.
     Pick one and update text and examples.

2. **Timestamp-hash layout description contradicts its own example** The text says
   “unchanged files are re-uploaded (no dedup),” but the example shows only changed
   files in the later prefix.
   Clarify whether it’s:

   * full snapshot per push, or
   * per-push prefix containing only changed files (and `.yref` points per-file).

3. **Invariant “sync only operates on committed `.yref`” conflicts with corner-case
   scenarios** Several pitfalls described (“pushed but forgot to commit ref,” “switched
   branches without committing”) only make sense if blobsy can push based on uncommitted
   refs. Decide:

   * does blobsy read refs from working tree, index, or HEAD?
   * and enforce consistent semantics across doc.

4. **`sync` mutating `.yref` (remote_prefix) conflicts with “doesn’t modify refs”
   messaging** The doc says it doesn’t modify `.yref` files “except to set
   `remote_prefix`.” That exception matters a lot; it changes how many commits users
   need and how “Git is manifest” really works.
   Clarify expected workflow.

5. **Gitignore examples likely use incorrect path form for per-directory `.gitignore`**
   If `.gitignore` is in the same directory as the tracked file, entries should be
   relative to that directory, not repo-root-prefixed.

6. **Directory tracking example appears inconsistent with default externalize rules**
   The example keeps a 2MB `.json` “in git (never list)” but the shown defaults would
   externalize by `min_size: 1mb` unless `.json` is in `externalize.never`. Either
   update defaults, or update the example to match.

7. **Command list includes `export/import` but later says export/import is deferred**
   Pick one for V1 and keep it consistent.

8. **Minor terminology confusion: “v2 design doc” but section titled “V1 scope”** This
   is likely just naming (“v2 architecture, V1 shipping scope”), but it should be
   explicit so implementers don’t misread priorities.

* * *

## 7) Recommended changes (prioritized)

### P0: Before implementation / before you treat the spec as “locked”

1. **Lock the remote key scheme + dedup contract**

   * Decide CAS-per-path vs pure CAS.
   * Specify exact remote key mapping including compression suffixes.
   * Update GC algorithm to match.

2. **Define what git state blobsy uses for refs**

   * Working tree vs index vs HEAD.
   * I strongly recommend: **status uses working tree; push/pull/sync operate on working
     tree refs**, with warnings or safeguards when refs are untracked/uncommitted
     (rather than a hard “must be committed” rule that blocks real workflows).

3. **Define GC reachability and defaults**

   * If you want the “old commit pull works” promise, GC must preserve history by
     default.
   * Add safe defaults (`--older-than` default, or require explicit flags to delete).

4. **Add a CI-safe remote presence check**

   * `blobsy check-remote` or `blobsy verify --remote` should exist in V1.

### P1: Very high leverage for adoption

5. **Optional hook installer**

   * `blobsy install-hooks` (pre-push) to prevent missing blobs.
   * Make it optional so the “no hooks required” promise remains true.

6. **Batch transfer support for high file counts**

   * Prioritize s5cmd batching if you want directory tracking to feel fast.

7. **Stat cache hardening**

   * Add racy-file safeguards and better file identity signals.

### P2 / future

8. **Parallel `.yref` directory option sooner than later**

   * This is mostly UX/cleanliness, but it matters for repos with many tracked files.

9. **Global cache / hardlinking (DVC-like)**

   * Not required for v1, but it’s the main path to “multiple clones don’t duplicate
     disk usage.”

* * *

## 8) References (attached)

* [blobsy-design-v2.md](sandbox:/mnt/data/blobsy-design-v2.md)
* [research-2026-02-19-sync-tools-landscape.md](sandbox:/mnt/data/research-2026-02-19-sync-tools-landscape.md)
* [research-2026-02-19-atomic-file-writes.md](sandbox:/mnt/data/research-2026-02-19-atomic-file-writes.md)
* [research-2026-02-19-backing-store-features.md](sandbox:/mnt/data/research-2026-02-19-backing-store-features.md)
* [blobsy-design-v1.md](sandbox:/mnt/data/blobsy-design-v1.md)
