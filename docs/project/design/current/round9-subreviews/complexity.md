# Blobsy Engineering Complexity Review

**Date:** 2026-10-22 **Reviewed revision:** `main` @ `04a3d1a` (merge of PR #5, round-8
grounding) **Scope:** `packages/blobsy/src` (8,862 LOC per `wc -l`, incl.
9-line generated `skill-text.ts` and a 6-line `.d.ts`), `packages/blobsy/tests` (4,089
LOC vitest + 7,693 lines across 71 tryscript goldens), `docs/project/design/current/`
(9,436 lines), README, user docs, SKILL.md, and the four open beads.

**Method.** Full read of all 27 source files and all current design docs; `pnpm test`
run (327 unit tests pass, 24 files, 50 s); three CLI experiments against the built
binary (`bin/blobsy`) in throwaway repos with the local backend; grep-based dead-code
and call-site audits.
Every claim marked **[verified]** was checked against code or run; **[by reading]**
means the code was read but the behaviour was not executed; **[unverified]** means I
could not check it in this environment.

Corrections to the brief’s numbers: unit tests are 327, not 298; goldens are 71 files,
not ~90; source is 8.9k LOC, not 7k. None changes the conclusions.

* * *

## 0. Executive summary

Blobsy’s core idea is sound and small: one file, one `.bref`, one blob, git is the
manifest. But roughly **half of the shipped code and most of the shipped concepts exist
to patch problems created by three early choices**: (1) a push-time timestamped key
template, which makes keys non-derivable and forces `remote_key` into the committed
pointer; (2) a bidirectional `sync` verb, which forces a persistent merge base (the stat
cache) and a conflict state machine; and (3) a per-file adjacency model carried into
places it does not scale (per-file gitignore lines, per-file git spawns, per-file
transport spawns).

The empirical headline findings:

- **Same bytes pushed twice produce two remote objects**
  (`20261022T150713Z-…/data/a.bin.zst` and `20261022T150716Z-…/data/a.bin.zst`);
  identical content at two paths produces two objects; `push --force` on *unchanged*
  content uploads a third copy.
  README:66 ("identical files are never uploaded twice") is false under the default
  template. **[verified]**
- **The stat cache is written by every mutating command and read by exactly one line**
  (`commands-stage2.ts:583`, the sync merge base).
  `getCachedHash` has zero callers.
  `status`/`verify`/`push`/`pull` re-hash every tracked file on every run: 300 × 2 MB =
  4.5 s per `status`, identical on the second run.
  **[verified]**
- **Three of the seven documented state symbols (◐ ◑ ⊗) are never emitted**; `status`
  never consults git HEAD. The “three orthogonal states” model in the design doc is not
  implemented. **[verified]**
- **The five-level config hierarchy is inert**: all 13 `resolveConfig` call sites pass
  `(repoRoot, repoRoot)`. The walk loop is duplicated verbatim in two functions.
  **[verified]**
- **The trash directory is written and never read** (except by `rm --remote` reading the
  file it just moved).
  Worse, the design says `.blobsy/` is committed, but `doctor` errors unless `.blobsy/`
  is in root `.gitignore` — so the “GC paper trail” is machine-local and silently
  discarded. **[verified]**
- `doctor`’s stat-cache stale/corrupt scan is dead: it `readdir`s the top level of a
  two-level sharded directory and filters for `*.json`, which never matches.
  Deleting a `.bref` and running `doctor --verbose` reports nothing about the cache.
  **[verified]**
- `doctor` alone is ~915 LOC (`commands-stage2.ts:885-1799`), larger than the whole
  tracking core, and includes a hand-rolled Levenshtein for did-you-mean on config keys.
- 13 exported functions have zero callers; `SyncAction` is exported from the public
  index and unused; the `checksum` config section is inert; bead `blobsy-aad8` points at
  a spec file that does not exist.

The right move for UC-1..UC-5 is not “add a mirror mode next to the current machinery”
(round 8) nor “add directory mode on top of brefs” (bead aad8). It is a **shared,
content-addressed, create-only store layer** with three thin *reference* layers on top
(per-file pointer, per-collection manifest, no-git-reference snapshot), where `push`,
`pull` and `status` are *one* loop over “entries” regardless of whether the entries come
from one `.bref` or one manifest.
That architecture makes the five biggest simplifications below prerequisites rather than
nice-to-haves.

* * *

## 1. Complexity inventory

### 1.1 By concern (source, tests, docs)

| # | Concern | Source LOC (where) | Tests | Design doc lines | Serves | Cost summary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | CLI plumbing: commander wiring, `wrapAction`, 4-way output branching, colors, docs/readme/skill commands, agent-file install | ~480 `cli.ts:100-600`; `format.ts` 308; `markdown-output.ts` 146 | help/docs/skill/readme/quiet/verbose/color goldens (7) | — | all | 117 hand-written `quiet/json` guard sites (68 in cli.ts, 49 in stage2); every handler re-implements human/json/quiet/dry-run |
| 2 | Tracking / brefs: `add`/`track`/`untrack`/`rm`/`mv`, ref I/O, externalize rules | ~1,080: `cli.ts:755-1755`, `ref.ts` 150, `externalize.ts` 33, `glob-match.ts` 15 | rm.test 378, ref-parser, externalize, 10 goldens | ~900 (Core Concepts, Ref Format, track/untrack/rm/mv) | UC-1, PAIN-1/3/4 | `trackSingleFile` and `trackDirectory` duplicate the create/update/cache logic; `untrackFile`/`rmFile` duplicate git staging; `mv` is file-at-a-time |
| 3 | Gitignore management: managed block + conflict detection + directory-rule rewriting | 326 `gitignore.ts` (block 140, conflict/rewrite 185) + call sites | gitignore.test, add-gitignored golden | ~40 + mv section | UC-1 | One line per tracked file; whole-file rewrite per tracked file (O(N²)); rewrite machinery exists only because adjacency + parent ignores collide |
| 4 | Stat cache + three-way sync | ~480: `stat-cache.ts` 112, `paths.ts:61-83`, `commands-stage2.ts:535-861` (sync 325), cache writes in track/push/pull/mv (~40) | stat-cache.test 229, three-way-sync, two-user-conflict, sync, sync-json goldens | 583 (stat-cache doc) + ~120 in main doc | UC-4 (claimed) | Cache is write-mostly; perf role unrealized; merge-base role exists only for `sync` |
| 5 | Hooks: installer, pre-commit verify, pre-push upload, doctor hook checks | ~520: `hooks.ts` 115, `commands-stage2.ts:1801-2167` (265), `cli.ts:724-753`, `checkHooks` 110 | hooks.test 338, hooks/no-hooks/doctor-hooks goldens | ~200 + impl-notes 331 | UC-4 safety | Pre-push writes `remote_key` into the working tree after the commit is fixed (bead pqyt); three docs describe hooks three ways (round 7 #3) |
| 6 | Key templates | 118 `template.ts` + default literal duplicated in `config.ts:50` and `transfer.ts:296` | template.test | ~400 (lines 333-732: 8 variables, 4 patterns, comparison table) | “flexible layout” | Non-determinism; `remote_key` becomes a push-time fact that must be committed; `sanitizeKeyComponent` collision caveat (L-09) |
| 7 | Compression | ~160: `compress.ts` 101, `transfer.ts:288-315, 375-405`, bref fields, `getCompressSuffix` | compress.test, compression + compression-algorithms goldens | ~120 | bandwidth/cost | Transport encoding leaks into identity (`{compress_suffix}` in key, `compressed`/`compressed_size` in pointer); compresses even when output is larger (300000 → 300015 B on random data **[verified]**) |
| 8 | Config hierarchy + `config` command | ~900: `config.ts` 444, `config-schema.ts` 102, `cli.ts:1757-2118` (360) | config.test 335, 5 config goldens | ~230 | UC-1 setup | Subdir walk inert (13/13 call sites root-only); walk duplicated in `resolveConfig`/`resolveConfigWithOrigins`; `checksum` inert; `sync.tools` honours only `aws-sdk`; `--show-origin`’s `subdir` origin unreachable |
| 9 | Backends + transfer: local, S3 SDK, aws-cli, rclone, command, URL parsing, coordinator | 1,928: backends 1,486 + `transfer.ts` 442 | ~1,160 LOC unit (5 backend tests + transfer), echo-backend/s3-backend/rclone-backend goldens | 1,016 (backend doc) | PAIN-5, UC-1..5 | Strongest layer. But every CLI backend spawns one *synchronous* process per file (`execFileSync`), so concurrency is impossible by construction; `aws-cli` backend duplicates what the SDK now does (streaming multipart, same credential chain) |
| 10 | Doctor | ~915 `commands-stage2.ts:885-1799` (incl. Levenshtein 1479-1516) | 6 goldens | ~110 + deferred section | ops | Largest single concern; stale-cache scan dead; duplicates status rendering |
| 11 | Push / pull (non-sync) | ~325 `commands-stage2.ts:208-533` | push-pull goldens, transfer.test | ~60 | UC-1 | Dry-run branch is a second implementation of the decision logic (push 234-280 vs 285-346) |
| 12 | Status / verify / health / check-unpushed / pre-push-check | ~360 (`cli.ts:1124-1243`, stage2 `146-206, 863-883, 1909-2008`) | 6 goldens | ~250 | UC-1 | Three overlapping “is it pushed” audits; status rehashes everything |
| 13 | Docs & skill shipping (build scripts, bundled docs, pager) | scripts 60 + `markdown-output.ts` | docs golden | — | agent goal | Three doc commands; pager spawn; dev-fallback path probing |

Totals: tracking+gitignore+sync+hooks+templates+compression+config ≈ 3,600 LOC of
*mode-specific* code; backends+transfer+output+core ≈ 2,900 LOC of *shareable* code;
doctor+plumbing ≈ 1,400; dead/duplicated ≈ 400 (see §5).

### 1.2 User-facing concept count

Counted from `--help`, config schema, `.bref` format and docs:

- **22 commands** (14 visible: `setup add untrack rm mv push pull sync status verify
  config doctor hooks docs`; 8 hidden: `init track health check-unpushed pre-push-check
  hook readme skill`), 5 global flags, 3 exit codes.
- **`.bref` fields:** `format hash size remote_key compressed compressed_size` (6).
- **Config keys:** `backend`, `backends.<name>.{type,url,bucket,prefix,path,region,
  endpoint,push_command,pull_command,exists_command,rclone_remote}` (11),
  `externalize.{min_size,always,never}`, `compress.{min_size,algorithm,always,never}`,
  `ignore`, `remote.key_template` + 8 template variables, `sync.tools`,
  `checksum.algorithm` (inert), `trust_command_backends` — about 35 leaf keys.
- **Environment variables:** `BLOBSY_HOME`, `BLOBSY_NO_HOOKS`,
  `BLOBSY_TRUST_COMMAND_BACKEND`, `BLOBSY_BACKEND_URL`, `BLOBSY_DEV_VERSION`,
  `NO_COLOR`, `PAGER`.
- **State symbols:** 7 documented, 4 emitted.
- **Hidden state:** `.blobsy/stat-cache/` (sharded JSON), `.blobsy/trash/`, two git
  hooks, per-directory `.gitignore` blocks, `.claude/skills/blobsy/SKILL.md`, an
  `AGENTS.md` section.

For a tool whose first goal is “simple usage is easy”, an agent must absorb ~80 nouns to
use it correctly. The SKILL.md (68 lines) manages by hiding most of them, which is the
right instinct, but the hidden ones still cost code, tests and failure modes.

* * *

## 2. Essential vs accidental complexity

The test for “accidental”: would the concept exist if an earlier choice were different?
Each item below names the upstream choice.

### 2.1 Timestamped default key template → non-derivable keys → `remote_key` in the pointer → two-phase push → hooks that mutate the working tree

Upstream choice: `remote.key_template` defaults to
`{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}` (`config.ts:50`,
duplicated as a fallback literal at `transfer.ts:295-296`).

Consequences, all verified:

1. **Non-determinism.** `evaluateTemplate` takes `vars.timestamp ?? new Date()`
   (`template.ts:56`); `pushFile` never passes a timestamp.
   Two pushes of the same bytes three seconds apart produced two objects.
   Design principle 11 ("Deterministic by design") is contradicted by its own
   parenthetical.
2. **False dedup claims.** README:66 says “identical files are never uploaded twice”;
   `packages/blobsy/docs/blobsy-docs.md:19` says “Pushing the same content twice is a
   no-op”. Both are only true for a custom pure-CAS template.
   Same content at two paths (`a.bin`, `b.bin`) → two objects, because `{repo_path}` is
   in the key.
3. **`push --force` orphans.** Forcing a push of unchanged, already-pushed content
   uploaded a third object under a new timestamp and rewrote `remote_key`
   (`commands-stage2.ts:288, 334-338`). “Remote blobs are immutable” (principle 12)
   holds, but storage is append-only with no reclaim path.
4. **`remote_key` must be in the committed pointer** because nobody else can recompute
   it. That is the direct cause of bead `blobsy-pqyt`: the pre-push hook uploads, then
   writes `remote_key` into the working-tree `.bref` (`commands-stage2.ts:2114-2120`),
   but the commits being pushed are already fixed, so collaborators receive pointers
   without keys. The hook prints a paragraph telling the user to make a second commit
   (`2144-2148`). Status, `check-unpushed`, `pre-push-check` and `doctor` all use
   “`remote_key` present” as the pushed bit (`stage2:181, 1062, 1922, 1961, 2077`), so
   the bit is also wrong whenever a teammate pushed but has not committed.
5. **`track` must clear `remote_key`, `compressed`, `compressed_size`** on content
   change (`cli.ts:938-945, 1068-1075`), and `sync`’s push path must rebuild them — four
   copies of the “upload then merge `refUpdates`” dance (`stage2:334-343, 719-724,
   747-754, 2112-2120`).

What it buys: a remote that is browsable by date and path with `aws s3 ls`. That is a
real property, but it is the property *mirror mode* (UC-3/UC-5) needs, not the property
per-file pointers need.
Round 8 said this explicitly ("two storage disciplines are genuinely needed:
content-addressed for repo-shaped files, path-mirrored for runs"). The current default
applies the path-mirrored discipline to the repo-shaped case.

Verdict: **accidental.** Everything in items 3–5 and bead pqyt disappears if the key is
a pure function of the pointer’s own fields.

### 2.2 Compression as part of identity

Compression is decided at *push* time from *config* (`transfer.ts:289`), and the result
is written into both the key (`{compress_suffix}`) and the pointer (`compressed`,
`compressed_size`). So:

- Two users with different `compress` config push the same file to different keys with
  different pointers (the design doc warns about this at lines 2179-2186 rather than
  preventing it).
- Compression is applied even when it enlarges the object (random 300,000 B → 300,015 B
  **[verified]**); there is no “keep only if smaller” check.
- Pull needs the pointer’s `compressed` field to know how to decode (`transfer.ts:375`),
  so a pointer without the push-time update (the pqyt case) cannot even try a derived
  key.

What it buys: smaller uploads for text-like payloads (`*.json`, `*.csv`, …). Essential
*feature*, accidental *placement*. The fix is cheap: decide compression at `track` time
(size and config are known then), record it in the pointer at track time, and make the
suffix part of the derived key.
Then the key is derivable from the committed pointer alone and “same config across
users” becomes a one-time repo setting rather than a per-push hazard.
Also: skip compression when `compressed_size >= size`.

### 2.3 `sync` → stat-cache merge base → conflict state machine

Upstream choice: a bidirectional verb that must *decide direction per file*.

- `decideSyncAction` (`stage2:553-594`) is the only reader of the cache (`getMergeBase`,
  line 583). The performance role described in both design docs ("stat all + hash 3: ~65
  ms") does not exist: `getCachedHash` has zero callers **[verified]**, and
  `status`/`verify`/`push`/`pull` call `computeHash` unconditionally
  (`stage2:170, 250, 293, 310, 423, 471; cli.ts:1208`).
- The cache is written in 9 places (track ×2, push, pull, sync ×4, mv), each a
  `createCacheEntry` + `writeCacheEntry` pair after the operation — correct per the
  cache-update rules, but it is bookkeeping for a reader that mostly is not there.
- `push` and `pull` already have the safety semantics (`DS-02` refuse-overwrite, `DS-03`
  refuse-stale-hash) *without* a merge base; they just refuse and tell the user which
  verb to use. `sync` adds: 9 decision outcomes, exit code 2, “ambiguous” errors after
  every fresh clone or `git checkout` (mtime reset), a `--skip-health-check` flag, and a
  583-line design doc.

What it buys: `blobsy sync` as a single verb for the UC-4 “both sides may have changed”
case. But the design already concedes that the ambiguous case “often occurs after
`git pull`” — i.e. in the normal workflow — and the recovery is “run push or pull
explicitly”. A sync that degrades to push/pull in the common case is not buying much.

Verdict: **accidental**, downstream of the choice to auto-decide direction.
The *hash cache* (size+mtime → hash) is independently valuable for large file counts and
should be kept — and actually wired in.
The *merge base* can go.

### 2.4 Trash directory

`moveBrefToTrash` (`cli.ts:2076-2086`) writes; the only reader is `rmFile` reading the
file it just moved (`cli.ts:1498`). No command lists, restores or expires trash.
The design doc says `.blobsy/` “is committed to git” (line 2596), but `doctor` reports
an error unless `.blobsy/` is gitignored (`stage2:993-1037`, auto-added by `--fix`), so
the trash never reaches git and the stated GC rationale (line 2612) cannot work.
Git history of the deleted `.bref` already is the paper trail.
**Accidental**, for a GC that is explicitly V2.

### 2.5 Hidden commands

Eight hidden commands still carry full handlers, goldens and coverage-script entries
(`scripts/check-golden-coverage.sh` lists `init track health check-unpushed
pre-push-check skill`). `track` is hidden yet recommended in `setup`’s next-steps text
(`cli.ts:503`) and in `handleTrack`’s own hint (`cli.ts:779`), and `blobsy skill` is
hidden yet advertised in `--help` (`cli.ts:377`) and AGENTS.md.
“Hidden” was the round-7 compromise; it saved help-text lines but no code, tests, or
docs. **Accidental.**

### 2.6 Per-file gitignore lines and the rewrite machinery

- 300 files → 302-line `.gitignore` **[verified]**. The design doc calls this “fine”
  (line 2588); it is fine for UC-1, and wrong for UC-2 where a manifest should own the
  collection.
- `trackDirectory` calls `addGitignoreEntry` per file (`cli.ts:1091`), and each call
  reads, dedups, sorts and rewrites the whole block (`gitignore.ts:26-35, 110-138`):
  O(N²) line writes per directory.
  300 files took 9 s for `add` including hashing 600 MB, so this is not yet the
  bottleneck, but it becomes one at the UC-2 scale the owner named.
- `detectGitignoreConflicts`/`fixGitignoreForBlobsy` (185 LOC) exist because a user’s
  pre-existing `data/` ignore line hides the adjacent `.bref` from git.
  That is an inherent cost of the adjacency model and is **essential for UC-1**; it is
  simply not the right model for UC-2/UC-3.

### 2.7 Five-level config hierarchy

Inert (§0). `mergeConfigs` grew one-level-deep section merging (CFG-02) for a subdir
case no call site exercises.
`resolveConfigWithOrigins` (`config.ts:231-278`) is a copy-paste of `resolveConfig` with
a different accumulator.
`checksum.algorithm` is stored, validated and never read.
`sync.tools` is only consulted for the literal `'aws-sdk'` (`transfer.ts:223`).
**Accidental**; bead `blobsy-4vpk` option (b).

### 2.8 Output-mode branching and dry-run duplication

Every handler hand-rolls four outputs (human / `--json` / `--quiet` / `--dry-run`),
giving 117 guard sites and a parallel dry-run implementation per command.
`sync` partially fixed this with `decideSyncAction` (plan reused by dry-run); `push`,
`pull`, `rm`, `mv`, `track` did not.
**Accidental**: no plan/execute split and no reporter abstraction.
This matters for the next phase because adding two modes will otherwise triple the guard
count.

### 2.9 Three “is it pushed” audits and two hooks

`check-unpushed` (remote_key absent), `pre-push-check` (remote_key absent **or**
`exists()` false), `doctor` orphan check (file missing **and** remote_key absent), plus
the pre-push hook’s own scan.
Four scans of the same question with three different answers.
Downstream of §2.1 (the pushed bit lives in the pointer).
With derived keys, “pushed” is exactly `backend.exists(derive(pointer))`, computed in
one place.

### 2.10 Essential and worth keeping

- The `.bref` pointer with `hash` + `size` (UC-1, PAIN-1/3/4).
- Backend interface + local/S3/rclone/command implementations (PAIN-5).
- Temp-file + hash-verify + rename on pull; create-only pushes; path containment
  (`resolveRepoPath`, `LocalBackend.resolveKey`); the threat model’s seven rules.
- Externalize rules for directory tracking (never/always/min_size).
- `doctor` as a concept (not at 915 LOC).
- `--json` everywhere, non-interactive, no daemon.
- Golden-test infrastructure.

* * *

## 3. Simplification proposals (ranked by complexity removed ÷ capability lost)

| Rank | Proposal | Removes | Loses | Migration | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | **S4** Delete the subdirectory config walk, `subdir` origin, `checksum` section, `sync.tools` (keep an explicit `backends.<n>.tool`) | ~150 LOC, one duplicated loop, bead 4vpk, a docs section with a “this is ignored” banner | nothing (inert) | none | S |
| 2 | **S5** Delete `.blobsy/trash/`; `untrack`/`rm` just remove the `.bref` (git history is the undo) | `moveBrefToTrash`, ⊗ symbol, the committed-vs-ignored contradiction, “GC paper trail” prose | nothing real | none; `doctor --fix` can delete stale trash dirs | S |
| 3 | **S3** Delete hidden commands: `init` (fold into `setup`), `track` (→ `add --no-stage`), `health` (→ `doctor --backend`), `check-unpushed` + `pre-push-check` (→ `doctor --remote`, exit-code contract), `readme`/`skill` (flags on `docs` already exist). Keep `hook` hidden | ~300 LOC, 7 goldens, 6 coverage-script entries, 3 doc sections | aliases scripts may use (alpha) | print “renamed to …” for one release | S |
| 4 | **S1** Content-addressed keys by default; `remote_key` becomes *derived*, not stored (optional legacy field read-only). Decide compression at `track` time and store it in the pointer; key = `sha256/<hex>{suffix}` (or `sha256/<2>/<62>{suffix}`) | bead pqyt entirely; hook write-back; 4 copies of the `refUpdates` dance; `push --force` orphaning; timestamp non-determinism; `{iso_date_secs}`, `{repo_path}`, `{filename}`, `{dirname}` as *default-path* concerns; the three “pushed” audits collapse to `exists()` | date/path-browsable remote for file mode (keep `key_template` as an advanced opt-in for people who want it; document that it re-introduces the two-phase lag) | `blobsy-bref/0.2`: reader accepts 0.1 with `remote_key` and uses it; writer omits it; `doctor --fix` rewrites. No remote migration needed (old keys keep resolving via the stored field) | M |
| 5 | **S2** Remove `sync`’s merge-base semantics. Either delete `sync`, or redefine it as `pull-missing + push-new` with the same refusals as push/pull (no cache read). Keep the stat cache as a *hash cache only* and wire `getCachedHash` into status/verify/push/pull | ~325 LOC sync, 9 decision states, exit-code-2-from-sync, “ambiguous after git pull”, 583-line design doc → ~60-line “hash cache” section | one-verb bidirectional merge-base detection (which already degrades to push/pull in the common case) | none for pointers; cache entries unchanged | S–M |
| 6 | **S7** Reporter abstraction: handlers emit typed events (`fileState`, `transfer`, `issue`, `plan`); one reporter renders human/json/quiet | ~117 guard sites, schema drift between commands | nothing | none | M |
| 7 | **S8** Plan/execute split per command (`plan(): Action[]`, `execute(plan)`); dry-run prints the plan | duplicated dry-run branches in push/pull/rm/mv/track | nothing | none | M |
| 8 | **S6** Batch gitignore writes per directory in `trackDirectory`; batch `git add`/`git rm --cached` once per command in untrack/rm/mv | O(N²) rewrites; 2 git spawns per file | nothing | none | S |
| 9 | **S10** Doctor diet: table-driven checks; drop Levenshtein (use zod `strict()` for unknown keys); fold `health`; delete the dead cache scan or fix it to walk shards | ~300 LOC | did-you-mean on config keys | none | S |
| 10 | **S9** Compression: zstd + none only (gzip/brotli add 3 enum values and 2 goldens for little); skip when not smaller | small | brotli/gzip choice | pointers with `compressed: gzip` still decode (keep decoders, drop encoders) | S |
| 11 | **S11** Consider dropping the `aws-cli` backend: the SDK backend now streams multipart and uses the same credential chain | 176 LOC + 1 test file + tool-detection code | users who need `aws` CLI quirks (profiles via `AWS_PROFILE` work in the SDK too) | none | S |

Ranks 1–3 are pure deletions and should land before any new mode.
Ranks 4–5 are the architectural ones; §4 assumes them.
Ranks 6–8 are what make adding modes cheap.

### 3.1 What S1 looks like concretely

```yaml
# blobsy -- https://github.com/jlevy/blobsy
format: blobsy-bref/0.2
hash: sha256:82020d96…
size: 300000
compressed: zstd          # decided at track time; absent = stored raw
```

Key derivation (pure, in one function used by push/pull/status/doctor):

```
key(ref) = `sha256/${hex}${suffix(ref.compressed)}`
```

`push` = `if (!await backend.exists(key)) await backend.put(key, encode(file))`.
`status` “pushed” = `exists(key)` (network) or “unknown” offline — which is honest; the
current offline “synced” symbol is actually “a key was recorded once”, not “it exists”.
Keep `remote.key_template` as an advanced option; when set, `remote_key` must be stored
and the docs say so.
Default users never see the field.

Dedup falls out: identical content → identical key → `exists()` short-circuit, across
paths, branches, users and time.
Rename = free. `gc` later = `list()` minus the set of keys derivable from
`.bref`/manifest files across refs — simpler than scanning stored `remote_key` strings.

* * *

## 4. Target architecture for UC-1..UC-5

### 4.1 Layers

```
cli/            commander wiring only; one file per verb; verbs dispatch by mode
  verbs/        add  rm  mv  push  pull  status  verify  doctor  config  setup  hooks  docs
core/           hash  paths  config (3 levels)  errors  reporter  git (spawn helpers)
store/          Backend interface; local / s3 / rclone / command; transfer (encode, tmp+verify+rename)
refs/           the mode-specific *reference* layers — each exposes the same tiny interface
  file.ts       .bref  (UC-1)
  manifest.ts   .bmanifest (UC-2)
  snapshot.ts   mirrors: stanza + receipts, no git reference (UC-3, UC-5)
doctor/         table of checks; each layer registers its own
```

### 4.2 Object model (four nouns, five invariants)

- **Blob** — immutable bytes identified by `hash` (sha256 of original content), with
  `size` and optional `encoding` (`zstd`). Stored at a key that is a pure function of
  (hash, encoding). Never overwritten, never deleted by normal commands.
- **Ref** — a committed pointer to one blob at one repo path.
  Today: `.bref`.
- **Manifest** — a committed list of (path, hash, size, encoding) for a collection
  directory. One file in git, N blobs in the store.
  A manifest *is* N refs.
- **Snapshot** — a *named*, immutable remote prefix (`runs/<id>/`) produced by mirroring
  a local tree, with a receipt `{tree_hash, files, bytes, pushed_at}` written into the
  tree and alongside it in the store.
  No git reference required; the receipt may be committed if the directory is
  git-adjacent. Keys are path-shaped by design (R9).

Invariants:

1. Store writes are create-only: `put` is skipped when `exists`; nothing overwrites.
2. `key = f(pointer fields)` for Ref/Manifest entries; no push-time state in a pointer.
3. A path is governed by exactly one layer; `doctor` errors on overlap.
4. Pulled bytes are hash-verified in a temp file before `rename` (already true).
5. Nothing in git hooks performs unbounded network work; hooks verify, `push` uploads
   (today’s split, kept) — and for Snapshot nothing runs in hooks at all.

### 4.3 The one interface that makes UC-2 cheap

```ts
interface Entry { path: string; hash: string; size: number; encoding?: 'zstd' }
interface RefLayer {
  // which committed thing governs this path, and what entries it yields
  entriesUnder(paths: string[]): Promise<{ owner: string; entries: Entry[] }[]>;
  // write back after track/update (file: rewrite .bref; manifest: rewrite one file)
  write(owner: string, entries: Entry[]): Promise<void>;
  // the gitignore contribution (file: per-file line; manifest: one line for the dir)
  ignoreRules(owner: string): string[];
}
```

`push`, `pull`, `status`, `verify` become **one loop over `Entry`** that does not know
whether an entry came from a `.bref` or a manifest:

```
for e of entries:  key = derive(e)
  push:   exists(key) || put(key, encode(local))
  pull:   localMatches(e) ? skip : (localExists && !force ? refuse : get(key)→verify→rename)
  status: hashCache(e.path) === e.hash ? (exists? synced : pending) : modified
```

That is the whole reason to do S1 and S2 first: with derived keys and no merge base, the
per-entry loop is ~60 lines and mode-agnostic.
With stored `remote_key` and a merge base, every mode would need its own copy of today’s
4-way push dance and 9-state sync decision.

### 4.4 Snapshot (mirror) mode shares the store, not the loop

Mirror mode is a different loop — it wants `rclone sync`/`copy --files-from` or
`aws s3 sync` over a whole tree, path-shaped keys, excludes, receipts — and should be
implemented as round 8 describes (B+C), with its own `push/pull/status` branch selected
by path. What it shares: `store/` (backend selection, trust gate, health), `core/`
(config, reporter, paths, doctor registry), `hash` (for `tree_hash`). What it must not
share: refs, hooks, stat cache, compression bookkeeping.
The `Backend` interface needs two additions for it: `list(prefix)` and a batch
`putMany/getMany` (or `syncTree`) that the rclone/aws-cli/local backends implement
natively; `command` can decline.

UC-5 (immutable named assets) is Snapshot with one rule added: a prefix is written at
most once (receipt exists → refuse).
No separate mode.

### 4.5 What is shared vs mode-specific

|  | file (.bref) | manifest | snapshot |
| --- | --- | --- | --- |
| backends, trust gate, health | shared | shared | shared |
| config (3 levels), reporter, errors, exit codes | shared | shared | shared |
| hash + hash cache | shared | shared | shared (tree_hash) |
| key derivation | `sha256/<hex><suffix>` | same | path-shaped, from `mirrors:` stanza |
| gitignore | per-file line | one line per collection dir | one line per mirror root (or none if already ignored) |
| push/pull/status loop | entry loop | entry loop | tree sync + receipt |
| hooks | pre-commit verify, pre-push upload | same (verify = manifest vs tree) | none |
| doctor checks | pointer validity, ignore entries | manifest validity, ignore entry | receipt vs tree, overlap |

### 4.6 Restructuring `cli.ts` / `commands-stage2.ts`

Today the split is historical ("stage 2"), not by domain, and it already caused one
divergence (two hook installers, HK-02). Proposed, in order:

1. Extract `core/reporter.ts` and route all output through it (S7). Mechanical; goldens
   guard the text.
2. Move each verb into `cli/verbs/<verb>.ts` exporting `plan()` + `execute()` (S8).
   `cli.ts` shrinks to program wiring (~250 lines).
3. Extract `refs/file.ts` from the track/untrack/rm/mv/status code; this is where
   `trackSingleFile`/`trackDirectory` get unified into one `upsertEntry`.
4. Extract `doctor/` with a check registry; each layer contributes checks.
5. Delete `commands-stage2.ts`.

### 4.7 Migration of existing `.bref` files

- Bump `format` to `blobsy-bref/0.2`. Reader: accept 0.1; if `remote_key` present, use
  it verbatim (old objects stay reachable forever).
  Writer: omit `remote_key` unless a custom `key_template` is configured.
- `doctor --fix --rewrite-refs` optionally re-pushes under derived keys and strips the
  field (one-time, opt-in; old objects become orphans for a future `gc`).
- Pointers that lack `compressed` because compression was decided at push time: on first
  `track`/`add` touch they get the field; until then `derive()` tries `{suffix, ''}` in
  order and `exists()` decides.
  Two HEAD requests worst case, once.

* * *

## 5. Code-quality findings that matter for the next phase

### 5.1 Duplication (will multiply by three with modes if not fixed first)

| What | Where | Note |
| --- | --- | --- |
| Create/update pointer + cache + gitignore | `cli.ts:891-994` vs `996-1122` | two implementations of the same state transition, already drifted once (Bugbot r11 comment at 1064) |
| Upload → merge `refUpdates` → write `.bref` → write cache | `stage2:334-343`, `719-724`, `747-754`, `2112-2120` | four copies |
| Config walk | `config.ts:159-197` vs `231-278` | verbatim copy with different accumulator |
| Status rendering | `cli.ts:1146-1176` vs `stage2:921-940` | `doctor` re-implements `status` |
| Untrack vs rm cleanup (gitignore, cache, `git add`, `git rm --cached`) | `cli.ts:1336-1364` vs `1539-1570` |  |
| Dry-run vs real decision | `stage2:234-280` vs `285-346` (push); `411-448` vs `453-498` (pull) | `sync` fixed this pattern; others did not follow |
| Default key template literal | `config.ts:50`, `transfer.ts:296` | two sources of truth |
| Hook-manager detection | `cli.ts:618-622` and `728` | same condition twice |

### 5.2 Error handling

- Three error classes with different shapes: `BlobsyError{category, exitCode,
  suggestions}`, `UserError{hint, exitCode}` (with its own `format()`), `ValidationError
  extends BlobsyError`. Backends throw `UserError` for `EACCES` and `BlobsyError` for
  everything else (`backend-local.ts:86, 93, 107`), so callers cannot pattern-match on
  category.
- `pushFile`/`pullFile` flatten any error to a string (`transfer.ts:331-337, 417-423`),
  losing `category` and `suggestions` before they reach `--json`.
- `process.exitCode` is set in ~20 places inside handlers instead of being returned;
  `wrapAction` and `main().catch` both format errors (`cli.ts:443-473`, `2127-2135`).
- Unexpected errors (`throw error; // Re-throw unexpected errors`) print `Error: <msg>`
  with no stack and no category, even with `--verbose`.

### 5.3 Performance traps at large file counts (the UC-2 scale)

| Trap | Evidence | Effect at 10k files |
| --- | --- | --- |
| Every read command rehashes every file | `getFileState` `stage2:170`; push 293/310; pull 423/471; verify `cli.ts:1208`; `getCachedHash` unused | `status` is O(total bytes) every time; measured 4.5 s for 600 MB, so ~minutes for tens of GB |
| Per-file whole-`.gitignore` rewrite | `cli.ts:1091` → `gitignore.ts:110-138` | O(N²) lines written per directory |
| Two `git` spawns per file in untrack/rm | `cli.ts:1347-1364`, `1553-1570` | 20k process spawns for `untrack --all` |
| One **synchronous** transport spawn per file | `backend-aws-cli.ts:131`, `backend-rclone.ts:154`, `backend-command.ts:288, 329` (`execFileSync`) | sequential by construction; the design’s “up to `sync.parallel` (default 8)” (line 1744) is not implemented and cannot be with sync spawns. BE-02 removed the config key rather than the limitation |
| `pre-commit` hashes every staged payload; `pre-push` hashes every unpushed payload | `stage2:2042`, `2100` | acceptable per-commit, but a 10k-file manifest commit will hash the whole collection |
| `doctor` runs the full status (rehash) plus a health check plus per-file `.gitignore` reads | `stage2:918-919`, `1084-1113` | slow doctor; the `.gitignore` is re-read once per tracked file |
| `findBrefFiles`/`findTrackableFiles` are synchronous recursive walks | `paths.ts:148-223` | fine; but they walk the *whole repo* for every bare `push`/`status`, including `node_modules` unless ignored — `findBrefFiles` applies no ignore patterns at all (`paths.ts:150` passes `null`) |

For UC-2 the design should assume: hash cache always consulted; one gitignore write per
directory per command; one `git add` per command; transport batched per command
(`--files-from`) with the per-file path only for `command` backends.

### 5.4 Dead and misleading code

- Zero-caller exports: `formatTransferSummary`, `formatHint`, `formatInfo`,
  `formatSuccess`, `formatCommand`, `formatNextSteps`, `formatCheckInfo` (`format.ts`);
  `formatBackendUrl` (`backend-url.ts`); `getDirectory`, `getFilename`,
  `resolveFilePath` (`paths.ts`); `hashString`, `isValidHash` (`hash.ts`);
  `getCachedHash` (`stat-cache.ts`). `SyncAction` (`types.ts:159`) is exported from the
  package index and unused — `decideSyncAction` defines its own `SyncDecision`.
- `FILE_STATE_SYMBOLS.committed_not_pushed / pushed_not_committed / deleted` never
  emitted; design doc §"Three Orthogonal States" and `blobsy stats` describe
  unimplemented behaviour as current.
- `doctor` stat-cache scan (`stage2:1151-1210`) never sees sharded entries.
- `checksum` config section: validated, listed as a known key, never read.
- Bead `blobsy-aad8`
  `spec_path: docs/project/specs/active/plan-2026-03-04-full-directory-mode.md` does not
  exist in the tree.
- `.blobsy/` committed (design) vs must-be-gitignored (doctor).

### 5.5 Testing gaps relative to the planned modes

- No scale test at all (largest fixture is a handful of files); nothing would catch the
  O(N²) gitignore or the rehash-everything regressions.
- No test asserts the hash cache is *used* (because it is not).
- Goldens pin the timestamped key shape via the `REMOTE_KEY` pattern
  (`tryscript.config.ts`); S1 will touch ~20 goldens — budget for it.
- `init`, `check-unpushed`, `pre-push-check`, `health`, `skill`, `readme` have goldens
  and coverage-script entries; deleting the commands (S3) deletes 7 goldens and
  simplifies the script.
- No tests for: concurrent `blobsy` processes (the stated reason for file-per-entry
  cache); `mv` across directories with user gitignores; Windows paths (`normalizePath`,
  `where`); real S3 beyond s3rver; rclone beyond `--version` presence in CI.
- Unit tests spawn the CLI per case (327 tests in 50 s). Fine today; a mode-agnostic
  entry loop (§4.3) would be unit-testable in-process and far faster.

* * *

## 6. Documentation complexity and a proposed structure

### 6.1 Current state

`docs/project/design/current/` is 9,436 lines — more than the source.
Breakdown: design 3,394; testing-design 2,018; backend-and-transport 1,016; round-7
review 915; stat-cache 583; round-8 review 490; implementation-notes 331; issues-history
142; threat-model 70. Plus `docs/project/specs/active/` 2,063 lines (six plans, several
already shipped), seven archived plans, README 409, user docs 350, SKILL 68.

Specific problems, verified against the text:

- V2 content inside V1 sections: GC Python pseudocode (lines 3127-3220), branch
  isolation (553-628), transfer-engine interface (3082-3100), `blobsy stats` with full
  sample output (1826-1874, “Deferred: new command”), `verify --rebuild-cache` described
  as existing in stat-cache doc (line 283) but absent from `cli.ts:234-238`.
- Described-but-unimplemented behaviour presented as current: three orthogonal states
  and symbols ◐ ◑ ⊗ (869-1030); `sync.parallel` / 8-way concurrency (1736-1750);
  `.blobsy/` committed (2594-2600); “Pattern 1 … deduplicates re-pushes … within the
  same second” (475-519) is technically true and practically never.
- Three overlapping specifications of the same thing: hooks (design 2011-2047,
  2510-2525, impl-notes 10-230); templates (333-732 in design, again in backend doc);
  compression rules in design, README, user docs, and `getBuiltinDefaults`.
- Review documents (rounds 7, 8) live in `current/` next to the spec they critique, so a
  reader cannot tell which statements are normative.
- The testing-design doc (2,018 lines) is longer than the entire test suite’s source
  (4,089 incl. goldens’ prose) and mostly reproduces golden examples.

### 6.2 Proposed structure

```
docs/
  spec/                       normative, present tense, nothing deferred
    blobsy-spec.md            ≤ 800 lines: concepts, invariants, formats (.bref,
                              .bmanifest, receipt), commands + exit codes, config keys,
                              env vars, threat model (merge the 70-line doc in)
    backends.md               ≤ 400: Backend interface, each backend's contract,
                              URL convention, trust gate, error categories
    architecture.md           ≤ 300: layers (§4.1), object model (§4.2), module map,
                              RefLayer interface, where each mode diverges
  roadmap/
    deferred.md               everything currently marked Deferred/V2: gc, branch
                              isolation, transfer engine, stats, remote checksums,
                              dictionary compression, export/import, parallel .bref dir
    mirror-mode.md            round 8 §4-5 reworked as a design, not a review
  reviews/                    round-7, round-8, issues-history, archived plans (read-only)
  testing.md                  ≤ 300: conventions, stable/unstable fields, echo backend,
                              how to add a golden; examples live in tests/
README.md                     quick start + pointers only (≤ 200 lines)
packages/blobsy/docs/         user guide (generated sections where possible: command
                              table from commander, defaults from getBuiltinDefaults)
packages/blobsy/SKILL.md      unchanged (already the single source for skill text)
```

Rules worth adopting:

1. One source of truth per fact: builtin defaults are rendered from
   `getBuiltinDefaults()` into docs by a script, as the skill text already is.
2. The spec describes only shipped behaviour; anything else moves to `roadmap/`, and a
   golden test exists for every spec’d command output.
3. Reviews never edit the spec in place; they produce beads, and the spec changes when
   the code does.

* * *

## 7. Answers to the four open beads, in this frame

- **blobsy-s2tr (mirror mode):** approve the file-vs-mirror split, but sequence it after
  S1–S5 and the `RefLayer` extraction, because otherwise mirror mode is a second copy of
  the output/dry-run/doctor plumbing.
  Build it on a batch `syncTree`/`list` extension of `Backend`, not on per-file `put`.
- **blobsy-pqyt (two-phase remote_key):** resolve by S1 (bead option 1, strengthened:
  compression decided at track time so no suffix guessing).
  Options 2 and 3 keep the stored key and therefore keep the problem.
- **blobsy-aad8 (directory tracking mode):** close as superseded; UC-2 is the manifest
  layer (§4.2), which is not “a `.bref` for a directory” but “N entries in one file”;
  its spec path is dangling anyway.
- **blobsy-4vpk (subdirectory configs):** drop (S4). Per-directory customization for
  UC-2/UC-3 belongs in the manifest/mirror stanza, declared centrally.

* * *

## 8. Things I could not verify

- Real S3/R2, GCS (rclone) or Azure behaviour; tests use s3rver and `rclone --version`.
- Windows behaviour of `normalizePath`, `where`, hook shims.
- Round 7’s `file:line` citations (they are to an older head; I re-derived all
  references above against `04a3d1a`).
- Whether the `finterm-ai/trading` repo’s requirements (round 8 R10–R12) still hold.
- Throughput claims in the stat-cache doc (hashing ~20 s per 10 GB); my single
  measurement (600 MB in ~4.5 s on this container) is consistent with them.
