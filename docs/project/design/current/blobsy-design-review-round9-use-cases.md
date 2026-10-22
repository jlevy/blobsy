# Blobsy Design Review — Round 9 (Use Cases, Design Coverage, and Complexity)

**Status:** Active review — design decisions requested (see §11)

**Date:** 2026-10-22

**Reviewed revision:** `main` @ `04a3d1a` (PR #5 merge).
No code has changed since PR #4 (2026-07-31); PR #5 was documentation only.
Build passes; 24 test files / 327 tests pass; 71 golden tryscripts.

**Scope:** A full senior-engineering review of blobsy against the owner’s restated
problem framing — five pain points (PAIN-1..5) and five use cases (UC-1..5) — covering
design coverage, the shipped implementation and its workflows, engineering complexity,
and the competitive landscape as of October 2026. Rounds 7 and 8 reviewed alpha
readiness and agent run-sync respectively; this round asks whether the *design* covers
the use cases blobsy must serve, and what the smallest coherent design that covers them
looks like.

**Method.** The lead reviewer read all current design docs, rounds 7–8, the open beads,
and the source; ran the CLI on scratch repos (a 1,000-file benchmark and targeted
reproductions); and delegated in parallel:

- Four deep design reviews (one per slice): engineering complexity; UC-1 + UC-4
  (per-file mode and merges); UC-2 (collections); UC-3 + UC-5 (trees and immutable
  assets). Each ran its own experiments against the built CLI. Their full reports are
  kept alongside this document in [`round9-subreviews/`](round9-subreviews/) as
  evidence; this document is the consolidated, normative-for-discussion version.
- Six research refreshes, committed under `docs/project/research/current/`: tool
  landscape, object-store capabilities, tree manifests and cache patterns, a
  source-level review of the new competitor **Gat**, other new entrants (Epic Lore,
  git-lfs-fuse, s3lfs, Oxen, Xet), and **Jujutsu (jj)** interop.
  Third-party sources were cloned into the gitignored `attic/` for source review.

Evidence markers: **[V]** reproduced or verified against source/primary docs this round;
**[S]** verified by a sub-review (see its report); **[I]** inference or design judgment.

* * *

## Verdict

**The per-file core is the right foundation, but the design covers only one of the five
use cases well, the shipped code has three data-safety bugs in normal git workflows, and
about half of the code is accidental complexity created by two early choices.
A smaller core plus two additional reference containers covers all five use cases with
less total complexity than blobsy has today.**

1. **Coverage.** UC-1 (a few files via pointers) is covered and mostly well built.
   UC-4 (merges) is *claimed* but is unsafe in practice (§3). UC-2 (collections) is
   served only by expanding a directory into N pointers — workable to ~50 files per
   directory, unreviewable past a few hundred (§5.3). UC-3 (huge trees, nothing in git)
   and UC-5 (immutable named assets) are not covered; file mode cannot even restore a
   build tree (symlinks skipped, executable bits lost) [S]. The design doc’s founding
   principle — “one primitive … there is no second kind of thing … there are no
   manifests” — is what prevents covering UC-2/3/5, and it should be reworded (§6).
2. **Safety.** Three reproduced blockers in ordinary workflows: `sync` silently
   overwrites a tracked-but-unpushed edit after `git stash` (data loss) [V]; the
   pre-push hook uploads based on the working tree, not the commits being pushed, so
   pushing another branch ships pointers without blobs [S]; a plain `git mv` + `mv` +
   `git add -A` rename commits the large payload to git (PAIN-1 violated) [S]. Plus a
   setup bug that commits the machine-local stat cache on `git add -A` [V].
3. **Complexity.** Two early choices generate most of the accidental complexity: a
   push-time **timestamped key template** (non-derivable keys → `remote_key` written
   back after push → two commits per change, bead `blobsy-pqyt`, false dedup claims) and
   a bidirectional **`sync` with a stat-cache merge base** (a 9-state decision table, a
   583-line design doc, and the data-loss bug).
   Fixing both shrinks the code *and* is the prerequisite that makes UC-2 cheap: with
   derived keys, push/pull/status become one ~60-line loop over entries regardless of
   whether they came from one pointer or one manifest (§7).
4. **Competition.** A direct competitor, **Gat** (Sept 2026, Rust, Apache-2.0), ships a
   committed repo-wide lock file, a per-path merge driver, hydration hooks and a local
   content cache — i.e. a strong UC-1/UC-2/UC-4 story — at ~150k lines of Rust.
   It has no UC-3/UC-5 story.
   Blobsy should adopt the parts of Gat’s design that are simply correct
   (content-derived keys, per-path manifest merging, hook-independent correctness) and
   differentiate on per-collection manifests, browsable/pluggable storage, immutable
   snapshots for trees and assets, and agent UX (§9).

**Recommended path:** fix the safety bugs now (Phase 0); then simplify the core
(content-derived keys, drop the merge base, wire the hash cache, delete inert features,
create-only writes, batched transfer) before adding any new mode (Phase 1); then add
collection manifests (UC-2) and snapshots (UC-3/UC-5) on the shared core (Phases 2–3).
Twelve owner decisions gate this (§11).

* * *

## 1. The problem, restated

### 1.1 Pain points (owner’s framing)

| ID | Pain |
| --- | --- |
| PAIN-1 | No individual file over a few MB should be in git: a permanent performance penalty. |
| PAIN-2 | Very large numbers of files are slow to manage and cause noisy diff churn in PRs. |
| PAIN-3 | Large files tied into git’s hash tree make retroactive removal very hard. |
| PAIN-4 | Git LFS is disliked, partly for PAIN-3 and partly for GitHub’s LFS cost. |
| PAIN-5 | Backend storage isn’t pluggable (S3, GCS, custom), so it doesn’t fit other tools. |

### 1.2 Use cases (owner’s framing, sharpened)

| ID | Use case | What git holds | Sharpened by this review |
| --- | --- | --- | --- |
| UC-1 | A few files stored externally, versioned via per-file references; PRs show the metadata. | One pointer per file. | Unchanged. |
| UC-2 | A collection of hundreds–thousands of files managed as a unit; git holds one manifest, not a placeholder per file. | One manifest per collection, one line per file. | The manifest must be **mergeable** and **reviewable**: a static header, one sorted line per file, no aggregates (§5.3). |
| UC-3 | A very large tree (node_modules, cargo `target/`) synced/cached externally with **no** manifest in git. | Nothing per tree (a config stanza at most). | Two different workloads hide here: **derived caches** (identity = input hash, racing writers, safe to lose, TTL) and **run/output archives** (round 8: path-browsable, single writer, never deleted). They need different primitives (§5.4). “Sync” of a derived tree is a trap; the operations are *publish* and *restore*. |
| UC-4 | Standard git merge workflows for externalized files; merges happen in git on the metadata (UC-1, UC-2). | — | Merges must be correct **without the network** and **without blobsy-installed hooks or drivers** (web merges, jj, fresh clones); drivers and hooks may only *improve* the result (§4). |
| UC-5 | Fixed assets with immutable names, separate from git workflows; likely the substrate for UC-3. | Nothing, or one pin line. | Confirmed: caches (UC-3) and assets (UC-5) are **one primitive** — an immutable, named snapshot — differing only in who picks the name (derived vs chosen) and how long it lives (TTL vs forever) [S]. |

### 1.3 Use cases and requirements the framing was missing

| ID | Addition | Why it matters |
| --- | --- | --- |
| UC-6 | **Run/output archives** (round 8): process output trees mirrored to path-shaped prefixes, with receipts; append-mostly, single writer, never deleted remotely. | Real, grounded demand (the trading repo). Distinct from UC-3 caches on every axis that matters (identity, concurrency, lifecycle). |
| UC-7 | **Adoption and history import**: convert existing large files *in git history* (and LFS pointers) to blobsy references. | PAIN-3/PAIN-4 are only solved going forward today. An LFS pointer is already `sha256` + size, so `import-lfs` is nearly free once keys are content-derived [S]. |
| X-1 | **Hook-independent correctness.** | Hooks don’t run on GitHub merges, in jj, or in clones that never ran `setup`. |
| X-2 | **Partial working sets** (pull by path/glob). | Collections and assets are often larger than any one user needs. |
| X-3 | **Local content cache** shared across worktrees/clones. | Today every worktree re-downloads; Gat, LFS and DVC all have one. |
| X-4 | **Batched transfer**; no per-file process spawn. | Today one *synchronous* process per file — the documented 8-way parallelism is impossible by construction [S]. |
| X-5 | **Fidelity** for trees: symlinks, exec bits, empty dirs. | Required for UC-3/UC-5; absent today [S]. |
| X-6 | **Server-enforced immutability** (create-only writes). | Now broadly supported (S3 `If-None-Match: *`, GCS `ifGenerationMatch=0`, Azure, R2) [S]. |
| X-7 | **Write segregation for shared caches.** | First-writer-wins caches are poisonable (CVE-2025-36852, “CREEP”) [S]. |
| X-8 | **Retention / GC** that is explicit, dry-run first, reachability- or lifecycle-based. | PAIN-3’s other half: deleting blobs safely. |

* * *

## 2. Current state

### 2.1 What works

- The `.bref` pointer (YAML: `format`, `hash`, `size`, `remote_key`, compression
  fields), adjacent to a gitignored payload; git versions and merges the pointer.
- Hash-verified atomic pulls (temp + verify + rename); push refuses stale hashes
  (DS-03); pull refuses to clobber local edits (DS-02); remote keys never overwritten.
- Five backends (built-in S3 SDK, aws-cli, rclone for GCS/Azure, local, command) with a
  trust gate for repo-supplied command backends, a threat model, and path containment.
- Non-interactive CLI with `--json` everywhere; agent skill installed by `setup`.
- Golden-test infrastructure that is unusually good for a project this size.
- Round 7’s blockers were fixed (stat cache now read as merge base, pull refusal, push
  sanity check, hook failure propagation, `rm --remote --force`, local-backend
  containment).

### 2.2 Measured behavior at collection scale [V]

1,000 files × 210 KB, 10 directories, local backend:

| Operation | Result |
| --- | --- |
| `track data/coll` | 16.0 s; 1,000 `.bref` + 10 `.gitignore` files (1,020 lines); commit touches 1,010 files |
| `status` | 3.6 s (re-hashes every file every run) |
| `push` | 23.3 s to *local disk* |
| no-op `sync` | 8.7 s (hashes every file) |
| Remote layout | 1,000 distinct top-level prefixes (one per file) |
| Compression | random `.bin` stored zstd-compressed although larger (210,012 > 210,000 bytes) |

At 5,000 × 4 KB files [S]: `add` 61 s, no-op `sync` 43 s, and adding 50 files to a
5,000-file directory costs 7.3 s (the whole `.gitignore` block is rewritten per file).
Git itself is untroubled at these sizes; the costs are blobsy’s per-file overhead and
the human-facing PR surface.

### 2.3 Design doc vs implementation drift [V/S]

- Three of seven documented state symbols (◐ ◑ ⊗) are never emitted; `status` never
  consults HEAD, so the “three orthogonal states” model is unimplemented.
- The stat cache is written in 9 places and read on one line (the sync merge base); its
  documented performance role (`getCachedHash`) has zero callers.
- The five-level config hierarchy is inert: all 13 `resolveConfig` call sites pass the
  repo root (bead `blobsy-4vpk`).
- `.blobsy/` is “committed to git” per the design doc, but `doctor` errors unless it is
  gitignored; `setup` does neither, so `git add -A` commits the stat cache.
  The trash directory is therefore machine-local and never read.
- README: “identical files are never uploaded twice” — false under the default template
  (same bytes pushed twice → two objects; same bytes at two paths → two objects) [V].
- Bead `blobsy-aad8` points at a spec file that does not exist.

* * *

## 3. Blocker and high-severity findings

All reproduced against `04a3d1a` with the built CLI and a `local:` backend.

| ID | Severity | Finding | Reproduction | Root cause |
| --- | --- | --- | --- | --- |
| B-1 | **Blocker — data loss** | `sync` overwrites a tracked-but-unpushed edit with the old blob. | `edit f; blobsy track f; git stash; blobsy sync` → file reverted to v1; v2 bytes exist nowhere; `git stash pop` restores a pointer to bytes that are gone [V]. Same via `git checkout -- f.bref`, and after an uncommitted push [S]. | `track` writes the stat-cache “merge base” before anything is committed or pushed; the three-way table then reads “ref moved back, local unchanged → pull”. |
| B-2 | **Blocker** | Pre-push hook uploads from the working tree, ignoring the refs being pushed. | Commit on `feature`, `git checkout main`, `git push origin feature` → 0 blobs uploaded; a clone of `feature` cannot pull [S]. | Hook ignores the `<local ref> <sha> <remote ref> <sha>` lines git passes on stdin. |
| B-3 | **Blocker — PAIN-1** | A natural rename commits the payload to git. | `git mv a.bref b.bref; mv a b; git add -A` → 250 KB payload committed [S]. | Gitignore entries are load-bearing; no pre-commit large-file guard. |
| H-1 | High | `setup` doesn’t gitignore `.blobsy/`; `git add -A` commits one stat-cache JSON per tracked file. | 1,000 cache files committed in the benchmark [V]. | Setup gap; design-doc contradiction. |
| H-2 | High | Two-phase `remote_key` (bead `pqyt`): two commits per change; dirty pointer blocks `git checkout`; rebases conflict twice; teammates can’t pull between the commits. | [S] | Push-time, non-derivable keys. |
| H-3 | High | After any git operation that changes a pointer (teammate update, revert, cherry-pick, the design doc’s own conflict recipe), `pull` refuses with exit 2 and recommends `--force`; `status` shows a teammate’s change as `~ modified`. | [S] | Overwrite decision based on a merge base instead of on known-synced content. |
| H-4 | High | Two developers adding *different* new files to the same directory conflict in the generated `.gitignore` block. | [S] | Sorted per-file ignore lines land in the same gap. |
| H-5 | High | Dedup and determinism claims are false under the default template. | [V] | Timestamped keys. |
| H-6 | High | Per-file `.gitignore` lines make `git status` superlinear in the number of tracked files per directory: 20k entries 0.82 s vs 0.009 s for one wildcard [V]; 50k entries 10.9 s [S]; s3lfs reports 70 s at 100k. Every git command pays this, not just blobsy. | [V] | One ignore line per tracked file. |
| H-7 | High | Under jj (and any tool that pushes with `--no-verify`), hooks never fire: `.bref` files reached the remote with no blobs; jj also auto-snapshots payloads under 1 MiB that were seen before `blobsy add`, and its conflict style can un-ignore payloads in the managed `.gitignore` block. | [S] (jj 0.46, colocated repo) | Correctness depends on hooks and on load-bearing ignore lines. |
| M-1 | Medium | Compression kept when larger; no keep-if-smaller rule. | [V] | — |
| M-2 | Medium | Exec bit lost on pull; symlinks skipped (verbose-only message); `dist/`, `build/`, `node_modules/` ignored by bare name at any depth. | [S] | No mode in `.bref`; walker rules. |
| M-3 | Medium | `check-unpushed` reports “all pushed” when a blob was deleted (checks key presence only). | [S] | Pushed-bit stored in the pointer. |
| M-4 | Medium | `doctor`’s stale-cache scan is dead code (reads the top level of a sharded dir). | [S] | — |
| L-1 | Low | `setup` rejects `local:../repo-remote` when the repo is `../repo` (string-prefix containment check, `backend-url.ts:176`). | [V] | Missing path-separator check. |

B-1 needs only a one-line policy change to stop the bleeding (write the cache only after
a successful push or pull), independent of every design decision below.

* * *

## 4. Merge workflows (UC-4) across all use cases

Merging is where the use cases diverge most, so it gets its own section.
The governing requirements: **(X-1)** a merge must be *correct* with plain git (no
driver, no hooks, no network) — GitHub’s merge button, merge queues, jj, and fresh
clones run nothing of ours; blobsy-installed drivers and hooks may only make it *nicer*.
**(No network in git operations.)** Payload hydration after a merge is a separate,
explicit (or opt-in hook) step.

### 4.1 What git does to the reference files

| Reference | Git-level merge behavior | Verdict |
| --- | --- | --- |
| `.bref` (UC-1) | A 3–4 line text file per data file. One side changed → clean. Both changed the same file → a real conflict on that pointer. Different files → different pointers → always clean. | Correct with plain git. **No merge driver needed** [S]. |
| Per-directory `.gitignore` block (UC-1 today) | Sorted per-file lines; two branches adding different files to one directory insert into the same gap → **false conflict** [S]. | Fix by making ignore entries non-load-bearing (pre-commit guard) and `doctor --fix` regeneration; collections use one directory line instead. |
| Collection manifest (UC-2) | Sorted one-line-per-file TSV. Git conflicts iff two hunks have no unchanged line between them: same-gap inserts, adjacent edits/deletes, both-append-at-EOF → **false conflicts**, even for distinct paths. Batch additions with date/run-prefixed names into one subdirectory conflict with P≈1 regardless of size [S, Monte-Carlo]. `merge=union` silently corrupts (duplicate paths; delete-vs-modify lost) [S]. | Safe but conservative with plain git. A **per-path three-way merge driver** removes all false conflicts (45-line prototype, 0.13 s on 20k lines) [S]. |
| Snapshot pin `.bref kind: tree` (UC-5) | One line changes per upgrade. Two branches upgrading to different versions conflict on that line — correct and trivial. | Plain git suffices. |
| Cache stanza (UC-3) | Git never sees the tree. The cache key is a function of committed inputs (lockfile); the package manager’s lockfile merge *is* the merge. | Nothing to merge [S]. |
| Run receipts (UC-6) | Single writer per run; never merged. | Nothing to merge. |

### 4.2 Ideal blobsy merge workflow per use case

**UC-1 (pointers).** `git merge` → clean or a per-pointer conflict → resolve with
`git checkout --ours|--theirs x.bref` (or `blobsy resolve x --tool <cmd>` for
content-level merges of text-like data, explicit and after the fact) → `git add` →
`blobsy pull`. With content-derived keys the merged pointer is complete (no `remote_key`
write-back), and the pull overwrite rule is “overwrite iff the local hash is one this
path has had in git history or was last synced here” — so a teammate’s update, a revert,
or a resolved conflict pulls cleanly, while unpushed local edits are refused (fixes B-1
and H-3) [S]. Optional hydration hooks (`post-checkout`/`post-merge`/`post-rewrite` →
`blobsy pull --quiet`, never failing the git operation) make this automatic for users
who opt in.

**UC-2 (collections).** `git merge` → the per-path driver merges the manifest by path:
changed on one side wins; identical changes merge; differing changes to the same path
and delete-vs-modify conflict **with markers scoped to that one line**. Without the
driver (web merge, fresh clone, jj), git’s text merge is safe-but-conservative and
`blobsy merge-manifest --resolve <file>` re-runs the same algorithm from the three index
stages git leaves behind (`:1:`/`:2:`/`:3:`), so no marker parsing is needed [S]. A
validator (sorted, unique, no markers) in pre-commit, `doctor`, and CI is the backstop
for hand-resolved or web-merged manifests.
Then `blobsy pull <collection>` hydrates; the same overwrite rule applies per entry.

**UC-3 (caches).** No merge exists: after `git merge`, the merged lockfile yields a new
key; `blobsy snap restore` hits or misses (with optional prefix fallback); a miss means
“build, then publish”.
Branches never need cache scoping because keys are pure functions of committed inputs.

**UC-5 (pinned assets).** A one-line pointer conflict when both branches upgrade
differently; pick one; `blobsy snap restore` verifies the tree id against the pin.

**UC-6 (runs).** Not merged; single writer per run prefix; receipts are append-only.

### 4.3 Gat vs blobsy on merging

Gat 0.0.15 was built from source and every scenario below was run with the real binary
against a `file://` remote (git 2.43) [S, `research-2026-10-22-competitor-gat.md` §7].
The blobsy columns are blobsy *today* (per-file pointers, measured) and the *proposed*
design (§5.1–§5.3; the UC-2 driver was prototyped and tested [S]).

**How Gat merges.** Gat keeps every tracked file in one repo-wide `gat.lock`
(`<blake3>⇥<path>` rows, sorted; optionally sharded by path hash).
A per-path merge driver (`gat merge-driver %O %A %B`) is registered **per clone** in
`.git/config` and `.git/info/attributes` by `gat init`; nothing is committed.
Per path: identical on both sides → keep; changed on one side → take it; changed
differently → conflict.
After a clean merge, a `post-merge` hook hydrates payloads from the local cache (no
network unless `sync.auto_fetch`).

| Scenario | Gat (driver installed) | Gat (no driver: fresh clone, web merge, jj) | Blobsy today | Blobsy proposed |
| --- | --- | --- | --- | --- |
| Two branches add different files to the same directory (adjacent names) | Clean; hook hydrates | **False conflict** in `gat.lock` | Pointers: clean. **`.gitignore` block: false conflict** (H-4) | UC-1: clean (ignore block regenerated, not merged). UC-2: clean with driver; false conflict without, repaired by `merge-manifest --resolve` |
| Edits to two different (adjacent) files | Clean | False conflict | Clean | Clean (UC-1); clean with driver (UC-2) |
| Both edit the same file differently | Conflict, but the lock is left as *ours*: no markers, **the other side’s clean changes are omitted**; a naive `git add` silently dropped an independent addition [S, tested] | Conflict with markers | Conflict on one small pointer, with markers | Conflict on one pointer (UC-1) or **one marked line in the full merged manifest** (UC-2); validator blocks committing markers |
| Delete vs modify | Conflict (same data-loss hazard on naive resolve) | Conflict | Conflict on the pointer | Same as above |
| Rename on one side, edit on the other | Conflict (rename seen as delete + add) | Conflict | Conflict | Same; `blobsy resolve` helps pick |
| Identical change on both sides | Clean | Clean | Clean | Clean |
| File added at `p` on one side, `p/x` on the other | Refused (driver) — but **sharded locks merge cleanly into an invalid lock** that blocks every Gat command | **Clean text merge → invalid lock**; “Could not read gat.lock” | Clean (independent pointers; on-disk clash surfaces at pull) | Validator (pre-commit, doctor, CI) flags the prefix collision; resolved per path |
| Rebase / cherry-pick | Clean; rebase hydrates (`post-rewrite`); cherry-pick does **not** hydrate | Likely conflicts | Clean pointers, but two-commit flow doubles conflicts (H-2) | Clean; one commit per change |
| After merge: payload hydration | Hook, cache-only; `gat pull` if objects missing | Manual `gat sync`/`pull` | Manual; `pull` falsely refuses after a teammate change (H-3); `sync` works | `blobsy pull` with the known-synced rule; opt-in hydration hooks |
| Resolve tooling | None; hand-edit hex rows from `:1:/:2:/:3:` | Same | `git checkout --ours/--theirs x.bref` | Same for UC-1; `blobsy merge-manifest --resolve [--ours/--theirs PATH]` for UC-2 |
| Network inside the merge | Never | Never | Never | Never |
| Under jj | No driver, no hooks | — | No hooks (H-7) | Driver also usable as a jj merge tool; correctness doesn’t depend on hooks |

**What this shows.**

1. **The per-path rules are the same, and both projects reached them independently.**
   Gat proves the manifest-plus-driver model works for UC-2. Blobsy’s prototype differs
   only in conflict handling, and that difference matters.
   Gat leaves the file as *ours* with no markers, so the conflict is invisible in
   `git diff`, and a careless `git add` loses the other side’s clean changes.
   Blobsy’s prototype writes the full merged result with per-path markers, which a
   validator then rejects.
2. **Neither model is correct without the driver unless something validates the
   result.** Gat has no pre-commit or CI check, so hosted or driverless merges can
   produce a lock that every Gat command refuses to read.
   Blobsy should put `merge=blobsy-manifest` in the committed `.gitattributes` (an
   undefined driver falls back silently to text merge, which is safe) and ship a
   validator in pre-commit, `doctor` and CI.
3. **Per-file pointers are the most host-robust merge unit.** They merge cleanly on
   GitHub, in jj and in driverless clones, because there is nothing to merge but
   independent small files.
   That is a real reason to keep `.bref` for UC-1 rather than fold everything into one
   repo-wide lock as Gat does.
   It is also a reason to keep collections *per directory* rather than per repo: churn
   and conflicts stay local.
4. **Hydration belongs after the merge, not in it.** Both projects agree: no network in
   drivers. Gat’s cache-only hydration hooks plus a local CAS cache make branch switches
   offline-capable. Blobsy should adopt both as opt-in features (X-3), while keeping its
   pre-commit and pre-push guards, which Gat lacks.
   Gat lets unpushed content reach `git push` unchecked.

* * *

## 5. Design review by use case

### 5.1 UC-1: per-file pointers

Right shape, wrong key model.
The pointer is minimal and reviewable, but because the default key embeds push time, the
pointer is incomplete until after push, which is the single largest source of
user-visible friction (H-2), of four duplicated “upload-then-write-back” code paths, of
three disagreeing “is it pushed” audits, and of the false dedup claims.

**Recommendation (bead `pqyt` option 1, strengthened):**

```yaml
# blobsy -- https://github.com/jlevy/blobsy
format: blobsy-bref/0.2
hash: sha256:82020d96…
size: 300000
compressed: zstd      # decided at track time; absent = stored as-is
```

- Key derived: `sha256/<hex>{suffix}` (pure CAS default).
  Push is a create-only PUT; “already exists” = already published.
  Push never edits the pointer.
- `remote_key` remains legal and authoritative when present: every existing 0.1 pointer
  keeps working with zero migration; an optional `migrate-keys` re-homes them.
- “Pushed” becomes remote state, not pointer state: offline `status` reports
  tracked/modified/missing; `status --remote` and the pre-push check HEAD the keys.
- Compression decided at track time and kept only if smaller; `compressed_size` dropped
  from the pointer.
- Cost: the date-browsable default remote layout.
  Browsability by path belongs to mirrors (UC-6) and can be rendered for file mode by
  `blobsy ls --remote`. A custom `key_template` stays available as an advanced option
  that documents its two-phase cost.

Plus: a pre-commit **large-file guard** (refuse staging a payload with a sibling pointer
or above `externalize.min_size`) so gitignore entries stop being load-bearing (B-3); and
a pre-push hook that reads the pushed refs from stdin (B-2), which only works once keys
are derivable from the committed pointer.

**Ignore entries (H-4, H-6, H-7).** Per-file ignore lines are fine at UC-1 scale but
conflict on concurrent adds and make every `git status` superlinear past a few thousand
entries. Three changes, in order: (1) collections (§5.3) take large directories down to
one line; (2) `doctor --fix` regenerates the managed block from the pointers present, so
a conflicted block is a one-command repair rather than a merge; (3) consider Gat’s
approach of writing per-file exclusions to the uncommitted `.git/info/exclude`,
regenerated from pointers, which removes the merge conflict entirely at the cost of
clones being unprotected until `blobsy setup`/`pull` runs — acceptable only once the
pre-commit guard and a CI check make ignores non-load-bearing.

### 5.2 UC-4: merges and git operations

Covered in §4. Summary of the change: replace the stat-cache merge base with the
**known-synced rule** (pull overwrites a local file only if its hash appears in this
path’s pointer history or was last pushed/pulled here); write the cache only after a
successful push or pull; keep the cache purely as a size+mtime hash-skip accelerator.
This dominates the three-way table: no “ambiguous” state, recomputable from git when the
cache is lost, and it fixes B-1 and H-3. `sync` then reduces to `pull && push` (or is
removed).

Do **not** add: a `.bref` merge driver (plain git is already right), file locking (needs
a server), content-merge drivers inside `git merge` (network inside git operations).
Do add: `blobsy diff` (PR summary: added/removed/changed with sizes), `blobsy resolve
--tool`, opt-in hydration hooks.

### 5.3 UC-2: collections

**Today:** a directory becomes N pointers, N ignore lines, N stat-cache files and (under
the default template) N remote prefixes.
Git is fine (10k files: 2.67 MB pack); the pain is the PR (a 100-file update is “101
files changed”), the ignore file, and blobsy’s per-file overhead [S]. Threshold:
pointers are right up to ~50 files per directory; review degrades between ~50 and ~300;
above ~300 — or for any directory that receives files in batches — collections are
needed [S].

**Recommended design** — a second *container* for the same entry, not a second kind of
thing:

```text
data/images/            <- directory, gitignored as a whole (one line: "images/")
data/images.brefs       <- committed manifest (name is an open decision; ".btree" also proposed)
```

```text
# blobsy collection manifest -- https://github.com/jlevy/blobsy
# Run: blobsy status data/images | blobsy --help
#format blobsy-manifest/0.1
#columns path	size	sha256	mode	stored
cats/001.jpg	48213	9f2c0e7b…e1	-	-
scripts/fetch.sh	1430	5e0f9c1d…02	x	-
tables/2026-10.parquet	734003200	a81c4f3e…9b	-	zstd
```

- Sorted bytewise TSV; static header; **no aggregates** (counts, totals, tree hash,
  timestamps change on every edit and make every concurrent edit conflict — DVC’s
  mistake). Tree id = sha256 over the first four columns, computed, never stored in git.
- Per-file content-addressed objects with keys derived from the line (content-only
  templates are mandatory for collections), so push never writes back and a file moved
  between a pointer and a collection needs no re-upload.
- Commands: `add --collection <dir>`, `add <dir|subpath>` (adds/updates; removal only
  via `--prune` or `rm`, because partial pulls make snapshot-style `add` unsafe),
  `status`, `push`, `pull --include <glob>`, `verify`, `diff`, `untrack`, demote via
  `add --files`.
- Merging as in §4: per-path driver installed by `setup`, `--resolve` fallback,
  validator in pre-commit/doctor/CI.
- Not in v1: auto-sharding, packs, symlink/mtime fidelity, textconv drivers, nested
  collections, per-entry key overrides, `merge=union`.

Round 8’s rejection of Option A (a digest-only directory pointer) still stands, for a
different reason here: UC-2 *wants* the per-file list in git.
Re-point bead `blobsy-aad8` at this design.

### 5.4 UC-3 and UC-5: trees and immutable assets

**Taxonomy [S].** Four workloads, three disciplines:

|  | Repo files (UC-1/2) | Run archives (UC-6, round 8) | Derived caches (UC-3) | Pinned assets (UC-5) |
| --- | --- | --- | --- | --- |
| Identity | path at a commit | path-shaped prefix | input hash (lockfile, toolchain, platform) | chosen immutable name |
| Writers | many, via git | one per prefix | many CI jobs racing | one publisher per name |
| Lifecycle | versioned by git; GC by reachability | frozen when done; never deleted | immutable per key; TTL | immutable; forever |
| Git holds | pointer / manifest | receipt (optional) | config stanza only | one pin pointer (optional) |
| Transfer unit | file | file (batched) | packed archive | packed archive or single file |
| Fidelity | content (+ exec bit) | content | symlinks, exec bits, empty dirs | same |

Stretching file mode to trees fails on fidelity, per-file transfer cost (14,711 PUTs for
one `node_modules`), and git footprint.
Stretching mirror mode to caches fails on identity, concurrency (last-writer-wins on a
shared prefix), restore speed, and lifecycle [S].

**Recommended: one *snapshot* primitive for UC-3 and UC-5** [S]:

- **Identity:** the canonical entry `path ⇥ kind ⇥ size ⇥ sha256` (kind
  `f|x|l:<target>|d`), bytewise-sorted; `tree_id = sha256` of the lines.
  Shared with UC-2 manifests and round-8 receipts, so “receipt matches manifest” is a
  string compare.
- **Store layout (everything under the name):** `snap/<name>/data.tar.zst`,
  `manifest.tsv.zst`, and a tiny `ref.yaml` written **last** with a create-only PUT —
  the commit point. A `412` on the ref → read it; same `tree_id` → already published.
- **Names:** derived for caches (`cache/target/v1/{os}-{arch}/{hash:Cargo.lock}`, pure
  template variables only — no `{cmd:…}`, per the threat model) or chosen for assets
  (`assets/llama-3-8b/v2`). Never mutable; no “latest”.
- **Git:** nothing per cache snapshot; a pinned asset is a `.bref` with `kind: tree`,
  `name`, and `hash: <tree_id>` (verified on restore).
- **Restore:** ref → manifest (verify tree id) → archive (via a local content cache) →
  extract to a sibling temp dir → verify every file → two-rename atomic swap.
  `--only <glob>` partial restore; `--fallback` to the newest name under the parent
  prefix (actions/cache `restore-keys` semantics).
- **Packing:** one deterministic `tar.zst` per snapshot in v1 (measured on this repo’s
  `node_modules`: 14,711 files / 171 MB → 40 MB in 2.8 s; restore with all symlinks and
  exec bits in 4.8 s) [S]. Package-grouped packs and range restore are v2.
- **Expiry:** bucket lifecycle rules on `snap/cache/`; assets never expire; `snap gc`
  only for backends without lifecycle.
- **CLI:** one noun with immutable verbs —
  `blobsy snap publish|restore|status|ls|show|pin|gc`. Do not reuse `push`/`pull` for
  snapshots: the safety profiles are opposite.
- **Non-goals:** bidirectional sync of derived trees, mutable names, hooks, per-file
  objects for snapshots, CDC, signatures (v1), ecosystem-specific pruning, executing
  commands from key templates.
- **Guidance:** for JS/Python, cache the package-manager store (pnpm store, uv cache),
  not `node_modules`/`.venv` (absolute paths, pnpm hardlinks); `target/`, model
  directories and preprocessed datasets are the clean wins.

**Mirror mode (UC-6) stays as round 8 proposed, narrowed:** keep attach points,
path-shaped keys, receipts (adopting the canonical `tree_id`), copy-only, no hooks, no
two-way merge. Move round 8’s R10 “shared tool caches” out of mirror mode into the
snapshot primitive as *entry assets* (create-only per entry).

**The owner’s hypothesis holds:** UC-5 lets UC-3 avoid file-level merges — precisely,
the merge surface collapses to the key inputs (the lockfile, merged by the package
manager) for caches, or to one pin line for assets.
The trade-off is that git cannot diff the tree; `blobsy snap show --diff` does.

### 5.5 PAIN-3 and PAIN-4: removal, migration, and the LFS comparison

Pointers solve PAIN-3 going forward: removing a pointer from history is cheap, and the
bytes live in a bucket the owner controls.
Native git still does not solve it: the “large object promisor” work (Git 2.49–2.56)
makes clones cheaper, but git’s own design notes say a pushed large blob may not be
removable without rewriting history [S]. GitHub still documents “delete and recreate the
repository” to remove LFS objects [S].

Missing for PAIN-3/4:

1. `blobsy migrate import` (history rewrite via `git filter-repo`, LFS-style) —
   tractable only with content-derived keys.
2. `blobsy import-lfs` — LFS pointers are already sha256 + size; convert pointers
   without downloading, copy objects into the CAS. The highest-leverage adoption
   feature.
3. Reachability GC: reachable = all hashes in all pointers/manifests across refs;
   orphans = listed − reachable; age gate; dry-run first; bucket versioning or Object
   Lock as the recovery window.

Honest LFS comparison: blobsy wins on cost, provider neutrality, legible state for
agents, and (after §5.1) dedup across history; LFS wins on transparency (smudge/clean),
maturity (migrate, prune, locks) and hosting UI. Blobsy should not claim “simpler” while
every change takes two commits.

* * *

## 6. Proposed architecture

### 6.1 One storage contract, three reference disciplines

Replace principle 9 (“one primitive … no second kind of thing”) with:

> **One storage contract** — immutable objects, create-only writes, hash-verified reads
> — and **one entry format** (`path, kind, size, sha256`), referenced in one of three
> ways: **in git** (a `.bref` pointer for a file, a `.brefs` manifest for a collection),
> **by name** (a snapshot for a tree or asset, optionally pinned in git), or **by path**
> (a mirror for run archives).

What was rightly eliminated in the original design was *mutable remote manifests as
coordination state*. A committed manifest is the opposite: git sees it and git merges
it, and the store stays a dumb immutable blob store.

### 6.2 Object model and invariants

- **Blob** — immutable bytes identified by sha256 of the original content; optional
  encoding (`zstd`); stored at a key that is a pure function of (hash, encoding).
- **Ref** — a committed pointer (`.bref`): one entry at an adjacent path.
- **Manifest** — a committed list of entries for a collection directory: N refs in one
  file.
- **Snapshot** — a named, immutable, packed tree (or single file) with a store-side
  manifest and a create-only commit object.
- **Mirror** — a path-shaped remote prefix for a run tree, with a receipt.

Invariants:

1. Store writes are create-only; nothing overwrites; deletion only by explicit GC or
   lifecycle rules on cache prefixes.
2. For refs and manifests, `key = f(entry)`; no push-time state is ever written into a
   committed file.
3. A path is governed by exactly one discipline; `doctor` errors on overlap.
4. Pulled or restored bytes are hash-verified before replacing anything.
5. Correctness never depends on hooks or drivers; hooks verify and convenience-sync;
   nothing unbounded runs in hooks; snapshots and mirrors never run in hooks.

### 6.3 Module layout

```
cli/verbs/   one file per verb (plan + execute); verbs dispatch by discipline
core/        hash + hash cache, paths, config (3 levels), errors, reporter, git helpers
store/       Backend (+ list, putIfAbsent, capabilities), transfer (batch), local CAS cache
refs/        file.ts (.bref), manifest.ts (.brefs)  — one Entry loop for push/pull/status/verify
snap/        snapshot publish/restore/ls/gc, pack/unpack, tree walk with fidelity
mirror/      round-8 attach points + receipts
doctor/      check registry; each module registers its checks
```

The key leverage: with derived keys and no merge base, `push`, `pull`, `status` and
`verify` for refs **and** manifests are one loop over `Entry {path, hash, size,
encoding}` [S]. Snapshots and mirrors share `store/` and `core/` but have their own
loops.

### 6.4 Backend interface additions

`list(prefix)`, `putIfAbsent(key, …)` (S3 `If-None-Match: *`, GCS `ifGenerationMatch=0`,
Azure `If-None-Match`, local `O_EXCL`), a batch transfer method (rclone `--files-from0`,
SDK concurrency pool), and `capabilities.conditionalPut` **set by a doctor probe**
(write a sentinel twice; expect success then 412), because S3-compatible stores can
silently ignore the header [S]. Known gaps: rclone’s GCS and Azure backends pass no
preconditions; B2 rejects the header; command backends can’t express it.
Use a documented exists-then-put fallback there, or a thin native write for small commit
objects only.

* * *

## 7. Engineering complexity review

### 7.1 Inventory [S]

8,862 source LOC; 9,436 lines of current design docs (more than the source).
Of the source, ≈3,600 LOC is mode-specific (tracking, gitignore, sync, hooks, templates,
compression, config), ≈2,900 is shareable (backends, transfer, output, core), ≈1,400 is
doctor and plumbing (`doctor` alone is ~915 LOC), and ≈400 is dead or duplicated.
An agent must absorb ~80 nouns (22 commands, 35 config keys, 7 env vars, 7 state
symbols, 6 pointer fields, hidden state) to use blobsy fully.

For scale: Gat, covering UC-1/2/4 with hooks, a cache, routes, and mounts, is ~150k
lines of Rust including tests.
The full feature surface is large; blobsy’s advantage must come from refusing most of it
(§10).

### 7.2 Accidental complexity

| Upstream choice | What it forced | Verdict |
| --- | --- | --- |
| Timestamped default key template | `remote_key` in the pointer; two-phase commits (pqyt); 4 copies of upload-then-write-back; `track` clearing keys; 3 “pushed” audits; false dedup; `push --force` orphaning unchanged content | Accidental — remove (§5.1) |
| Bidirectional `sync` with stat-cache merge base | 9 decision states; exit 2 from sync; “ambiguous after git pull”; B-1 data loss; 583-line design doc | Accidental — replace with the known-synced rule (§5.2) |
| Compression decided at push time | Encoding leaks into key and pointer; different configs → different keys | Accidental placement — decide at track time |
| Trash directory | Written, never read; gitignored so the “GC paper trail” can’t work | Delete; git history is the undo |
| 8 hidden commands | Full handlers, goldens, docs | Delete or fold into flags |
| Five-level config hierarchy | Inert walk, duplicated loop, unreachable `subdir` origin, inert `checksum` section | Delete (bead `4vpk`: drop) |
| No reporter / plan-execute split | 117 hand-written quiet/json guards; duplicated dry-run logic per command | Refactor before adding modes |
| Per-file adjacency everywhere | O(N²) gitignore rewrites, 2 git spawns per file in rm/untrack, 1 synchronous transport spawn per file | Batch per command |

Essential and worth keeping: the pointer (hash + size), the backend layer, atomic
verified pulls, create-only remote semantics, path containment and the threat model,
externalization rules, `--json` and non-interactivity, golden tests, and `doctor` as a
concept (at a fraction of its size).

### 7.3 Simplifications, ranked by complexity removed ÷ capability lost [S]

| # | Change | Removes | Loses |
| --- | --- | --- | --- |
| S1 | Delete inert subdir-config walk, `subdir` origin, `checksum`, `sync.tools` | ~150 LOC, bead 4vpk | nothing |
| S2 | Delete `.blobsy/trash/` and the ⊗ state | contradiction + dead code | nothing |
| S3 | Delete hidden commands (`init`→`setup`, `track`→`add --no-stage`, `health`/`check-unpushed`/`pre-push-check`→`doctor` flags, `readme`/`skill`→`docs` flags) | ~300 LOC, 7 goldens | aliases (print “renamed” for one release) |
| S4 | Content-derived keys; compression at track time; `remote_key` optional | pqyt, write-back, 4 duplicated paths, 3 audits | date-browsable default layout |
| S5 | Drop the merge base; hash cache only, actually wired into status/verify/push/pull | ~325 LOC, 9 states, B-1, H-3 | one-verb bidirectional detection (already degrades to push/pull) |
| S6 | Reporter abstraction + plan/execute per verb | 117 guards, duplicated dry-runs | nothing |
| S7 | Batch gitignore writes and git spawns per command | O(N²) and O(N) spawns | nothing |
| S8 | Doctor diet: table-driven checks; fold `health`; fix or drop the dead cache scan | ~300 LOC | did-you-mean on config keys |
| S9 | Compression: zstd + none; keep only if smaller | small | gzip/brotli encoders (keep decoders) |
| S10 | Consider dropping the `aws-cli` backend (the SDK backend covers it) | 176 LOC + tests | aws-cli quirks |

S1–S3 are pure deletions and should land first.
S4–S5 are the architectural pair that makes UC-2 cheap.
S6–S7 are what keep the next modes from tripling the plumbing.

### 7.4 Implementation language: TypeScript vs Rust

Full report:
[`round9-subreviews/language-typescript-vs-rust.md`](round9-subreviews/language-typescript-vs-rust.md)
[S]. Gat, jj, Xet, Oxen and Lore are all Rust, and the landscape research calls
single-binary distribution “the category norm”, so the question is fair.
The evidence says it is not a language problem.

| Concern | Finding |
| --- | --- |
| Startup | `blobsy --version` 0.53–0.58 s vs bare `node` 0.03 s [V]. The cost is eager imports: `marked-terminal` ~160 ms, `@aws-sdk/client-s3` ~133 ms, `zod` ~64 ms, `yaml` ~36 ms [S]. A lazily-loaded TS CLI starts in ~100–150 ms; Rust CLIs (gat, jj) in 8–14 ms. A merge driver runs once per conflicted *manifest*, not per data file, so ~100 ms is invisible. |
| Hot paths | Node is within 1.0–1.5× of Rust: SHA-256 (OpenSSL) 1 GiB in 4.3–4.9 s vs Rust `sha2` 6.7 s on this CPU; 100k-file walk+stat 340 ms vs 209–288 ms; zstd of 179 MB 2.1–2.3 s vs 1.7–1.8 s [S]. Only BLAKE3 is a large Rust win, and that is a hash choice, not a language choice; the Gat comparison recommends keeping SHA-256. |
| Single binary | `bun build --compile` produced a working 84 MB blobsy binary in 2.8 s [S]. Node SEA is maturing. Claude Code and Codex ship native binaries via per-platform npm packages; the same packaging works for a bun/SEA build or a Rust binary, so install UX is independent of language. |
| Ecosystem | Create-only writes are available in every option: AWS SDK v3 `IfNoneMatch`; `aws-sdk-s3`; Rust `object_store`; and **OpenDAL’s npm bindings**, which could give in-process GCS/Azure preconditions without rclone (closing the gap in §6.4) [S]. |
| Supply chain | A wash: 166 npm packages in blobsy’s prod tree (94 are AWS SDK/Smithy) vs ~276 crates for a blobsy-shaped Rust CLI (Gat: 455) [S]. |
| Velocity | Rust clean release builds take minutes (Gat ~7 min); vitest and goldens iterate in seconds. Coding agents still pay a compile-fix tax in Rust [S]. The three blockers (B-1..B-3) are policy bugs that no type system prevents; error-shape drift is the one place Rust’s `Result` would genuinely help. |
| Switch cost | After Phases 1–2: ~5–6k LOC TS → ~7–9k Rust, 3–6 weeks plus release engineering [I]. Porting *before* Phase 1 would port code that is about to be deleted. The 71 golden tryscripts run `blobsy` from `$PATH` and carry over unchanged to any binary with identical output [S]. A napi-rs hybrid is the worst option: all of Rust’s build matrix for ≤1.5× gains. |

**Recommendation: stay in TypeScript through Phase 3** (no rewrite, no hybrid).
Do these now regardless:
- Lazy-load `@aws-sdk`, `marked-terminal` and `zod`, with a CI startup budget
  (`--version` < 200 ms).
- Give the merge driver and hooks a minimal-import entry point.
- Ship bun-compiled binaries alongside npm as an experiment, and run the golden suite
  against them.
- Loosen `engines` to Node ≥ 22.15 (the zstd floor).
- Make the formats language-neutral: a normative spec with test vectors for `.bref` 0.2,
  `.brefs`, `tree_id`, the deterministic tar flavor, key derivation and `--json`
  schemas. That makes a later port, or a second implementation, cheap.

**Decision rule:** switch to Rust after Phase 2 only if one of these is *measured*:
1. After Phase 1 and lazy imports, a real workload is more than 2× over budget and the
   profile blames the runtime.
   Suggested budgets:
   - `status`/`verify` on a 10k-entry manifest: ≤ 1 s warm;
   - `--version`, hooks and the merge driver: ≤ 150 ms;
   - publishing a 15k-file / 170 MB snapshot: ≤ 10 s.
2. Both `npx` and a single binary are unacceptable in a target environment.
3. Blobsy becomes a library product that needs in-process git or non-JS embedding.
4. An npm supply-chain incident makes the dependency tree unacceptable.

If none fires by the end of Phase 3, the question is settled.

### 7.5 Documentation

Restructure (round 7 already asked for part of this): a normative `spec/` (≤800 lines,
shipped behavior only — concepts, invariants, formats, commands, config, threat model),
`roadmap/` (everything deferred, including this review’s proposals once approved),
`reviews/` (rounds 7–9 and archived plans, read-only), a ≤300-line testing doc, and a
≤200-line README. Render defaults and command tables from code, as the skill text
already is.

* * *

## 8. Agents and non-git porcelains

- The SKILL omits `sync`, `mv`, `rm`, conflicts, what to do after `git
  pull/merge/rebase/stash`, and the two-commit rule; and `pull`’s refusal message
  teaches `--force`, which is destructive in exactly the case that matters [S]. After
  §5.1–§5.2 most of these instructions disappear rather than needing to be added.
- **jj (Jujutsu)**
  [S, `research-2026-10-22-jj-vcs-and-blobsy.md`, tested with jj 0.46.0 in a colocated repo].
  jj is active (monthly releases 0.34 → 0.46 since Oct 2025; its creator moved from
  Google to East River Source Control in July 2026) and still has no Git LFS,
  `.gitattributes`, hooks, or partial-clone support; its roadmap points at a VFS and
  chunked storage rather than LFS. For blobsy:
  - `jj git push` runs `git push --no-verify` and `jj commit` runs no hooks, so the
    pre-push upload never happens (H-7). This is the strongest single argument for X-1
    (hook-independent correctness) and for derived keys (nothing to write back).
  - jj snapshots every non-ignored file under 1 MiB on almost every command, so a
    payload jj saw before `blobsy add` stays tracked; recovery needs `jj file untrack`.
  - jj ignores `.gitattributes` merge drivers; the planned manifest driver must also be
    a standalone `$base $left $right $output` tool registrable as a jj merge tool.
  - What works: `blobsy add` → `blobsy push` → `jj commit` → `jj git push` produces a
    correct commit; `.bref` conflicts resolve with `jj resolve --tool :theirs`;
    colocated `git add` is harmless (jj 0.45 fixed an index-corruption bug triggered by
    exactly this pattern).
  - Recommendations: gitignore `.blobsy/` at setup (H-1); regenerate the managed
    `.gitignore` block from pointers rather than merging it; detect jj (skip `git add`,
    untrack already-snapshotted payloads, jj wording); add a jj pre-upload hook once jj
    ships one (open design PR); hydration must stay on-demand and idempotent.
- Plan/apply output (`--dry-run --json` that emits the exact resolved keys and actions)
  is trivial once keys are derivable and suits agents well [S].

* * *

## 9. Competitive landscape (October 2026)

### 9.1 Gat — the closest competitor

Full reference: `research-2026-10-22-competitor-gat.md` (source review plus empirical
runs of Gat 0.0.15 built from source) [S].

**What it is.** Rust, Apache-2.0, created 2026-09-07, releases v0.0.10–0.0.15, ~152k
lines including 2,467 tests, CI on three OSes; one human maintainer, ~630 stars, little
discussion so far. It has:
- a committed repo-wide `gat.lock` (BLAKE3 → path; no size, mode or compression;
  optional sharding by path hash) and three config scopes (`gat.yaml`, global, local);
- derived keys `blake3/xx/yy/<oid>` that are never stored, so there is no two-phase
  commit, but the remote is opaque;
- OpenDAL backends (S3, Azure, GCS, OSS, fs);
- a local CAS cache (`.gat/objects`) with reflink/hardlink materialization, and SQLite
  placement state;
- per-file exclusions in `.git/info/exclude`;
- hydration hooks (post-checkout, post-merge, post-rewrite), but **no pre-commit or
  pre-push guard**;
- a per-path merge driver installed per clone;
- no `--json` output.

**Is Gat’s design better?** Decision by decision [S, §12 of the Gat doc]:

| Decision | Better | Note |
| --- | --- | --- |
| Derived keys vs stored `remote_key` | **Gat** | The single most important lesson; adopt (D2). |
| Local CAS cache | **Gat** | Offline branch switches; free re-adds; verified prune. Adopt as optional (X-3). |
| Merge driver | **Gat ships one; blobsy’s prototype handles conflicts better** | Same rules; Gat’s keep-ours-without-markers conflict handling loses data on a naive resolve. |
| Config scopes (global/project/local, `${VAR}` URLs) | **Gat** | Matches dropping subdirectory configs (S1). |
| Single binary | **Gat** | Category norm; see §7.4. |
| Unit of reference | **Split** | One lock is best at scale but is a single conflict hotspot that needs a per-clone driver; per-file pointers merge everywhere. Blobsy’s pointers plus per-collection manifests combine the strengths. |
| PR diff readability | **Split** | Gat: one line per change, hash first, no size. Blobsy proposed: path-first rows with size and mode. |
| Hash (BLAKE3 vs SHA-256) | **Blobsy** | SHA-256 matches LFS oids (free `import-lfs`), S3 native checksums, and Node crypto. |
| Remote browsability | **Blobsy** | Gat buckets are unreadable without git. |
| Backend pluggability | **Blobsy** | Command and rclone backends have no Gat equivalent. |
| Safety hooks | **Blobsy** | Gat lets unpushed content reach `git push` and ignores `core.hooksPath`. |
| Agent UX | **Blobsy** | `--json`, skill, self-describing pointers. |
| UC-3 / UC-5 | **Blobsy (if built)** | Gat has none. Its experimental `mount` pins another repo’s lock, the nearest thing to UC-5. |

**Verdict.** For the repo-files core (UC-1/2/4), Gat’s design is better engineered and
more coherent than blobsy’s *current* design: it made the right calls on keys,
collections, caching and hydration.
It is weaker on safety at the edges, transparency, pluggability and UC-3. Gat bugs found
by running it:
- a data-losing conflict UX;
- invalid locks from hosted or sharded merges;
- worktrees clobbering each other’s exclude blocks;
- `core.hooksPath` ignored;
- exec bit lost;
- payload edits invisible to `gat status`;
- fetch stops at the first missing object.

Most of the changes this review recommends for blobsy’s core (D2, D3, D4, X-3) are ones
Gat already embodies.
The rest (safety guards, validation, `--json`, UC-3/5) are where blobsy can lead.

### 9.2 Other tools

Source-level reviews in `research-2026-10-22-competitors-other.md` and the landscape
refresh [S]:

| Tool | What it is (Oct 2026) | Relevance to blobsy |
| --- | --- | --- |
| **s3lfs** (Python) | Committed YAML manifest (path → sha256) split per top-level dir, key-wise merge driver, hooks, browsable S3 layout `assets/<sha>/<path>`, racy-clean hash cache, “never delete local bytes unless the remote has them”, TLA+ models. 0 stars, one author, S3 only. | A design reference, not a market threat; validates the UC-2 design and supplies two rules blobsy lacks (racy-clean cache; remote-presence check before local deletion). |
| **git-xet** (Hugging Face) | Git LFS custom transfer agent; Hub-negotiated storage; only a dev server is open. | Fails PAIN-5. Borrow the shape (content id separate from location; index uploaded last), not the chunk formats. |
| **Oxen** | Own VCS + server; directories bucketed (~10k entries) by path hash; merges outside git. | Not git-compatible for UC-4; non-deterministic tree hashes. |
| **Epic Lore** (Jun 2026) | Centralized chunked VCS, no git interop. | Patterns: single conditional-write commit, typed “obliterated” markers instead of 404s, compression outside identity, causal locks for unmergeable files. |
| **git-lfs-fuse** | ~1.5k LOC Go; lazy FUSE mount of LFS repos; inactive since mid-2025. | Not a competitor. |
| **Git (native)** | Large-object promisors (2.49–2.56) reduce clone cost; history removal still requires rewriting. | Complement, not a replacement; PAIN-3 untouched. |
| **Git LFS / GitHub** | 3.7.x–3.8.0; metered billing (10 GiB free storage/bandwidth); removal = delete and recreate the repo. | PAIN-3/4 confirmed; `import-lfs` is the on-ramp (LFS oid = sha256 of raw bytes). |
| **DVC** | Acquired by lakeFS (Nov 2025); last release Mar 2026. | Stalled incumbent for UC-2-like workflows. |
| **HF Storage Buckets** (Mar 2026) | Mutable S3-like buckets beside versioned repos; plan/apply sync. | Same versioned-vs-working-storage split as file vs mirror mode; HF-only. |

No tool reviewed — Gat included — offers UC-3/UC-5 (immutable tree snapshots and caches
outside git) on arbitrary storage.
Cache-specific tools (actions/cache, runs-on/cache, Turborepo/Nx, sccache, Bazel) are
CI- or build-system-scoped; Nx deprecated its bucket caches after CVE-2025-36852.

### 9.3 Positioning

- **The “serverless LFS replacement with a manifest and a merge driver” niche is crowded
  in design (Gat, s3lfs) but thin in adoption.** Building UC-2 *only* to match Gat would
  duplicate a better-tested tool.
  UC-2 is still worth building, because blobsy’s users need it and because it shares the
  entry format, tree id and store with UC-3/5. But it should ship bundled with blobsy’s
  differentiators, not as the headline.

- **Blobsy’s defensible position is the combination:**
  - **UC-1:** per-file pointers that merge on any host.
  - **UC-2:** per-collection manifests with validated merges.
  - **UC-3/5:** immutable snapshots for trees and assets on any bucket.
    Nobody covers this.
  - **UC-6:** run mirrors.

  All four sit on any storage (command and rclone backends), with safety guards that
  don’t depend on hooks, and are built agent-first (`--json`, skill, plan/apply).

- **Interop:**
  - `import-lfs` is the high-value on-ramp.
  - Reading `gat.lock` is not worth it now.
    Gat uses BLAKE3, so import means rehashing, and its user base is tiny.
  - Revisit if Gat gains traction.
    A `blobsy import-gat` would be straightforward, since a lock row maps to a manifest
    line once rehashed.

- **Remote browsability vs derived keys** is not either/or.
  The invariant that matters is “the key is a function of committed data”.
  Pure CAS (`sha256/<hex>`) is the default; `{content_sha256_short}/{filename}`-style
  templates stay available.
  They are still derivable, so there is no two-phase commit, but renames re-upload.
  Path-shaped browsability is the job of mirrors (UC-6), plus `blobsy ls --remote` for
  file mode.

* * *

## 10. Recommendations and sequencing

**Phase 0 — safety, now (no design decisions needed):** B-1 (write the stat cache only
after successful push/pull), B-2 (pre-push hook reads pushed refs; interim: scan the
commits in `<remote>..<local>` for pointers), B-3 (pre-commit large-file guard), H-1
(`setup` gitignores `.blobsy/`; fix design-doc wording), M-1 (keep compressed only if
smaller), L-1 (path containment), README dedup claim, SKILL “after git operations”
guidance.

**Phase 1 — simplify the core (gates every new mode):** S1–S3 deletions; S4
content-derived keys + `.bref` 0.2 + create-only PUT; S5 known-synced rule + wired hash
cache; S6 reporter + plan/execute; S7 batching; `Backend.list`, `putIfAbsent`,
capabilities probe; batched transfer.
**Pin the entry format and `tree_id` definition as a normative appendix** (tiny, and the
trading repo wants the receipt schema first).

**Phase 2 — UC-2 collections:** manifest format + validator; `RefSource` abstraction;
collection verbs; per-path merge driver + `--resolve`; `blobsy diff`; CI check.

**Phase 3 — UC-3/UC-5 snapshots:** `snap publish/restore/ls` with a single archive and a
local content cache; then fallback, gc, status; then pins.
Validate on `target/` and model directories first; run the cargo mtime experiment before
fixing the default.

**Phase 4 — UC-6 mirrors (round 8), narrowed;** sequencing relative to Phase 3 is an
owner decision driven by the trading repo’s needs.

**Phase 5 — adoption and lifecycle:** `import-lfs`, `migrate import`, reachability GC,
opt-in hydration hooks, `blobsy resolve --tool`.

**Explicit non-goals (all phases):** file locking; smudge/clean filters; merge drivers
for `.bref`; network inside git operations; mutable names; bidirectional sync of derived
trees; CDC/sub-file dedup; a server.

* * *

## 11. Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Adopt “one storage contract, one entry format, three reference disciplines”; reword principle 9 and “What This Design Eliminates”. | Yes |
| D2 | Content-derived keys as the file-mode default (closes `pqyt`), giving up the date-browsable default layout. | Yes |
| D3 | Replace the stat-cache merge base with the known-synced rule; make `sync` = `pull && push` or remove it. | Yes; keep `sync` as the one recommended verb |
| D4 | Collection manifest: name/placement (`<dir>.brefs` sibling vs `.btree`), explicit `--collection`, explicit prune, merge driver installed by `setup`. | `.brefs` sibling; explicit; explicit prune; driver on by default |
| D5 | Snapshot primitive for UC-3/UC-5: `snap` verbs, layout “everything under the name”, single `tar.zst` in v1, pins as `.bref kind: tree`. | Yes |
| D6 | Snapshot trust: IAM + write segregation + provenance in v1, signatures later? | Yes (signature field reserved) |
| D7 | Conditional writes: require a probe-verified backend for snapshot publish, or allow exists-then-put with a documented race? Thin native writes for GCS/Azure commit objects? | Allow fallback, surfaced by `doctor`; native writes for small commit objects |
| D8 | Mirror mode (bead `s2tr`): approve, narrowed per §5.4, with R10 moved to entry assets; sequence vs snapshots. | Approve narrowed; sequence by trading-repo demand |
| D9 | Hooks: correctness never depends on them; hydration hooks opt-in. | Yes |
| D10 | Compression: zstd + none only; decided at track/add time; none in collections v1? | zstd + none; keep-if-smaller; allow in collections via `stored` |
| D11 | Approve the S1–S3 deletions (hidden commands, trash, inert config). | Yes |
| D12 | Positioning vs Gat: interoperate (read `gat.lock`) or differentiate. | Differentiate (§9.3); `import-lfs` first; revisit `import-gat` only if Gat gains traction |
| D13 | Implementation language: stay TypeScript, rewrite in Rust, or hybrid. | Stay TypeScript through Phase 3; lazy imports + startup budget; ship bun single binary alongside npm; switch only per the §7.4 decision rule |

Bead dispositions: `blobsy-pqyt` → close via D2; `blobsy-aad8` → re-point at the UC-2
collection design (§5.3); `blobsy-4vpk` → drop (S1); `blobsy-s2tr` → resolve via D8.

* * *

## Appendix A. Evidence index

Sub-reviews (full reports, with reproductions; scratch paths refer to the review
session’s ephemeral workspace):

- [`round9-subreviews/complexity.md`](round9-subreviews/complexity.md) — engineering
  complexity, target architecture, doc structure.
- [`round9-subreviews/uc1-uc4-file-mode-and-merges.md`](round9-subreviews/uc1-uc4-file-mode-and-merges.md)
  — UC-1/UC-4 workflows, blockers B-1..B-3, PAIN-3/4.
- [`round9-subreviews/uc2-collections.md`](round9-subreviews/uc2-collections.md) —
  collection manifest design, merge experiments and Monte-Carlo, driver prototype.
- [`round9-subreviews/uc3-uc5-snapshots.md`](round9-subreviews/uc3-uc5-snapshots.md) —
  taxonomy, snapshot primitive, conditional-write matrix, `node_modules` profile.
- [`round9-subreviews/language-typescript-vs-rust.md`](round9-subreviews/language-typescript-vs-rust.md)
  — TypeScript vs Rust: startup, hot-path benchmarks, distribution, switch cost.

Research (October 2026 refresh), in `docs/project/research/current/`:

- `research-2026-10-22-large-file-tools-landscape-refresh.md`
- `research-2026-10-22-object-store-capabilities-refresh.md`
- `research-2026-10-22-tree-manifests-and-cache-patterns.md`
- `research-2026-10-22-competitor-gat.md`
- `research-2026-10-22-competitors-other.md`
- `research-2026-10-22-jj-vcs-and-blobsy.md`

Lead-reviewer reproductions: the 1,000-file benchmark (§2.2), B-1 (`edit; track;
stash; sync`), H-1 (`setup` + `git add -A`), L-1 (`local:../g1rem` rejected for repo
`g1`), compression-larger (§2.2).

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
