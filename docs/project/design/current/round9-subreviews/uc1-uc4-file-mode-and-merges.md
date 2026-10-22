# Blobsy per-file mode review: UC-1, UC-4, PAIN-1/3/4

**Date:** 2026-10-22 · **Reviewed at:** `main` @ 04a3d1a (CLI stamp
`0.1.0-dev.146.04a3d1a-dirty`, git 2.43) · **Reviewer:** Fable (round 9 sub-review)

**Method.** Read the design doc, stat-cache design, implementation notes, threat model,
round 7/8 reviews, LFS migration + joining + CI docs, the relevant source (`cli.ts`,
`commands-stage2.ts`, `ref.ts`, `template.ts`, `hooks.ts`, `stat-cache.ts`,
`transfer.ts`, `gitignore.ts`, `compress.ts`), the four open beads, the Feb landscape
research and the three Oct-22 research refreshes that appeared during this review
(`research-2026-10-22-object-store-capabilities-refresh.md`,
`research-2026-10-22-tree-manifests-and-cache-patterns.md`,
`research-2026-10-22-large-file-tools-landscape-refresh.md`; reconciled in §9). Every
workflow below was then executed end-to-end with the built CLI against a `local:`
backend in scratch repos (`scratchpad/uc1/{origin.git,alice,bob,carol}`,
`scratchpad/addall/`, `scratchpad/hookgap/`). Claims marked **[V]** were reproduced;
**[C]** were verified by reading code only; **[U]** could not be verified here.

Lead reviewer’s notes were used as hypotheses.
Where I tested them: `.blobsy/` not gitignored by `setup` **[V, confirmed]**; stat cache
never used as a hash-skip cache
**[C, confirmed: `getCachedHash` has no callers outside `stat-cache.ts`]**; compression
kept even when larger **[V, confirmed]**; dedup lost under the default template
**[V, confirmed, see §2]**.

* * *

## 0. Verdict in one paragraph

Per-file mode is the right shape for UC-1 and it already does the hard, boring things
well: hash-verified atomic pulls, push refusing stale hashes, pull refusing to clobber,
a real three-way `sync`, immutable remote keys, a trust gate on command backends.
But as shipped it is **not yet safe or simple enough for UC-1/UC-4 in a team or agent
setting**: (1) the stat-cache “merge base” is written by `track` before anything is
committed or pushed, so `sync` silently overwrites a user’s new content after
`git stash`, `git checkout -- *.bref`, or any other git operation that moves the `.bref`
back — reproduced three ways, true data loss; (2) the two-phase `remote_key` makes
*every* change a two-commit, dirty-working-tree affair that blocks branch switching,
doubles merge/rebase conflicts, and leaves a window in which teammates cannot pull; (3)
the pre-push hook inspects the working tree rather than the commits being pushed, so
pushing a branch from another checkout ships refs with no blobs; (4) the per-directory
`.gitignore` block is a shared file that conflicts whenever two people add files in the
same directory; (5) a plain git rename (`git mv` + `mv`) followed by `git add -A`
commits the payload to git — PAIN-1 reintroduced by the most natural workflow.
None of these needs a redesign.
All of them follow from two design choices worth reversing: *remote keys are assigned at
push time* and *the merge base is “last time blobsy touched the file”*. Fix those
(pure-CAS default with derivable keys; base = last *synced* state, recorded only by
push/pull), and most of UC-4 collapses into “git merges a 3-line text file” — which is
what the design already claims.

* * *

## 1. UC-1 lifecycle walked end-to-end

Setup: Alice `blobsy setup --auto local:../remote`, three files in `data/` (two ≥200 KB
random, one small), `blobsy add data/`, commit, `git push` with hooks, Bob clones.
Then modify / re-track / rename / delete / untrack.

| Step | What happened | Verdict |
| --- | --- | --- |
| `setup --auto` | Creates `.blobsy.yml`, hooks, `.claude/skills/blobsy/SKILL.md`. Does **not** create/append root `.gitignore` for `.blobsy/`; `doctor` immediately reports `✗ .blobsy/ not in root .gitignore` **[V]**. | Bug. Setup must own this. |
| `blobsy add data/` | Correct externalization, per-dir `.gitignore` block, brefs staged. `.blobsy.yml` is **not** staged; `.claude/` and `.blobsy/` left untracked **[V]**. | `add` should stage `.blobsy.yml` on first use (teammates get a repo with brefs and no config otherwise). |
| `git commit` | Pre-commit hook checks only *staged* brefs. Editing a tracked payload and committing unrelated files is silent **[V]** (acceptable, but `status` is then the only signal and nothing stops `git push`). | OK by design; document. |
| `git push` (hooks) | Hook uploads, writes `remote_key`/`compressed*` into working-tree brefs, prints the “commit them” reminder. Working tree is now dirty; pushed commit has brefs with no `remote_key` **[V]**. | The two-phase problem, §2. |
| Bob clones at that commit | `blobsy pull` → “no remote_key (not pushed, or pusher hasn’t committed the .bref update)”, exit 0 **[V]**. | Honest message, but Bob is stuck until Alice’s second commit. Exit 0 hides it from CI. |
| Alice commits keys; Bob pulls | Works; hashes verified; stat cache written **[V]**. Bob has no hooks unless he runs `setup`. | Fine. |
| Modify → `blobsy add` | Bref diff: `-hash/-size/-remote_key/-compressed/-compressed_size` then `+hash/+size` — i.e. the PR shows the key *disappearing*; the second “record keys” commit adds it back **[V]**. | PR diff is noise-heavy and semantically thin (§1.1). |
| Restore original bytes → `track` → `push` | `track` clears `remote_key`; push creates a **second copy** of identical content under a new timestamp prefix (`20261022T151016Z-94f8…` and `20261022T151058Z-94f8…` both exist) **[V]**. | README’s “identical files are never uploaded twice” is false under the default template. |
| `blobsy mv` | Moves payload+bref, fixes both gitignores, preserves `remote_key` (which still embeds the *old* path: `…/data/f1.bin.zst` for `renamed.bin`) **[V]**. | Correct. Remote browsability degrades after renames; another argument for CAS keys. |
| `git mv a.bref b.bref` only (no `blobsy mv`) | `status`: `? data/other.bin file missing`; no “found at old location” hint as the design doc promises; `doctor` flags missing gitignore entry + dangling entry **[V]**. | Design doc overstates. |
| `git mv a.bref b.bref && mv a b && git add -A` | **Payload (250 KB) committed to git** — `data/moved.bin | Bin 0 -> 250000 bytes` **[V]**. | PAIN-1 violation via the most natural rename. Needs a pre-commit guard (§6, G-5). |
| `blobsy rm` | Bref → `.blobsy/trash/` (flattened name with timestamp, not path-preserving as designed), gitignore entry removed, local deleted, remote blob kept **[V]**. | Correct for immutability; trash layout drifts from design (round 7 L-01, still open). |
| `blobsy untrack` then `blobsy add` again | New bref has no `remote_key`; next push re-uploads a duplicate **[V]**. | Consequence of non-derivable keys. |
| `git add -A` after `add` | Commits `.blobsy/stat-cache/**/*.json` (one per tracked file) and `.claude/skills/...` **[V]**. The design doc’s own status example says “Run 'git add -A && git commit'”. | Same root cause as row 1. |

### 1.1 What a reviewer sees in a PR

Today a bref change is a 3–5 line YAML hunk whose only reviewable content is a hash and
a byte size. Two commits per change (hook flow) means a reviewer sees the key removed
then re-added. Three cheap improvements, in order of value:

1. **Make the diff stable**: with derivable keys (§2) the bref becomes
   `format / hash / size` (+ `compressed` decided at track time).
   A modification is a 2-line hunk, one commit.
   This is the biggest win and is free once §2 lands.
2. **`blobsy diff [<rev>] [<rev>]`** (offline): walks `git diff --name-status` for
   `*.bref` between two revisions and prints a table — added / removed / renamed /
   modified with old→new size and delta, and, when the blob is present locally or
   `--fetch` is given, a per-pattern content diff (e.g. `csvdiff`, `jq`, `pdftotext`,
   image dims). This is the natural home for *content-level review*; cheap to build
   because brefs are tiny and git does the revision walking.
3. **`git textconv` driver** (`*.bref diff=bref`,
   `git config diff.bref.textconv 'blobsy bref-show'`): small UX win locally
   (`git log -p` shows `size 300000→310000 (+3%)`), but `.gitattributes` drivers do not
   run on GitHub/GitLab web diffs, and the bref is already text.
   Offer it in `blobsy setup` as an opt-in; do not rely on it.

### 1.2 Status model: design vs implementation

The design describes seven states (○ ◐ ◑ ✓ ~ ? ⊗) with a committed-vs-HEAD axis.
The implementation computes four (`synced / modified / new / missing`) from `remote_key`
presence plus a hash compare **[C: `getFileState`]**; it never consults HEAD.
Consequences seen in testing: after `git checkout <old-commit>` a file that *was* pushed
later shows `○ not pushed`; after `git pull` of a teammate’s change the file shows
`~ modified` **[V]** — the same symbol as a local edit, which is exactly the distinction
UC-4 needs (§3). `status` also re-hashes every file every run (the stat cache’s
performance role is unimplemented), which the lead measured at 3.6 s per 1,000 files.

* * *

## 2. The two-phase `remote_key` problem (bead blobsy-pqyt)

### 2.1 What it costs (all reproduced)

- Every content change = two commits (`model v3` + `keys v3`), or a dirty working tree
  if the user forgets.
  The hook prints the right reminder, but the reminder itself is the symptom.
- The dirty bref **blocks `git checkout`** of any branch where that bref differs ("Your
  local changes … would be overwritten") **[V]**. Agents hit this constantly.
- In a rebase of a two-commit change onto a conflicting upstream, **both** commits
  conflict (`carol table`, then `carol keys`) **[V]**. Merges that should be one
  conflict are two.
- Teammates fetching the first commit cannot pull (§1). `check-unpushed` reports these
  as unpushed even though the blob exists.
- `track` must clear `remote_key` on change (otherwise push says “already pushed”),
  which is why restoring old bytes re-uploads (§1).
- The state model conflates “has a key” with “was pushed”, so `status` cannot be right
  across history.

### 2.2 The three candidates in the bead, judged

| Option | Fixes two-phase? | Side effects | Judgment |
| --- | --- | --- | --- |
| 1. Derivable keys (pure CAS default) + pull falls back to derived key | Yes, structurally: the committed bref is complete at track time. | Loses date-browsable layout; compression must be decided at track time or derived; existing timestamped brefs keep working because `remote_key` stays authoritative when present. | **Adopt.** |
| 2. Assign `remote_key` at track time (keep timestamp template, evaluate early) | Yes for the gap, but the “pushed” bit moves to a remote existence check or a local marker; dedup still broken; keys still non-derivable from content (a re-track at another time gives another key). | Keeps browsability; weakest on simplicity. | Reject: it fixes the symptom and keeps the dedup/immutability contradiction. |
| 3. Hook stages bref updates (`git add` in pre-push) | No: pushed commits are still fixed; it only pre-stages the *next* commit. Also surprising to anyone curating the index. | Smallest change. | Reject as the fix; acceptable only as a temporary mitigation. |

### 2.3 Recommendation: pure-CAS default, key derivable, `remote_key` optional override

**Model.** A bref is complete the moment `track` writes it:

```yaml
format: blobsy-bref/0.2
hash: sha256:<64 hex>
size: 300000
compressed: zstd          # decided at track time from compress rules; omitted if none
```

The remote key is **derived**:
`key = evaluate(key_template, {hash, size, repo_path, compress_suffix})` with a default
template that contains no push-time variable: `sha256/{content_sha256}{compress_suffix}`
(or `{content_sha256_short}/{filename}{compress_suffix}` if a human-readable tail is
wanted; both are derivable).
`remote_key` remains a legal field and, **when present, is authoritative** — that is the
override/migration hook.
Rules:

- `push`: compute key; create-only PUT (`If-None-Match: *` — the Oct-22 object-store
  research confirms S3/R2/Tigris/Azure/GCS/MinIO support it and
  `aws s3 cp --no-overwrite` and rclone ≥1.72 expose it); 412 on a CAS key = already
  published → success.
  Push **does not modify the bref** unless the template is non-derivable (then it writes
  `remote_key` as today).
- `pull`: use `remote_key` if present, else the derived key.
  Hash-verify as today.
- `status` “pushed” bit: not stored in git at all (it never belonged there — it is
  remote state). Offline `status` shows tracked/modified/missing; `status --remote` (and
  `pre-push-check`) HEAD the derived keys.
  The stat cache may memoize “seen on remote at <time>” for speed.
- `compressed` is decided at **track time** (file name + size, both known), so the key’s
  suffix is derivable and the bref is stable.
  `compressed_size` is dropped from the bref (it is a push-time measurement; record it
  in `--json` output or the stat cache if anyone needs it).
  Also fix: keep the compressed object only if smaller (today a 300,000-byte random
  `.bin` is stored as 300,015 bytes `.zst` **[V]**).
- `mv`, `untrack` → `add`, revert-to-old-bytes: all become free (same hash ⇒ same key ⇒
  412 ⇒ no upload). The README’s dedup claim becomes true.
  Principle 11 ("deterministic") stops contradicting the default.
  GC reachability becomes “set of hashes reachable from git”, computable without reading
  historical `remote_key`s.

**What is lost.** The date-sortable, path-browsable default layout.
Mitigations: (a) the `{content_sha256_short}/{filename}` variant keeps file names
visible in consoles; (b) `blobsy ls --remote` can render a path view from brefs; (c)
teams that truly want path-shaped remotes can set `shared/{repo_path}` (non-derivable
only in the sense of mutability — it is derivable from the bref, so no two-phase problem
either; it is just not immutable, and push must then refuse 412 as a conflict, per the
object-store research P1). The round-8 mirror mode is the right home for “browsable by
path”; per-file refs should not carry that burden.

**Migration for existing brefs.** No rewrite needed: `format: blobsy-bref/0.1` files
with a `remote_key` keep working forever because `remote_key` stays authoritative.
`track` on an unchanged file leaves them alone.
On the next content change, `track` writes a 0.2 bref without `remote_key`. Optional
`blobsy migrate-keys` re-pushes everything to CAS keys (create-only, so it is
idempotent) and strips `remote_key`; the old objects stay for history.
`pull` must accept both forms; `readBref` already tolerates minor-version bumps **[C]**.
The one hard rule: the *default* template change must land together with “derive when
absent”, otherwise old clones push to timestamped keys and new ones derive CAS keys —
the design doc’s own “template must be consistent across users” warning.

**Reconciliation with the Oct-22 tree-manifests research.** That doc proposes a
canonical entry `(path, size, sha256, mode)` and says a `.bref` is the 1-entry
degenerate case with location derived as `sha256/<hash>` for `.btree`. The
recommendation above is the same move applied to `.bref`: derive location from content;
keep `remote_key` only as an override.
If both land, `.bref` 0.2 and `.btree` share the key derivation function, which is what
makes “promote a per-file ref into a collection” free.

* * *

## 3. UC-4: merges and every git operation that touches a `.bref`

Scenarios executed in `uc1/{alice,bob,carol}` after Bob had a stat cache from an earlier
pull.

| Scenario | Result | Correct? |
| --- | --- | --- |
| Teammate updates file; Bob `git pull` then `blobsy status` | `~ modified` **[V]** | Misleading: Bob changed nothing. |
| … then `blobsy pull` | Refuses, exit 2: “local file modified; use --force … (or push to keep local)” **[V]** | **False refusal.** The message teaches `--force`. |
| … then `blobsy sync` | `pulled (updated)` **[V]** | Correct — only `sync` consults the base. |
| Same, but Bob’s `.blobsy/` was deleted (`git clean -fdx`) | `sync` → “no merge base …”, exit 2; `pull` → refuses; only `pull --force` works **[V]** | Safe but dead-ends on the one flag that is dangerous elsewhere. |
| `git revert` of the update commits | `pull` refuses (exit 2); `sync` pulls old content **[V]** | Same false refusal. |
| `git checkout <first tracking commit>` (bref without key) | `status` shows `○ not pushed` for a file that *was* pushed later; `pull` prints “no remote_key…”, exit 0 **[V]** | Wrong state, wrong exit code. |
| Both modify same file; `git pull` (merge) | Conflict in bref; `status` shows `? invalid .bref`; after `git checkout --theirs` + `git add`, the design-doc recipe `blobsy pull` **refuses** (exit 2); `sync` pulls; `pull --force` pulls **[V]** | Design doc recipe is wrong as written. |
| Same, via `git rebase` | Two conflicts (content commit, keys commit); `status` during conflict: `✗ Unresolved merge conflict markers`, exit 1 **[V]** | Conflict detection is good; two-commit flow doubles the pain. |
| Two devs each add a **different new** file in the same directory | **Conflict in `data/.gitignore`** (both insert into the same gap of the sorted managed block) **[V]** | Hidden UC-4 failure: a change that git should auto-merge conflicts in a file blobsy generated. |
| `git stash` after `edit + blobsy track` (not committed) | bref back to HEAD, payload still new; `sync --dry-run` says “Would pull”; `sync` **overwrites the user’s new content** with the old blob **[V]** | **Data loss.** |
| `edit + track`, then `git checkout -- data/x.bref` | Same overwrite **[V]** | **Data loss.** |
| `edit + track + push` (uncommitted), then `git checkout -- x.bref` | Same overwrite; new blob survives only under an orphan key nobody recorded **[V]** | Data loss in practice. |
| Cherry-pick of a bref-only commit onto a branch with stale payload | Behaves like revert: `pull` refuses, `sync` pulls **[V by equivalence, not run separately]** | Same false refusal. |
| Linked worktree | Hooks resolve via `git rev-parse --git-path hooks` (shared); stat cache and payloads are per-worktree; second full download; `.blobsy/` untracked **[V]** | Works. No shared local object cache. |
| Detached HEAD (CI) | `pull --force` works **[V]** | Fine. |
| Remote blob deleted | `pull` fails exit 1 with key; `check-unpushed` says “All tracked files have been pushed” (checks only key presence); `pre-push-check` catches it **[V]** | `check-unpushed` is misnamed/misleading. |

### 3.1 Is the stat-cache three-way base the right mechanism?

It is the right *idea* and the wrong *bookkeeping*. The decision table is sound only if
the base is “the last state this clone knew to be in sync with both ref and remote”.
The implementation writes the base at **`track`** time
(`trackSingleFile`/`trackDirectory` → `createCacheEntry`) **[C]**, i.e. before any
commit or push. That single choice produces every data-loss row above: after `track`,
local == base, and any git operation that restores the older bref makes `ref != base`,
which the table reads as “git pull updated the ref, local unchanged → pull”.
The user’s unpushed bytes are then replaced by the old blob.

Compare the simpler rule the brief asks about — *“pull overwrites only if the local
file’s hash matches some known-pushed hash”*. Test it against the same table:

- Teammate update / revert / checkout / cherry-pick: local hash == a hash that was
  pushed (it is in git history at HEAD~n, and in the stat cache as last-pulled) →
  overwrite is safe. All false refusals disappear, **without** a merge base.
- Stash / discard-bref after `track`: local hash is *not* known-pushed (it was only
  tracked) → refuse. The data-loss rows disappear.
- True conflict (both changed): local hash not known-pushed → refuse, exit 2. Same as
  today.
- Lost cache: “known-pushed” can be recomputed from git itself — `git log -p -- x.bref`
  yields every hash ever committed for that path; no cache required.
  A hash in HEAD’s history is by construction something a blob exists for (or should).

So the simpler rule dominates: fewer states, no ambiguity error, and it is derivable
from git with the cache as a pure accelerator.
The remaining job of the cache is *performance* (size+mtime → skip hashing), which today
is unimplemented anyway.
Concretely:

- **`pull` (no flag):** overwrite if local hash ∈ {hashes of this bref in `git log` ∪
  last-synced hash in cache}; otherwise refuse with “local content is not in this file’s
  history; `blobsy push` to keep it or `pull --force` to discard”.
  The message stops recommending `--force` first.
- **`push`:** unchanged (refuses hash mismatch, DS-03).
- **`sync` = `pull` with that rule, then push anything whose bref has no remote
  object**. The “ambiguous” state and the merge-base error go away.
- **Cache writes only after a successful push or pull** (and `verify`), never from
  `track`. That one-line change fixes the three data-loss reproductions even if nothing
  else is adopted. The stat-cache doc’s own update-rules table says “After writing .bref”
  for `track`; that row is the bug.

### 3.2 Should blobsy offer…

- **A git merge driver for `.bref`?** Low value for per-file refs.
  Git’s default text merge already auto-resolves when one side equals base (the bref is
  three lines; both-changed is a true conflict).
  The driver would only (a) produce a cleaner conflict (no YAML gibberish — but
  `readBref` already detects markers and `status` reports it **[V]**), and (b) **pick a
  default** (e.g. “theirs”) which is exactly the decision a human must make for binary
  content. Also drivers live in `.git/config`, not the repo, and do not run on hosted
  merge buttons. **Skip for `.bref`.** It is, however, the right tool for the
  **`.gitignore` managed block** conflict — or better, remove the cause (§6, G-4). For
  UC-2 manifests the Oct-22 research is right that a key-wise driver matters; the same
  driver can validate the gitignore block as a trivial case.
- **Post-checkout / post-merge hydration hooks?** Yes (Gat installs exactly these —
  checkout, merge, rewrite — per the landscape refresh), but non-blocking and opt-in:
  `blobsy hooks install --hydrate` installs `post-checkout`, `post-merge`,
  `post-rewrite` running `blobsy pull --quiet` in the background-safe mode (exit 0
  always, print one line on failure).
  The design’s own “unbounded cost” objection is real for first clone but not for
  incremental pulls, which are exactly the moments the false-refusal rows above bite.
  Default off; the SKILL should tell agents to run `blobsy pull` after
  `git pull/checkout/merge/rebase`.
- **Content-level merges (fetch base/ours/theirs blobs, invoke a per-pattern tool)?**
  Not as a merge driver.
  The mechanics are easy (three keys, three pulls, run a tool), but it only pays for a
  few text-like formats (CSV/JSONL/SQLite via `sqldiff`), and a driver that downloads
  during `git merge` violates the no-network-in-git-ops stance the design takes for
  pull. Ship it as **`blobsy resolve <path> --tool <cmd>`** (explicit, after the
  conflict) and as part of `blobsy diff` for review.
  That gives agents a deterministic recipe: `git checkout --theirs|--ours x.bref` **or**
  `blobsy resolve x --tool …`, then `blobsy pull`.
- **File locking (LFS has it)?** No.
  Locks need a server with a lock table; blobsy’s store is a dumb bucket and the threat
  model forbids shared mutable state.
  The blobsy-native answer to “two people edited the same binary” is already correct:
  CAS keeps both versions, the bref conflict names them, resolution is explicit.
  Document that; add `blobsy lock` only if a real team asks, and then as an *advisory*
  object in the store, not a hook that blocks `git push`.

### 3.3 Hooks: the branch gap

`handlePrePushHook` scans `findBrefFiles(repoRoot)` — the working tree — and ignores the
`<local ref> <local sha> <remote ref> <remote sha>` lines git passes on stdin **[C]**.
Reproduced: track+commit on `feature`, `git checkout main`, `git push origin feature` →
hook finds nothing to upload, push succeeds, a fresh clone of `feature` sees “no
remote_key” **[V]**. Pushing from the branch itself works **[V]**. Fix: read stdin,
`git diff --name-only <remote sha|empty-tree>..<local sha> -- '*.bref'`, read each bref
from the *commit* (`git show <sha>:path`), upload what the backend lacks (with derivable
keys this is a HEAD per bref; with the current model the committed bref has no key, so
this fix *depends on §2*). That also makes the hook correct for pushes of tags and of
multiple branches in one `git push`.

* * *

## 4. PAIN-3 (retroactive removal) and PAIN-4 (vs Git LFS)

### 4.1 How well per-file refs solve PAIN-3

Forward-looking: well.
Once a file is a bref, removing it from history is a
`git filter-repo --path x.bref --invert-paths` on 200 bytes, and the blob can be deleted
from the bucket independently.
What is **missing** for the pain as stated ("files already tied into git’s hash tree"):

1. **History-rewrite import.** No `git lfs migrate import` analog.
   The needed command is `blobsy migrate import [--include <glob>] [--everything]`: for
   each commit (via `git filter-repo --blob-callback` or a `fast-export` filter) replace
   each matching blob with a bref whose `hash` is the sha256 of the blob content, push
   every distinct blob to the CAS key, and add the gitignore entries.
   This is tractable *only* with derivable keys (§2) — with push-time timestamps every
   historical bref would need a key assigned during the rewrite.
   `git-filter-repo` is not installed here (**[V]** `which` fails), so test infra must
   vendor or depend on it.
2. **LFS history migration.** `docs/migrating-from-git-lfs.md` is honest that it does
   not rewrite history.
   A converter is mechanical: an LFS pointer is `oid sha256:<hex>\nsize <n>` — the same
   hash algorithm blobsy uses — so `blobsy migrate from-lfs` can rewrite each pointer
   into a bref *without downloading anything* and then copy `.git/lfs/objects/<oid>` (or
   `git lfs fetch --all`) into the CAS. This is the single most compelling PAIN-4
   feature because it is nearly free given SHA-256 parity.
   Note `git lfs migrate export` exists for the reverse direction.
3. **Reachability-aware GC.** Designed (V2) but absent; `rm --remote --force` is the
   only deletion and is correctly labeled history-breaking.
   With CAS keys, GC is
   `reachable = ∪ hashes of all *.bref in all refs (and optionally reflog/trash)`;
   `orphans = list(bucket) − reachable`; age filter; dry-run.
   Bucket versioning or Object Lock (the Oct-22 research notes S3 variable retention and
   R2 bucket locks) gives a recovery window.
4. **What happens to old commits when blobs are deleted:** today, `pull` fails with the
   key and exit 1 **[V]**, and `check-unpushed` wrongly says everything is pushed.
   After GC, old commits become unrestorable by design; `blobsy status --remote` should
   say “blob garbage-collected” rather than “not pushed”.
   This is acceptable (it is also LFS’s behavior after `git lfs prune` on the server) as
   long as GC is explicit, dry-run first, and age-gated.

### 4.2 PAIN-4: honest comparison with current Git LFS

Current facts (checked 2026-10-22, and consistent with
`research-2026-10-22-large-file-tools-landscape-refresh.md`): GitHub LFS is metered —
Free/Pro get 10 GiB storage + 10 GiB bandwidth per month, Team/Enterprise 250 GiB each;
overage $0.07/GiB-month storage and $0.0875/GiB bandwidth; bandwidth counts every
clone/CI fetch and does not roll over; a $0 budget blocks LFS for the rest of the month;
per-file caps of 2/4/5 GB are reported by third parties (not confirmed on the billing
page) **[V, sources below]**. GitHub’s own docs still say that to remove LFS objects you
must **delete and recreate the repository** (landscape refresh, verbatim quote) — that
single sentence is PAIN-3 and PAIN-4 together and is the strongest argument for pointers
whose bytes live in a bucket you control.
Git LFS client is at 3.7.1 (Oct 2025): `fetch --json/--dry-run/--refetch`, faster
`migrate`, symlink handling; locking exists since 2.0 and needs server support; custom
transfer agents and the pure-SSH protocol let LFS pointers back onto S3 (`lfs-s3`,
`lfs-dal`, `git-lfs-s3-proxy`), so “LFS has no pluggable backends” in the design doc is
too strong
**[V/U mixed; feature list from release notes, server-side specifics unverified]**. Also
relevant: `jj` (0.46) and Sapling have no LFS/`.gitattributes` support, which favors a
pointer file that is plain text with no smudge filter — blobsy’s model — for the growing
non-git-porcelain audience (landscape refresh, [V]).

| Dimension | Git LFS (GitHub-hosted) | Blobsy per-file (today) | Blobsy after §2/§3 |
| --- | --- | --- | --- |
| Transparency | smudge/clean: checkout materializes; devs barely notice | explicit `blobsy pull`; brefs visible | same, plus optional hydration hooks |
| Cost | $0.07/GiB-mo + $0.0875/GiB egress; CI multiplies it | any bucket; R2/B2 egress-free | same |
| Lock-in | server per host; `migrate export` to leave | none; any S3 tool reads the bucket | none |
| Dedup across versions/paths | none (one object per oid, but oids *are* content hashes — so renames/reverts dedupe) | **worse than LFS**: timestamped keys duplicate reverts/renames **[V]** | equal to LFS |
| Merges | pointer is 3 lines; same conflict story as bref | same, but two-commit flow doubles conflicts | one commit; same as LFS |
| Locking | `git lfs lock` (server) | none | none (advisory at most) |
| History import | `git lfs migrate import` | none | `migrate import` / `from-lfs` (proposed) |
| GC | server-side prune; `git lfs prune` locally | none; `rm --remote --force` only | reachability GC (proposed) |
| Hooks | pre-push transfer, post-checkout/merge for locks | pre-commit verify, pre-push upload (branch gap) | fixed pre-push; opt-in hydration |
| Partial fetch | `lfs.fetchinclude/exclude`, `GIT_LFS_SKIP_SMUDGE` | `pull <path>` | same |
| Agent legibility | pointers hidden by smudge; `git lfs ls-files` | bref is a readable YAML next to the file; `--json` everywhere | same |

Honest summary: blobsy’s real advantages are cost, provider neutrality, explicit/legible
state for agents, and (with §2) history-level deduplication.
LFS’s real advantages are transparency and maturity (migrate, prune, locks, hosting UI).
Blobsy should not claim “simpler” until the two-commit flow is gone; today a developer
who knows LFS will find blobsy’s commit discipline *harder*.

* * *

## 5. Agents and CI

**Can an agent operate UC-1 from the SKILL alone?** Partly.
The installed `SKILL.md` **[V, from `skill-text.ts`]** covers install,
`add/push/pull/track/status/doctor/config/docs` and `--json`. It omits: `sync`, `mv`,
`rm`, `untrack`, what to do after `git pull/merge/rebase/stash`, conflict resolution,
the two-phase “commit the keys again” step (the single most common failure in my runs),
and the fact that `.blobsy.yml` must be committed.
`blobsy docs` topics (`common-workflows`, `ci-integration`, …) contain no mention of
conflict, stash, revert, rebase, worktree, GC or LFS **[V, grep]**. An agent that
follows the skill will: run `blobsy add`, commit, `git push` (hook uploads), see a dirty
tree, and — because the skill says nothing — either commit again (fine) or
`git checkout -- .` (loses keys; with §3’s bug, a later `sync` can then clobber
content).
The `--force` recommendation in pull’s refusal message is the other agent trap:
an agent that sees “use `blobsy pull --force`” after a routine `git pull` will learn to
always pass `--force`, which *is* destructive in the one case that matters.

Minimum SKILL additions: (1) the after-git-ops rule ("after
`git pull`/`checkout`/`merge`/`rebase`, run `blobsy sync` (not `pull --force`)"); (2)
the two-commit rule until §2 lands; (3) conflict recipe:
`git checkout --theirs|--ours <f>.bref && git add … && blobsy sync`; (4) never
`rm --remote`; (5) commit `.blobsy.yml`; (6) `status --json` field meanings.

**CI pull patterns.** `docs/ci-github-actions.md` is correct and read-only credentials
suffice (health check is HeadBucket for aws-cli; the built-in S3 backend’s put+delete
probe was BE-07 in round 7 — not re-verified here **[U]**). Gaps: (a)
`BLOBSY_NO_HOOKS=1` is set but `blobsy setup` is not run, so no hooks — fine, but
`actions/cache` keyed on bref hashes is suggested without the needed `path:` (the
payloads are gitignored, so the cache must list the data dirs); (b) `pre-push-check` is
the right CI gate and should be in the example (it is the only command that detects a
GC’d/missing blob — `check-unpushed` does not **[V]**); (c) detached HEAD works **[V]**.

**Credential setup.** Delegated to AWS/rclone credential chains; `blobsy health`
verifies; `trust_command_backends` gate is correct for agents.
Nothing in the skill tells an agent *how* to get credentials or that
`BLOBSY_BACKEND_URL` can override the backend for a scratch bucket — add both lines.

* * *

## 6. Gaps ranked by severity (with reproductions)

Severity: **Blocker** = data loss or PAIN-1 violated by a normal workflow; **High** =
UC-1/UC-4 workflow broken or misleading in a way that pushes users to destructive flags;
**Medium** = correctness/UX; **Low** = polish.

| ID | Sev | Gap | Reproduction |
| --- | --- | --- | --- |
| G-1 | Blocker | **`sync` overwrites tracked-but-unsynced content** because `track` writes the merge base. | `edit; blobsy track f; git stash; blobsy sync` → new bytes replaced by old blob **[V]**. Also `git checkout -- f.bref` variant and the pushed-but-uncommitted variant **[V]**. `sync --dry-run` says “Would pull” — the dry run is truthful, which proves the decision is wrong, not the plumbing. |
| G-2 | Blocker | **Pre-push hook ignores pushed refs**; pushing a branch from another checkout ships brefs without blobs. | `hookgap/`: commit on `feature`, checkout `main`, `git push origin feature` → 0 blobs uploaded; clone of `feature` cannot pull **[V]**. |
| G-3 | Blocker | **Natural rename commits the payload** (`git mv x.bref y.bref; mv x y; git add -A`). | `addall/`: `data/moved.bin | Bin 0 -> 250000 bytes` in the commit **[V]**. Pre-commit hook should refuse staging any non-bref file that has a sibling `.bref` or whose size exceeds `externalize.min_size` unless `--allow-large`. |
| G-4 | High | **Per-dir `.gitignore` managed block conflicts** when two branches add different files in one directory. | `uc1/carol`: `CONFLICT (content): Merge conflict in data/.gitignore` with both inserts in the same gap **[V]**. Fix options: one pattern instead of N entries (`*` + `!*.bref` + `!.gitignore` inside a blobsy-owned directory is wrong for mixed dirs), or — simplest — stop writing per-file lines and ignore by convention: a single root rule `**/*` is too broad; the robust alternative is a **`.gitignore` line per bref generated from the bref itself**: `git` cannot do that, so keep the block but make the entries *unsorted-append* with a merge driver, or accept the conflict and have `blobsy doctor --fix` regenerate the block from the brefs present (one command resolves it). Recommend: doctor regeneration + document; longer term, a pre-commit “large file” guard (G-3) makes the gitignore entries belt-and-braces rather than load-bearing. |
| G-5 | High | **Two-phase `remote_key`** (bead pqyt): two commits per change, dirty tree blocks `git checkout`, doubled rebase conflicts, teammates blocked for one commit. | §1, §2 **[V]**. |
| G-6 | High | **`pull` refuses after any git op that changes the bref** and recommends `--force`; `status` shows `~ modified` for teammate updates. | `uc1/bob` B1/B3 **[V]**. |
| G-7 | High | **`setup` does not gitignore `.blobsy/`; `add` does not stage `.blobsy.yml`; design doc recommends `git add -A`.** | `addall/`: three stat-cache JSONs + SKILL.md in the first commit **[V]**. |
| G-8 | High | **Dedup/determinism claims false under default template**; identical content stored under multiple keys on revert, untrack/re-add, rename. | `uc1/alice`: two objects with hash `94f8f987…` **[V]**. |
| G-9 | Medium | **Design doc conflict recipe does not work** (`checkout --theirs` + `blobsy pull` → exit 2). | `uc1/carol` **[V]**. Docs must say `blobsy sync` or `pull --force`. |
| G-10 | Medium | **`status` has no committed-vs-HEAD axis** and no remote axis; `○ not pushed` shown for pushed files at old commits; `check-unpushed` says “all pushed” when the blob is gone. | **[V]**. |
| G-11 | Medium | **Compression kept when larger** (+15 B on random data; +12 B at 250 KB). | **[V]**. Keep only if `compressed_size < size * 0.95` or so. |
| G-12 | Medium | **No history-rewrite import, no LFS-history conversion, no GC** (PAIN-3). | §4. |
| G-13 | Medium | **Stat cache performance role unimplemented**: `status`/`verify`/`push`/`sync` hash every file every time; `verify --rebuild-cache` from the stat-cache doc does not exist. | **[C]** `getCachedHash` unused; no `--rebuild-cache` option **[V]**. |
| G-14 | Medium | **`mv` keeps a key that embeds the old path**; remote becomes misleading after renames. | **[V]**. Goes away with CAS keys. |
| G-15 | Low | Trash is flattened with a timestamp suffix, not path-preserving (round 7 L-01). | **[V]**. |
| G-16 | Low | `git mv` of a bref gives no “found at old location” hint, contrary to the design doc. | **[V]**. |
| G-17 | Low | SKILL/docs omit `sync`, conflicts, stash/revert/rebase, GC, LFS, credential setup (§5). | **[V]**. |

* * *

## 7. What can be simplified without losing UC-1/UC-4

1. **Drop the stat cache as a correctness mechanism.** Keep it as an optional size+mtime
   hash-skip (its original “performance” role, currently unimplemented).
   The “known-pushed hash” rule in §3.1 is derivable from git and the last pull,
   eliminates the ambiguous state and the merge-base error, and fixes G-1. That removes
   a whole design doc from the correctness story.
2. **Make `sync` the one verb, or delete it.** With derivable keys and the §3.1 rule,
   `pull` + “push what the remote lacks” is deterministic and needs no three-way table;
   `sync` is then `pull && push`. Either keep only `push`/`pull` (round 7’s “13
   commands” option) or keep `sync` as the single recommended command and make `pull`
   behave identically for the overwrite decision.
   Today’s split — `pull` refuses, `sync` succeeds, for the same state — is the
   confusing part.
3. **One commit per change.** Falls out of §2. Delete the “commit the keys” messaging,
   the “pushed without committing the bref” error branches, the `remote_key`-clearing
   logic in `track`, and the `check-unpushed` command (its question is answered by
   `status --remote`/`pre-push-check`).
4. **Drop `compressed_size` from the bref**; decide `compressed` at track time.
   Smaller diffs, stable brefs.
5. **Hooks: pre-commit = large-file guard + bref/payload hash check; pre-push = upload
   for pushed refs; hydration opt-in.** Remove the hook’s dependence on working-tree
   scanning.
6. **Keep per-file `.gitignore` blocks but stop treating them as load-bearing**
   (pre-commit guard), and let `doctor --fix` regenerate them from brefs so a merge
   conflict in the block is a one-command repair.
7. **Do not add**: a `.bref` merge driver, file locking, content-merge drivers inside
   `git merge`. Add `blobsy diff` and `blobsy resolve --tool` instead (explicit,
   offline-first).
8. **Consider adding (not a simplification, but it removes a class of re-downloads):** a
   machine-local content-addressed cache (`~/.cache/blobsy/sha256/<hash>` or
   `$GIT_COMMON_DIR/blobsy/objects`), hard-linked or copied into worktrees on pull and
   populated on push/track.
   DVC, LFS (`.git/lfs/objects`), and Gat (`.gat/objects/`) all have one; with CAS keys
   it is a one-to-one mirror of the remote and makes `git worktree`, branch switching,
   and `pull --force` after a false refusal free of network cost.

* * *

## 8. UC-2 implications (for the manifest reviewer)

- Everything in §2 about derivable keys applies verbatim to a manifest: an entry
  `(path, size, sha256)` must locate its blob without a push-time field, or the manifest
  inherits the two-phase problem N times over.
  The Oct-22 tree-manifests research already assumes `sha256/<hash>`; this review
  endorses that and recommends `.bref` 0.2 use the same derivation so a bref is
  literally a one-row manifest.
- The §3.1 overwrite rule generalizes: pull overwrites a file iff its local hash appears
  in the manifest’s git history for that path.
  No per-file stat cache needed; a manifest-level cache is only an accelerator.
- The `.gitignore` conflict (G-4) is the per-file analogue of the “two inserts in the
  same gap” manifest conflict the research measured.
  The same key-wise merge driver or `doctor --fix` regeneration solves both; for
  manifests the driver is worth it, for brefs it is not.

* * *

## 9. Reconciliation with the Oct-22 research refreshes

- **Object-store refresh P1 (create-only PUT)**: adopt as the push primitive; it is what
  makes the CAS default *safe* under concurrent pushers (412 ⇒ already published) and
  makes the immutability invariant enforceable rather than advisory.
  Blobsy’s rclone path for GCS/Azure cannot send the precondition (research finding 2) —
  document as advisory there.
- **P2 (provider checksum at upload, verify by HEAD)**: with `compressed` decided at
  track time, the bref knows whether the stored object is the raw file; for uncompressed
  objects `x-amz-checksum-sha256` equals `hash` and `status --remote` becomes one HEAD
  per file. For compressed objects store the compressed sha256 in the stat cache or
  accept size-only HEAD checks.
- **Tree-manifests §6c (one canonical entry)**: consistent with `.bref` 0.2 as proposed
  here; the only addition this review asks for is that the *location derivation* be
  shared, not just the entry format.
- **Landscape refresh (`research-2026-10-22-large-file-tools-landscape-refresh.md`,
  appeared while this review was being written).** Points of agreement and disagreement:
  - *Agree:* `blobsy import-lfs` is “the highest-leverage interop” — §4.1 item 2 here
    says the same and adds that SHA-256 parity makes it nearly free.
    `If-None-Match: *` create-only writes as the immutability primitive — adopted in
    §2.3. `pull --json --dry-run` should emit resolved keys/URLs (its idea 8) — trivial
    once keys are derivable, impossible to do correctly for un-pushed files while keys
    are assigned at push time; another argument for §2.
  - *Agree, with a sharper framing:* it names **Gat** (Rust, OpenDAL backends, committed
    `gat.lock` manifest, semantic merge driver, hooks that sync after
    checkout/merge/rewrite, local CAS cache in `.gat/objects/`) as the closest
    competitor and says blobsy’s differentiators are per-file pointer diffs, browsable
    remotes, command backends, compression, mirror mode, and the agent surface.
    Two of Gat’s features are exactly the gaps found here: **hydration hooks** (§3.2,
    G-6) and a **local content-addressed cache** (worktrees re-download; §3 table).
    Gat’s manifest merge driver is the right tool for UC-2, not for `.bref` (§3.2).
    Where I disagree: “browsable path-shaped remote keys” should not be defended for
    per-file mode — they are the direct cause of the two-phase problem and the dedup
    failure (§2); keep browsability for mirror mode and offer it to per-file users as a
    `blobsy ls`-rendered view, not as the storage layout.
  - *Its “push before commit” ordering rule* (idea 2, from lakeFS `.lakefs_ref.yaml`) is
    the correct discipline for receipts; for per-file refs it is unnecessary once the
    bref is complete at track time and the pre-push hook uploads what the pushed commits
    reference (§3.3).
  - *Its suggested doc update* “soften 'Git LFS: no pluggable backends'” is adopted in
    §4.2.

* * *

## Appendix A. Reproduction index

All under
`/tmp/claude-0/-home-user-blobsy/0713c929-56bc-5939-ab24-7ac184df530b/scratchpad/`:

- `uc1/alice` — setup, add, hook push, modify, dedup duplicate
  (`find uc1/remote -type f`), rename (`side` branch), gitignore conflict source.
- `uc1/bob` — teammate update (B1), lost cache (B2), revert (B3), old checkout (B4),
  stash/discard data loss (G, G2, G3; witnesses in `/tmp/bob_new*.bin`).
- `uc1/carol` — merge conflict + design-recipe failure, rebase double conflict,
  `.gitignore` block conflict.
- `addall/repo` — `git add -A` leaks stat cache; compression larger;
  `mv`/`rm`/`untrack`; git-way rename commits payload (`git show --stat HEAD`).
- `hookgap/{w,t,wt2}` — pre-push branch gap, worktree, detached HEAD, deleted remote
  blob.

## Appendix B. Not verified here

- Built-in S3 backend health-check write probe (round 7 BE-07) and multipart behavior —
  no cloud credentials.
- Git LFS server-side locking details and per-file caps beyond third-party reporting.
- Performance numbers (lead’s 1,000-file timings) — not re-measured; code reading
  confirms the mechanism (unconditional `computeHash`).
- Behavior with `core.hooksPath` set (code uses `git rev-parse --git-path hooks`, which
  should handle it).

## Sources (web, checked 2026-10-22)

- GitHub billing for Git LFS:
  https://docs.github.com/en/billing/using-the-new-billing-platform/about-billing-for-git-large-file-storage
- Older GitHub LFS data-pack page (outdated pricing):
  https://help.github.com/en/articles/upgrading-git-large-file-storage
- Third-party summary of LFS caps/quotas: https://fast.io/resources/git-lfs-limit.md
- git-lfs 3.7.x changelog as packaged:
  https://src.opensuse.org/pool/git-lfs/src/branch/factory/git-lfs.changes
- git-lfs 3.7.1 packaging note:
  https://git.almalinux.org/rpms/git-lfs/commit/bdb20a0b7102d4a8ea25acf91de05b1a5a782f60
