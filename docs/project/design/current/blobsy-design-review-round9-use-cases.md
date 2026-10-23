# Blobsy Design Review — Round 9 (Use Cases, Design Coverage, and Complexity)

**Status:** Active review — design decisions requested (see §11)

**Date:** 2026-10-22. A v2 was issued the same day, revised after an independent
red-team pass (Appendix B). v3, also the same day, applies the owner’s policy of **no
backward compatibility** (blobsy is pre-alpha), removing every legacy and migration
provision.

**Reviewed revision:** `main` @ `04a3d1a` (PR #5 merge).
No code has changed since PR #4 (2026-07-31); PR #5 was documentation only.
The build passes; 24 test files / 327 tests pass; there are 71 golden tryscripts.

**Scope:** A full senior-engineering review of blobsy against the owner’s restated
problem framing: five pain points (PAIN-1..5) and five use cases (UC-1..5). It covers:

- design coverage;
- the shipped implementation and its workflows;
- engineering complexity;
- merge workflows per use case, compared with the new competitor Gat;
- the implementation language;
- the competitive landscape as of October 2026.

Rounds 7 and 8 reviewed alpha readiness and agent run-sync.
This round asks whether the *design* covers the use cases blobsy must serve, and what
the smallest coherent design that covers them looks like.

**Method.** The lead reviewer read all current design docs, rounds 7–8, the open beads
and the source. The lead also ran the CLI on scratch repos: a 1,000-file benchmark plus
targeted reproductions.
In parallel, the work was delegated as follows:

- **Five deep reviews**, each with its own experiments against the built CLI:
  - engineering complexity;
  - UC-1 + UC-4 (per-file mode and merges);
  - UC-2 (collections);
  - UC-3 + UC-5 (trees and immutable assets);
  - TypeScript vs Rust.

  The full reports are kept in [`round9-subreviews/`](round9-subreviews/) as evidence.
  Where this document and a sub-review disagree, this document wins.

- **Six research refreshes** in `docs/project/research/current/`:
  - tool landscape;
  - object-store capabilities;
  - tree manifests and cache patterns;
  - a source-level and empirical review of **Gat**;
  - other new entrants (s3lfs, git-lfs-fuse, Xet, Oxen, Epic Lore);
  - **Jujutsu (jj)** interop.

  Third-party sources were cloned into the gitignored `attic/`.

- **An independent red-team pass** over the draft: 34 findings, all addressed (Appendix
  B).

Evidence markers:

- **[V]**: reproduced, or verified against source or primary docs, by the lead reviewer.
- **[S]**: verified by a sub-review or research doc (cited).
- **[I]**: inference or design judgment.

* * *

## The owner’s questions, answered

| Question | Answer |
| --- | --- |
| Is the design right, and does it cover the use cases? | The per-file core is right for UC-1. UC-2, UC-3 and UC-5 are not covered, and the design’s founding principle (“one primitive … no manifests”) is what prevents covering them. UC-4 is claimed but unsafe in practice. (§1, §3, §5) |
| Are UC-1, UC-2 and UC-3 separate flows? | Yes. UC-1 is a **pointer** per file. UC-2 is a committed **manifest** per collection. UC-3/UC-5 is an immutable **snapshot** reached by name, with nothing in git. §4.0 shows the three flows side by side. |
| Is it too complex? | Yes, in the wrong places. Two early choices create most of the concepts a user must learn and all three data-safety bugs. Removing them deletes roughly a fifth of the source outright. Covering all use cases will add code overall, but with fewer concepts per use case than today. §10 gives the smallest cut of each phase. (§7) |
| How do merges work, Gat vs blobsy, per use case? | §4.3. Both reach the same per-path merge rules. Gat’s conflict handling can silently drop the other side’s changes; blobsy should write conflict markers and add a validator. Per-file pointers merge correctly on any host, including GitHub and jj. |
| TypeScript or Rust? | Stay TypeScript through Phase 3, with a measurable rule for when to switch. The slow startup comes from eager imports, not from Node. (§7.4) |

## Verdict

**The per-file core is the right foundation.
But the design covers only one of the five use cases well, the shipped code has three
data-safety bugs in ordinary git workflows, and two early choices generate most of the
accidental complexity.**

1. **Coverage.**
   - UC-1 (a few files via pointers) is covered and mostly well built.
   - UC-4 (merges) is *claimed* but unsafe in practice (§3).
   - UC-2 (collections) is served only by expanding a directory into N pointers.
     That works up to ~50 files per directory and is unreviewable past a few hundred
     (§5.3).
   - UC-3 (huge trees, nothing in git) and UC-5 (immutable named assets) are not
     covered. File mode cannot even restore a build tree: symlinks are skipped and exec
     bits are lost [S].

2. **Safety.** Three blockers reproduce in ordinary workflows:
   - `sync` silently overwrites a tracked-but-unpushed edit after `git stash`, losing
     data [V].
   - The pre-push hook uploads based on the working tree, not the commits being pushed
     [S].
   - A plain `git mv` + `mv` + `git add -A` rename commits the large payload to git [S].

3. **Complexity.** Two early choices account for most of the shipped *concepts* and for
   all three safety bugs:
   - A push-time **timestamped key template.** Keys can’t be derived, so `remote_key` is
     written back after push and every change takes two commits (bead `blobsy-pqyt`).
   - A bidirectional **`sync` with a stat-cache merge base.** This produces a 9-state
     decision table and the data-loss bug.

   Removing both deletes roughly a fifth of the source outright.
   The rest of the mode-specific code then collapses into one loop over entries, shared
   by pointers and manifests (§7).

4. **Competition.** **Gat** (Sept 2026, Rust) has a complete UC-1/UC-2/UC-4 story in
   ~150k lines of Rust.
   But its merge UX is unsafe at the edges, and it has no UC-3/UC-5 story.
   Blobsy should adopt what Gat got right: content-derived keys, per-path manifest
   merging and a local content cache.
   It should differentiate on safety, immutable snapshots, any-storage backends and
   agent UX (§9).

**Recommended path:**

- **Phase 0:** fix the safety bugs.
- **Phase 1:** simplify the core before adding any new mode: content-derived keys, a
  recoverability rule instead of the merge base, the hash cache wired in, the inert
  features deleted, and create-only writes.
- **Phases 2–3:** add collection manifests (UC-2) and snapshots (UC-3/UC-5) on the
  shared core. Their order is itself a decision (D14).

Fifteen owner decisions gate this (§11). Five of them (D1, D2, D3, D11, D15) gate Phase
1; the rest can wait.

### Glossary

- **Entry**: one file’s identity, `path, kind, size, sha256`. Kind is `f` (file), `x`
  (executable), `l:<target>` (symlink) or `d` (empty directory).
- **Pointer (`.bref`)**: a committed file holding one entry, next to its payload.
- **Manifest (`.brefs`)**: a committed file holding many entries for one collection
  directory.
- **Snapshot**: an immutable, named, packed tree (or single file) in the store, with a
  store-side manifest.
  Git holds nothing for it, or one pin pointer.
- **Recoverability rule**: `pull` may overwrite a local file only if its bytes are known
  to exist remotely or were synced on this machine (§5.2).
- **Create-only write**: an upload that fails with HTTP 412 if the key already exists
  (S3 `If-None-Match: *`, GCS `ifGenerationMatch=0`).
- **`tree_id`**: sha256 over a tree’s sorted entry lines.
- **Receipt**: a small file recording that a tree was published (`tree_id`, counts,
  destination, time).
- **Mirror**: round 8’s path-shaped copy of a run directory.
- **X-n**: a cross-cutting requirement (§1.3).

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
| UC-3 | A very large tree (node_modules, cargo `target/`) synced or cached externally with **no** manifest in git. | Nothing per tree (a config stanza at most). | Two different workloads hide here (§5.4). **Derived caches**: identity = input hash, racing writers, safe to lose, they expire. **Run archives** (round 8): path-browsable, single writer, never deleted. For derived trees the operations are *publish* and *restore*, not “sync”. |
| UC-4 | Standard git merge workflows for externalized files; merges happen in git on the metadata (UC-1, UC-2). | — | Merges must be correct **without the network** and **without hooks or drivers that blobsy installs** (GitHub merges, jj, fresh clones). Drivers and hooks may only make the result *nicer* (§4). |
| UC-5 | Fixed assets with immutable names, separate from git workflows; likely the substrate for UC-3. | Nothing, or one pin line. | Confirmed: caches (UC-3) and assets (UC-5) are **one primitive**, an immutable named snapshot. They differ only in who picks the name (derived vs chosen) and how long it lives (expiring vs forever) [S]. |

### 1.3 Use cases and requirements the framing was missing

| ID | Addition | Why it matters |
| --- | --- | --- |
| UC-6 | **Run/output archives** (round 8): process output trees mirrored to path-shaped prefixes, with receipts; append-mostly, single writer, never deleted remotely. | Real, grounded demand (the trading repo). But that repo already has a working tool, and it asked first only for the receipt schema. See D8. |
| UC-7 | **Adoption and history import**: convert existing large files *in git history*, and LFS pointers, to blobsy references. | PAIN-3/PAIN-4 are only solved going forward today. An LFS pointer is already `sha256` + size, so `import-lfs` is nearly free once keys are content-derived [S]. |
| X-1 | **Hook-independent correctness.** | Hooks don’t run on GitHub merges, in jj, with `--no-verify`, or in clones that never ran `setup`. |
| X-2 | **Partial working sets** (pull by path/glob). | Collections and assets are often larger than any one user needs. |
| X-3 | **Local content cache** shared across worktrees/clones. | Today every worktree re-downloads; Gat, LFS and DVC all have a cache. |
| X-4 | **Batched transfer and batched existence checks.** | Transfers are sequential by construction: a `for … await` loop, and the CLI backends spawn one synchronous process per file [S]. The documented 8-way parallelism cannot happen. Existence checks have the same problem at 10k entries. |
| X-5 | **Fidelity** for trees: symlinks, exec bits, empty dirs. | Required for UC-3/UC-5; absent today [S]. |
| X-6 | **Server-enforced immutability** (create-only writes). | Now broadly supported: S3, GCS, Azure, R2. Not supported by rclone’s GCS/Azure backends, B2, or command backends [S]. |
| X-7 | **Write segregation for shared caches.** | Caches where the first writer wins can be poisoned (CVE-2025-36852, “CREEP”). The mitigation is credentials, not checksums (§5.6) [S]. |
| X-8 | **Retention / GC** that is explicit, dry-run first, and based on reachability or lifecycle rules. | The other half of PAIN-3: deleting blobs safely. |

* * *

## 2. Current state

### 2.1 What works

- **The pointer.** The `.bref` pointer (YAML: `format`, `hash`, `size`, `remote_key`,
  compression fields) sits next to a gitignored payload; git versions and merges the
  pointer.
- **Safe transfers.** Pulls are hash-verified and atomic: temp file, verify, rename.
  Push refuses stale hashes (DS-03). Pull refuses to clobber local edits (DS-02). Remote
  keys are never overwritten.
- **Five backends**: built-in S3 SDK, aws-cli, rclone (GCS/Azure), local, and command.
  Command backends supplied by the repo require explicit trust.
  There is a threat model, and path containment is enforced.
- **Agent-friendly CLI.** It is non-interactive, with `--json` everywhere, and `setup`
  installs an agent skill.
- **Golden tests.** The golden-test infrastructure is unusually good for a project this
  size.
- **Round 7 blockers fixed.**
  - The stat cache is now read as a merge base.
  - Pull refuses to overwrite local edits.
  - Push has a sanity check.
  - Hook failures propagate.
  - `rm --remote --force` exists.
  - The local backend checks containment.

### 2.2 Measured behavior at collection scale [V]

Setup: 1,000 files × 210 KB of random data in 10 directories, local backend, default
config. The commands were `blobsy track data/coll`, then `push` and `sync`; the exact
steps are in Appendix A.

| Operation | Result |
| --- | --- |
| `track data/coll` | 16.0 s; produced 1,000 `.bref` + 10 `.gitignore` files (1,020 lines); the commit touches 1,010 files |
| `status` | 3.6 s (re-hashes every file on every run) |
| `push` | 23.3 s, to *local disk* |
| no-op `sync` | 8.7 s (hashes every file) |
| Remote layout | 1,000 distinct top-level prefixes, one per file |
| Compression | Random `.bin` files are stored zstd-compressed even though compression makes them larger (210,012 > 210,000 bytes) |

At 5,000 × 4 KB files [S, UC-2 sub-review]:

- `add` took 61 s.
- A no-op `sync` took 43 s.
- Adding 50 files to a 5,000-file directory cost 7.3 s, because the whole `.gitignore`
  block is rewritten for each file.

Git itself is untroubled at these sizes.
The costs come from blobsy’s per-file overhead and from what humans see in PRs.

### 2.3 Design doc vs implementation drift [V/S]

- **State symbols.** Three of the seven documented state symbols (◐ ◑ ⊗) are never
  emitted. `status` never consults HEAD, so the “three orthogonal states” model is not
  implemented.
- **Stat cache.** It is written at 12 call sites (every mutating command plus the
  pre-push hook) but read on one line: the sync merge base.
  Its documented performance role (`getCachedHash`) has zero callers.
- **Config hierarchy.** The five-level hierarchy is inert: all 13 `resolveConfig` call
  sites pass the repo root (bead `blobsy-4vpk`).
- **`.blobsy/` directory.** The design doc says `.blobsy/` is “committed to git”, but
  `doctor` errors unless it is gitignored, and `setup` does neither.
  So `git add -A` commits the stat cache, and the trash directory is machine-local and
  never read.
- **README dedup claim.** “Identical files are never uploaded twice” is false under the
  default template. The same bytes pushed twice produce two objects, and the same bytes
  at two paths also produce two objects [V].
- **Dangling spec reference.** Bead `blobsy-aad8` points at a spec file that does not
  exist.

* * *

## 3. Blocker and high-severity findings

All of these were reproduced against `04a3d1a` with the built CLI and a `local:`
backend. The table summarizes them; the blockers get details below it.

| ID | Severity | Finding | Evidence | Root cause |
| --- | --- | --- | --- | --- |
| B-1 | **Blocker — data loss** | `sync` overwrites a tracked-but-unpushed edit with the old blob. | [V]; variants [S] | `track` writes the stat-cache “merge base” before anything is committed or pushed. The three-way table then reads “ref moved back, local unchanged → pull”. |
| B-2 | **Blocker** | The pre-push hook uploads from the working tree, ignoring the refs being pushed. | [S] | The hook ignores the `<local ref> <sha> <remote ref> <sha>` lines git passes on stdin. |
| B-3 | **Blocker — PAIN-1** | A natural rename commits the payload to git. | [S] | Gitignore entries are the only protection; there is no large-file guard. |
| H-1 | High | `setup` doesn’t gitignore `.blobsy/`, so `git add -A` commits one stat-cache JSON per tracked file (1,000 cache files committed in the benchmark). | [V] | A setup gap, plus a design-doc contradiction. |
| H-2 | High | Two-phase `remote_key` (bead `pqyt`): two commits per change; the dirty pointer blocks `git checkout`; rebases conflict twice; teammates can’t pull between the two commits. | [S] | Keys assigned at push time cannot be derived. |
| H-3 | High | After any git operation that changes a pointer, `pull` refuses with exit 2 and recommends `--force`. Triggers include a teammate’s update, a revert, a cherry-pick, and the design doc’s own conflict recipe. `status` shows a teammate’s change as `~ modified`. | [S] | The overwrite decision is based on a merge base instead of on recoverability. |
| H-4 | High | Two developers adding *different* new files to the same directory get a conflict in the generated `.gitignore` block. | [S] | Sorted per-file ignore lines land in the same gap. |
| H-5 | High | The dedup and determinism claims are false under the default template. | [V] | Timestamped keys. |
| H-6 | High | Per-file `.gitignore` lines make `git status` slow down superlinearly as the number of tracked files in a directory grows. Every git command pays this, not just blobsy. | [V] | One ignore line per tracked file. |
| H-7 | High | Under jj, and under any push with `--no-verify`, hooks never fire, so `.bref` files reached the remote with no blobs. jj also mishandles payloads and ignore blocks. | [S] | Correctness depends on hooks and on load-bearing ignore lines. |
| M-1 | Medium | Compressed output is kept even when it is larger; there is no keep-if-smaller rule. | [V] | — |
| M-2 | Medium | The exec bit is lost on pull, and symlinks are skipped with only a verbose-mode message. `dist/`, `build/` and `node_modules/` are ignored by bare name at any depth. | [S] | No mode in `.bref`; walker rules. |
| M-3 | Medium | `check-unpushed` reports “all pushed” when a blob was deleted, because it checks only key presence. | [S] | The pushed state is stored in the pointer. |
| M-4 | Medium | `doctor`’s stale-cache scan is dead code: it reads only the top level of a sharded directory. | [S] | — |
| L-1 | Low | `setup` rejects `local:../repo-remote` when the repo is `../repo`, because the containment check compares string prefixes (`backend-url.ts:176`). | [V] | Missing path-separator check. |

**B-1 reproduction.** `edit f; blobsy track f; git stash; blobsy sync` reverts the file
to v1, and the v2 bytes exist nowhere.
`git stash pop` then restores a pointer to bytes that are gone [V]. The same happens via
`git checkout -- f.bref` [S]. Variant C: after an *uncommitted push*, the same revert
happens, and v2 survives only at a timestamped key that nothing records [S]. To
reproduce, gitignore `.blobsy/` first.
If `.blobsy/` was committed (H-1), `git stash` also restores the stat cache and the bug
hides.

**B-2 reproduction.** Commit on `feature`, then `git checkout main`, then
`git push origin feature`. Zero blobs are uploaded, and a clone of `feature` cannot pull
[S].

**B-3 reproduction.** `git mv a.bref b.bref; mv a b; git add -A` commits the 250 KB
payload [S].

**H-6 numbers.**

- At 20k entries, `git status` takes 0.82 s with per-file lines vs 0.009 s with one
  wildcard [V].
- The red team measured 1.3–1.6 s vs 0.013 s on another machine.
  The claim is the ~100× ratio, not the absolute times.
- 10.9 s at 50k entries [S, competitors-other §3].
- s3lfs reports 70 s at 100k.

**H-7 details** [S, jj research, jj 0.46 colocated repo]:

- jj auto-snapshots payloads under 1 MiB that it saw before `blobsy add`.
- jj’s conflict style can un-ignore payloads in the managed `.gitignore` block.

* * *

## 4. Workflows and merges across the use cases

### 4.0 The flows side by side (proposed design)

| Step | UC-1 pointer | UC-2 collection | UC-3 cache snapshot | UC-5 asset snapshot |
| --- | --- | --- | --- | --- |
| Declare | `blobsy add data/model.bin` | `blobsy add --collection data/images` | `snapshots:` stanza in `.blobsy.yml` (path + key recipe, e.g. `{hash:Cargo.lock}`) | `snapshots:` stanza with a chosen name pattern |
| Git holds | `data/model.bin.bref` (3 fields) | `data/images.brefs` (one line per file) + one ignore line | the stanza only | the stanza + optional pin `models/llama.bref` (`kind: tree`) |
| Commit | `git commit` | `git commit` | nothing per build | `git commit` the pin |
| Publish | `blobsy push` (or the pre-push hook) | `blobsy push data/images` | `blobsy snap publish target` (CI, write credentials) | `blobsy snap publish llama --version v2` |
| Clone / CI | `blobsy pull` | `blobsy pull data/images [--include 'cats/**']` | `blobsy snap restore target [--fallback]` | `blobsy snap restore llama` (verifies the pin’s `tree_id`) |
| Change | edit, `blobsy add`, commit, push | edit/add files, `blobsy add data/images`, commit, push | lockfile changes → new key → build → publish | publish `--version v3`, update the pin |
| Merge | one pointer per file (§4.2) | per-line manifest merge (§4.2) | none: the lockfile merge decides the key | one pin line |
| Delete / GC | reachability GC (§5.5) | reachability GC | bucket lifecycle rule (expires) | never |

Run archives (UC-6) are left out of this table pending D8.

### 4.1 What git does to the reference files

Two requirements govern merges:

- **Plain git must be enough for correctness** (X-1): no driver, no hooks, no network.
  GitHub’s merge button, merge queues, jj and fresh clones run nothing of ours.
- **Hydration is a separate step.** Fetching payloads after a merge is explicit, or an
  opt-in hook.

| Reference | Git-level merge behavior | Verdict |
| --- | --- | --- |
| `.bref` (UC-1) | A 6-field YAML file today; 3 fields after §5.1. One side changed → clean. Both changed the same file → a real conflict on that pointer. Different files → always clean. | Correct with plain git. **No merge driver needed** [S]. |
| Per-directory `.gitignore` block (UC-1 today) | Sorted per-file lines. Two branches adding different files to one directory insert into the same gap, causing a **false conflict** [S]. | Regenerate the block from pointers instead of merging it (§5.1). Collections use one directory line. |
| Collection manifest (UC-2) | Sorted TSV, one line per file. See the note below the table. | Safe but conservative with plain git. A **per-path three-way merge driver** removes all the false conflicts [S]. |
| Snapshot pin (UC-5) | One line changes per upgrade. Two branches upgrading to different versions conflict on that line, which is correct and trivial to resolve. | Plain git is enough. |
| Cache stanza (UC-3) | Git never sees the tree. The cache key is a function of committed inputs (the lockfile), so the package manager’s lockfile merge *is* the merge. | Nothing to merge [S]. |
| Run receipts (UC-6) | Single writer per run; never merged. | Nothing to merge. |

**Collection manifests under plain git.** Git conflicts whenever two hunks have no
unchanged line between them.
So these are all **false conflicts**, even when the paths are distinct:

- inserts into the same gap;
- edits or deletes of adjacent lines;
- both sides appending at the end of the file.

Batch additions with date- or run-prefixed names into one subdirectory conflict with
probability ≈1, whatever the manifest size [S, Monte-Carlo]. `merge=union` silently
corrupts the file: it produces duplicate paths and loses delete-vs-modify [S]. The
per-path driver prototype is 45 lines and runs in 0.13 s on 20k lines [S].

### 4.2 Ideal blobsy merge workflow per use case

**UC-1 (pointers).**

1. `git merge` is clean, or conflicts on one pointer.
2. Resolve with `git checkout --ours|--theirs x.bref`. For a content-level merge of
   text-like data, use `blobsy resolve x --tool <cmd>`, which is explicit and runs after
   the fact.
3. `git add`, then `blobsy pull`.

With content-derived keys the merged pointer is already complete: there is no
`remote_key` to write back.
`pull` applies the **recoverability rule** (§5.2):

- A teammate’s update, a revert, or a resolved conflict pulls cleanly, because the old
  bytes were synced here or exist remotely.
- An unpushed local edit is refused, and blobsy prints the two explicit choices.

Optional hydration hooks make this automatic for users who opt in: `post-checkout`,
`post-merge` and `post-rewrite` run `blobsy pull --quiet`, and never fail the git
operation.

**UC-2 (collections).** `git merge` runs the per-path driver:

- A path changed on one side takes that side.
- Identical changes merge.
- Differing changes to the same path, and delete-vs-modify, conflict **with markers
  scoped to that one line**, inside an otherwise fully merged file.

Without the driver, there are three cases:

- **A local driverless merge (fresh clone).** It is repaired by
  `blobsy merge-manifest --resolve <file>`. That command re-runs the same algorithm on
  the three index stages git leaves behind (`:1:`/`:2:`/`:3:`) [S].
- **A GitHub web-UI merge.** This leaves no index stages locally, so the **validator**
  catches a bad result.
  It checks for sorted lines, no duplicates, no conflict markers and no file/directory
  prefix collisions, and it runs in CI and pre-commit.
  The user re-runs the merge locally if it fails.
- **jj.** jj calls the same algorithm as a four-argument merge tool
  (`$base $left $right $output`), because jj ignores `.gitattributes` drivers.

Then `blobsy pull <collection>` hydrates, applying the recoverability rule per entry.

**UC-3 (caches).** No merge exists.

- After `git merge`, the merged lockfile yields a new key.
- `blobsy snap restore` hits, or misses and can fall back by prefix.
- A miss means: build, then publish.

Branches never need cache scoping, because keys are pure functions of committed inputs.

**UC-5 (pinned assets).** When both branches upgrade differently, the one-line pin
conflicts and you pick one.
`blobsy snap restore` verifies the tree id against the pin.

**UC-6 (runs).** Not merged.
Each run prefix has a single writer, and receipts are append-only.

### 4.3 Gat vs blobsy on merging

Gat 0.0.15 was built from source and tested against a `file://` remote with git 2.43
[S, `research-2026-10-22-competitor-gat.md` §7].

- **Gat, driver installed:** every scenario was run with the real binary.
- **Gat, no driver:** only the same-directory/adjacent, fresh-clone and prefix-collision
  rows were run. The other cells are standard git text-merge behavior [I].
- **Blobsy columns:** blobsy *today* (per-file pointers, measured) and the *proposed*
  design (§5.1–§5.3). The UC-2 driver was prototyped and tested [S].

**How Gat merges.**

- **One repo-wide lock.** Gat keeps every tracked file in a single `gat.lock`: sorted
  `<blake3>⇥<path>` rows, optionally sharded by path hash.
- **A per-path merge driver, installed per clone.** `gat init` registers
  `gat merge-driver %O %A %B` in `.git/config` and `.git/info/attributes`. Nothing is
  committed.
- **The per-path rule:** identical on both sides → keep; changed on one side → take it;
  changed differently → conflict.
- **Hydration after the merge.** After a clean merge, a `post-merge` hook hydrates
  payloads from the local cache.
  There is no network access unless `sync.auto_fetch` is set.

The table rows are named in the list below it.

| # | Gat (driver installed) | Gat (no driver: fresh clone, web merge, jj) | Blobsy today | Blobsy proposed |
| --- | --- | --- | --- | --- |
| **A** | Clean; hook hydrates | **False conflict** in `gat.lock` | Pointers clean, but a **false conflict in the `.gitignore` block** (H-4) | UC-1: clean (ignore block regenerated, not merged). UC-2: clean with the driver. Without it, a false conflict, repaired by `--resolve` (local) or a local re-merge (web) |
| B | Clean | False conflict [I] | Clean | Clean (UC-1); clean with the driver (UC-2) |
| **C** | Conflict, but the lock is left as *ours*, with no markers and **the other side’s clean changes omitted**. A naive `git add` silently dropped an independent addition [S, tested] | Conflict with markers [I] | Conflict on one small pointer, with markers | UC-1: conflict on one pointer. UC-2: **one marked line in the fully merged manifest**; the validator blocks committing markers |
| D | Conflict (same data-loss hazard on a naive resolve) | Conflict [I] | Conflict on the pointer | As above |
| E | Conflict (a rename is seen as delete + add) | Conflict [I] | Conflict | Same; `blobsy resolve` helps pick |
| F | Clean | Clean [I] | Clean | Clean |
| **G** | Refused by the driver. But **sharded locks merge cleanly into an invalid lock** that blocks every Gat command | **Clean text merge into an invalid lock**: “Could not read gat.lock” | Clean (independent pointers; the on-disk clash surfaces at pull) | The validator (pre-commit, `doctor`, CI) flags the prefix collision; resolved per path |
| H | Clean. Rebase hydrates (`post-rewrite`); cherry-pick does **not** hydrate | Likely conflicts [I] | Pointers clean, but the two-commit flow doubles conflicts (H-2) | Clean; one commit per change |
| I | Hook, cache-only; `gat pull` if objects are missing | Manual `gat sync`/`pull` | Manual. `pull` falsely refuses after a teammate change (H-3); `sync` works | `blobsy pull` with the recoverability rule; opt-in hydration hooks |
| J | None; hand-edit hex rows from `:1:/:2:/:3:` | Same | `git checkout --ours/--theirs x.bref` | Same for UC-1; for UC-2, `blobsy merge-manifest --resolve [--ours/--theirs PATH]` |
| K | Never | Never | Never | Never |
| L | No driver, no hooks | — | No hooks (H-7) | The driver also works as a jj merge tool; correctness doesn’t depend on hooks |

Rows (the three bold rows matter most):

- **A**: two branches add different files to the same directory, with adjacent names.
- **B**: edits to two different files on adjacent lines.
- **C**: both branches edit the same file differently.
- **D**: one branch deletes a file, the other modifies it.
- **E**: a rename on one branch, an edit on the other.
- **F**: an identical change on both branches.
- **G**: a file added at `p` on one branch and at `p/x` on the other.
- **H**: rebase and cherry-pick.
- **I**: payload hydration after the merge.
- **J**: tooling for resolving conflicts.
- **K**: whether any merge step uses the network.
- **L**: behavior under jj.

**What this shows.**

1. **Both projects reached the same per-path rules independently.** Gat proves that the
   manifest-plus-driver model works for UC-2. Blobsy’s prototype differs only in how it
   handles conflicts, and that difference matters:
   - Gat leaves the file as *ours*, with no markers.
     The conflict is invisible in `git diff`, and a careless `git add` loses the other
     side’s clean changes.
   - Blobsy writes the full merged result with per-path markers, and a validator rejects
     any file that still contains markers.
2. **Neither model is correct without the driver unless something validates the merged
   result.** Gat has no pre-commit or CI check, so hosted or driverless merges can
   produce a lock that every Gat command refuses to read.
   Blobsy should:
   - commit `merge=blobsy-manifest` in `.gitattributes` (an undefined driver falls back
     silently to text merge, which is safe);
   - ship the validator in pre-commit, `doctor` and CI.
3. **Per-file pointers are the merge unit that survives any host.** They merge cleanly
   on GitHub, in jj and in driverless clones, because there is nothing to merge except
   independent small files.
   That argues for:
   - keeping `.bref` for UC-1, rather than folding everything into one repo-wide lock as
     Gat does;
   - keeping collections *per directory* rather than per repo, so churn and conflicts
     stay local.
4. **Hydration belongs after the merge, not inside it.** Both projects agree: no network
   access inside drivers.
   - Gat’s cache-only hydration hooks, plus a local content cache, let branch switches
     work offline. Blobsy should adopt both as opt-in features (X-3).
   - Blobsy should also keep its pre-commit and pre-push guards, which Gat lacks.
     Gat lets unpushed content reach `git push` unchecked.

* * *

## 5. Design review by use case

### 5.1 UC-1: per-file pointers

**Right shape, wrong key model.** The pointer is minimal and reviewable.
But the default key embeds push time, so the pointer is incomplete until after push.
That is the largest single source of:

- user-visible friction (H-2);
- four duplicated “upload-then-write-back” code paths;
- three “is it pushed” audits that disagree with each other;
- the false dedup claims.

**Recommendation** (bead `pqyt` option 1, strengthened):

```yaml
# blobsy -- https://github.com/jlevy/blobsy
format: blobsy-bref/0.2
hash: sha256:82020d96…
size: 300000
compressed: zstd      # decided at add time; absent = stored as-is
```

- **Keys are derived, never stored.** The key is a pure function of the pointer’s
  content facts: a fixed layout `<algo>/<h0h1>/<h2h3>/<hash>[.zst]` under the backend
  prefix.
  - Push never writes back, and invariant 2 (§6.2) holds without exceptions.
  - `remote.key_template`, its variables and the timestamped default are deleted.
  - Because the key doesn’t depend on the path, `git mv`, renames and promotion into a
    collection never change it.
- **Filenames stay visible as object metadata**, not in the key (D2). Blobsy sets
  `x-amz-meta-blobsy-path` and `Content-Disposition` at upload where the backend
  supports it, and `blobsy ls --remote` renders a path view from the pointers.
- **Push is a create-only PUT.** “Already exists” means already published.
  Push never edits the pointer.
- **No backward compatibility.** The reader accepts exactly `blobsy-bref/0.2` and fails
  fast on anything else (“re-run `blobsy add`”). See §5.7.
- **The design is specified in full** in
  `docs/project/specs/active/plan-2026-10-22-blobsy-v3-redesign.md`.
- **“Pushed” becomes remote state, not pointer state.** Offline `status` reports
  tracked, modified or missing.
  `status --remote` and the pre-push check verify existence in batch (X-4).
- **Compression is decided at `add` time.**
  - Decide by rule. For candidate files, compress once and keep the result only if it is
    at least 5% smaller; the file is being hashed anyway.
  - Record the decision in the pointer, so every machine derives the same key.
  - Drop `compressed_size` from the pointer.
- **What is lost:** the date-browsable default layout.
  Path-shaped browsability is the job of mirrors (UC-6), and for file mode, of
  `blobsy ls --remote`.

**The pre-push hook (B-2).** The hook reads the pushed refs from stdin and uploads what
those commits reference.

- Uploading from *any* commit needs D2.
- Until then, the hook can upload only from the working tree.
  It must **abort** the push when a pushed pointer’s payload is not in the working tree.

**The large-file guard (B-3).** A pre-commit guard refuses a staged payload that has a
sibling pointer or exceeds `externalize.min_size`, and a CI/`doctor` check does the
same.

- Hooks are not reliable (X-1), so committed ignore lines remain the hook-independent
  protection.
- They stay load-bearing until the CI check exists.

**Ignore entries (H-4, H-6, H-7).** Per-file ignore lines are fine at UC-1 scale.
Past a few thousand entries, though, they conflict on concurrent adds and make every
`git status` superlinear.
The fixes:

1. **Collections** (§5.3) take large directories down to one ignore line.
2. **Regeneration:** `doctor --fix` rebuilds the managed block from the pointers that
   are present. A conflicted block becomes a one-command repair rather than a merge.
3. **Rejected: Gat’s approach** of writing per-file exclusions to the uncommitted
   `.git/info/exclude`.
   - It is per-clone.
   - It breaks in linked worktrees, which is a known Gat bug.
   - It makes unprotected clones the default.

### 5.2 UC-4: merges and git operations

The merge workflows are in §4. The core change here: replace the stat-cache merge base
with a **recoverability rule**.

> `pull` overwrites a local file only if its bytes are known to be recoverable, meaning
> either: (a) the hash cache records that this hash was pushed or pulled on this
> machine, or (b) with derived keys, `exists(key(localHash))` is true on the backend.
> 
> Git history is used only to word the refusal (“your local content matches commit X,
> which was never pushed”), never as permission to overwrite.
> When offline with no cache evidence, refuse and print the two explicit choices.

**Why not the v1 draft’s rule.** The v1 draft proposed a weaker “known-synced” rule:
overwrite if the local hash appears in the path’s git history.
The red team showed that loses data in plain git:

1. `blobsy add`.
2. `git commit` (not pushed).
3. `git revert`.
4. `blobsy pull` overwrites bytes that were never uploaded.

The same happens after jj, `--no-verify` or B-2. A hash in history is not evidence that
the bytes exist remotely.

**What the recoverability rule changes:**

- It fixes all B-1 variants and H-3 without a merge base.
- The cache becomes a size+mtime hash-skip accelerator plus a record of what was pushed
  and pulled.
- The cache is written only after a successful push or pull, never by `track`.

**`sync` becomes `pull` followed by `push`, with no decision logic of its own.** It
exits 2 only on a refusal that `pull` would also make.
Otherwise the 9-state table will grow back.

**Do not add:**

- a `.bref` merge driver (plain git already gets it right);
- file locking (it needs a server);
- content-merge drivers inside `git merge` (that means network inside git operations).

**Do add:**

- `blobsy diff`, a PR summary of what was added, removed or changed, with sizes;
- `blobsy resolve --tool`;
- opt-in hydration hooks.

### 5.3 UC-2: collections

**Today**, a directory becomes N pointers, N ignore lines, N stat-cache files and, under
the default template, N remote prefixes.
Git copes fine: 10k files make a 2.67 MB pack.
The pain is elsewhere [S]:

- the PR: a 100-file update shows as “101 files changed”;
- the ignore file;
- blobsy’s per-file overhead.

Thresholds [S]:

- up to ~50 files per directory, pointers are right;
- between ~50 and ~300, review degrades;
- above ~300, or for any directory that receives files in batches, use collections.

**Recommended design:** a second *container* for the same entry, not a second kind of
thing. The name `.brefs` is an open decision; `.btree` was also proposed.

```text
data/images/            <- directory, gitignored as a whole (one line: "images/")
data/images.brefs       <- committed manifest
```

```text
# blobsy collection manifest -- https://github.com/jlevy/blobsy
# Run: blobsy status data/images | blobsy --help
#format blobsy-manifest/0.1
#columns path	kind	size	sha256	stored
cats/001.jpg	f	48213	9f2c0e7b…e1	-
scripts/fetch.sh	x	1430	5e0f9c1d…02	-
tables/2026-10.parquet	f	734003200	a81c4f3e…9b	zstd
```

**One entry format, pinned here.**

- **Columns:** `path ⇥ kind ⇥ size ⇥ sha256`, with `kind ∈ {f, x, l:<target>, d}`.
  Collections will rarely contain `l:` or `d`.
- **`stored`:** `.brefs` adds this as a fifth column, excluded from the id.
- **`tree_id`:** sha256 over the sorted lines of the first four columns.
  It is computed, never stored in git.
- **Shared definition.** Snapshots (§5.4) and receipts use the same definition, so
  checking that a receipt matches a manifest is a string compare.
- **Supersedes** the `path size sha256 mode` column order in the tree-manifests research
  doc and the UC-2 sub-review.

**Static header, no aggregates.** The body is sorted bytewise TSV. Counts, totals, a
tree hash or timestamps would change on every edit and make every pair of concurrent
edits conflict. That was DVC’s mistake.

**Per-file objects, content-addressed.** Keys are derived from the line.
Push never writes back, and moving a file between a pointer and a collection needs no
re-upload.

**Commands:**

- `add --collection <dir>`.
- `add <dir|subpath>` adds and updates.
  Removal happens only via `--prune` or `rm`, because partial pulls make snapshot-style
  `add` unsafe.
- `status`, `push`, `pull [--include <glob>]`, `verify`, `untrack`.
- Later: `diff`, and demotion back to pointers via `add --files`.

**Status, pull and sync** on collections use the recoverability rule of §5.2. This
supersedes the UC-2 sub-review’s reuse of `decideSyncAction` and the merge base.
The sub-review’s “not pulled” vs “missing” distinction survives: it depends on whether
the hash cache has ever recorded the path.

**Merging** works as in §4:

- `setup` installs the per-path driver, and `.gitattributes` is committed.
- `--resolve` handles local driverless merges.
- The validator runs in pre-commit, `doctor` and CI.

**Not in v1:** auto-sharding, packs, symlink/mtime fidelity, textconv drivers, nested
collections, per-entry key overrides, `merge=union`.

**Option A stays rejected.** Round 8 rejected Option A (a digest-only directory
pointer). That rejection stands, for a different reason here: UC-2 *wants* the per-file
list in git. Re-point bead `blobsy-aad8` at this design.

### 5.4 UC-3 and UC-5: trees and immutable assets

**Taxonomy [S].**

|  | Repo files (UC-1/2) | Run archives (UC-6, round 8) | Derived caches (UC-3) | Pinned assets (UC-5) |
| --- | --- | --- | --- | --- |
| Identity | path at a commit | path-shaped prefix | input hash (lockfile, toolchain, platform) | chosen immutable name |
| Writers | many, via git | one per prefix | many CI jobs racing | one publisher per name |
| Lifecycle | versioned by git; GC by reachability | frozen when done; never deleted | immutable per key; expires | immutable; forever |
| Git holds | pointer / manifest | receipt (optional) | config stanza only | one pin pointer (optional) |
| Transfer unit | file (batched) | file (batched) | packed archive | packed archive or single file |
| Fidelity | content + exec bit | content | symlinks, exec bits, empty dirs | same |

**Why existing modes can’t stretch to cover trees [S].**

- Stretching **file mode** to trees fails on:
  - fidelity;
  - per-file transfer cost (14,711 PUTs for one `node_modules`);
  - git footprint.
- Stretching **mirror mode** to caches fails on:
  - identity;
  - concurrency (last writer wins on a shared prefix);
  - restore speed;
  - lifecycle.

**Recommended: one *snapshot* primitive for UC-3 and UC-5** [S]:

- **Identity:** the canonical entry of §5.3; `tree_id` over the sorted entry lines.

- **Store layout:** everything lives under the snapshot’s name.
  - `snap/<name>/data.tar.zst` and `manifest.tsv.zst`.
  - A tiny `ref.yaml`, written **last** with a create-only PUT. It is the commit point.
  - If the ref write returns 412, read the existing ref.
    Same `tree_id` means it is already published.

- **Names:**
  - Derived for caches, e.g. `cache/target/v1/{os}-{arch}/{hash:Cargo.lock}`. Template
    variables must be pure, so there is no `{cmd:…}` (threat-model rule 1).
  - Chosen for assets, e.g. `assets/llama-3-8b/v2`.
  - Names are never mutable, and there is no “latest”.

- **Git:** holds nothing per cache snapshot.
  A pinned asset is a `.bref` with `kind: tree`, `name` and `hash: <tree_id>`, verified
  on restore.

- **Restore:**
  1. Read the ref and the manifest, and verify the tree id.
  2. Fetch the archive through the local content cache.
  3. Extract to a sibling temp directory, and verify every file.
  4. Swap it into place with two renames.

  Options: `--only <glob>` restores part of the tree; `--fallback` restores the newest
  name under the parent prefix (actions/cache `restore-keys` semantics).

- **Packing:** one deterministic `tar.zst` per snapshot in v1. Measured on this repo’s
  `node_modules` [S]:
  - 14,711 files / 171 MB packed to 40 MB in 2.8 s;
  - restored, with all symlinks and exec bits, in 4.8 s.

- **Expiry:** bucket lifecycle rules on `snap/cache/`. Assets never expire.

- **CLI:** one noun with immutable verbs: `blobsy snap publish|restore|ls`, later
  `status|show|pin|gc`. Don’t reuse `push`/`pull`; the safety profiles are opposite.

- **Non-goals:**
  - bidirectional sync of derived trees;
  - mutable names;
  - hooks;
  - per-file objects for snapshots;
  - CDC;
  - signatures (in v1);
  - ecosystem-specific pruning;
  - executing commands from key templates.

- **Guidance:**
  - For JS and Python, cache the package-manager store (pnpm store, uv cache), not
    `node_modules`/`.venv`, which contain absolute paths and pnpm hardlinks.
  - The clean wins are `target/`, model directories and preprocessed datasets.
  - The default mtime policy needs a cargo fingerprint experiment first.

**Mirrors (UC-6) are an open decision (D8), not settled.** The options:

- (a) Approve round 8’s mirror mode, narrowed.
- (b) Fold mirrors into snapshots as `snap publish --unpacked`: path-shaped keys, no
  tar, and the receipt *is* the snapshot `ref.yaml`.
- (c) Defer: ship only `blobsy receipt write|verify <dir>` (`tree_id` plus a receipt,
  ~100 LOC) and an rclone recipe.
  Build mirrors only if the trading repo commits to adopting them.

Recommendation: (c) now, and (b) if demand materializes.
That leaves two families: in-git entries (pointers and manifests) and named snapshots.
Under any option, round 8’s R10 “shared tool caches” belong to the snapshot primitive,
as single-file *entry assets*.

**The owner’s hypothesis holds.** UC-5 lets UC-3 avoid file-level merges.
Precisely, the merge surface collapses to:

- the key inputs, for caches (the lockfile, which the package manager merges);
- one pin line, for assets.

The trade-off is that git cannot diff the tree; `blobsy snap show --diff` does.

### 5.5 PAIN-3 and PAIN-4: removal, migration, and the LFS comparison

**Pointers solve PAIN-3 going forward.** Removing a pointer from history is cheap, and
the bytes live in a bucket the owner controls.

**Native git still does not solve it.** The “large object promisor” work (Git 2.49–2.56)
makes clones cheaper.
But git’s own design notes say a pushed large blob may not be removable without
rewriting history [S]. GitHub still documents “delete and recreate the repository” as
the way to remove LFS objects [S].

**Missing for PAIN-3/4:**

1. **`blobsy import-lfs`.** LFS pointers are sha256 + size.
   With SHA-256 (D15) they convert without reading the content.
   With BLAKE3, each object in `.git/lfs/objects` is read once to rehash, which is local
   work done while copying it into the store anyway.
   This is the highest-leverage adoption feature.
2. **`blobsy migrate import`.** A history rewrite via `git filter-repo`, in the style of
   `git lfs migrate import`. It is tractable only with content-derived keys.
3. **Reachability GC.**
   - Reachable keys are `key(entry)` for every entry in every `.bref`/`.brefs`, across
     all refs.
   - Orphans are the listed objects minus the reachable ones.
   - Deletion is age-gated and dry-run first, with bucket versioning or Object Lock as
     the recovery window.
   - GC must refuse to run if any pointer in the scanned history fails to parse in the
     current format, rather than treating its objects as orphans.

**An honest LFS comparison.**

- Blobsy wins on:
  - cost;
  - provider neutrality;
  - state that agents can read;
  - dedup across history (after §5.1).
- LFS wins on:
  - transparency (smudge/clean filters);
  - maturity (migrate, prune, locks);
  - hosting UI.

Blobsy should not claim “simpler” while every change takes two commits.

### 5.6 Cross-cutting: credentials, CI, platforms, large objects, scope

- **Credentials and CI (X-7).** This is the actual CREEP mitigation [S]:
  - Laptops and PR builds get read-only credentials.
  - Only protected-branch CI gets write credentials for `snap/cache/` (and for pushes,
    where policy allows).
  - Snapshot `ref.yaml` records provenance (branch, commit, run id), and a signature
    field is reserved.
- **Windows.** None of this is tested today.
  - Restoring snapshot symlinks needs Developer Mode or admin rights.
    Restore must fall back to copying the targets, with a warning.
  - Case-insensitive filesystems need collision detection when files are added to a
    manifest.
  - Hook shims must work in Git for Windows.
- **Large single objects (over 5 GB)** must be uploaded multipart.
  - S3 honors `If-None-Match` on `CompleteMultipartUpload`.
  - GCS’s XML multipart API rejects preconditions, and R2 doesn’t document support for
    them at multipart completion.
  - So create-only writes for very large objects fall back to exists-then-put on those
    backends. Snapshot commit objects are always small single PUTs, so this never affects
    them.
- **Moving between backends** becomes a real PAIN-5 win with derived keys: `rclone copy`
  the prefix and change the backend URL. No pointer is rewritten.
- **Scope limits.**
  - One backend per repo.
    Dropping subdirectory configs removes the only per-directory override, so monorepos
    that need two buckets are out of scope for now.
  - Partial clone and sparse checkout compose naturally: pointers and manifests are
    tiny, and snapshots live outside git.

### 5.7 No backward compatibility

Blobsy is a pre-alpha proof of concept with no released users.
Per the owner’s policy and `backward-compatibility-rules` (“DO NOT MAINTAIN”), none of
this work keeps old formats, keys, config, commands or objects.

- **Pointers:** readers accept exactly the current format and fail fast with “re-run
  `blobsy add`”. There is no dual reader and no migration command.
- **Objects:** objects stored under old key layouts are abandoned.
  Existing test repos delete their pointers and re-add.
- **Commands and config:** removed commands and config keys disappear outright, with no
  aliases or deprecation period.
- **Local state:** machine-local state moves under the git directory.
  Any stray `.blobsy/` is just deleted.
- **Releases:** each change ships as one coordinated breaking release, with no mixed-
  version rollout planning.

* * *

## 6. Proposed architecture

### 6.1 One storage contract, one entry format, two ways to reference it

Replace principle 9 (“one primitive … no second kind of thing”) with the statement
below. If D2 picks pure CAS, also reword principles 5–6, which promise filenames in the
remote.

> **One storage contract**: immutable objects, create-only writes and hash-verified
> reads.
> 
> **One entry format**: `path, kind, size, sha256`.
> 
> **Two ways to reference it:**
> 
> - **in git**: a `.bref` pointer for a file, or a `.brefs` manifest for a collection;
> - **by name**: a snapshot for a tree or asset, optionally pinned in git.

Mirrors become a third way only if D8 approves them.

The original design was right to eliminate *mutable remote manifests used as
coordination state*. A committed manifest is the opposite: git sees it, git merges it,
and the store stays a dumb store of immutable blobs.

### 6.2 Object model and invariants

**Objects:**

- **Blob:** immutable bytes, identified by the sha256 of the original content, with an
  optional encoding (`zstd`). It is stored at a key that is a function of committed
  entry data.
- **Ref:** a committed pointer (`.bref`): one entry at an adjacent path.
- **Manifest:** a committed list of entries for a collection directory: N refs in one
  file.
- **Snapshot:** a named, immutable, packed tree (or single file), with a store-side
  manifest and a create-only commit object.

**Invariants:**

1. **Store writes are create-only.** Nothing overwrites.
   Deletion happens only through explicit GC, or lifecycle rules on cache prefixes.
2. **Keys come only from committed data.** For refs and manifests, the key is a function
   of committed entry data.
   No push-time state is ever written into a committed file.
3. **One discipline per path.** A path is governed by exactly one discipline, and
   `doctor` errors on overlap.
4. **Verify before replacing.** Pulled or restored bytes are hash-verified before they
   replace anything. Local bytes are overwritten only if they are recoverable (§5.2).
5. **Correctness never depends on hooks or drivers.**
   - Hooks only verify and do convenience syncs; nothing unbounded runs in them.
   - Snapshots never run in hooks.
   - CI checks are the backstop that doesn’t depend on hooks.

### 6.3 Module layout

```
cli/verbs/   one file per verb (plan + execute); verbs dispatch by discipline
core/        hash + hash cache, paths, config (3 levels), errors, reporter, git helpers
store/       Backend (+ list, putIfAbsent, capabilities), transfer (batch), local CAS cache
refs/        file.ts (.bref), manifest.ts (.brefs) — one Entry loop for push/pull/status/verify
snap/        snapshot publish/restore/ls/gc, pack/unpack, tree walk with fidelity
doctor/      check registry; each module registers its checks
```

**One loop for refs and manifests.** Once keys are derived and the merge base is gone,
`push`, `pull`, `status` and `verify` become one loop over
`Entry {path, kind, hash, size, encoding}` for both refs **and** manifests [S].
Snapshots share `store/` and `core/`, but have their own loop.

**Machine-local state moves under the git directory.**

- The hash cache goes under `$(git rev-parse --git-path blobsy)/` (per worktree).
- The shared content cache goes under `$(git rev-parse --git-common-dir)/blobsy/`, or a
  user-level cache.
- This removes `.blobsy/` from the working tree entirely: no gitignore line, no `doctor`
  check, and nothing for jj to auto-snapshot.

### 6.4 Backend interface additions

- **`list(prefix)`.**
- **`putIfAbsent(key, …)`:** S3 `If-None-Match: *`, GCS `ifGenerationMatch=0`, Azure
  `If-None-Match`, local `O_EXCL`.
- **Batch transfer and batch existence checks:** rclone `--files-from0`, an SDK
  concurrency pool, and `list` over the content-addressed prefix instead of one HEAD per
  file.
- **`capabilities.conditionalPut`**, set by a `doctor` probe that writes a sentinel
  twice and expects success, then 412. A probe is needed because S3-compatible stores
  can silently ignore the header [S].

**Known gaps:**

- rclone’s GCS and Azure backends pass no preconditions.
- B2 rejects the header.
- Command backends can’t express it.

On those backends blobsy uses a documented exists-then-put fallback.
Alternatively, for the small commit objects only, OpenDAL’s npm bindings offer native
in-process writes (§7.4). Command backends without a `list_command` fall back to
per-file existence checks.

* * *

## 7. Engineering complexity review

### 7.1 Inventory [S]

The source is 8,862 LOC; the current design docs are 9,436 lines, more than the source.
The source breaks down as:

- ≈3,600 LOC mode-specific: tracking, gitignore, sync, hooks, templates, compression,
  config;
- ≈2,900 shareable: backends, transfer, output, core;
- ≈1,400 doctor and plumbing (`doctor` alone is ~915 LOC);
- ≈400 dead or duplicated.

To use blobsy fully, an agent must absorb ~80 nouns:

- 22 commands;
- ~35 config keys;
- 7 environment variables;
- 7 state symbols;
- 6 pointer fields;
- hidden state.

**What the proposal does to these numbers (honestly):**

- **Phase 1** deletions (S1–S5, S8, S10) remove roughly 1.3–1.9k LOC (15–20%). They
  remove a much larger share of the *concepts*: timestamps, write-back, two-commit
  flows, the merge base, ambiguous states, the trash, inert config levels and hidden
  commands.
- **Phases 2–3** then add more code than Phase 1 removes: a manifest parser, validator
  and driver; tar packing; snapshot verbs; the backend additions.

The net result is **fewer concepts per use case, and more code in total**. For scale:
Gat covers UC-1/2/4, with hooks, a cache, routes and mounts, in ~150k lines of Rust
including tests. Blobsy’s advantage has to come from refusing most of that surface.
§10 names the smallest cut of each phase.

### 7.2 Accidental complexity

| Upstream choice | What it forced | Verdict |
| --- | --- | --- |
| Timestamped default key template | `remote_key` in the pointer; two-phase commits (pqyt); 4 copies of upload-then-write-back; `track` clearing keys; 3 “pushed” audits; false dedup; `push --force` orphaning unchanged content | Accidental. Remove it, and forbid push-time variables (§5.1). |
| Bidirectional `sync` with a stat-cache merge base | 9 decision states; exit 2 from sync; “ambiguous after git pull”; B-1 data loss; a 583-line design doc | Accidental. Replace with the recoverability rule (§5.2). |
| Compression decided at push time | The encoding leaks into the key and the pointer; different configs → different keys | Wrong placement. Decide at add time. |
| Trash directory | Written, never read. It is gitignored, so the “GC paper trail” can’t work | Delete; git history is the undo. |
| 8 hidden commands | Full handlers, goldens, docs | Delete them, or fold them into flags. |
| Five-level config hierarchy | An inert walk, a duplicated loop, an unreachable `subdir` origin, an inert `checksum` section | Delete (bead `4vpk`: drop). |
| No reporter, no plan/execute split | 117 hand-written quiet/json guards; duplicated dry-run logic per command | Refactor when the second container lands (Phase 2). |
| Per-file adjacency everywhere | O(N²) gitignore rewrites; 2 git spawns per file in rm/untrack; sequential transfers | Batch per command. |

**Essential, and worth keeping:**

- the pointer (hash + size);
- the backend layer;
- atomic verified pulls, and create-only remote semantics;
- path containment, and the threat model;
- externalization rules;
- `--json` and non-interactivity;
- golden tests;
- `doctor` as a concept, at a fraction of its size.

### 7.3 Simplifications, ranked by complexity removed ÷ capability lost [S]

| # | Change | Removes | Loses |
| --- | --- | --- | --- |
| S1 | Delete the inert subdir-config walk, the `subdir` origin, `checksum`, `sync.tools` | ~150 LOC; bead 4vpk | nothing |
| S2 | Delete `.blobsy/trash/` and the ⊗ state | a contradiction + dead code | nothing |
| S3 | Delete the hidden commands (see below) | ~300 LOC; 7 goldens | nothing (no aliases; pre-alpha) |
| S4 | Derived keys only, with no push-time variables; compression decided at add time; no stored `remote_key`; fixed key layout (templates deleted) | pqyt; all write-back paths; 3 audits | the date-browsable default layout |
| S5 | Drop the merge base; adopt the recoverability rule; actually wire the hash cache into status/verify/push/pull | ~325 LOC; 9 states; B-1; H-3 | nothing that works today |
| S6 | A reporter abstraction + plan/execute per verb | 117 guards; duplicated dry-runs | nothing |
| S7 | Batch gitignore writes, git spawns and transfers per command | O(N²) rewrites and O(N) spawns | nothing |
| S8 | Doctor diet: table-driven checks; fold `health` in; fix or drop the dead cache scan | ~300 LOC | did-you-mean on config keys |
| S9 | Compression: zstd + none only; keep output only if smaller | small | gzip/brotli (no decoders kept) |
| S10 | Consider dropping the `aws-cli` backend; the SDK backend covers it | 176 LOC + tests | aws-cli quirks |

The hidden commands in S3, and where each one goes:

- `init` → `setup`;
- `track` → `add --no-stage`;
- `health`, `check-unpushed`, `pre-push-check` → `doctor` flags;
- `readme`, `skill` → `docs` flags.

**How the changes group:**

- **S1–S3** are pure deletions.
- **S4–S5** are the architectural pair that makes UC-2 cheap.
- **S6–S7** keep the next modes from tripling the plumbing.
  Do them as part of Phase 2, not before.

### 7.4 Implementation language: TypeScript vs Rust

Full report:
[`round9-subreviews/language-typescript-vs-rust.md`](round9-subreviews/language-typescript-vs-rust.md)
[S].

The question is fair.
Gat, jj, Xet, Oxen and Lore are all written in Rust, and the landscape research calls
single-binary distribution “the category norm”.
But the evidence says this is not a language problem.

| Concern | Finding |
| --- | --- |
| Startup | `blobsy --version` takes 0.53–0.58 s, vs 0.03 s for bare `node` [V]. The cost is eager imports (see the breakdown below) [S]. A lazily loaded TS CLI starts in ~100–150 ms; Rust CLIs (gat, jj) start in 8–14 ms. A merge driver runs once per conflicted *manifest*, not once per data file, so ~100 ms is invisible. |
| Hot paths | Rough parity [S]. SHA-256, a 100k-file walk and zstd are all within 1.0–1.5×. The SHA-256 comparison was OpenSSL vs Rust `sha2` without SHA-NI on this CPU. Neither language is the bottleneck. Only BLAKE3 is a large Rust win, and that is a choice of hash, not of language; the Gat comparison recommends keeping SHA-256. |
| Single binary | `bun build --compile` produced a working 84 MB blobsy binary in 2.8 s [S], and Node SEA is maturing. Claude Code and Codex ship native binaries through per-platform npm packages. That packaging works the same for a bun/SEA build or a Rust binary, so install UX is independent of language. |
| Ecosystem | Create-only writes are available in every option: AWS SDK v3 `IfNoneMatch`, `aws-sdk-s3`, Rust `object_store`, and **OpenDAL’s npm bindings**. The last could give blobsy in-process GCS/Azure preconditions without rclone, closing the gap in §6.4 [S]. |
| Supply chain | A wash [S]. Blobsy’s production dependency tree has 166 npm packages (94 are AWS SDK/Smithy). A blobsy-shaped Rust CLI would pull ~276 crates; Gat pulls 455. |
| Velocity | A clean Rust release build takes minutes (Gat ~7 min); vitest and goldens iterate in seconds. Coding agents still pay a compile-fix tax in Rust [S]. The three blockers (B-1..B-3) are policy bugs that no type system prevents. Error-shape drift is the one place Rust’s `Result` would genuinely help. |
| Switch cost | After Phases 1–2: ~5–6k LOC of TS becomes ~7–9k of Rust, taking 3–6 weeks plus release engineering [I]. Porting *before* Phase 1 would mean porting code that is about to be deleted. The 71 golden tryscripts run `blobsy` from `$PATH`, so they carry over unchanged to any binary with identical output [S]. A napi-rs hybrid is the worst option: all of Rust’s build matrix for ≤1.5× gains. |

Startup cost by import [S]:

- `marked-terminal`: ~160 ms;
- `@aws-sdk/client-s3`: ~133 ms;
- `zod`: ~64 ms;
- `yaml`: ~36 ms.

**Recommendation: stay in TypeScript through Phase 3**: no rewrite, no hybrid.
Whatever happens later, do these now:

- Lazy-load `@aws-sdk`, `marked-terminal` and `zod`, with a CI startup budget
  (`--version` under 200 ms).

- Give the merge driver and the hooks a minimal-import entry point.

- Ship bun-compiled binaries alongside npm as an experiment, and run the golden suite
  against them.

- Write a normative spec, with test vectors, for:
  - `.bref` 0.2 and `.brefs`;
  - `tree_id`;
  - the deterministic tar flavor;
  - key derivation;
  - the `--json` schemas.

  A spec makes a later port, or a second implementation, cheap.

The package already requires Node ≥ 22.15, the zstd floor.
Only `CLAUDE.md` and `.nvmrc` imply 24, and only for development.

**Decision rule:** switch to Rust after Phase 2 only if one of these is *measured*:

1. **A workload blows its budget.** After Phase 1 and lazy imports, a real workload is
   more than 2× over budget, and the profile blames the runtime.
   Suggested budgets:
   - `status`/`verify` on a 10k-entry manifest: ≤ 1 s warm;
   - `--version`, hooks and the merge driver: ≤ 150 ms;
   - publishing a 15k-file / 170 MB snapshot: ≤ 10 s.
2. **Distribution fails.** Both `npx` and a single binary are unacceptable in a target
   environment.
3. **Blobsy becomes a library product** that needs in-process git or non-JS embedding.
4. **A supply-chain incident.** An npm incident makes the dependency tree unacceptable.

If none of these fires by the end of Phase 3, the question is settled.

### 7.5 Documentation

Restructure the docs (round 7 already asked for part of this):

- **`spec/`**, normative and ≤800 lines, describing shipped behavior only: concepts,
  invariants, formats, commands, config, threat model.
- **`roadmap/`**: everything deferred, including this review’s proposals once approved.
- **`reviews/`**, read-only: rounds 7–9, these sub-reviews, archived plans.
- **A testing doc** of ≤300 lines, and **a README** of ≤200 lines.

Render defaults and command tables from code, as is already done for the skill text.

This round adds ~4,400 lines of review and research.
The first act of the restructure should be moving rounds 7–9 and the sub-reviews into
`reviews/`, so the normative spec stops sharing a directory with critiques of it.

* * *

## 8. Agents and non-git porcelains

**Agent skill gaps [S].**

- The SKILL omits:
  - `sync`, `mv` and `rm`;
  - conflicts;
  - what to do after `git pull/merge/rebase/stash`;
  - the two-commit rule.
- Worse, `pull`’s refusal message teaches `--force`, which is destructive in exactly the
  case that matters.
- After §5.1–§5.2, most of these instructions disappear rather than needing to be added.

**jj (Jujutsu)** [S, jj research, tested with jj 0.46.0 in a colocated repo]. jj is
active, with monthly releases (0.34 → 0.46 since Oct 2025). It still has no LFS,
`.gitattributes`, hooks or partial clone.

What breaks for blobsy under jj:

- **No pre-push upload.** `jj git push` runs `git push --no-verify`, so the pre-push
  upload never happens (H-7). This is the strongest argument for X-1 and for derived
  keys.
- **Payloads committed by accident.** jj snapshots non-ignored files under 1 MiB. A
  payload that jj saw before `blobsy add` stays tracked, and recovery needs
  `jj file untrack`.
- **Drivers ignored.** jj ignores `.gitattributes` drivers, so the manifest driver must
  also work as a four-argument jj merge tool.

What already works:

- `blobsy add` → `blobsy push` → `jj commit` → `jj git push`;
- `jj resolve --tool :theirs` for pointer conflicts.

Recommendations:

- Move machine-local state under the git directory (§6.3).
- Regenerate the ignore block rather than merging it.
- Detect jj: skip `git add`, and untrack payloads that jj already snapshotted.
- Add a jj pre-upload hook once jj ships one.

**Plan/apply output.** A `--dry-run --json` that emits the exact resolved keys and
actions becomes trivial once keys are derivable, and suits agents well [S].

* * *

## 9. Competitive landscape (October 2026)

### 9.1 Gat — the closest competitor

Full reference: `research-2026-10-22-competitor-gat.md`: a source review plus empirical
runs of Gat 0.0.15, built from source [S].

**What it is.**

- Rust, Apache-2.0, created 2026-09-07; releases v0.0.10–0.0.15.
- About 152k lines, including 2,467 tests, with CI on three OSes.
- One human maintainer, ~630 stars, and little discussion so far.

**Its design:**

- **Lock file:** a committed repo-wide `gat.lock` (BLAKE3 → path; no size, mode or
  compression), optionally sharded by path hash.
- **Config:** three scopes (global, project, local).
- **Keys:** derived as `blake3/xx/yy/<oid>` and never stored, so there is no two-phase
  commit. The remote is opaque.
- **Backends:** OpenDAL (S3, Azure, GCS, OSS, fs).
- **Local state:** a CAS cache with reflink/hardlink materialization, plus SQLite
  placement state.
- **Ignores:** per-file exclusions in `.git/info/exclude`.
- **Hooks:** hydration hooks (post-checkout, post-merge, post-rewrite), but **no
  pre-commit or pre-push guard**.
- **Merging:** a per-path merge driver, installed per clone.
- **Output:** no `--json`.

**Is Gat’s design better?** Decision by decision [S, Gat doc §12]:

| Decision | Better | Note |
| --- | --- | --- |
| Derived keys vs stored `remote_key` | **Gat** | The single most important lesson. Adopt it (D2). |
| Local CAS cache | **Gat** | Offline branch switches, free re-adds, verified prune. Adopt it as optional (X-3). |
| Merge driver | **Gat ships one; blobsy’s prototype handles conflicts better** | The rules are the same. On conflict Gat keeps *ours* with no markers, which loses data on a naive resolve. |
| Config scopes (global/project/local, `${VAR}` URLs) | **Gat** | Matches dropping subdirectory configs (S1). |
| Single binary | **Gat** | The category norm. §7.4 shows how blobsy gets one without Rust. |
| Unit of reference | **Split** | One lock is best at scale, but it is a single conflict hotspot that needs a per-clone driver. Per-file pointers merge everywhere. Blobsy’s pointers plus per-collection manifests combine both strengths. |
| PR diff readability | **Split** | Gat: one line per change, hash first, no size. Blobsy proposes path-first rows with kind and size. |
| Hash (BLAKE3 vs SHA-256) | **Split** | SHA-256 matches LFS oids (making `import-lfs` free), S3 native checksums, and Node crypto. BLAKE3 measured ~8.5× faster per file here, in Node, Bun and Rust alike. One algorithm is chosen (D15). |
| Remote browsability | **Blobsy** (with D2 option b) | Gat buckets are unreadable without git. |
| Backend pluggability | **Blobsy** | Command and rclone backends have no Gat equivalent. |
| Safety hooks | **Blobsy** | Gat lets unpushed content reach `git push`, and it ignores `core.hooksPath`. |
| Agent UX | **Blobsy** | `--json`, the skill, and self-describing pointers. |
| UC-3 / UC-5 | **Blobsy (if built)** | Gat has none. Its experimental `mount`, which pins another repo’s lock, is the nearest thing to UC-5. |

**Verdict.** For the repo-files core (UC-1/2/4), Gat’s design is better engineered and
more coherent than blobsy’s *current* design.
It made the right calls on keys, collections, caching and hydration.
It is weaker on safety at the edges, transparency, pluggability and UC-3.

Running Gat surfaced these bugs:

- a conflict UX that loses data;
- invalid locks from hosted or sharded merges;
- worktrees clobbering each other’s exclude blocks;
- `core.hooksPath` ignored;
- the exec bit lost;
- payload edits invisible to `gat status`;
- fetch stopping at the first missing object.

Gat already embodies most of the core changes this review recommends (D2, D3, D4, X-3).
The rest — safety guards, validation, `--json`, UC-3/UC-5 — are where blobsy can lead.

### 9.2 Other tools

Source-level reviews are in `research-2026-10-22-competitors-other.md` and the landscape
refresh [S]:

| Tool | What it is (Oct 2026) | Relevance to blobsy |
| --- | --- | --- |
| **s3lfs** (Python) | A committed YAML manifest (path → sha256) split per top-level dir, a key-wise merge driver, hooks, a browsable S3 layout `assets/<sha>/<path>`, a racy-clean hash cache, and TLA+ models. 0 stars, one author, S3 only. | A design reference, not a market threat. It validates the UC-2 design, and it adds two rules blobsy lacks: a racy-clean cache, and checking that the remote has the bytes before deleting local ones. |
| **git-xet** (Hugging Face) | A Git LFS custom transfer agent with Hub-negotiated storage; only a dev server is open. | Fails PAIN-5. Borrow the shape (content id separate from location; index uploaded last), not the chunk formats. |
| **Oxen** | Its own VCS and server. Directories are bucketed (~10k entries) by path hash, and merges happen outside git. | Not git-compatible for UC-4, and its tree hashes are non-deterministic. |
| **Epic Lore** (Jun 2026) | A centralized chunked VCS with no git interop. | Patterns worth noting: a single conditional-write commit, typed “obliterated” markers instead of 404s, compression kept outside identity, and causal locks for files that can’t be merged. |
| **git-lfs-fuse** | ~1.5k LOC of Go: a lazy FUSE mount of LFS repos, inactive since mid-2025. | Not a competitor. |
| **Git (native)** | Large-object promisors (2.49–2.56) reduce clone cost. Removing history still requires rewriting it. | A complement, not a replacement; PAIN-3 is untouched. |
| **Git LFS / GitHub** | Versions 3.7.x–3.8.0. Billing is metered (10 GiB free storage and bandwidth). Removing objects means deleting and recreating the repo. | Confirms PAIN-3/4. `import-lfs` is the on-ramp, since an LFS oid is the sha256 of the raw bytes. |
| **DVC** | Acquired by lakeFS (Nov 2025); last release Mar 2026. | A stalled incumbent for UC-2-like workflows. |
| **HF Storage Buckets** (Mar 2026) | Mutable S3-like buckets beside versioned repos, with plan/apply sync. | The same versioned-vs-working-storage split as file vs mirror mode, but HF-only. |

**Nobody offers UC-3/UC-5 on arbitrary storage.** No tool reviewed, Gat included, offers
immutable tree snapshots and caches outside git on any bucket.
The cache-specific tools (actions/cache, runs-on/cache, Turborepo/Nx, sccache, Bazel)
are scoped to CI or to a build system.
Nx deprecated its bucket caches after CVE-2025-36852.

### 9.3 Positioning

- **The niche is crowded in design but thin in adoption.** Gat and s3lfs both already
  offer “a serverless LFS replacement with a manifest and a merge driver”.
  - Building UC-2 *only* to match Gat would duplicate a better-tested tool.
  - UC-2 is still worth building: blobsy’s users need it, and it shares the entry
    format, tree id and store with UC-3/5.
  - But it should not be the headline.

- **Blobsy’s defensible position is the combination:**
  - **UC-1:** per-file pointers that merge on any host.
  - **UC-2:** per-collection manifests with validated merges.
  - **UC-3/5:** immutable snapshots for trees and assets, on any bucket.
    Nobody else covers this.

  All three run on any storage, including command and rclone backends.
  Safety doesn’t depend on hooks, and the CLI is agent-first (`--json`, skill,
  plan/apply).

- **Interop:**
  - `import-lfs` is the high-value on-ramp.
  - Reading `gat.lock` is not worth it now.
    Gat uses BLAKE3, so import means rehashing, and its user base is tiny.
  - Revisit if Gat gains traction; a `blobsy import-gat` would be straightforward.

- **Remote browsability vs derived keys is not either/or.** The invariant is only that
  the key is a function of committed data.
  Option (b) in D2 keeps filenames visible.

* * *

## 10. Recommendations and sequencing

Each phase lists its **smallest shippable cut** first, then what to defer.

**Phase 0 — safety, now.** No decisions are needed; the full B-2 fix waits for D2.

Smallest cut:

- **B-1:** write the cache only after a successful push or pull.
  - This closes the stash and discard variants.
  - The pushed-but-uncommitted variant stays open until D2.
  - As an interim, `sync` and `pull --force` print the cache-recorded key before
    overwriting, so the bytes can be recovered by hand.
- **B-2 (interim):** the hook reads the pushed refs from stdin and lists the `*.bref`
  files in `<remote>..<local>`.
  - It uploads from the working tree when the file’s hash matches the committed pointer.
  - Otherwise it **aborts the push**, naming the commit and path.
    Today it silently succeeds.
- **B-3:** a pre-commit large-file guard, plus a `doctor` check.
- **H-1:** move the stat cache under `$(git rev-parse --git-path blobsy)/` instead of
  adding a gitignore line.
- **M-1:** a push-time keep-if-smaller check.
  Phase 1 replaces it with the add-time decision.
- **Also:**
  - L-1 (containment);
  - the README dedup claim;
  - SKILL guidance for what to do after git operations.

**Phase 1 — simplify the core.** This gates every new mode, and needs D1, D2, D3 and
D11.

Smallest cut:

- the S1–S3 deletions;
- S4: derived keys only, `.bref` 0.2, and create-only PUT on S3 and local;
- S5: the recoverability rule, with the hash cache wired in;
- the full B-2 fix;
- the entry format and `tree_id` pinned in a normative appendix, with test vectors.
  It is tiny, and the trading repo wants the receipt schema first.

Defer to Phase 2 (UC-2 scale needs these; UC-1 does not):

- S6/S7 (reporter, plan/execute, batching);
- `Backend.list`;
- the capabilities probe;
- batched transfer.

Defer further:

- S8–S10;
- the startup and lazy-import work, which can happen at any time.

**Phase 2 — UC-2 collections.** Needs D4 and D10.

Smallest cut:

- the manifest format, parser and validator;
- `add --collection`, `add`, `status`, `push`, `pull` and `verify`, all over the shared
  entry loop;
- one ignore line per collection;
- the validator in pre-commit and `doctor`;
- batched transfer and existence checks;
- S6/S7, done as part of this work.

Defer:

- the merge driver and `--resolve`. Plain text merge is safe, so ship them when a real
  collection hits the clustered-adds conflict;
- `blobsy diff`, `--include` globs, promotion/demotion, a CI action.

**Phase 3 — UC-3/UC-5 snapshots.** Needs D5, D6 and D7.

Smallest cut:

- `snap publish|restore|ls`, with one `tar.zst` and a create-only `ref.yaml`;
- local and S3 backends only, with exists-then-put elsewhere;
- validation on `target/` and model directories;
- the cargo mtime experiment, run before the default is fixed.

Defer:

- fallback, gc, status and pins;
- the local archive cache;
- provenance fields;
- the capabilities probe.

**Phase order (D14).**

- UC-2 is cheaper once the Phase 1 entry loop exists.
- UC-3/5 is the uncontested differentiator, and was described as a current need.
- After Phase 1, per-file mode is acceptable up to a few hundred files per directory.

Recommendation: choose by whichever pain is pressing now.
If that is caches or build trees, do Phase 3 before Phase 2.

**Phase 4 — run archives (D8):** receipts only, unless D8 approves more.

**Phase 5 — adoption and lifecycle:**

- `import-lfs` first;
- reachability GC, only with bucket versioning as the safety net;
- opt-in hydration hooks and `blobsy resolve --tool`;
- `migrate import` last.

**Explicit non-goals, for all phases:**

- file locking;
- smudge/clean filters;
- merge drivers for `.bref`;
- network inside git operations;
- mutable names;
- bidirectional sync of derived trees;
- CDC or sub-file dedup;
- a server;
- multiple backends per repo.

* * *

## 11. Decisions for the owner

| # | Decision | Recommendation | Blocks |
| --- | --- | --- | --- |
| D1 | Adopt the new model: one storage contract, one entry format, references in git or by name. Reword principles 5, 6 and 9, and “What This Design Eliminates”. | Yes | Phase 1 |
| D2 | Keys derived from content, never stored: a fixed layout `<algo>/<h0h1>/<h2h3>/<hash>[.zst]`, with the filename as object metadata; `remote.key_template` deleted. Closes `pqyt`. Specified in `specs/active/plan-2026-10-22-blobsy-v3-redesign.md` (K1, K2). | Yes | Phase 1 |
| D3 | Replace the stat-cache merge base with the recoverability rule. `sync` = `pull` then `push`, with no logic of its own. | Yes; keep `sync` as the one recommended verb | Phase 1 |
| D11 | Approve the S1–S3 deletions (hidden commands, trash, inert config). | Yes | Phase 1 |
| D4 | Collection manifest: name and placement (`<dir>.brefs` sibling vs `.btree`), explicit `--collection`, explicit prune, and whether `setup` installs the merge driver once it exists. | `.brefs` sibling; explicit; explicit prune; driver on by default | Phase 2 |
| D10 | Compression: zstd and none only, decided at add time with keep-if-smaller. Allowed in collections via the `stored` column? | Yes | Phase 2 |
| D14 | Phase order: collections (Phase 2) or snapshots (Phase 3) first? | Whichever pain is pressing now; snapshots first if build trees are the need | Phase 2/3 |
| D5 | Snapshot primitive for UC-3/UC-5: `snap` verbs, everything stored under the name, a single `tar.zst` in v1, pins as `.bref kind: tree`. | Yes | Phase 3 |
| D6 | Snapshot trust: IAM, write segregation and provenance in v1, with signatures later? | Yes (signature field reserved) | Phase 3 |
| D7 | Conditional writes. Require a probe-verified backend for snapshot publish, or allow exists-then-put with a documented race? Use native writes (OpenDAL npm) for GCS/Azure commit objects? | Allow the fallback, surfaced by `doctor`; native writes for small commit objects | Phase 3 |
| D8 | Run archives (bead `s2tr`): (a) approve round-8 mirrors, narrowed; (b) fold them into snapshots as `snap publish --unpacked`; or (c) defer, shipping only `blobsy receipt write/verify` and an rclone recipe. | (c) now; (b) if demand materializes | Phase 4 |
| D9 | Hooks: correctness never depends on them, and hydration hooks are opt-in. | Yes | none |
| D12 | Positioning vs Gat: interoperate (read `gat.lock`) or differentiate. | Differentiate (§9.3); `import-lfs` first | none |
| D13 | Implementation language: TypeScript, Rust, or a hybrid. | TypeScript through Phase 3; switch only under the §7.4 rule | none |
| D15 | One hash for all content: SHA-256 or BLAKE3 (native addon; WASM fallback). Measured on this CPU without SHA-NI: native BLAKE3 ~8.5× faster per file than SHA-256 in Node and Bun, and Node/Bun match Rust single-threaded once reads use 1 MB buffers (`research-2026-10-22-hash-performance-node-bun-rust.md`). Expected ~1.5–2.5× on CPUs with SHA hardware [I]. With BLAKE3, `import-lfs` rehashes each object once. | BLAKE3 if a cross-hardware benchmark shows ≥3× on at least two of four common platforms (plan K3) | Phase 1 |

Bead dispositions:

- `blobsy-pqyt`: close via D2.
- `blobsy-aad8`: re-point at the UC-2 collection design (§5.3).
- `blobsy-4vpk`: drop (S1).
- `blobsy-s2tr`: resolve via D8.

* * *

## Appendix A. Evidence index

**Sub-reviews.** These are the full reports, with reproductions.
Scratch paths in them refer to the review session’s ephemeral workspace.

- [`round9-subreviews/complexity.md`](round9-subreviews/complexity.md): engineering
  complexity, the target architecture, doc structure.
- [`round9-subreviews/uc1-uc4-file-mode-and-merges.md`](round9-subreviews/uc1-uc4-file-mode-and-merges.md):
  UC-1/UC-4 workflows, blockers B-1..B-3, PAIN-3/4. Its “known-pushed hash” overwrite
  rule is superseded by §5.2.
- [`round9-subreviews/uc2-collections.md`](round9-subreviews/uc2-collections.md): the
  collection manifest design, merge experiments and Monte-Carlo, the driver prototype.
  Its entry column order and merge-base reuse are superseded by §5.3.
- [`round9-subreviews/uc3-uc5-snapshots.md`](round9-subreviews/uc3-uc5-snapshots.md):
  the taxonomy, the snapshot primitive, the conditional-write matrix, the `node_modules`
  profile.
- [`round9-subreviews/language-typescript-vs-rust.md`](round9-subreviews/language-typescript-vs-rust.md):
  TypeScript vs Rust: startup, hot-path benchmarks, distribution, switch cost.
  Its “loosen engines” advice is already true.

**Research** (the October 2026 refresh), in `docs/project/research/current/`:

- `research-2026-10-22-large-file-tools-landscape-refresh.md`
- `research-2026-10-22-object-store-capabilities-refresh.md`
- `research-2026-10-22-tree-manifests-and-cache-patterns.md`
- `research-2026-10-22-competitor-gat.md`
- `research-2026-10-22-competitors-other.md`
- `research-2026-10-22-jj-vcs-and-blobsy.md`

**Lead-reviewer reproductions.** All used the CLI at `packages/blobsy/bin/blobsy`, a
`local:` backend, and git 2.43.

- **1,000-file benchmark (§2.2):**
  1. `setup --auto local:../remote`.
  2. Create 10 dirs × 100 files with `head -c 210000 /dev/urandom`.
  3. `track data/coll`, `status`, `push`, commit, `status`, `sync`, each timed.

- **B-1:**
  1. Gitignore `.blobsy/`.
  2. `add f.bin`, commit, `push`, commit.
  3. Overwrite `f.bin`, then `track f.bin`.
  4. `git stash`, then `sync`.

  Result: the file is reverted to v1, and v2 exists in no remote object.

- **H-1:** `setup` in a fresh repo, then `track`, then `git status` shows `.blobsy/`
  untracked. `doctor` reports “✗ .blobsy/ not in root .gitignore”.

- **H-6:** 20,000 files and 20,000 ignore lines in one directory make `git status` take
  0.82 s. A single `*.bin` line takes 0.009 s.

- **L-1:** with repo `g1`, `setup --auto local:../g1rem` fails with “must be outside the
  git repository”.

- **Startup:** `blobsy --version` takes 0.53–0.58 s, vs 0.03 s for `node -e ''`.

## Appendix B. Red-team revisions (v2)

An independent red-team pass checked the v1 draft against the source, the sub-reviews
and the running CLI.

**What it confirmed:** the load-bearing facts.

- B-1 (all three variants), H-1, H-6 and L-1;
- the startup numbers;
- the inert config;
- the unemitted state symbols;
- that `getCachedHash` is unused;
- the 9-state sync;
- the Gat and jj facts.

**What it found:** 34 issues, all incorporated (full list:
[`round9-subreviews/redteam-findings.md`](round9-subreviews/redteam-findings.md)). The
substantive changes from v1:

1. **A new overwrite rule.** “Known-synced” (the hash appears in git history) became
   **recoverability** (synced here, or exists remotely).
   The v1 rule lost unpushed bytes after `commit` + `revert` in plain git.
2. **One entry format** (`path, kind, size, sha256`), pinned in §5.3. v1 presented two
   incompatible column orders.
3. **Complexity claims corrected.** Phase 1 removes ~15–20% of LOC and most of the
   accidental *concepts*. The full design adds code overall but reduces concepts per use
   case.
4. **Push-time key variables forbidden** in `.bref` 0.2, so invariant 2 holds.
   v1 kept them as an “advanced option”, which would have kept all the write-back code.
5. **Phase 0 qualified.** B-1’s pushed-but-uncommitted variant and the full B-2 fix need
   D2. B-2’s interim fix aborts the push.
   B-3 adds a `doctor`/CI check, because hooks are unreliable.
6. **Mirrors became an open decision** (D8: approve, fold or defer).
   The recommendation is to defer.
7. **New material:**
   - §4.0 (the flows side by side);
   - §5.6 (credentials, Windows, large objects, backend moves, scope);
   - §5.7 (now: no backward compatibility, per v3);
   - the smallest cut per phase;
   - a “Blocks” column in §11, and D14 (phase order).
8. **Smaller fixes:**
   - GC reachability handling of legacy keys (removed again in v3: no backward
     compatibility).
   - The scope of `--resolve` is narrowed.
   - `.git/info/exclude` is rejected.
   - Machine-local state moves under the git directory.
   - Stat-cache call sites corrected to 12.
   - Gat no-driver cells marked [I].
   - D2 offered a filename-preserving template (v3: the filename moves to object
     metadata, and templates are deleted).
   - The `engines` advice is corrected.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
