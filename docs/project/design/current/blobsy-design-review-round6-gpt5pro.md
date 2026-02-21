# Senior engineering review: **blobsy (V2 consolidated design)**

*(Architectural → product/market placement → workflows/versioning/branching → detailed
spec + corner cases → inaccuracies/nits → prioritized recommendations)*

## 0) Executive summary

**What’s strong / makes sense**

* **Per-file ref files committed to Git** is the right foundational choice.
  It collapses a lot of “directory manifest” complexity, makes merges naturally
  per-file, and leverages Git’s conflict machinery rather than reinventing it.
* **Delegating transfer + storage to existing tools** (aws-cli, rclone, template
  commands) keeps scope sane and reduces infrastructure burden.
* **A stateless CLI + machine-readable output** is exactly what modern
  CI/automation/agent workflows want.
* The design explicitly thinks about **integrity, atomicity, idempotency, and trust
  boundaries**—rare and good for a “simple CLI” tool.

**Primary architectural gaps / risks**

1. **Rename/move semantics are not solved** for gitignored payloads.
   Without a first-class `blobsy mv` (or a robust story), real repos will drift: refs
   move via Git, but ignored payloads do not.
   This becomes a constant foot-gun.
2. **Inconsistent invariants around “committed vs working tree”**: some sections say
   `sync/push` operate on uncommitted refs with warnings; elsewhere “sync only operates
   on committed refs.” Pick one model and enforce it consistently in code + docs.
3. **Default remote key template likely creates unnecessary churn** and encourages
   awkward “push updates .yref” workflows.
   A deterministic CAS-first default would simplify versioning/branching and reduce
   “two-step commit” traps.
4. **GC is underspecified for safety at scale** (multiple clones, partial refs, S3
   listing cost, multi-repo prefixes, and “only delete what we’re sure is ours”). It’s
   feasible, but needs a stronger safety model than “list remote and diff.”
5. **Schema/versioning for `.yref` needs future-proofing** (hash algorithm agility,
   compression metadata, remote address evolution).

**Strategic direction**

* If blobsy is “Git LFS without server support + DVC without heavyweight ecosystem,”
  then the differentiator must be: **minimal operational burden, pluggable storage, and
  boring workflows**. That means: deterministic keys by default, minimal ref churn, and
  very clear branch/merge semantics.

* * *

## 1) Market / ecosystem placement (“does this fill a room?”)

### Comparable tools (and the “room” blobsy aims to fill)

* **Git LFS**: pointer files + external storage, but typically requires platform/server
  LFS support and has a specialized protocol and workflow expectations.
  ([GitLab Docs][1])
* **DVC**: also pointer files and pluggable remotes, but it’s Python-centric and its
  UX/mental model is “data pipelines,” not “simple sync.”
  (Your design is explicitly “stateless CLI, Git is the manifest.”)
* **git-annexest philosophical neighbor: content-addressed storage, many remotes,
  “largefiles” rules, and strong distributed workflows.
  ([changelog.complete.org][2]) **Implication:** blobsy must clearly explain “why not
  git-annex?” The answer can be valid—e.g., *simpler mental model (no symlinks),
  friendlier for S3 browsing, better agent-friendly JSON, and fewer modes*—but it should
  be explicitly articulated.

### Does blobsy fill a gap?

Yes—**if you optimize hard for “simple + stateless + infra-neutral + pointer files
committed to Git”** and avoid the operational burden of LFS servers and the ecosystem
footprint of DVC/git-annex.
That’s a real niche, especially for:

* teams using object stores directly (S3/R2/MinIO/etc.),
* automation/agents that need `--json`,
* repos where “just store a blob in a bucket” is preferred to running an LFS service.

But to “fill the room,” blobsy must win on **workflow friction**. The current design has
some friction points (rename/move, remote_key churn, commit/push coordination) that will
dominate user perception unless addressed.

* * *

## 2) Architectural review (top-down)

### 2.1 The “one primitive” model is excellent—keep it

“One file ↔ one `.yref` ↔ one remote blob” is a powerful simplifying constraint.
It turns many tricky distributed problems into:

* “Git handles merge conflicts for refs”
* “Storage is dumb”
* “Sync is a per-file operation” This is the right architecture for a CLI tool.

### 2.2 “Git is the manifest” is a good bet—with one caveat

Using `.yref` files as the manifest is great: versare “just Git.”
**Caveat:** Git only versions the ref files.
If your data lifecycle (GC/retention) allows blobs referenced bypear, you’ve effectively
broken “Git is the manifest” for historical checkouts.
So you need a first-class **retention policy model** (even if it’s “we never delete
unless explicitly asked”).

### 2.3 Delegation to existing transfer tools is strategically correct

Leaning on aws-cli/rclone gives you resilience, auth maturity, and performance without
re-implementing transfer logic.
However: relying on tool internals for things like atomicity is risky (details below).

### 2.4 Remote key tebut it’s also a major complexity magnet

Configurable key templates are flexible, but they create long-tail corner cases:

* branch renames and detached HEAD,
* cross-user consistency,
* template evolution/migrations,
* GC safety when templates change,
* deterministic vs time-based addressing.

This is an area where you’ll want **opinionated defaults** and “escape hatches,” not
“everything is flexible by default.”

* * *

## 3) Versioning + branching workflows (deep focus)

### 3.1 The best default for versioning/branching is **deterministic CAS**

Your design offers multiple layouts (timestamp+hash, pure CAS, branch-isolated, shared
path). For *branching and merging*, the lowest-friction model is:

* **Default remote layout = pure content-addressa**, optionally with a debug suffix
  (`---<filename>`).

  * Merge behavior becomes trivial.
  * Remote keys don’t depend on time/branch.
  * `push` doesn’t need to mutate refs beyond recording “uploaded/present” (and arguably
    doesn’t need to record that at all).
  * GC can be correct with simple “reachable refs → referenced hashes.”

If you keep timestamp+hash as the default, you are choosing “browsability by time” over
“workflow simplicity,” and it will cause:

* more ref churn,
* more storage duplication,
* more “why did my `.yref` change when I pushed?”
  confusion.

**Recommendation:** make **pure CAS the default**, and treat time/branch prefixes as
advanced/opt-in.

### 3.2 Branch-isolated mode has a subtle but serious hazard

**→ blobsy-pqxs: Move Branch Isolated Mode to V2, keep git hash/date/fixed modes in V1**

In branch-isolated layout, refs merged into `main` may still point to `feature/...`
remote keys. That means **you cannot delete the feature namespace** without potentially
breaking main—even after merge—unlate” objects.

You mention “optional re-push on main to migrate blobs.”
That’s not optional in practice; it’s required if you want sane cleanup.

**Recommendation:** if you keep branch-isolated mode:

* Provide a first-class command like `blobsy promote --from feature/x --to main` or
  `blobsy rewrite-remote-keys --to-template <...>` that updates refs + ensures objects
  exist at the new keys.
* Or explicitly label branch-isolated mode as “temporary experimentation; requires
  promotion before cleanup.”

### 3.3 Detached HEAD and branch name stability

You allow `{git_branch}` in templates.
You need an explicit policy for:

* detached HEAD (CI often runs detached),
* branch names containing slashes ,
* branch renames (Git allows it; remotes diverge).

Even if this is “advanced,” you should define behavior:

* if branch is unavailable: error vs fallback to `detached/<shortsha>` vs `HEAD`.
* sanitize mapping (and document it).

### 3.4 Commit/push coordination is currently the biggest workflow trap

Your design recognizes two user error modes:

* pushed data but forgot to commit ref change,
* committed ref but forgot to push data.

This is not just a footnote—this will be the #1 source of user pain.

**Ways to reduce this pain (pick at leasush not require ref mutation in the common
case.** Deterministic CAS keys allow pull to locate blobs without storing a time-based
`remote_key` in the ref.
2. If you must store `remote_key`, store it deterministically (CAS), and make
timestamping a **remote metadata/tag** concern rather than part of the key.
3. Add a “preflight”/CI check: `blobsy check-remote` that verifies every `.yref` in HEAD
has a corresponding remote object (fast HEAD requests).
4. Add an optional “safe mode” that refuses to push unless refs are staged/committed, or
conversely refuses to exit success unless refs are staged after mutation.

* * *

## 4) Detailed design review (spec-level)

### 4.1 `.yref` schema + versioning

Current format includes `format: blobsy-yref/0.1`, `sha256`, `size`, `remote_key`, and
optional compression fields.

**Gaps / improvements**

* **Hash algorithm agility:** the field name is `sha256`, which bakes in the
  algorithma512/blake3/etc., you’ll need a schema break.
  Consider:

  ```yaml
  hash:
    alg: sha256
    value: <hex>
  size: <bytes>
  ```

  **→ blobsy-ojz7: Add ‘sha256:’ prefix to hash string in .yref file format**

* **Compression correctness:** you store hash of original content (good), but for
  debugging and remote verification you may also want:

  * `stored_size` (you have `compressed_size`)
  * optional `stored_hash` (hash of compressed bytes) for certain backends or to detect
    corrupted stored objects without download (when combined with provider HEAD
    checksums).

* **Remote addressing evolution:** `remote_key` is currently a single string.
  If you ever want multi-remote fallback, mirrors, tiered storage, etc., you’ll want a
  structure:

  ```yaml
  remotes:
    - backend: default
      key: ...
      stored_checksum: ...
  ```

  Even if V1 only supports one remote, designing for extensibility early reduces format
  churn.

### 4.2 Remote key templates

Templates are flexible and a major feature.
**But** they introduce correctness requirements you should codify:

* define evaluation time: is `{iso_date_seper run** or per file?
  If per file, “batch grouping by timestamp” is flaky.
* define path normalization: Windows path separators should not leak into remote keys;
  enforce posix separators.
  **→ blobsy-m9nb**
* define allowed character set and forbid path traversal sequences for `local` and
  `command` backends.

**Security hardening note:** If `remote_key` can contain `../` or shell metacharacters,
then `command`/`local` backends can be exploited even in trusted repos by malicious
refs. “Trusted” should not mean “no escaping/sanitization.”

### 4.3 State model + command semantics: resolve contradictions

You have two competing statements:

* `push/sync` can operate on uncommitted refs with warnings (working tree semantics).
* later: “`blobsy sync` only operates on files whose `.yref` is committed to git.”

Pick d align:

* docs,
* CLI behavior,
* exit codes,
* JSON output schema.

**Suggestion:*des:

* default: working-tree semantics (more ergonomic),
* `--require-clean` / `--require-committed` for CI and “safe automation.”

### 4.4 Gitignore management

Per-file explicit ignore entries in a marked block is a solid choice.
**Corner cases to handle**

* existing user-managed `.gitignore` blocks and ordering,
* path normalization (es
* renames/moves (see below),
* ensuring `.yref` is never ignored by broad rules (users often ignore `data/`).

You may also consider adding a `blobsy doctor` check: “your `.yref` files are ignored by
Git” as a hard error.

### 4.5 Rename/move is currently a P0 gap

Because payloads are gitignored, **Git cannot move the actual file**, only the `.yref`.
That means:

* `git mv data/a.bin.yref data/b.bin.yref` moves the ref, but the local file stays
  `data/a.bin`.
* on another machine, only the ref move is seen; there is no file to rename.

**This is not an edge case; it will happen constantly.**

You need one of:

* `blobsy mv <old> <new>` that:

  * moves the local payload,
  * moves the `.yref`,
  * updates `.gitignore` entries,
  * and (optionally) avoids re-upload if CAS.

* OR enforce “never rename tracked payloads; treat rename as delete+add” (and document
  very loudly, with tooling to assist).
  This is less desirable.

### 4.6 Atomicity and partial files

**→ blobsy-5o3h: Implement atomic downloads: temp file with hash verification, then
rename into place**

You state external tools handle atomic writes for downloads.
That’s not something I’d rely on across tools/platforms.
A safer pattern:

* always download to a blobsy-managy hash,
* then rename into place.

This gives you:

* consistent behavior regardless of transfer engine,
* integrity checks before clobbering,
* safer `--force` semantics.

### 4.7 Integrity claims: good approach, but tighten where needed

* The portable “compute our own SHA-256” approach is correct.
* Your mention of S3’s default checksums is directionally right; AWS has expanded
  checksum support and defaulns.
  ([Amazon Web Services, Inc.][3])

**Improvements**

**→ blobsy-diee: V2: Remote checksum support - store provider ETag/checksums in .yref
for fast verification**

* Offer an optional “fast remote verification” mode: store provider checksum/ETag values
  in `.yref` after upload (where available) and compare via HEAD calls.
* Explicitly document multipart edge cases for ETags; do not treat ETag as MD5 except in
  known cases.

### 4.8 Stat cache correctness

The “git-index-like” stat cache is a strong performance choice.
But add guardrails for:

* filesystems with coarse mtime resolution,
* clock skew / weird mtimes from unzip/copy tools,
* network filesystems,
* “changed content, same size, same mtime” (rare but possible).

**Recommecape hatch:

* `--no-stat-cache`
* periodic sampling (rehash 1/N files)
* optionally incorporate inode+ctime where available.

### 4.9 Security and trust model: good start, needs one more layer

Disallowing repo-config `command` backends unless explicitly trusted is the right
default. But also consider:

* **argument escaping** for template variables (spaces, quotes),
* **remote_key sanitization** to prevent `../` traversal with `local`/`command`,
* “dangerous operations in hooks”: even if you avoiy wrap blobsy in scripts; make
  `--json` outputs stable and easy to parse.

### 4.10 GC: correct high-level idea, but safety model needs reinforcement

Your deferred `gc` design includes depth/age and dry-run safety.
What’s missing:

* **multi-clone safety:** a clone might not have all refs/tags fetched; GC could delete
  objects still referenced elsewhere.
  “Fetch all refs/tags” should be an enforced precondition, or GC should be rud
  environment (CI with `--mirror` clone).
* **scope safety:** only delete objects under blobsy’s prefix and ideally only those
  that blobsy “owns.”
* **scale:** listing all objects can be expensive (and slow) in large buckets.

**Recommendation: adopt a two-tier GC**

1. **Trash-driven GC (safe default):** delete only objects whose keys appear in
   `.blobsy/trash/` and are not referenced by any reachable ref.
   This aligns deletion with explicit user intent and avoids “delete unknown objects.”
2. **Full unreferenced sweep (opt-in):** `blobsy gc --sweep` that does remote listing
   diffs, with stronger warnings and required parameters.

* * *

## 5) Maintainability / implementation guidance

### 5.1 Make the internal architecture mirror the conceptual simplicity

Suggested module boundaries:

* `yref/` (parse, validate, canonical write order)
* `config/` (hierarchical resolution + deterministic merge semantics)
* `planner/` (diff local/ref/remote → plan actions)
* `transfer/` (engines: aws-cli, rclone, sdk, command)
* `store/` (backend-specific key building + HEAD/list/delete)
* `ui/` (human output + JSON schema)
* `fs/` (atomic writes, temp files, stat cache)

This makes it far easier to test planner logic without doing I/O, and swap transfer
backends later.

### 5.2 Define merge semantics for hierarchical `.blobsy.yml` precisely

**→ blobsy-fxrg: Document .blobsy.yml merge semantics: arrays/objects are replaced, not
merged**

Right now “settings merge” is too ambiguous for lists.
You need to decide:

* are arrays replaced, appended, or “append unless explicitly cleared”?
* how do you clear an inherited list?
  (e.g., `always: []` vs `null`)
* how do you merge nested objects?

A strict documentedit worked on my machine” remote incompatibilities.

### 5.3 Treat “determinism” as a feature for maintainability

**→ blobsy-62i6: Add ‘determinism as a feature’ to design principles section**

The more you can make:

* remote addressing,
* `.yref` contents,
* and outputs deterministic and stable, the less churn, fewer merge conflicts, and fewer
  “why did this change” bug reports.

* * *

## 6) Errors, inaccuracies, and spec inconsistencies I noticed

### 6.1 SHA-256 short collision math is off

**→ blobsy-p3u3: Fix SHA-256 short collision math (12 hex chars = 48 bits, collision at
~2.4M not 16M)**

You state 12 hex chars = 48 bits and “~~1% chance after 16 million files.”
Using the birthday bound, 1% collision probability for 48-bit space happens around
**~~2.4 million** samples, not 16 million (order-of-magnitude, but materially
different).
**Fix:** either correct the math or increaort` default length (e.g., 16 chars
/ 64 bits) to push collision risk effectively to “never.”

### 6.2 `{iso_date_secs}` format string typo

**→ blobsy-9mpf: Fix {iso_date_secs} format string typo (remove extra ‘s’ in
YYYYMMDDTHHMMSSsZ)**

You describe `YYYYMMDDTHHMMSSsZ` (extra `s`) in one place.
Likely intended: `YYYYMMDDTHHMMSSZ`.

### 6.3 Remote “batch dedup” phrasing is misleading for the timestamp+hash template

**→ blobsy-93b1: Clarify remote ‘batch dedup’ only applies to same
path+content+timestamp, not batch-wide**

The default template includes `{repo_path}`; so identical content at different paths
will not e same second.
Clarify: it dedupes **same path + same content + same timestamp**, not “batch-wide
dedup.”

### 6.4 `sync` semantics contradiction (mentioned above)

**→ blobsy-j3bw: Resolve sync semantics contradiction: clarify whether sync operates on
committed vs uncommitted refs**

Resolve and rewrite the spec so there’s one truth.

### 6.5 Don’t oavior of external tools

Even if aws-cli/rclone usually do something safe, it’s better to implement atomicity as
a blobsy invariant (download to temp + verify + rename).

### 6.6 Node zstd support statement should be more precise

**→ blobsy-mhfd: Specify exact minimum Node.js version for zstd support in design doc**

Node’s `node:zlib` does include Zstd in current docs, but the exact version where it
becomes stable/available matters for “no external deps.”
([Node.js][4])search12 If blobsy requires a minimum Node version, specify it
unambiguously and test that version in CI.

* * *

## 7) Prioritized recommendations (what I’d do next)

### P0 (must fix before real adoption)

1. **Introduce `blobsy mv` (or an explicit rename story).**
2. **Choose and enforce a single committed/working-tree invariant** (or add explicit
   modes).
3. **Switch default remote layout to deterministic CAS**, and position other templates
   as opt-in.

### P1 (big quality-of-life / robustness)

4. Implement “download to temp → verify → rename” for all transfer engines.
5. Make `.yref` schema future-proof: generic `hash` field, structured `remotes`.
6. Tighten config merge semantics (documented and unit-tested).
7. Provide CI-friendly checks: `blobsy check-remote` and `blobsy check-clean`.

### P2 (scale + advanced workflows)

8. Batch transfer engine abstraction (your V2 plan) and/or s5cmd/rclone batching.
9. Two-tier GC (trash-driven default + sweep opt-in), with “mirror clone required”
   safety.
10. Promotion/migration tooling for branch-isolated mode.

* * *

## 8) Final take

Architecturally, **per-file `.yref` + dumb object storage + stateless CLI** is a clean,
modern, and defensible design.
It can absolutely “fill a room,” but only if blobsy commits to being *boring and
deterministic* in day-to-day workflows.
The current spec is close—your biggest remaining challenges are **rename/move**,
**remote_key churn**, and **semantic consistency** around how `sync/push` treat Git
state.

If you want, I can also turn this into a polished internal review memo (1–2 pages) with
an “approved w/ changes” decision and a tracked issue list suitable for a design review
meeting.

[1]: https://docs.gitlab.com/topics/git/lfs/?utm_source=chatgpt.com "Git Large File Storage (LFS)"
[2]: https://changelog.complete.org/archives/10516-using-git-annex-for-data-archiving?utm_source=chatgpt.com "Using git-annex for Data Archiving"
[3]: https://aws.amazon.com/blogs/aws/introducing-default-data-integrity-protections-for-new-objects-in-amazon-s3/?utm_source=chatgpt.com "Introducing default data integrity protections for new ..."
[4]: https://nodejs.org/api/zlib.html?utm_source=chatgpt.com "Zlib | Node.js v25.6.1 Documentation"
