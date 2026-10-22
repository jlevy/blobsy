# UC-2 design review and proposal: collections referenced by one manifest in git

**Reviewer:** Fable (senior/staff design review), 2026-10-22, against `main` @ 04a3d1a.
**Scope:** UC-2 (hundreds–thousands of files, one committed manifest) and the UC-4 merge
property of that manifest.
UC-3 and UC-5 are covered elsewhere; this document only states the interfaces they share
with UC-2.

**Evidence key:** [M] = measured in this review (commands and paths in the appendix),
[L] = the lead reviewer’s verified findings, [R] = the parallel research doc
`research-2026-10-22-tree-manifests-and-cache-patterns.md` (§ refs), [R-objstore] =
`research-2026-10-22-object-store-capabilities-refresh.md`, [R-landscape] =
`research-2026-10-22-large-file-tools-landscape-refresh.md`, [I] = inference or design
judgment.

* * *

## 0. Executive summary

Blobsy today serves UC-2 by expanding a directory into N `.bref` files, N `.gitignore`
lines, N stat-cache entries and (under the default template) N unrelated remote
prefixes. At 1,000 files this *works* (git itself is unbothered: 2,274 objects, 413 KB
packed [M]), but every human-facing surface scales with N: a 100-file update is a
101-file PR diff instead of one file with +100/−50 lines [M]; the remote is 1,000
top-level timestamped prefixes [L]; `.gitignore` grows one line per file; and the two
costs the design doc calls “fine” are the two that reviewers and merge tools actually
feel. The pain is structural, not an implementation bug, although three real
implementation bugs make it worse (status re-hashes everything; `add` rewrites the
`.gitignore` once per file; push spawns a process per file).

**Recommendation.** Add a second *container* for the existing entry type, not a second
kind of thing: a committed, sorted, tab-separated manifest `data/images.brefs` (name is
an open question) adjacent to the gitignored directory `data/images/`, one line per file
(`path size sha256 mode stored`), static header, **no aggregates**, blobs stored as
per-file content-addressed objects whose keys are *derived* from the line (so push never
writes back to git, and the two-phase `remote_key` problem does not exist for
collections). Git merges it safely by default; a tiny per-path merge driver (prototype:
45 lines, 0.13 s on 20k lines [M]) removes the false conflicts that git’s line-adjacency
rule produces, and a `blobsy merge-manifest --resolve` fallback handles clones without
the driver by reading the three index stages git leaves behind [M].

What to *not* do: do not store a digest-only directory pointer (round 8’s Option A /
DVC’s `.dvc`), do not use `merge=union`, do not shard automatically, do not pack, do not
add symlink/mtime fidelity, do not add a diff/textconv driver.
The round-8 reasons for rejecting Option A were about run workloads and about a
digest-only pointer; neither applies to UC-2, which *wants* commit coupling and *wants*
the per-file list in git.

* * *

## 1. What UC-2 is, and how it differs from its neighbours

|  | UC-1 (few files) | **UC-2 (collection)** | UC-3 (huge derived trees) | Round-8 runs |
| --- | --- | --- | --- | --- |
| Git holds | one `.bref` per file | **one manifest per collection, listing every file** | nothing per snapshot (static config stanza) | receipt (optional) |
| Unit of change | file | **file, inside a collection** | whole tree | whole run |
| Commit-coupled | yes | **yes** (the collection is versioned repo state) | no | no |
| Reviewable diff | per `.bref` | **per line** | n/a | n/a |
| Merges | git, per `.bref` | **git, per line + driver** | n/a | n/a |
| Partial fetch | by file | **by glob over lines** | subtree (packs + TOC) | by prefix |
| Writers | several, different files | **several, different files in the same collection** | one | one |
| Keys | templated, written back | **derived from content** | packs by content | path-mirrored |

The owner’s suspicion is right: UC-1/2/3 are distinct flows.
The useful observation is that UC-1 and UC-2 differ only in the *container* for
references, while UC-3/5 differ in *where the manifest lives* (the store, not git) and
in transfer granularity (packs).
The lead reviewer’s hypothesis 1 (one storage layer, three reference disciplines) holds;
§5 gives the concrete boundary rules.

* * *

## 2. How blobsy handles UC-2 today, measured

### 2.1 The 1,000-file benchmark (lead [L], re-measured here [M])

Setup: 10 dirs × 100 files × 210 KB random, local backend, default config.

| Surface | Per-file brefs today | Comment |
| --- | --- | --- |
| Committed files | 1,000 `.bref` + 10 `.gitignore` (1,020 lines) | plus 1,000 stat-cache JSONs if the user runs `git add -A` (setup bug [L]) |
| Git objects / pack | 2,274 objects, 413 KB packed [M] | git is fine; `git status` 37 ms [M] |
| Initial commit diff | “2,010 files changed, 18,020 insertions” [M] | the PR is unreviewable as a diff |
| `blobsy add` | 16.0 s (16 ms/file) [L] | mostly `.gitignore` rewrite per file + per-file YAML writes; see 2.3 |
| `blobsy status` | 2.7 s [M] (3.6 s [L]) | raw `sha256sum` of all payloads: 0.67 s; node start 0.5 s; so ~1.5 s is per-file overhead |
| `blobsy push` | 23.3 s on local disk [L] | process/stream per file + zstd on incompressible data |
| no-op `sync` | 8.7 s [L] | hashes every file; stat cache used only as merge base |
| Remote layout | 1,000 top-level prefixes `20261022T150537Z-<hash12>/data/coll/...` [L] | not browsable, not deduplicated |

### 2.2 Git-side cost at 10k files, brefs vs manifest (synthetic [M])

Workload: 10,000 entries, then 20 versions each modifying 50 files and adding 50.

|  | 10k `.bref` + `.gitignore` | one 10k-line manifest |
| --- | --- | --- |
| Pack after `git gc` | 12,084 objects, **2.67 MB** | 63 objects, **560 KB** (manifest is 958 KB uncompressed; versions delta well) |
| Tracked files | 11,001 | 1 |
| One version’s diff | **101 files changed**, 546 insertions, 146 deletions | **1 file changed**, 100 insertions, 50 deletions |
| What a reviewer sees | 100 hunks of `hash:`/`size:` lines, path only in the hunk header | `-img/00021.png 2672792 sha256:6f4b… / +img/00021.png 2672793 sha256:d5ae…` |

### 2.3 Scale run: 5,000 × 4 KB files, single dir vs 50 dirs [M]

Tiny files, so hashing and transfer bytes are negligible and per-file overhead is all
that remains. Local backend, `--min-size 1kb`.

|  | 5,000 files in 1 dir | 5,000 files in 50 dirs |
| --- | --- | --- |
| `blobsy add` (initial) | 60.9 s (12 ms/file) | 80.1 s (16 ms/file; the two runs overlapped other experiments, treat ±30% as noise) |
| committed | 10,004 files (5,000 brefs + 1 `.gitignore` of 5,002 lines) | 10,053 files (5,000 brefs + 50 `.gitignore`s, 5,100 lines) |
| `git status` | 0.0 s | 10,053 files (5,000 brefs + 50 `.gitignore`s, 5,100 lines)STATUS |
| `blobsy status` | 5.1 s (1 ms/file of pure overhead; bytes are trivial) | 6.3 s |
| `blobsy push` | 68.5 s (14 ms/file, local disk) | 96.8 s |
| no-op `blobsy sync` | **42.8 s** (8.6 ms/file: hash + cache read per file) | **59.7 s** |
| initial commit diff | “5,001 files changed” | “5,001 files changed” |
| remote top-level prefixes | 5,000 | 5,000 |
| add 50 new files afterwards | **7.3 s** (146 ms per new file in a 5,000-bref dir) | **2.2 s** (44 ms per new file in a 100-bref dir) |

Readings: `add` and `push` are linear but expensive per file (YAML write + stat-cache
write + `.gitignore` block rewrite per file, then process/stream per file on push).
The incremental add exposes the per-directory quadratic term: the same 50 new files cost
7.3 s in a directory holding 5,000 brefs and 2.2 s in one holding 100, because
`addGitignoreEntry` (`gitignore.ts:26-35`) re-reads and rewrites the whole managed block
for every file, so adding to a large directory costs O(existing entries) per new file.
Even the 2.2 s floor is 44 ms per new file (per-file YAML/cache writes plus one
`git check-ignore` and one `git add` per invocation).
No-op `sync` is the worst surprise: `decideSyncAction` hashes every file and reads a
cache entry per file even when nothing changed (the stat cache is not used as a
hash-skip cache, as the lead noted).
All of these are fixable in per-file mode; none of them changes the “files changed”
count or the ignore-line count, which are the structural costs.

### 2.4 Which costs are structural

| Cost | Fixable in per-file mode? | How |
| --- | --- | --- |
| N files in every PR diff; “files changed” = N | **No** | only a container change fixes this |
| N `.gitignore` lines; one line per rename/move | **No** | directory ignore needs a directory-level reference |
| N git blobs + tree entries per version | partly | brefs are small; git copes to ~100k, IDEs and GitHub earlier |
| N remote prefixes under the default template | yes | pure-CAS template (round 7 issue, bead pqyt) |
| `status`/`sync` hash everything | yes | use the stat cache as a hash-skip cache (stat-cache design, Role 1) |
| `add` 16 ms/file | yes | write the `.gitignore` block once per directory |
| `push` process per file | yes | batch transfer (`rclone --files-from0`, SDK concurrency) |
| Two-phase `remote_key` write-back after push (bead pqyt) | yes | content-derived keys |

### 2.5 Where the threshold is [I, from the numbers above]

- **≤ ~50 externalized files per directory and per PR:** per-file brefs are the right
  tool. Diffs are readable, conflicts are per-file, nothing to learn.
- **~50–300:** brefs work but PR review degrades (GitHub collapses large diffs; a
  300-file “files changed” tab is skimmed, not read).
  Reviewers stop looking at hashes and sizes, which defeats the point of a reviewable
  pointer.
- **≥ ~300 files per directory, or any directory that receives files in batches:**
  collection mode. The decisive signal is not count but *batch churn*: a directory where
  a normal change is “add 40 files” should be a collection.
- **≥ ~3,000 files touched in one PR:** per-file mode is unusable (GitHub stops
  rendering the diff; `git add -A` accidents become likely).

A practical rule for `blobsy add <dir>`: when a directory scan would externalize more
than `collection.suggest_threshold` (default 200) files, print a one-line suggestion to
use `--collection`. Do not auto-switch (see §7, open question 6).

* * *

## 3. The UC-2 design

### 3.1 The manifest file

```text
# blobsy collection manifest -- https://github.com/jlevy/blobsy
# Run: blobsy status data/images | blobsy --help
#format blobsy-manifest/0.1
#keys sha256/{content_sha256}{compress_suffix}
#columns path	size	sha256	mode	stored
cats/001.jpg	48213	9f2c0e7b…e1	-	-
cats/002.jpg	51877	07ab13c9…3c	-	-
cats/README.txt	912	c4d1aa02…77	-	-
scripts/fetch.sh	1430	5e0f9c1d…02	x	-
tables/2026-10.parquet	734003200	a81c4f3e…9b	-	zstd
```

Rules (these pin the format; everything downstream depends on them):

1. **Body is TSV**, one entry per line, **sorted bytewise** (`LC_ALL=C sort`) by `path`.
   Duplicate paths are invalid.
   A validator enforces sorted/unique on read.
2. **Header lines start with `#`.** `#format` and `#keys` are the only semantic header
   lines; `#columns` documents column order; the two comment lines are the
   self-documentation the `.bref` convention already requires (Goal 3). **The header is
   static:** no count, no total bytes, no tree hash, no timestamp.
   Any line that changes on every edit conflicts on every concurrent pair of edits
   [M, §4.1 case 7] and this is exactly DVC’s `.dvc` problem [R §2.2].
3. **Columns.** `path` is relative to the collection root, POSIX separators, no `..`, no
   leading `./`; `\t`, `\n`, `\r`, `%` are percent-encoded.
   `size` is bytes of the original content.
   `sha256` is the lowercase hex digest of the original content (no `sha256:` prefix;
   the `#format` line fixes the algorithm).
   `mode` is `-` or `x` (executable).
   `stored` is `-` (as-is) or a compression algorithm name (`zstd`, `gzip`, `brotli`).
   Unknown extra columns are ignored by older readers; `#format` minor bumps add columns
   to the right.
4. **The tree id** of a collection is `sha256` over the body lines restricted to the
   first four columns (`path size sha256 mode`), in file order [R §6c]. `stored` is
   location/storage data and is excluded, so the same bytes have the same id however
   they are stored. `grep -v '^#' x.brefs | cut -f1-4 | sha256sum` reproduces it.
   Nothing in git stores this id; receipts (round 8) and `blobsy status` compute it.
5. **Remote key** for an entry is `#keys` evaluated with the entry’s content variables
   only: `{content_sha256}`, `{content_sha256_short}`, `{compress_suffix}` (derived from
   `stored`), and optionally `{filename}`. `{iso_date_secs}` and `{repo_path}` are
   **rejected** in a collection key template, because a key that depends on push time or
   on the path must be written back after push (two-phase) and would conflict on merge
   when two branches push the same content.
6. **Why TSV and not YAML/JSON.** The `.bref` is YAML for a reason (one record, human
   comments, forward-compatible keys).
   A collection is thousands of homogeneous records: YAML triples the size, makes a hunk
   span record boundaries so that every nearby merge conflicts, and conflict markers
   break the parser. TSV keeps a changed file to one changed line and is
   `sort`/`join`/`comm`/`awk`-native [R §4.1]. A YAML-header + TSV-body hybrid was
   considered; `#key value` lines are simpler and keep the body a pure byte stream for
   the tree id.

### 3.2 Where it lives, and the gitignore line

```text
data/images/                 <- directory, gitignored as a whole (one line)
data/images.brefs            <- manifest, committed
data/.gitignore              <- "images/" in the blobsy-managed block
```

The manifest is a **sibling** of the directory, mirroring `file.bin` ↔ `file.bin.bref`.
Reasons: (a) the ignore rule is a single directory pattern `images/`, which git treats
as “do not descend” — `git status` never readdirs the payload tree, which matters at
100k files [I]; (b) no negation patterns (`data/images/*` + `!…/.manifest` works but the
design doc forbids negations and `doctor` would have to special-case it); (c) the
manifest is discoverable by the same adjacency rule as brefs, so `resolveTrackedFiles`
can find both with one walk.
The cost is that copying the directory elsewhere loses its manifest; for UC-3/receipts
the store-side copy lives *inside* the tree (§5.2), which is the right place there.

Nested collections and `.bref` files inside a collection root are errors (§5.3).

### 3.3 Mapping files to remote objects

- **Per-file CAS objects**, key `sha256/<hex>[.zst]` under the backend prefix (the
  design doc’s “Pattern 2”). Dedup across versions, branches and collections is then
  real, `mv` inside a collection is a line rename with no transfer, and a file moved
  between a UC-1 bref and a UC-2 collection needs no re-upload *if the bref also uses a
  content-derived key*. Under today’s default timestamped template a promoted bref’s
  object sits at a different key; §5.4 covers that.
- **Compression is decided at `add` time** from the existing rules (`compress.never`,
  `min_size`, extension) and recorded in `stored`. Push therefore never touches the
  manifest. The lead’s finding that incompressible `.bin` files are kept compressed
  although larger [L] is a rules problem that applies to both modes; a sampled “compress
  only if ≥ X% smaller” check at `add` time is possible since `add` reads the file
  anyway, but it is not needed for v1 (see §7 Q5: consider no compression in collections
  at all).
- **No per-tree object in the store** for UC-2. The git-committed manifest *is* the
  pointer; git’s merge is the compare-and-swap [R-objstore §5.3]. Optionally push also
  writes `manifests/<tree-id>.brefs` create-only so the bucket is self-describing; this
  is append-only and never read by blobsy, so it cannot cause coordination problems.
- **Push planning without per-line state.** There is no `remote_key`-present bit per
  line. Push decides what to upload from (a) a local pushed-set cache
  (`.blobsy/pushed/<hash>` markers, machine-local like the stat cache) and (b) for lines
  not in it, a batched existence check (HEAD; the local backend’s `blobExists` already
  exists). A fresh clone does one round of HEADs and is cached thereafter.
  The pre-push hook does better: `git diff <upstream>..HEAD -- '*.brefs'` yields exactly
  the lines a push would publish, and only those hashes need to exist remotely.
- **Transfer must be batched** for this mode to be usable above ~1k files: rclone
  `copy --files-from0` (v1.75+), `gcloud storage cp -I`, SDK uploads with a concurrency
  pool for S3 [R-objstore §5.4]. This is the deferred `TransferEngine.transferBatch` and
  it is a UC-1 need too; UC-2 just makes it mandatory.

### 3.4 Commands

```bash
# Create a collection (explicit opt-in; no silent mode switch)
blobsy add --collection data/images
#   Scanning data/images/... 10,312 files, 4.2 GB
#   Created data/images.brefs (collection, 10,312 entries)
#   Added images/ to data/.gitignore
#   Staged 2 files. Run `git commit`, then `blobsy push data/images`.

# Later: re-scan (adds new files, updates changed ones; never removes silently)
blobsy add data/images                 # whole collection
blobsy add data/images/cats            # only entries under this subtree
#   +12 added  ~3 updated  0 removed   (44 entries missing locally: not pulled or deleted;
#   use `blobsy add --prune` or `blobsy rm` to drop them)

blobsy add --prune data/images         # also drop entries whose files are gone
blobsy rm data/images/cats/001.jpg     # drop one entry (+ delete the local file)
blobsy mv data/images/cats data/images/felines   # line rename, no transfer (CAS)

blobsy status data/images
#   data/images.brefs   collection   10,324 entries   4.21 GB   tree sha256:1c9e…
#     synced 10,250   modified 3   untracked 2   missing 1   not pulled 44   unpushed 12
#   (use --all for the per-file list, --remote to verify existence against the backend)

blobsy push data/images                # uploads blobs for lines not known to exist remotely
blobsy pull data/images                # materializes missing entries; refuses locally modified files
blobsy pull data/images --include 'cats/**' --include '*.parquet'   # partial by glob
blobsy sync data/images                # per-path three-way, same engine as brefs (§3.5)
blobsy verify data/images              # hash every present file against its line
blobsy diff HEAD~3..HEAD data/images   # "+120 files (+1.1 GB), -4 (-80 MB), ~9; largest: …"
blobsy untrack data/images             # deletes the manifest, removes the ignore line,
                                       # leaves payloads on disk (warns: now visible to git)
blobsy add --files data/images         # demote: explode into per-file brefs (§5.4)
```

Design notes:

- `--collection` is explicit.
  A heuristic suggestion ("this directory would externalize 312 files; consider
  `--collection`") is printed, but the mode never flips by itself.
  Config may declare collections (`collections: [data/images]`) so that `blobsy add
  data/images` on a fresh directory does the right thing in CI, but the committed
  manifest, not config, is the source of truth for *existing* collections.
- Sub-path arguments are allowed for `add`, `pull`, `push`, `status`, `verify`, and they
  scope the operation to lines with that prefix.
  This is what makes 50k-entry collections workable day to day.
- `add` is **not** a snapshot (DVC-style “the manifest is whatever is on disk”) because
  of partial pulls: a user who pulled `cats/**` must not have the other 10k entries
  deleted by the next `add`. Removal is explicit (`--prune`, `rm`). This is the single
  most important semantic decision in the command surface; see §7 Q3.

### 3.5 Status, diff and sync semantics

Per entry, the three hashes that exist today are the same: **local** (disk), **ref**
(now the manifest line instead of a `.bref`), and **base** (stat cache).
The stat cache is already keyed by repo-relative path (`getCacheEntryPath`), so
collection members use it unchanged, and `decideSyncAction` (`commands-stage2.ts:553`)
applies verbatim once its `ref` argument comes from a line.
The only new state is **not pulled**: a line whose file is absent *and* has no
stat-cache entry (never materialized here) vs.
**missing**: absent *with* a stat-cache entry (was here, user deleted).
The distinction is advisory; `pull` treats both as “fetch”, `add --prune` treats both as
“drop”, and `status` labels them differently so a user can tell the two apart.

Implementation shape: introduce a `RefSource` that yields `{relPath, entry}` from either
a `.bref` walk or a manifest parse, and make `resolveTrackedFiles` return entries from
both containers. Push/pull/sync/status/verify then operate on entries, not on files with
adjacent `.bref` paths.
The write path differs (bref: rewrite one YAML file; collection: rewrite one line and
re-serialize the manifest atomically), and that is the only place the two containers
diverge.

### 3.6 What a PR looks like, and whether to add a diff driver

A 50-file update is one file in the “files changed” tab with 50 `-`/`+` pairs showing
path, size and hash; a 50-file addition is 50 `+` lines.
The size column lets a reviewer notice a 4 GB accident, which bref diffs also show but
spread over 50 files.
**No textconv/diff driver is needed**: the manifest is already text and already one line
per file. The two cheap additions worth making are (a) `blobsy diff` (above), which CI
can post as a PR comment, and (b) a CI check (`blobsy verify --manifest-only`) that
fails on unsorted lines, duplicate paths, conflict markers, or a key template that is
not content-derived.
(b) is what catches web-UI merges that bypassed the local driver (§4.4).

GitHub-side limits to keep in mind [I, not re-verified today]: large single-file diffs
are collapsed behind “Load diff” and very large ones are not rendered at all; a 1 MB
manifest with a 100-line change renders, a manifest *creation* of 10k lines will be
collapsed.
That is acceptable: creation is reviewed by `blobsy diff` summary, updates are
reviewed line by line.

### 3.7 Hooks

- **pre-commit:** validate every staged `.brefs` (sorted, unique, no markers, header
  sane) and, as today for brefs, verify that staged lines match local payloads.
  Use the stat cache fast path (size+mtime) so a 10k-entry collection costs
  milliseconds, not a re-hash; fall back to hashing only for lines whose stat differs.
- **pre-push:** `git diff <remote-ref>..<local-ref> -- '*.brefs' | grep '^+[^+#]'` gives
  the published lines; ensure each hash exists remotely (HEAD) or upload it.
  This is tighter than today’s “remote_key present” check and needs no manifest
  write-back.
- **post-merge / post-checkout hydration:** keep it out of v1 as the design doc already
  decided for brefs, but design the flag now: `blobsy pull --materialized-only` pulls
  only collections that have at least one stat-cache entry (the user had them on disk),
  so a future hook is bounded and non-blocking.

* * *

## 4. Merging manifests (UC-4) in depth

### 4.1 What git actually does to a sorted manifest [M, git 2.43]

Base: 100 sorted lines `f000.bin … f099.bin`; two branches; `git merge`.

| Case | Side A | Side B | Result |
| --- | --- | --- | --- |
| 1 | insert after `f050` | insert (different path) after `f050` | **CONFLICT** — same gap |
| 2 | insert after `f050` | insert after `f051` (one unchanged line between) | clean |
| 3, 4 | gap of 2 or 3 unchanged lines |  | clean |
| 5 | modify line `f050` | modify line `f051` (adjacent) | **CONFLICT** |
| 5x | modify `f050` | modify `f052` | clean |
| 6 | add `f050a` = hash X | add `f050a` = hash X (identical) | clean |
| 6x | add `f050a` = hash X | add `f050a` = hash Y | **CONFLICT** (correct) |
| 7 | append at EOF | append at EOF | **CONFLICT** — same gap |
| 8 | insert after `f010` | insert after `f080` | clean |
| 9 | delete `f050` | delete `f051` (adjacent) | **CONFLICT** |

Git’s rule is exact: two hunks conflict iff no unchanged line separates them.
There is no “context lines” slack: *one* untouched line between the changes is enough.
So the default text merge is **safe** (it never silently produces a wrong manifest; the
markers sit on whole lines) but **conservative** (cases 1, 5, 7, 9 are false conflicts).

### 4.2 How often does it bite? [M, Monte-Carlo with `git merge-file`, 40 trials/cell]

Two branches each add *k* files to an *N*-line manifest.

Uniformly random names (new files land in random gaps):

| N | k | P(conflict) | analytic 1−(1−k/(N+1))^k |
| --- | --- | --- | --- |
| 100 | 5 | 0.23 | 0.22 |
| 100 | 20 | 1.00 | 0.99 |
| 1,000 | 5 | 0.00 | 0.02 |
| 1,000 | 20 | 0.25 | 0.33 |
| 1,000 | 100 | 1.00 | 1.00 |
| 10,000 | 20 | 0.05 | 0.04 |
| 10,000 | 100 | 0.68 | 0.63 |

Clustered names (both sides add date-prefixed files `2026-10-22-*` into one subdir of a
2,000-line manifest with *s* subdirs):

| subdirs s | k | P(conflict) | P(both chose the same subdir) |
| --- | --- | --- | --- |
| 1 | 1 | 1.00 | 1.00 |
| 1 | 20 | 1.00 | 1.00 |
| 4 | 5 | 0.17 | 0.17 |
| 20 | 20 | 0.03 | 0.03 |

Two conclusions. First, for the “occasional edits to a big collection” case the default
merge almost never conflicts.
Second — and this is the realistic UC-2 workload — **batch additions with
date/run/sequence-prefixed names always land in the same gap**, so two branches adding
to the same subdirectory conflict with probability ≈1 regardless of manifest size.
Sorting alone does not fix this.
Neither does sharding (§4.3): the clustered table *is* the sharded case, because sorted
regions of one file behave exactly like separate shards.

### 4.3 Options evaluated

**(a) Plain text merge, nothing else.** Safe, zero cost, conservative.
Acceptable as the *fallback* (clones without the driver, web merges), not as the
experience, because the clustered workload conflicts every time and the resolution is a
hand-edit of a TSV inside markers.

**(b) `merge=union`.** Rejected.
Verified silent corruption [M]: both sides modify `f050` → merged file has **two `f050`
lines**; A deletes `f050`, B modifies it → B’s line silently wins.
The lead’s own `mergetest` shows the same duplicate.
A validator would catch duplicates after the fact, but a manifest that is *wrong by
construction* cannot be the default, and union is wrong for delete-vs-modify with no
duplicate to detect.

**(c) Sharding (one manifest per subdirectory).** Does not reduce conflicts (§4.2). It
caps file size and localizes diffs, at the cost of many committed files, which is what
UC-2 exists to avoid.
Keep as a manual option (`blobsy add --collection
data/images/cats` is simply a smaller collection); do not auto-shard.
Revisit only if a real collection passes ~50k entries / ~5 MB.

**(d) Custom merge driver — per-path three-way merge.** Prototype `merge-manifest.mjs`
(45 lines) [M]: parse O/A/B as `path → line`, per path apply “changed on one side wins;
identical on both wins; differing changes conflict; delete vs modify conflicts”, header
from ours, output re-sorted.
Results on the same cases: 1, 5, 7, 9 **clean**; 6 clean; 6x and delete-vs-modify
**conflict with markers scoped to the single path**:

```text
<<<<<<< ours
f050a.bin	1	aaaa
=======
f050a.bin	1	bbbb
>>>>>>> theirs
```

0.13 s for a 20,000-line manifest with 200 additions per side (git’s own merge-file:
0.04 s, with a conflict).
Installation is two git-config keys plus a committed `.gitattributes` line:

```ini
# written by `blobsy setup` / `blobsy hooks install` (per clone, like hooks)
[merge "blobsy-manifest"]
    name = blobsy collection manifest (per-path three-way merge)
    driver = blobsy merge-manifest %O %A %B %P
    recursive = blobsy-manifest        # also used for virtual ancestors in criss-cross merges
```

```gitattributes
# committed, in the blobsy-managed block of the root .gitattributes
*.brefs merge=blobsy-manifest
```

Rebase, cherry-pick and stash apply go through the same merge machinery, so the driver
covers them too.

**(e) What happens on a clone without the driver config** [M]: git sees
`merge=blobsy-manifest`, finds no `merge.blobsy-manifest.driver`, and silently falls
back to the built-in text merge — no error, no warning.
So the degraded path is exactly (a). Two mitigations: `blobsy doctor` reports the
missing config (and `--fix` installs it), and `blobsy merge-manifest --resolve <file>`
repairs a conflicted manifest after the fact.
The repair does **not** parse conflict markers: during a conflicted merge git keeps all
three versions in the index as stages 1/2/3 (verified with `git ls-files -u` and
`git show :1:m.tsv` [M]), so `--resolve` reads `:1:`, `:2:`, `:3:` and runs the
identical algorithm, then the user runs `git add`. The same command works after a GitHub
web-UI conflict is pulled locally.

**(f) GitHub merge button / merge queues** [I]: they never run local drivers.
Clean text merges (most non-clustered cases) still merge in the UI; false conflicts show
as “this branch has conflicts” and must be resolved locally with (e). The CI validator
(§3.6) is the backstop against a hand-resolved manifest that is unsorted or has
duplicates.

### 4.4 Payload hydration after a merge

A merge changes lines; payloads on disk are whatever was there before.
Today the same gap exists for brefs and the design doc defers post-merge auto-pull.
For collections the recipe is: `git merge` → `blobsy status data/images` shows *not
pulled* / *missing* counts → `blobsy pull data/images` (refuses locally modified files,
as today). The `--materialized-only` flag (§3.7) is what a future hook would use.
Conflict resolution flow:

```bash
$ git merge feature
Auto-merging data/images.brefs
blobsy: 1 conflicting path(s) in data/images.brefs
CONFLICT (content): Merge conflict in data/images.brefs
$ blobsy status data/images          # refuses: "unresolved conflict markers" (reuse hasConflictMarkers)
$ $EDITOR data/images.brefs          # keep one of the two lines for cats/001.jpg
$ git add data/images.brefs && git commit
$ blobsy pull data/images            # materializes the chosen content
```

### 4.5 Recommendation

Plain text merge as the always-safe baseline; ship the per-path driver and install it
from `blobsy setup`/`hooks install` (it is the same “per-clone config” problem hooks
already have and already solve); ship `merge-manifest --resolve` for driverless clones;
add the sorted/unique/no-markers validator to pre-commit, `doctor`, and the CI check.
No `merge=union`, no auto-sharding.
Keep the header static so that the driver’s only job is lines.

* * *

## 5. Relationship to the other modes

### 5.1 UC-1 `.bref` as a degenerate manifest

Semantically yes: a `.bref` is one entry whose path is implied by adjacency, carrying
the same `(size, sha256, mode?, stored)` plus a `remote_key` that a collection derives
instead of storing. The implementation should share the **entry type** and the
**ref-source abstraction** (§3.5), not the file format.
Rewriting `.bref` as a one-line TSV would buy nothing for users and would break the only
shipped format. The one change worth making on the UC-1 side is the one round 7 and bead
`pqyt` already want: a content-derived default key template, so that brefs and
collections share objects and promotion/demotion is a metadata-only operation.

### 5.2 One manifest format for UC-2 (in git) and UC-3/round-8 receipts (in the store)

Yes, with a clear split of what goes where [R §6c]: the **entry** (`path size sha256
mode`) and the **tree id** are shared; UC-2 adds `stored` and commits the file;
UC-3/UC-5 add location columns (`pack offset length`) and restore metadata (`mtime`,
symlink targets) and store the file next to the data as `…/.blobsy-manifest.brefs` (a
compressed copy is fine there); round-8 receipts stay a small YAML with aggregates
(`files`, `bytes`, `tree_hash`) *because they are never merged*, and their `tree_hash`
should be defined as this tree id so “receipt matches manifest” is a string compare.
Round 8’s optional `--manifest` on a receipt is then exactly “write a `.brefs` next to
the receipt”. One parser, one writer, one validator, three places.

### 5.3 Boundary rules (a path is governed by exactly one discipline)

1. A path is either plain git, a `.bref` file, a member of one collection, or inside one
   mirror attach point (round 8). `doctor` errors on any overlap; `add` refuses to
   create one.
2. A collection root may not contain `.bref` files, another collection’s manifest, or a
   mirror attach point, and may not sit inside any of those.
3. `blobsy add <file-inside-collection>` is interpreted as “update this path’s entry”,
   never as “create a bref here”.
4. Collections may not contain `.brefs` manifests of *other* collections as data (no
   ref-to-ref indirection; the design doc’s “won’t do” list already says this).
5. The `#keys` template of a collection must be content-derived (§3.1 rule 5); `add`
   refuses otherwise.

### 5.4 Promotion and demotion

- **Promote** (`blobsy add --collection <dir>` on a directory containing brefs): read
  each bref, write entries, move brefs to `.blobsy/trash/` (GC paper trail), remove
  their ignore lines, add the directory line.
  If a bref’s `remote_key` equals the derived key (content-derived template), nothing
  moves. Otherwise the object exists under a different key: copy it server-side (S3
  `CopyObject`, `rclone copyto`, local `cp`) to the derived key, or re-upload if the
  backend cannot copy.
  **Do not** add a per-entry key-override column to avoid the copy; it reintroduces
  location data into the manifest and two code paths into pull.
- **Demote** (`blobsy add --files <dir>`): write one bref per entry with `remote_key` =
  derived key (brefs accept any key string), restore per-file ignore lines, delete the
  manifest. No transfer.
- Both are rare; implement after the core, and make both refuse on a dirty collection
  (modified or unpushed entries).

### 5.5 The “one primitive” principle

Rewrite Principle 9 as: *one storage primitive (an immutable blob under a content-
derived key) and one reference entry (`path, size, hash, mode`), held in one of two git
containers: a `.bref` for a file, a `.brefs` manifest for a collection.* “There is no
second kind of thing” becomes “there is a second container, not a second kind of thing”.
The “What This Design Eliminates” list should drop “Manifests — gone entirely”; what was
eliminated, correctly, was *remote-only* manifests as a coordination mechanism (archive
v1 §Manifests: remote `.blobsy-manifest.json`, rewritten on every push, used for
single-writer conflict detection).
Those died because they were mutable remote state that git could not see or merge.
A *committed* manifest is the opposite: git sees it, git merges it, and the remote stays
a dumb immutable blob store.

* * *

## 6. Prior art: borrow / avoid

| System | Borrow | Avoid |
| --- | --- | --- |
| **git trees** | sorted entries `(mode, name, hash)`; path-wise 3-way merge is the gold standard the driver reproduces inside one file; record only the executable bit | binary format (opaque in PRs) |
| **DVC `.dir` + `.dvc`** | per-dir one-line `.gitignore`; a merge driver that merges additions; `.dir` object in the CAS next to blobs | keeping the per-file list *out* of git (PR shows “hash changed”) and aggregates `nfiles`/`size` *in* git (conflicts on every concurrent change) — this is round 8’s Option A |
| **git-annex** | key embeds size (`SHA256E-s<size>--<hash>`) for debuggability | union-merged logs with read-time resolution: right for presence logs, wrong for desired-content manifests (§4.3b) |
| **Git LFS** | pointer-in-git model | clean/smudge filters (invisible, slow, the thing PAIN-4 dislikes); per-file pointers only, no collection story |
| **Xet / HF** | 64 MiB xorb packing for small-file trees → UC-3 | chunk-level dedup machinery; not needed for UC-2’s whole-file CAS |
| **OCI** | blobs first, manifest last, create-only (`If-None-Match: *`); manifest immutability | JSON manifest (unmergeable); tags as mutable pointers (git is our pointer) |
| **mtree(5)** | plain text, one line per path, reviewable | no canonical sort/escaping spec |
| **Bazel REAPI** | `FindMissingBlobs` ≈ batched HEAD before push (§3.3) | gRPC/proto |
| **Gat (2026)** [R-landscape] | committed `gat.lock` = sorted `path → content id (+size)`, exactly UC-2’s shape; semantic per-path merge driver with the same three rules as §4.3d; rejects `merge=union`; hooks that sync after checkout/merge; manual shard into a `gat.lock/` directory | one lock for the whole repo (every PR churns it; blobsy’s per-collection manifests keep churn local); leaving a conflicted lock *without* markers (the user cannot see the conflict in `git diff`; §4.3d keeps per-path markers so plain git tooling still shows it); undocumented remote layout |

Gat is the existence proof that “committed manifest + per-path merge driver” is a
shippable UC-2/UC-4 design, and the landscape doc calls it the biggest design delta
blobsy should absorb.
Blobsy’s differentiation is keeping UC-1 brefs for the few-file case, per-collection
(not per-repo) manifests, browsable/pluggable backends, and the agent surface.

* * *

## 7. Complexity budget

### 7.1 Minimal UC-2 that delivers most of the value

1. Manifest format, parser/writer/validator (sorted, unique, escaping, header).
2. `RefSource` abstraction; `add --collection`, `add <dir|subpath>`, `add --prune`,
   `status`, `push`, `pull [--include]`, `verify`, `sync` on collections, reusing
   `decideSyncAction` and the stat cache unchanged.
3. One ignore line per collection; `doctor` boundary checks.
4. Content-derived keys enforced for collections; compression decided at `add`.
5. Batched transfer for push/pull (also benefits UC-1).
6. Merge driver + `.gitattributes` + `setup`/`hooks install`/`doctor --fix` +
   `merge-manifest --resolve`.
7. pre-commit validate/verify; pre-push publish check via manifest diff.
8. `blobsy diff` summary and the CI validator.

Sizing [I]: comparable to the stat-cache/sync batch of round 7; items 1, 2, 4, 6 are the
core (~60% of the work), 5 is independent and shared, 7–8 are small.

### 7.2 Explicitly not in v1

Auto-sharding; symlinks, mtime and empty directories (UC-3 fidelity — reserve `mode`
values `l`, `d`); packs (UC-3); a diff/textconv driver; post-merge auto-pull hook;
per-entry key overrides; nested collections; `rm` with trash semantics for members (`rm`
just drops the line; the blob stays until GC); promotion/demotion in the first cut;
`merge=union`; `blobsy resolve`-style interactive conflict UI; per-collection
`.blobsy.yml` (collections do not need subdirectory configs — another argument for
closing `blobsy-4vpk` as “drop”).

### 7.3 Why round 8 rejected Option A, and why those reasons do not apply here

Option A = one `.bref` per directory carrying only a tree digest.
Rejected for runs because it (1) inherits the bref lifecycle (two-phase `remote_key`,
compression fields); (2) needs a tree-shaped stat cache; (3) couples runs to commits and
hooks; (4) makes partial pull/verify of a tree pointer hard; (5) re-hashes 40 GB to
decide “dirty”. For UC-2: (1) is removed by content-derived keys and add-time
compression; (2) is moot because per-path entries reuse the per-path stat cache; (3) is
*desired* — the collection is repo state, pre-commit verification and pre-push
publication are the guarantees collaborators rely on; (4) is solved because the per-file
list is in git, so partial pull is a filter over lines; (5) is the stat cache’s job in
both modes. The one Option-A property that would hurt UC-2 — a digest-only pointer that
always conflicts and shows “hash changed” in PRs — is precisely what this design avoids
by committing the list.
So: Option A stays rejected for runs *and* for collections, for different reasons, and
bead `blobsy-aad8` should be re-pointed at this design (its missing spec file can be
this document’s §3–§4).

* * *

## 8. Open questions for the owner

1. **Name and placement.** `data/images.brefs` (this doc), `data/images.btree` [R], or
   `data/images.blobsy-manifest`; sibling file (recommended) vs.
   inside the directory with a negation rule.
2. **Content-derived keys.** Mandatory for collections (recommended).
   Should the UC-1 default template also become
   `sha256/{content_sha256}{compress_suffix}` now, closing `pqyt` and restoring the
   README’s dedup claim, at the cost of date-browsable prefixes?
3. **Deletion semantics of `add`.** Explicit `--prune`/`rm` (recommended, because of
   partial pulls) vs. DVC-style snapshot.
4. **Driver install policy.** Install from `blobsy setup` by default (recommended; same
   footing as hooks), with `doctor` reporting absence; or opt-in.
5. **Compression in collections.** Rule-based at `add` time with a `stored` column (this
   doc), or *no compression in collections* for v1 (simplest; most collection payloads
   are already compressed media/parquet).
   Either way, fix “keep compressed only if smaller” for both modes.
6. **Opt-in vs. suggestion vs.
   auto.** `--collection` explicit with a printed suggestion above a threshold
   (recommended), or auto-collection above N files.
7. **Validator strictness in CI.** Fail the PR on unsorted/duplicate/markers
   (recommended) and optionally on “added line whose blob is not in the remote”.
8. **Path normalization.** NFC-normalize at `add` (recommended) or refuse NFD paths;
   case-insensitive collision handling.
9. **Size ceiling.** Warn at 20k entries / 2 MB, hard-refuse at 100k, or neither.
10. **Receipts.** Adopt the §3.1 tree-id definition for round-8 `tree_hash` so one
    format spans UC-2 manifests, UC-3 store-side manifests, and receipts.
11. **Pre-commit cost.** Stat-cache fast path only (recommended) vs.
    full re-hash of staged collections.

* * *

## Appendix A. Reproduction

All paths under
`/tmp/claude-0/-home-user-blobsy/0713c929-56bc-5939-ab24-7ac184df530b/scratchpad/`.

- **A.1 Merge cases (§4.1):** `uc2-merge/run.sh` builds `uc2-merge/repo` and prints the
  case table; the `merge=union` and unknown-driver sections are at the end.
- **A.2 Monte-Carlo (§4.2):** `uc2-merge/montecarlo.py 40` (uses `git merge-file`).
- **A.3 Scale run (§2.3):** `uc2-scale/scale.sh`, log in `uc2-scale/scale.log`.
- **A.4 Driver prototype (§4.3d):** `uc2-merge/merge-manifest.mjs`; registered via
  `.git/info/attributes` + `git config merge.blobsy-manifest.driver` in
  `uc2-merge/repo`; the `--resolve` feasibility check is the `git ls-files -u` /
  `git show :1:m.tsv` step at the end of the driver test.
- **A.5 Git cost (§2.2):** `uc2-gitcost/` (manifest) and `uc2-gitcost/brefs/`.
- **A.6 Status profiling (§2.1):** run in the lead’s `bench/repo` with
  `packages/blobsy/bin/blobsy status` vs `find … | xargs sha256sum`.
