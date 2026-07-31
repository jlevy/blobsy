# Blobsy Design Review — Round 8 (Agent Run-Sync Workflows)

**Status:** Active review — design decision requested

**Date:** 2026-07-30 (grounding update 2026-07-31: cross-checked against the trading
repo; corrections marked inline, additions under §1.3)

**Scope:** How blobsy should support the “agent-driven run storage” workflow class:
agents (and humans) manually syncing bulk process output — pipeline runs, cohorts, logs,
tool caches — to S3/GCS/other stores, while monitoring and updating small status files
in git, with one-off or lightly customized layers per project.
The reference case is the `finterm-ai/trading` repo’s run-storage setup.
This round asks two questions: what point fixes would make blobsy serve this workflow,
and what radical simplifications would make it *simpler than both* the trading repo’s
hand-rolled scripts and blobsy’s current per-file machinery.

**Method and evidence:** The trading repo itself was not reachable from this session
(cross-org repo access is denied here; `docs/run-storage.md` could not be read directly
— flagged as a follow-up below).
Instead, the *live production storage* that repo syncs to was inspected directly via
authenticated GCS access: full listings and file reads across `gs://metaproc-runs`,
`gs://dxdt-pipelines`, `gs://ft-dev-results`, and `gs://ft-prod-results` on 2026-07-30.
Observed artifacts (sync markers, status files, layout conventions) are primary evidence
of what the workflow actually does — arguably better than the doc, since it shows
shipped behavior — but intent statements in `docs/run-storage.md` should be
cross-checked when repo access is available.
Blobsy-side claims were verified against the PR #4 head (`0122276`).

*(Grounding update, 2026-07-31: a session with the `finterm-ai/trading` repo attached
has now cross-checked this review against `docs/run-storage.md` and
`scripts/sync_runs.py`, closing the gap flagged above.
Corrections are marked inline — the bucket-only inference understated the trading tool
in two places (§1.1, §5 table) — and requirements the bucket state could not reveal are
added as R10–R12 in §1.3.)*

## Verdict

**Blobsy currently solves a different problem than the one this workflow has — and
stretching the current per-file machinery to cover it would be a mistake.
The right move is a second, radically smaller primitive that shares blobsy’s
config/backends/doctor/skill but none of its per-file tracking.**

Blobsy today is a git-LFS replacement: files that live at stable paths *inside* the
repo’s content, externalized one `.bref` per file, with a stat cache, three-way sync,
and git hooks keeping working tree and remote consistent with commits.
That model is right for its problem and Round 7 confirmed the architecture.

The trading workflow is a different shape entirely: **bulk, append-mostly directory
trees produced by processes, living beside the repo’s content, where git should hold
only small status/receipt files and the store holds everything else.** No finding below
suggests weakening the file model.
The finding is that the *directory* problem deserves its own primitive — an “attach
point” that mirrors a directory to a remote prefix and leaves a verifiable receipt — and
that adding it lets blobsy *drop or refuse* several planned complexities (full directory
tracking mode, subdirectory configs, per-file pointers for runs) rather than accrete
them.

## 1. The observed workflow (evidence)

### 1.1 Cohort runs (`gs://metaproc-runs/trends-arb/cohorts/`)

A cohort is one pipeline campaign over ~28 tickers.
The synced tree for `google-trends-2026-07-29-earnings` contains, at the top level:

```
.DS_Store                  <- macOS junk, leaked by a sync with no excludes
.synced-to-gcs.yaml        <- hand-rolled sync marker (see below)
RUN-STATUS.md              <- human-readable status summary
RUN-STATUS.yaml            <- machine-readable status (counts + per-run states)
launch.sh                  <- the script that launched this cohort
normalize_identity.py      <- one-off helper scripts, archived with the data
reset_bad_keywords.py
reset_bad_review.py
summarize.py
.logs/                     <- cohort-level process logs
BG/ BOOT/ CHDN/ CMG/ ...   <- one directory per ticker run
```

Each ticker directory holds `.logs/tasks/<step>/` with per-step agent transcripts
(`*.jsonl`), prompts (`*.txt`), and process logs — roughly 21 steps per run, several
files per step. A single cohort is therefore **thousands of small files**, almost all
under 200 KB.

The sync marker is three lines:

```yaml
dest: gs://metaproc-runs/trends-arb/cohorts/google-trends-2026-07-29-earnings
verified_at: 2026-07-29T01:29:20Z
tool: scripts/sync_runs.py
```

And `RUN-STATUS.yaml` reveals where runs live locally:

```yaml
title: google-trends-2026-07-29-earnings
generated_at: '2026-07-29T01:37:46Z'
root: runs/local/google-trends-2026-07-29-earnings
counts: { completed: 27, failed: 1, not_started: 0 }
runs:
  - run: BG
    state: completed
    steps_total: 21
    steps_completed: 21
    ...
```

So the loop is: pipeline writes to `runs/local/<cohort>/` inside the repo working tree
(gitignored); a custom `scripts/sync_runs.py` mirrors the whole tree to a GCS prefix and
stamps `.synced-to-gcs.yaml`; status tooling generates `RUN-STATUS.{yaml,md}`, which are
small enough to commit and are what humans and agents actually monitor.

*(Corrected/expanded 2026-07-31, from the repo.)* The tool is more than
mirror-and-stamp, and the loop is governed by a registry doc (`docs/run-storage.md`)
with eight invariants:

- **Transfers are byte-verified**: both directions run `rclone copy --checksum` then
  `rclone check --one-way --checksum`; a transfer only counts as done after the check
  passes. The marker’s `verified_at` records a real verification, not just a timestamp —
  though nothing durable *re-verifies* later (the receipt gap, R4, stands).
- **Copy-only, never deletes remote**: the only deletion anywhere is local
  (`push --prune`), gated on a passing verify and on an active-writer guard (`pgrep`
  against the local process table — machine-local, see R11).
- **A pull story exists**: `pull` hydrates a working dir with the same checksum
  verification (no refusal semantics — it will overwrite local modifications).
- **Discovery without pulling**: `list` / `cat` / `find` verbs read `RUN-STATUS.yaml`
  straight from the bucket, locate a run across partitions, and print a ready-to-run
  `pull`.
- **A second storage class** rides the same tool: shared tool caches
  (`tool-caches/<tool>/<source>/`) with union-merge semantics (see R10).

The registry’s rules line up almost one-for-one with this review’s direction: one
registered prefix per workflow, GCS as source of truth with local as scratch, copy-only
verified transfers, prune-after-verify, self-describing partitions, manifests traveling
with data, no laptop mounts, one shared tool.

### 1.2 Three more conventions in the same org

- `gs://metaproc-runs/tool-caches/fintool/trends-serpapi/` — a shared tool cache, synced
  by the same or similar scripting.
- `gs://dxdt-pipelines/` — a different project, different convention: `raw/`,
  `processed/`, `tickers.json`, and a `_meta.json` stamp
  (`{"lastSync": ..., "companyCount": ...}`) — the same “marker file” idea,
  independently reinvented with a different schema.
- `gs://ft-{dev,prod}-results/fintool-server/<env>/runs/<run_id>/` — server-side writers
  uploading runs directly (ids like `ptrun_req_mqheh6m1_8ijimlb9`); no repo-side sync at
  all, but agents still want to *fetch and inspect* these locally.

That is at least three hand-rolled sync/marker conventions plus one server-side
producer, all in one org.
Each has its own script, its own marker schema, no shared verification, no shared
excludes (hence `.DS_Store` in a production bucket), and no pull story.

### 1.3 Requirements this implies

- **R1 — the unit is a directory tree**, not a file.
  Nobody wants per-file operations on 2,000 log files; they want “this run is archived”
  / “this run is fetched.”
- **R2 — bulk data never enters git; small status files do.** The git-visible surface is
  `RUN-STATUS.*` plus a sync marker — a few KB.
- **R3 — push-mostly, append-mostly, effectively single-writer per prefix.** Runs are
  immutable once complete.
  There is no three-way merge problem here.
- **R4 — agents drive it manually and need a verifiable “synced” receipt** they can
  trust and re-check (`verified_at` exists precisely because agents lie to themselves
  about partial uploads).
- **R5 — arbitrary one-off content rides along** (helper scripts, launch scripts) and
  must be mirrored, not fought.
- **R6 — layouts are lightly customized per project** (cohorts vs `raw/processed` vs
  server runs) — a template for dest prefixes, not hardcoded structure.
- **R7 — monitoring means regenerating small manifest files that travel with the data.**
  *(Corrected 2026-07-31: in practice `RUN-STATUS.{yaml,md}` are not committed to git —
  they are re-pushed to the prefix and read from the store without pulling, via
  `cat`/`find` verbs. Receipts and manifests must stay bucket-readable; committing them
  to git is an option, not the practice.)*
- **R8 — excludes are needed by default** (`.DS_Store` is in prod).
- **R9 — remote browsability matters.** Humans navigate these buckets by ticker/cohort
  in the console; keys must stay path-shaped, not hash-shaped.

*Grounding additions (2026-07-31) — requirements the bucket state could not reveal:*

- **R10 — a second storage class exists: shared tool caches**
  (`tool-caches/<tool>/<source>/`), synced by the same tool with different rules:
  derived, add-only, safe to lose; union-merged in both directions (same content-keyed
  entry ⇒ same content, so multi-machine push/pull never conflicts); never pruned;
  growth bounded by a GCS lifecycle rule (90 days), not tooling.
  Receipts as designed (a final tree digest) do not fit an always-growing tree — mirror
  mode should either offer an add-only/union attach-point flavor or scope caches out
  explicitly.
- **R11 — producers are relocating to GCP VMs**, with the working tree possibly on a
  kernel-NFS Filestore mount, so the tool must run identically under ADC on a VM — and
  cross-machine safety becomes real: the trading tool’s active-writer guard is `pgrep`
  against the local process table, which goes blind on a shared mount.
  **Receipt-verified prune** ("local digest matches receipt and remote verifies → safe
  to reclaim") is the correct replacement, and is a genuine argument *for* Option C
  beyond archival trust.
- **R12 — remote-side deletion is forbidden, not just optional.** The trading registry’s
  rule 3 makes transfers copy-only in both directions; the only deletion anywhere is
  *local* prune after verify.
  Mirror mode’s deletion story should default to this stricter stance: `push` never
  deletes remote objects, with any propagation an explicit, separately-guarded verb.
- Answers to the open questions in §6.3: retention is indefinite for run partitions
  (lifecycle rules exist only on `tool-caches/`); access is uniform bucket-level IAM
  over ADC; and no two-way merge cases are planned — the trading side rejects two-way
  explicitly, matching non-goal 1.

## 2. Where current blobsy fits and misfits

Fit: backends (S3 builtin, aws-cli, `rclone_remote` for GCS/Azure, command), in-repo
config resolution, `doctor`, trust model, refusal-to-clobber semantics (DS-02), and the
agent SKILL are all *exactly* what this workflow lacks.
This is the 80% worth sharing.

Misfit, walking the requirements:

- **R1/R2 vs per-file pointers.** `blobsy track runs/local/<cohort>` today expands a
  directory into per-file tracking (`resolveTrackedFiles`), gated by the 200 KB
  externalize threshold.
  For a cohort of thousands of sub-200 KB logs this does the *opposite* of what’s
  wanted: small files stay in git (threshold not met), large ones each gain a committed
  `.bref`. Either way git’s object database and the working-tree diff fill with run
  debris. The workflow wants git to hold ~3 small files per cohort, total.
- **R3 vs stat-cache three-way sync.** The merge-base machinery (DS-01, 19 tests) exists
  to protect multi-writer file edits.
  Runs are single-writer and immutable; that machinery is pure overhead here, and worse,
  it implies semantics (conflict exit 2) that make no sense for runs.
- **R4.** Blobsy has push verification (DS-03 hash sanity) but no *receipt* — nothing
  durable and committable that says “this tree, this many files, this digest, pushed
  here, verified then.”
- **R6 vs subdirectory configs.** The inert nested-`.blobsy.yml` mechanism (CFG-02, bead
  `blobsy-4vpk`) is the current answer to per-directory customization, and Round 7
  already flagged it as a footgun.
  Attach points (below) answer R6 more directly, with less machinery.
- **R9 vs `remote.key_template`.** File mode’s content-addressed-ish keys and the
  two-phase `remote_key` lifecycle (bead `blobsy-pqyt`) are wrong for runs: keys must
  mirror paths so the bucket stays browsable, which also means no two-phase problem at
  all in this mode.
- **Hooks.** Pre-commit/pre-push hooks couple file state to commits.
  Runs are not commit-coupled; a 40 GB cohort upload must never sit inside a `git push`.
  Mirror operations must stay out of hooks entirely.

Conclusion: every hard part of current blobsy (stat cache, hooks, per-file brefs,
compression bookkeeping, key templating, two-phase remote_key) is dead weight for this
workflow, while every easy part (config, backends, doctor, skill) is wanted.
That asymmetry is the design signal.

## 3. Point fixes (incremental, no new mode)

If we did nothing structural, these would still help; they are listed for completeness
and because several stand on their own:

- **PF-1: default excludes + `.blobsyignore`.** Ship a default exclude set (`.DS_Store`,
  `Thumbs.db`, `*.tmp`, `.git`) applied to all directory scans and transfers, with a
  repo-level ignore file.
  Justified by production evidence (R8) regardless of any mode decision.
- **PF-2: `--dest` / per-invocation prefix override on push.** One-off destinations
  without config surgery (R6-lite).
- **PF-3: machine-readable status.** `blobsy status --yaml` emitting a stable schema, so
  agents can commit or diff status without screen-scraping (R7-lite).
  (Status output today is human-oriented.)
- **PF-4: directory-scoped pull with globs**
  (`blobsy pull runs/local/x --include '*.yaml'`) for partial fetches of big trees.
- **PF-5: raise-the-floor docs.** A user-guide chapter “run storage patterns”
  documenting the receipts convention even if blobsy doesn’t write them yet.

These fixes make blobsy *usable* for run sync.
They do not make it *good* for it: per-file brefs for thousands of log files remain
wrong (R1/R2), and no receipt exists (R4). Hence the structural options.

## 4. Radical simplifications (alternatives, in detail)

### Option A — Full directory tracking mode (one `.bref` per directory)

The direction bead `blobsy-aad8` gestured at: `blobsy track <dir> --as-unit` produces a
single committed `.bref` covering the tree, with a manifest digest (sorted
`path + sha256` Merkle-style hash), and push/pull/sync operate on the tree as a unit.

- *Pros:* stays inside the existing pointer model; one committed file per run (R2);
  status can diff digest vs working tree.
- *Cons:* inherits everything that misfits — the bref lifecycle (two-phase remote_key,
  compression fields), stat-cache interaction for a tree, hook coupling, and a hard new
  problem: partial pulls and partial verification of a tree pointer.
  Re-hashing a 40 GB tree to decide “dirty or not” is slow; the stat cache would need a
  tree-shaped extension.
  It also keeps runs commit-coupled, which R3 says they are not.
- *Assessment:* the *obvious* extension and the wrong one.
  Most of its cost is spent making runs behave like repo files, which the workflow
  actively does not want.

### Option B — Attach points ("mounts"): directories mapped to remote prefixes

Top-level `blobsy.yml` declares directory ↔ prefix mappings; no per-file state at all:

```yaml
backend: gcs-runs
backends:
  gcs-runs:
    type: gcs
    bucket: metaproc-runs

mirrors:
  runs/local:
    dest: 'trends-arb/cohorts/{dir}'   # {dir} = first-level directory name
    exclude: ['.DS_Store', '*.tmp']
```

`blobsy push runs/local/google-trends-2026-07-29-earnings` resolves the attach point,
mirrors the tree (rclone/aws-cli/builtin, whichever backend), verifies, and writes a
receipt (Option C’s schema) into the directory.
`blobsy pull` mirrors down, with DS-02-style refusal to overwrite locally modified files
without `--force`. `blobsy status` lists attach points and, per first-level directory,
whether it is unsynced / synced / changed-since-receipt.

- *Pros:* answers R1, R2, R3, R5, R6, R9 directly.
  Git holds one config stanza plus receipts.
  Subdirectory configs become unnecessary — the attach point *is* the per-directory
  config, declared centrally where it is visible (resolves `blobsy-4vpk` toward “drop”).
  Pulling server-produced runs (`ft-dev-results`) works with zero setup beyond a mirror
  stanza — pull does not require receipts, it trusts the listing.
- *Cons:* a second mental model inside one tool; verbs (`push/pull/status`) now dispatch
  by path. Scope-creep risk toward a generic sync tool (mitigations in §5).

### Option C — Receipts as the core primitive (formalize `.synced-to-gcs.yaml`)

The minimal heart of the whole workflow is: *mirror, verify, leave a signed note*. A
receipt schema:

```yaml
format: blobsy-receipt/0.1
dest: gs://metaproc-runs/trends-arb/cohorts/google-trends-2026-07-29-earnings
backend: gcs-runs
pushed_at: 2026-07-30T17:20:11Z
tool: blobsy 0.1.0
files: 2114
bytes: 1073741824
tree_hash: sha256:...        # digest of sorted (path, size, sha256) tuples
verified: size               # none | size | hash
```

Written into the pushed directory and uploaded alongside it (so the bucket is
self-describing, like `.synced-to-gcs.yaml` today), and small enough to commit when the
run directory itself is git-adjacent.
`blobsy status` compares tree state against the receipt instead of a stat cache.
An optional `--manifest` flag additionally writes a per-file manifest
(`path, size, sha256` — one committable file, reviewable in PRs, exact verification on
pull) for the cases that want LFS-grade integrity without per-file brefs.

- *Pros:* this is *simpler than the trading repo* (one schema instead of three, with
  verification and counts built in) and *simpler than blobsy file mode* (no stat cache,
  no hooks, no brefs).
  It is also the piece that makes agents trustworthy: an agent can always answer “is
  this run archived?” by reading one file and can re-verify with one command.
  *(Grounding addition, 2026-07-31:)* receipt-verified **prune** — local digest matches
  receipt and remote verifies, therefore safe to reclaim — is also the only
  cross-machine-safe disk-reclaim protocol; the trading tool’s `pgrep`-based
  active-writer guard is machine-local and goes blind once the working tree sits on a
  shared Filestore mount (their cloud-locus plan, R11). One design note from their
  practice: still-active trees get interim pushes (manifest refreshes mid-run), so a
  receipt must either be skipped or explicitly marked non-final for those — a receipt
  should assert only verified, complete trees.
- *Cons:* alone it is not a tool — it needs Option B’s mapping to know *where* to
  mirror. B and C are two halves of one design.

### Option D — No tool: convention + agent skill only

Ship a documented convention (layout, receipt schema, rclone command patterns, excludes)
as a SKILL and let agents run rclone directly.

- *Pros:* zero code; agents are demonstrably capable of running rclone.
- *Cons:* this is what the trading org effectively has, three times, divergently — the
  evidence argues conventions-without-a-tool drift (three marker schemas, `.DS_Store` in
  prod, no verification, no pull story).
  Verification and refusal semantics are exactly the things you want *enforced*, not
  suggested. Rejected, but it sharpens the bar: every feature in the chosen design must
  beat “just run rclone” or be cut.

### Option E — Force runs through the content-addressed store

Unify on file mode’s CAS-style keying for everything.
Rejected on R9 alone: hash-shaped keys destroy console browsability, per-prefix
lifecycle/TTL policies, and server-side producers’ ability to write predictable paths.
Two storage disciplines are genuinely needed: **content-addressed for repo-shaped files,
path-mirrored for runs.** Naming that split explicitly is itself a simplification — it
ends the temptation to make one discipline serve both.

## 5. Recommendation

**Adopt B + C as a single “mirror mode,” sharing config/backends/doctor/skill with file
mode and sharing nothing else.**

Boundaries that keep it radically small (non-goals, stated up front):

1. **No two-way merge, ever.** `push` and `pull` are one-way mirrors with refusal
   semantics. No stat cache, no merge base, no conflict states.
   Deletion propagation only via explicit `push --prune` / `pull --prune`.
2. **No hooks.** Mirror operations never run inside git hooks.
3. **No brefs in mirrors; no mirror logic in file mode.** A path is governed by exactly
   one discipline; `blobsy doctor` errors on overlap (a tracked file inside an attach
   point).
4. **No compression bookkeeping.** Mirrors copy bytes as-is (backends may compress in
   flight; blobsy doesn’t track it).
5. **Verbs dispatch by path.** `blobsy push <path>` inside an attach point = mirror
   semantics; elsewhere = file semantics.
   Bare `blobsy push` (no args) stays file-mode only — bulk mirror pushes must name
   their target (a 40 GB accident is worse than a required argument).
   `blobsy status` shows both worlds in two sections.

Why this passes the “simpler than both” bar:

|  | trading repo scripts | blobsy today (file mode) | mirror mode (B+C) |
| --- | --- | --- | --- |
| unit of sync | directory (per-project script) | file | directory (declared attach point) |
| git footprint per run | marker + status (ad hoc) | N brefs or N small files | receipt (+ optional manifest) |
| verification | transfer-time `rclone check --checksum`; no durable receipt¹ | per-file hash | size/hash check + tree digest |
| pull story | checksum-verified pull; no refusal semantics¹ | per-file | mirror down w/ refusal semantics |
| excludes | none (`.DS_Store` in prod) | n/a | default set + per-attach |
| state machinery | 3 divergent marker schemas | stat cache + hooks + brefs | receipts only |
| new concepts for an agent | read N scripts | track/bref lifecycle | `mirrors:` stanza + push/pull/status |

¹ *Corrected 2026-07-31 after reading `scripts/sync_runs.py`: the original cells,
written from bucket state alone, understated the trading tool — its transfers are
byte-verified and it has a pull.
The mirror-mode advantage over it is narrower but real: durable re-verifiable receipts,
default excludes, pull refusal semantics, and one schema org-wide.*

Impact on open design decisions (all three currently awaiting jlevy on PR #4):

- **`blobsy-aad8` (full directory tracking mode):** resolve as *superseded by mirror
  mode* — Option A should not be built.
  This document is the design pass that bead’s missing spec was meant to be.
- **`blobsy-4vpk` (subdirectory configs):** resolve as *drop* (option b in the bead).
  Attach points carry per-directory destination/excludes centrally; the inert
  nested-config walk gets deleted.
- **`blobsy-pqyt` (two-phase remote_key):** unaffected in file mode, and explicitly
  absent from mirror mode (keys are path-derived, assigned at declaration time, no
  two-phase lifecycle).
  The mode split shrinks the problem to where it already is.

Sizing honestly: mirror mode is not free.
It is a new command-dispatch path, receipt read/write, tree hashing, and
status-vs-receipt diffing — but it reuses transfer, backends, config, path containment,
and refusal logic that already exist and are tested.
Estimate: comparable to one of the mid-size Round 7 batches (smaller than the stat-cache
work), and it *removes* two open design obligations (aad8’s tree-pointer design, 4vpk’s
merge semantics).

## 6. Suggested decisions and next steps

For jlevy:

1. Approve/deny the file-vs-mirror mode split (§5) as the direction.
2. If approved: close `blobsy-4vpk` as “drop nested configs,” repoint `blobsy-aad8` at
   mirror mode (or close it and open a fresh epic), and confirm the non-goals list (§5,
   items 1–5) as hard boundaries.
3. Follow-up grounding — **done 2026-07-31.** Corrections are inline (§1.1, R7, §5
   table); new requirements are R10–R12 (tool-cache class, cloud-locus producers +
   receipt-verified prune, no-remote-deletion); retention/permissions/two-way are
   answered under R12’s note.
   Notably, the trading repo’s own storage research
   (`docs/project/research/research-2026-04-19-filestore-mount-alternatives.md`, Option
   G) independently endorses the B+C direction and takes a **contract-first** stance: it
   plans to upgrade its `.synced-to-gcs.yaml` to a `blobsy-receipt/0.1`-compatible
   schema inside its existing tool now — becoming the schema’s first live consumer — and
   to revisit converging on mirror mode once it ships (their stated bar: mirror mode
   built, rclone/GCS backend validated, alpha blockers closed, batched transfer for
   thousands-of-small-files trees).
   Sizing implication: the receipt schema is the highest-leverage piece to stabilize
   first; it delivers value to reference users before any mirror-mode code lands.
4. Independent of the decision: PF-1 (default excludes) and PF-3 (machine-readable
   status) are worth doing in any future.

## Appendix: evidence trail

Inspected 2026-07-30 via authenticated GCS (`aitradearena` project), read-only: bucket
listings for `metaproc-runs`, `dxdt-pipelines`, `ft-dev-results`, `ft-prod-results`;
recursive listing of cohort `trends-arb/cohorts/google-trends-2026-07-29-earnings` and
ticker `BG/`; full reads of that cohort’s `.synced-to-gcs.yaml` and `RUN-STATUS.yaml`
(head) and `dxdt-pipelines/_meta.json`. The `finterm-ai/trading` repository was not
readable from this session (cross-org access denied at the proxy); no claims here about
`docs/run-storage.md`’s text — only about observed storage state.
Blobsy references: `packages/blobsy/src/commands-stage2.ts` (`resolveTrackedFiles`
directory expansion), `packages/blobsy/src/types.ts` (`Bref` fields),
`packages/blobsy/src/config-schema.ts` (config surface), beads `blobsy-aad8`,
`blobsy-4vpk`, `blobsy-pqyt`, and the Round 7 review findings cited inline (DS-01/02/03,
CFG-02/03, HK-01/03, CLI-07).

Grounding update (2026-07-31): the repo-access limitation above is now partially
superseded — `finterm-ai/trading` `docs/run-storage.md`, `scripts/sync_runs.py`, and
`docs/project/research/research-2026-04-19-filestore-mount-alternatives.md` (its
F12/F13/Option F/Option G analysis of this same design space) were read directly, and
this document’s bucket-only inferences corrected where marked.
