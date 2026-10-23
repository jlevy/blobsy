# Blobsy Design and Implementation Review — Round 7 (Alpha Readiness)

**Status:** Active review — findings to be addressed

**Date:** 2026-07-27 (v2, revised 2026-07-27 addressing the PR #4 counter-review,
findings R1–R12; see “Corrections from v1” near the end)

**Scope:** Full review of the current design docs (`docs/project/design/current/`) and
the entire implementation (`packages/blobsy/`), including tests, CI, and all user-facing
documentation. Unlike rounds 1–6 (design-only), this round reviews the design *and* the
shipped code against it.

**Review lens (project goals):**

1. Dead-simple setup, especially as an **agent skill** — an AI coding agent should be
   able to set up blobsy in a repo from the installed skill alone.
2. Any repo with many large files can adopt blobsy easily, for some or all files.
3. Normal git workflows keep working; only blob contents are externalized.
4. **Minimal complexity** — a clean CLI end-to-end.
   Needless complexity is itself a defect.

**Method:** Full read of all five current design docs; line-by-line review of all 26
source files by focus area (CLI commands, core library, backends, tests/CI,
docs/onboarding); build/test runs; cross-checking every doc claim against code.
Every finding was verified against the actual source before being recorded.

**Reviewed revision:** base `main` @ `8bebb0a`; all disputed or measured evidence in
this v2 was re-verified at PR head `c2830b1` with a freshly built CLI (version stamp
`0.1.0-dev.111.c2830b1`). `file:line` references are to that tree.
Environment, exact commands, and result counts are in the **Reproducibility appendix**
at the end.

## Verdict

**Not alpha-ready yet — but close, because the architecture is right.**

The core design is genuinely good: one file, one `.bref`, one blob; git is the manifest;
the remote is a dumb blob store.
That model is the correct foundation for the stated goals.
Most of the implementation is competent and the golden-test infrastructure is unusually
good for a project at this stage.

What blocks alpha is that **the safety layers the design promises are not actually wired
in**. The stat cache is written but never read, so `sync` cannot detect payload-vs-ref
desync and will silently revert teammates’ changes.
`pull` overwrites local modifications without `--force`. `push` skips its designed hash
sanity check and can poison the remote.
The pre-push hook — the design’s primary data-loss prevention — swallows failures and
reports success. `rm --remote` can delete blobs still referenced by git history (and
`--quiet` skips its only confirmation), and a hostile `.bref` can walk the local backend
outside its directory.
Each of these is a localized fix; none requires redesign.

The second theme is **drift and trust**: three divergent versions of the agent skill
text, a README that documents a different externalize threshold than the code ships,
hooks described three different ways across three docs, 65 golden tests that never run
in CI (with six already stale), and a test harness that resolves the CLI from `PATH` —
so a run can silently “verify” a stale or unrelated binary (this bit both this review’s
v1 evidence and the counter-review’s; see DX-01).

The third theme is **complexity creep against goal #4**: 22 CLI commands (with several
overlapping pairs), a two-file CLI implementation split with no organizing principle, a
five-level config hierarchy with surprising replace-semantics, and a 3,400-line design
doc with V2 specifications interleaved into V1 sections.

Recommended path: land TEST-04’s stat-cache tests, fix the six blockers, make the test
suite hermetic and wire the golden suite into CI (DX-01, TEST-01), fix transfer
viability (BE-01, BE-04), state the trust model (SEC-03, HK-03), consolidate the command
surface (22 → 14 public, 13 with `sync` deferred), and align the three skill-text
variants. The **alpha-exit matrix** near the end makes the gate explicit and testable.

## Design Assessment

### What the design gets right

- **The `.bref` primitive.** Adjacent pointer file + per-file gitignore entry + dumb
  remote is the simplest workable model in this space.
  Against Git LFS it avoids a server, smudge/clean filters, and provider lock-in;
  against DVC it avoids a Python dependency and an opaque cache, and keeps the remote
  browsable. The tradeoff should be stated rather than declared won: LFS and DVC bring
  mature checkout integration, locking, retention/GC, hosting, and migration tooling
  that blobsy defers or omits.
  Blobsy’s claim is “simplest for the CLI/agent use case,” and on that criterion it
  holds. Git-native merges of `.bref` files are a real differentiator.
- **Delegation.** Letting git handle history/conflicts, external tools handle transfer,
  and `node:zlib` handle compression keeps blobsy small.
  The “externalize everything” principle is the right instinct and is mostly followed.
- **Non-interactive, `--json` everywhere, self-documenting refs.** Exactly right for the
  agent-skill goal (with one violation, DS-04 below).
- **Local backend for testing.** Zero-credential integration testing is working well in
  practice (the tryscript golden suite is built on it).
- **Idempotency as a design decision.** Correct and mostly achieved.

### Design weaknesses and contradictions

1. **The determinism principle contradicts the default key template.** Principle 11
   claims “Same configuration produces same remote keys” and “multiple users pushing
   identical content produce identical remote blobs,” but the default template
   `{iso_date_secs}-{content_sha256_short}/...` embeds push *time*, so identical content
   pushed at different seconds produces different keys and duplicate storage.
   The “no post-merge gap” rationale ("same content hash = same remote key",
   blobsy-design.md:2751) is only true for the pure-CAS template; the mechanism that
   actually makes merges work is `remote_key` persistence in the `.bref`. The docs
   oversell dedup under the default layout.
   Either make pure CAS the default (aligns with the stated principles, maximizes dedup,
   simplifies GC later) or rewrite principle 11 and the dedup claims to match the
   timestamped default.
2. **The stat-cache/three-way-merge design is the most complex part of the system and is
   entirely unimplemented** (see DS-01). Decide explicitly: implement it as specified
   (recommended — it is the only thing that makes `sync` safe), or cut `sync` from alpha
   and ship push/pull/status only.
   Shipping a `sync` that ignores the design is the worst of both worlds.
3. **Hook behavior is specified three different ways.** blobsy-design.md:2001–2002
   (pre-commit verifies, pre-push uploads), blobsy-design.md:2510 (pre-commit auto-runs
   push), and blobsy-implementation-notes.md:99–141 (pre-commit pushes and re-stages).
   The implementation matches the first.
   Fix the other two docs.
4. **V2 material is interleaved into the V1 design doc.** GC pseudocode (in Python),
   branch-isolation specs, transfer-engine interfaces, and “Deferred” markers appear
   inside V1 sections. At 3,376 lines the design doc no longer serves goal #4. Move all
   V2/deferred content into a separate `blobsy-v2-roadmap.md` and keep the current doc
   describing only what V1 does.
5. **Five-level config hierarchy with replace-not-merge semantics** is documented as a
   footgun ("Best Practice: keep rules in root … to avoid confusion") and the
   implementation makes it worse by falling back to *builtin* defaults rather than
   parent values when a subdir overrides one field (CFG-02). For alpha, consider
   supporting only builtin → `~/.blobsy.yml` → repo root, and defer subdirectory configs
   entirely. Almost nobody needs them, and they interact badly with every other feature
   (mv re-evaluation warnings, compression consistency across users, docs complexity).
6. **The design’s central invariant is never stated.** The rule everything else hangs on
   is: *once a `remote_key` has been published, normal operations never overwrite or
   delete that object*. DS-03 (stale-hash upload), `push --force` semantics,
   local-backend write atomicity (BE-09), pull verification, and the deferred GC are all
   downstream of this one rule — and DS-04 is settled by it (deletion is never a normal
   operation). Name it explicitly in blobsy-design.md and make each command’s contract
   reference it.
7. **There is no threat model.** `.blobsy.yml` and `.bref` files arrive via git from
   other contributors; hooks and `sync` act on them automatically; the command backend
   executes configured programs (SEC-03); `remote_key` feeds path construction (BE-03);
   user-supplied paths feed file operations (SEC-02). A half-page statement of who
   controls each input and what blobsy trusts would have caught several findings below
   at design time.

### Command surface: 22 commands is too many for alpha

Current:
`setup init add track untrack rm mv push pull sync status verify config health doctor hooks check-unpushed pre-push-check hook(hidden) readme docs skill`.

Overlapping pairs and consolidation proposal:

| Keep | Fold in | How |
| --- | --- | --- |
| `setup` | `init` | `init` becomes `setup` without `--auto` extras, or keep `init` as hidden plumbing. One documented entry point. |
| `add` | `track` | `track` = `add --no-stage`. One verb in docs and skill text. |
| `doctor` | `health`, `check-unpushed` | `doctor` already supersets status/config/hooks checks; add `--remote` for blob reachability (covers check-unpushed) and keep `pre-push-check` as `doctor --ci` or a documented exit-code contract. |
| `docs` | `readme`, `skill` | `docs --readme`, `docs --skill` (or topics). Three doc commands is two too many. |
| `hooks` | `hook` (hidden) | Fine as-is; `hook` stays hidden plumbing. |

That yields **14 public commands**:
`setup add untrack rm mv push pull sync status verify config doctor hooks docs` (plus
the hidden `hook` plumbing) — **13 with `sync` deferred** (see weakness 2). Each cut
directly serves goal #4 and shrinks the skill text agents must absorb.

### Implementation structure

The `cli.ts` (2,017 lines) / `commands-stage2.ts` (1,703 lines) split has no organizing
principle: `track/add/untrack/rm/mv` live in cli.ts while `push/pull/sync/doctor/hooks`
live in commands-stage2.ts, everything is statically imported (no lazy-load benefit),
and the split has already caused real divergence — two hook installers with different
behavior (HK-02, HK-03) and duplicated status rendering.
Reorganize by domain (`commands/track.ts`, `commands/sync.ts`, …) or merge and extract
shared helpers. The core library modules (config, ref, hash, paths, stat-cache,
gitignore, compress, template, transfer) have clean boundaries and are the strongest
part of the codebase.

## Findings

Severity: **Blocker** (data loss / security / core promise broken), **High** (real-world
failure or goal violation), **Medium** (correctness/UX defect), **Low** (polish).
IDs are stable for tracking.
`file:line` references are to head `c2830b1`.

Counts (checkable against the sections below):

| Severity | Count | IDs |
| --- | --- | --- |
| Blocker | 6 | DS-01, DS-02, DS-03, DS-04, HK-01, BE-03 |
| High | 20 | BE-01, BE-02, BE-04, BE-05, BE-06, SEC-02, SEC-03, HK-03, HK-04, LIB-01, LIB-02, CLI-01, CLI-02, TEST-01, DX-01, TEST-03, TEST-04, TEST-05, DOCS-01, DOCS-02 |
| Medium | 21 | SEC-01, CFG-01, CFG-02, CFG-03, HK-02, CLI-03, CLI-04, CLI-05, CLI-06, CLI-07, BE-07, BE-08, BE-09, LIB-03, TEST-02, TEST-06, TEST-07, TEST-08, DOCS-03, DOCS-04, DOCS-05 |
| Low | 15 | L-01 … L-15 |

Total: 62. (v1 had 58 = 7/16/20/15; v2 adds SEC-02, SEC-03, HK-03, HK-04, promotes BE-03
to Blocker, and demotes CLI-01 to High and SEC-01 to Medium — rationale inline.)

### Blockers

**DS-01 — `sync` silently reverts other users’ changes; stat cache is write-only.**
`packages/blobsy/src/commands-stage2.ts:435-498`,
`packages/blobsy/src/stat-cache.ts:27,91`. `readCacheEntry`/`getMergeBase` have zero
callers outside stat-cache.ts; the three-way merge decision table
(blobsy-stat-cache-design.md:376-453) is unimplemented.
When a local file exists, `remote_key` is set, and local hash ≠ ref hash, `handleSync`
unconditionally re-hashes, rewrites the `.bref`, and pushes local content.
Failure: user A updates a file, pushes, commits; user B runs `git pull` then
`blobsy sync` — B’s stale local copy silently overwrites A’s update in both the `.bref`
and (for path-keyed templates) the remote.
Additionally, sync only ever pulls when the local file is *missing*, so updated content
is never pulled onto machines that have an older copy — the most common team workflow is
broken in the unsafe direction.
**Fix:** Implement the designed per-file logic: consult the stat-cache merge base;
local==base && ref!=base → pull; local!=base && ref==base → push; both differ → conflict
error (exit 2) with explicit `push`/`pull` resolution guidance; no base and local!=ref →
ambiguity error as designed.
This is the single highest-priority fix (land TEST-04’s stat-cache tests first).

**DS-02 — `pull` destroys local modifications without `--force`.**
`packages/blobsy/src/commands-stage2.ts:335-345`. Without `--force`, a local file whose
hash differs from the ref is not skipped and not refused — it falls through to
`pullFile`, which atomically renames the download over the modified file.
The design mandates refusal with exit code 2 (blobsy-design.md:1773-1776). `--force`
currently only re-downloads up-to-date files — inverted semantics.
Exit code 2 is unused anywhere in the implementation.
**Fix:** Without `--force`: if local exists and hash ≠ ref hash, refuse with exit 2 and
a “local file modified; use --force to overwrite” error.
With `--force`: overwrite.

**DS-03 — `push` uploads modified content under a stale hash, poisoning the remote.**
`packages/blobsy/src/transfer.ts:191-244`,
`packages/blobsy/src/commands-stage2.ts:224-242`. Neither `handlePush` nor `pushFile`
verifies that the local file still matches `ref.hash` before upload (the design’s push
sanity check, blobsy-design.md:1768-1771). Failure: `track` → edit file → `push` uploads
the *new* bytes to a key derived from the *old* hash, and the `.bref` keeps the old
hash. Every subsequent `pull` of that ref downloads the blob, hash-verifies it against
the stale hash, and fails — for everyone, permanently, until a force re-push.
Also breaks the CAS invariant (key claims a sha256 the content doesn’t have).
Separately, a file with `remote_key` set whose local content was modified is silently
skipped as “already pushed”.
**Fix:** In push, hash the local file first; on mismatch fail with the designed
three-option error (`track` / `pull --force` / `push --force`). Report modified-but-
already-pushed files instead of skipping silently.

**DS-04 — Remote deletion is unsafe by design; the prompt/`--quiet` interaction makes it
worse.** `packages/blobsy/src/cli.ts:1420-1467`. Two layered problems, and v1
mis-identified which one is the blocker.
*(a) Acute:* the design commits to “No command ever prompts”
(blobsy-design.md:2965-2978), yet `rm --remote` opens a readline prompt — and the guard
is `if (!force && !globalOpts.quiet)`, so `blobsy rm --remote --quiet` (the natural
agent/script invocation) permanently deletes the remote blob with no confirmation.
`--quiet` must never imply consent.
*(b) Structural — the actual blocker:* a `.bref` is a durable pointer in git history.
Deleting the object because one working-tree ref was removed can break an older commit
or tag that still references the key, another branch, another current `.bref` sharing a
CAS key, another clone or repo sharing the backend, or an in-flight operation.
Confirmation — including `--force` — establishes *intent*, not *reachability*; no flag
makes this deletion safe.
The design doc itself says normal `rm` leaves remote blobs untouched and defers
reclamation to a GC that scans reachable branches and tags
(blobsy-design.md:1439-1452,1514-1519,3099-3110). **Fix:** Remove or hide `rm --remote`
for alpha. Remote reclamation belongs to the deferred reachability-aware GC design
(retention/age policy, dry-run output, branch/tag scanning, race handling — ideally atop
bucket versioning for a recovery window).
If manual deletion stays as emergency plumbing: require `--force`, label it
history-breaking in help text, and never branch safety behavior on `--quiet`. Align
README/design wording as part of DOCS-06.

**HK-01 — Pre-push hook swallows upload failures and lets `git push` proceed.**
`packages/blobsy/src/commands-stage2.ts:1648-1685`. `handlePrePushHook` ignores
`result.success === false`, prints “all blobs uploaded.”
unconditionally, and never sets a nonzero exit code — so the hook that exists to prevent
committed-ref-without-blob data loss (the design’s “Prevention (Primary)” layer)
approves the push on network failure, missing credentials, or any backend error.
Collaborators then hit “missing (no remote!)”. **Fix:** Collect failures, print each
with its error, set `process.exitCode = 1` when any push fails so git aborts the push.

**BE-03 — `LocalBackend` path traversal via `remote_key`.**
`packages/blobsy/src/backend-local.ts:27,54,120,125`. `join(this.remoteDir, remoteKey)`
with a `.bref`-supplied `remote_key` like `../../…` escapes the backend directory for
read, write, and delete (`rm --remote` reaches `delete`). `.bref` files arrive via git
from other users — this is attacker-influenceable input reaching filesystem write and
delete outside the configured boundary.
*(v2: promoted High → Blocker per the document’s own taxonomy — security across a trust
boundary.)* **Fix:** Resolve and verify containment (`resolve(remoteDir, key)` must
start with `resolve(remoteDir) + sep`); reject otherwise.
Validate `remote_key` shape at `readBref` time for all backends.

### High

**BE-01 — 60-second hard timeout kills large transfers.**
`packages/blobsy/src/backend-aws-cli.ts:129`, `backend-rclone.ts:153`,
`backend-command.ts:23,276`. Every external-tool push/pull is run with `timeout: 60000`.
A 500 MB upload (the design doc’s own example) exceeds 60s on most residential uplinks;
the transfer is killed with an opaque error.
For a tool whose purpose is large files this makes the aws-cli/rclone/command paths
unusable in practice.
**Fix:** Remove the timeout for transfers (keep short timeouts for `--version` probes
and exists checks) or make it size-aware/configurable (`sync.timeout`, default off).

**BE-02 — All transfers are fully sequential; `sync.parallel` is dead config; blocking
`execFileSync` would defeat concurrency anyway.**
`packages/blobsy/src/commands-stage2.ts:224-253,325-353,435-498` (sequential loops);
`backend-aws-cli.ts:127`, `backend-rclone.ts:151`, `backend-command.ts:274`
(`execFileSync` blocks the event loop).
The design promises a concurrency pool of `sync.parallel` (default 8,
blobsy-design.md:1739-1754); the config key exists and does nothing.
Additionally each `pushFile`/`pullFile` call re-runs `resolveBackend` + `createBackend`
\+ tool detection (`aws --version` / `rclone version` subprocesses) per file — O(N)
process spawns before any transfer starts.
**Fix:** Switch backends to async `execFile`/`spawn`; create the backend once per
command; add a simple promise pool honoring `sync.parallel`. Or, for a smaller alpha:
delete the `sync.parallel` config key and document transfers as sequential — but the
per-file backend/tool re-detection should be fixed regardless.

**BE-04 — Built-in S3 backend buffers entire files in memory, and streaming alone still
cannot exceed the 5 GB single-PUT limit.** `packages/blobsy/src/backend-s3.ts:66-91`
(push `readFile`), `:117-120` (pull chunk accumulation + `Buffer.concat` — ~2× file
size).
Multi-GB files OOM the default Node heap, and this is the fallback backend when no
CLI tool is installed — the lowest-friction path for new users.
Swapping `readFile` for `createReadStream` fixes heap use but merely moves the failure:
a single `PutObject` PUT is capped at 5 GB (AWS-documented), so a large-file tool needs
multipart. **Fix:** Use `@aws-sdk/lib-storage`’s `Upload` for uploads (streaming
multipart with abort/cleanup and configurable part concurrency) and
`pipeline(response.Body, createWriteStream(tmp))` for pulls.
Test multipart via a small forced part-size threshold, plus interrupted-upload cleanup.

**BE-05 — `CommandBackend.pull`: no `ensureDir`, temp file leaked on failure.**
`packages/blobsy/src/backend-command.ts:142-168`. Every other backend ensures the target
directory and cleans up its temp file on error; the command backend does neither — pulls
into a missing directory fail with a bare rename ENOENT, and failed pulls accumulate
`.blobsy-cmd-*` litter.
**Fix:** Mirror the other backends’ `ensureDir` + try/finally-unlink pattern.

**BE-06 — `{relative_path}` template variable documented but always empty.**
`packages/blobsy/src/backend-command.ts:135,151,177`;
blobsy-backend-and-transport-design.md:390. All three call sites hardcode
`relative_path: ''`, so command templates using it silently target wrong paths.
**Fix:** Thread the repo-relative path through `Backend.push/pull/exists`, or remove the
variable from docs and `KNOWN_TEMPLATE_VARS` and error if used.

**SEC-02 — User-supplied working-tree paths are not contained to the repository.** *(new
in v2)* `packages/blobsy/src/paths.ts:86-88` (`resolveFilePath` is a bare `resolve()`),
`commands-stage2.ts:85-114` (`resolveTrackedFiles`), consumed by every path-taking
handler (`cli.ts:735-742,1243-1252,1356-1370,1543-1544` among others).
Absolute and `../` paths are accepted, and `toRepoRelative()` (paths.ts:34) happily
returns `../`-prefixed “relative” paths.
Consequences: `track`/`add` create `.bref` and `.gitignore` files outside the
repository; `untrack`/`rm` mutate or delete files outside the repository — composing
badly with CLI-05, which deletes before checking for a `.bref`; `mv` moves payloads
across the repository boundary; push/pull/status resolve explicit external paths.
For an agent-driven CLI, “the caller supplied the path” is not a safety boundary —
agents assemble paths.
**Fix:** One central `resolveRepoPath()` used by every path-taking command: reject any
resolved path outside `repoRoot` (compare with a separator suffix, cf.
CFG-01), define a symlink policy via `realpath` for existing sources, and test absolute,
`../`, symlink-out, missing-destination, and linked-worktree cases.

**SEC-03 — The command backend executes repository-controlled commands with no trust
gate.** *(new in v2)* `packages/blobsy/src/backend-command.ts:120-205,211-281`. A
committed `.blobsy.yml` selects the executable and arguments for push/pull/exists.
The token allowlist prevents shell-metacharacter injection — good — but not the choice
of `node`, `python`, `sh -c`, `curl`, or any other program.
Hooks, `sync`, and `doctor` run backends automatically, so “clone, then an agent runs
setup/sync” can execute repository-supplied commands.
This may be an intentional “configuration is code” stance, but it is a code-execution
trust boundary the design never states, and it is material precisely because of the
agent-skill goal (#1): agents are told to run these commands.
**Fix:** Write the threat model (design weakness 7). Require command backends to be
authorized outside the repo — a user-global allowlist in `~/.blobsy.yml` or an explicit
`blobsy trust` step — before execution; never auto-execute an untrusted command backend
from hooks; test the trust decision.

**HK-03 — Hook install/uninstall can overwrite or delete user-owned hooks.** *(new in
v2)* `packages/blobsy/src/commands-stage2.ts:1349-1361,1472-1501`; `cli.ts:699-716`.
`blobsy hooks install` writes `pre-commit`/`pre-push` with **no existence check at all**
(installHook writes unconditionally).
The init/setup installer preserves an existing hook only when it does *not* contain the
substring `blobsy` — a user’s multi-command hook that merely calls blobsy is rewritten
wholesale. Uninstall deletes any hook file containing the substring.
Net effect: a user’s tests, linters, secret scanning, or signing can be silently removed
from their hooks by the default onboarding path (`setup --auto` installs hooks
automatically, and per CLI-01, `--no-hooks` does not opt out).
Direct violation of goal #3, “normal git workflows keep working.”
**Fix:** Consolidate the installers (HK-02) around explicit ownership: an exact managed
marker; only rewrite or delete content matching the expected managed shape; refuse or
append-compose when a user-owned hook exists; back up before replacement; add mixed-hook
install/uninstall tests.

**HK-04 — Hook paths hardcode `.git/hooks`; broken in linked worktrees and with
`core.hooksPath`.** *(new in v2)* `packages/blobsy/src/cli.ts:684`;
`commands-stage2.ts:1350,1370,1495`. In a linked worktree `.git` is a file, so
`ensureDir(<root>/.git/hooks)` fails with ENOTDIR and doctor inspects a nonexistent
directory; a repo- or user-configured `core.hooksPath` is ignored entirely.
Worktrees are standard practice for coding agents — the primary audience.
**Fix:** Resolve the hooks directory via `git rev-parse --git-path hooks` in one shared
helper used by install, doctor, and uninstall; add a linked-worktree integration test.

**LIB-01 — Gitignore rewrite negation only reaches one directory level; nested `.bref`
files become invisible to git.** `packages/blobsy/src/gitignore.ts:275-278`. The comment
says the rewrite should emit `!data/**/` but the code emits `!${negationBase}*/` →
`!data/*/`. Git never descends into still-excluded deeper directories, so
`data/a/b/model.bin.bref` is not committable — collaborators never receive the ref,
which reads as data loss.
**Fix:** Emit `!${negationBase}**/` (match the comment); add a golden test tracking a
file two levels below a directory that was previously wholesale-gitignored.

**LIB-02 — Gitignore managed-block parsing corrupts files when markers are damaged.**
`packages/blobsy/src/gitignore.ts:55-76,90-100`. (a) `writeBlobsyBlock` finds
`BLOCK_END` searching from index 0, so an END before START garbles the file; (b) if END
is missing, everything after START is silently deleted on rewrite; (c) `readBlobsyBlock`
with a missing END treats all subsequent user lines as blobsy entries and will absorb
them into the managed block on next write.
Merge conflicts in `.gitignore` make damaged markers a realistic state.
**Fix:** Pair markers (search END from START’s index); if unpaired, warn and append a
fresh block rather than rewriting; never absorb lines outside a well-formed block.

**CLI-01 — `--no-hooks` does nothing; hooks are always installed.**
`packages/blobsy/src/cli.ts:137,146,671`. Commander maps `--no-hooks` to
`opts.hooks === false`, but the code checks `!opts.noHooks`, which is always true.
Both `setup --auto --no-hooks` and `init --no-hooks` install hooks anyway — surprising
in exactly the situations (hook managers, CI) where users opted out, and it composes
with HK-03: the flag users would reach for to protect their existing hooks is a no-op.
*(v2: reclassified Blocker → High per the taxonomy — a serious contract violation, but
not independently a data-loss path.)* **Fix:** Check `opts.hooks !== false`. Add a
golden test asserting no hook files exist after `--no-hooks`.

**CLI-02 — `sync --dry-run` and `pull --dry-run` misreport the plan.**
`packages/blobsy/src/commands-stage2.ts:408-417` (sync dry-run omits the
locally-modified→push case entirely, reporting “Everything up to date”); `:304-321`
(pull dry-run counts already-up-to-date files it would skip).
`--dry-run` is the primary trust mechanism for agents and scripts; it must match the
real plan — especially while DS-01/DS-02 make the real plan destructive.
**Fix:** Run the same per-file decision logic in dry-run mode and print its actions.

**TEST-01 — The golden suite does not run in CI, and six golden files have drifted.**
`packages/blobsy/vitest.config.ts` (includes only `tests/**/*.test.ts`),
`.github/workflows/ci.yml:48-53` (runs exactly one tryscript file, the rclone
lifecycle).
65 `.tryscript.md` golden tests — the testing design’s centerpiece (“All unit
tests (vitest) and golden tests (tryscript) run on every PR”,
blobsy-testing-design.md:1993) — never execute in CI, and drift has accumulated
invisibly: the default compression algorithm changed from gzip to zstd in `a1b3d06`
(2026-02-23) and six goldens still encode gzip-era output.
Verified at head `c2830b1` with a freshly built CLI (appendix, run G): **581 passed, 10
failed**. Drift failures: `commands/check-unpushed`, `commands/push-pull`,
`commands/status`, `workflows/branch-workflow`, `workflows/fresh-setup` — all expect
`(32 B)` for the 12-byte CSV fixture, which is the *gzip* size (zstd yields 21 B; both
measured, appendix run Z) — and `json/push-pull-json`, which expects
`"compressed": "gzip", "compressed_size": 32` outright.
Three more files (`commands/health`, `commands/sync`, `errors/partial-failure`) fail
only when the suite runs as root, where permission-revocation scenarios cannot fail — a
CI-wiring consideration (run non-root), not drift.
The suite is currently ornamental: it documents intended behavior without enforcing it,
and `--json` shape breaks for agents would ship silently.
**Fix:** Add a `test:golden` script running the full tryscript suite; re-record the six
stale files after confirming zstd output is intended; wire the script into ci.yml (both
Node lanes, non-root user) and the lefthook pre-push gate.
Consider normalizing byte sizes in transfer-output goldens (a `[SIZE]`-style
placeholder) so a future compression-library change doesn’t invalidate dozens of files
at once — `workflows/compression-algorithms.tryscript.md` already pins exact sizes where
that is the point of the test, and can stay exact.

**DX-01 — The test suite is not hermetic: it can silently test the wrong binary (false
green), and fails on fresh clones.** *(rewritten in v2 — the v1 framing understated it)*
`tests/hooks.test.ts`, `setup.test.ts`, `init.test.ts`, `commands/rm.test.ts`,
`errors/user-error.test.ts` spawn `blobsy` from `PATH` via execa, and the tryscript
goldens resolve `blobsy` from `PATH` too.
Only CI’s undocumented `pnpm link --global` step (ci.yml:40-42) makes that work — and
whatever the link currently points at is what gets tested.
Both failure modes verified in this environment (appendix, runs V1/V2): with a global
link on `PATH`, vitest passes 253/253 even when the linked shim is a stale build (the
shim here was stamped `0.1.0-dev.108.8bebb0a-dirty` while “verifying” head `c2830b1`);
with `blobsy` absent, 49 of 253 fail on spawn errors (the PR #4 counter-review measured
50 in its environment — the count is environment-dependent, which is itself the
finding). A false green is worse than a deterministic fresh-clone failure — and this
mechanism produced contradictory “verified at head” golden-suite claims in this review’s
own v1 *and* in the counter-review (see Corrections).
CLAUDE.md and docs/development.md say `pnpm install && pnpm build && pnpm test`, which
fails on a fresh clone today.
**Fix:** Resolve the CLI under test explicitly from the checkout (absolute path to
`packages/blobsy/dist/cli.mjs`) in both the vitest helpers and the tryscript goldens;
print the tested binary path and version stamp in harness output; delete the CI
global-link step.

**TEST-03 — False-pass tests mask regressions in the primary S3 backend.**
`packages/blobsy/tests/backend-s3.test.ts:87-98,101-111`. Two error-categorization tests
wrap the call in try/catch with assertions only inside `catch` and no
`expect.assertions()` — if the code under test stops throwing, the tests pass with zero
assertions executed.
**Fix:** `await expect(...).rejects.toThrow(BlobsyError)` (or `expect.assertions(n)`).
Also add push/pull tests: `backend-s3.test.ts` currently covers only
`exists`/`healthCheck`/error mapping, and `backend-aws-cli.ts` (173 lines, a primary S3
transfer path) has no test file at all.

**TEST-04 — Correctness-critical modules with zero unit tests.** `src/stat-cache.ts`
(112 lines — the component DS-01’s fix will depend on; the testing design lists 16
specific cases at blobsy-testing-design.md:1957-1976, none implemented),
`src/backend-aws-cli.ts` (see TEST-03), and `src/format.ts` (292 lines of pure,
trivially testable output functions).
**Fix:** Add `tests/stat-cache.test.ts` first — it is a prerequisite for landing DS-01
safely (and is ordered first in the alpha plan below); aws-cli and format tests follow.

**TEST-05 — `release.yml` publishes to npm without running tests.**
`.github/workflows/release.yml` builds and `pnpm -r publish`es with no test step
(publish.yml has one; both trigger on version tags).
**Fix:** Add `pnpm test` (and the golden suite once TEST-01 lands) before publish, or
consolidate the two workflows.

**DOCS-01 — The installed agent skill is a degraded third variant that omits the
recommended workflow.** `packages/blobsy/src/skill-text.ts` (what `blobsy setup --auto`
installs into `.claude/skills/blobsy/SKILL.md` and what `blobsy skill` prints) never
mentions `blobsy add` — the command README and SKILL.md call “recommended” — nor
`config`, nor `docs`. Three divergent skill texts exist (SKILL.md, skill-text.ts,
shipped npm docs). Given goal #1, the text agents actually receive is the one that
matters most, and it steers them to the low-level `track` flow without git staging.
Also: SKILL.md lacks frontmatter (`name`/`description`) per the project’s own
cli-agent-skill-patterns guideline, and is not shipped in the npm package
(`files: ["dist"]`). **Fix:** Single source of truth: make skill-text.ts import/embed
SKILL.md content at build time (a build step already copies docs); lead with `add`; add
frontmatter.

**DOCS-02 — README documents a 1 MB externalize default; the code ships 200 KB.**
`README.md:22,51,224-231` vs `packages/blobsy/src/config.ts:26` (`min_size: '200kb'`,
changed in commit d28a935). First-run behavior visibly contradicts the README — an
immediate trust breaker, and wrong input for agents.
**Fix:** Update README (four places).
Add a golden test that prints the default config and would catch future default drift.

### Medium

**SEC-01 — Prototype pollution via `blobsy config` keys (in-process only).**
`packages/blobsy/src/cli.ts:1963-2000` (`getNestedValue`/`setNestedValue`),
`packages/blobsy/src/config.ts:255` (`unsetNestedValue`). Key paths are split on `.` and
traversed with no filtering, so `blobsy config __proto__.x 1` walks into
`Object.prototype` and sets `x` there, polluting the running process.
*(v2 correction and reclassification, Blocker → Medium: v1 claimed the polluted
structure is serialized into `.blobsy.yml`; that is wrong and withdrawn — the
`__proto__` walk mutates the prototype, never creates an own property, and the YAML
output is unaffected.
The pollution is confined to a short-lived CLI process that writes config and exits,
with no demonstrated security-sensitive read afterward.
It becomes serious the day the CLI grows any long-lived mode.)* **Fix:** Reject
`__proto__`, `constructor`, and `prototype` as path segments in `setNestedValue`,
`getNestedValue`, and `unsetNestedValue`; validate keys against the known config schema
(see CFG-03); add regression tests for all three segments.

**CFG-01 — `startsWith` path containment bug.** `packages/blobsy/src/config.ts:142,198`.
`dir.startsWith(repoRootResolved)` without a separator: `/home/u/project-data` matches
repo root `/home/u/project`, so config discovery walks directories outside the repo.
**Fix:** `dir === root || dir.startsWith(root + sep)`.

**CFG-02 — Subdir config override silently discards intermediate values.**
`packages/blobsy/src/config.ts:110-120,371+`. Top-level keys are replaced wholesale, and
`getExternalizeConfig` falls back to *builtin* defaults — so a subdir setting only
`externalize.always` loses the repo root’s `min_size` and `never`. Combined with the
design-level concern above: either implement one-level-deep merge for
`externalize`/`compress`/`remote`/`sync`, or drop subdir configs for alpha.

**CFG-03 — No schema validation for `.blobsy.yml` or `.bref` YAML.**
`packages/blobsy/src/config.ts:99-101`, `ref.ts:50`. Parsed YAML is cast
(`as BlobsyConfig`) with only top-level type checks; `externalize.min_size: true`
surfaces later as a confusing `parseSize` error.
The project’s own typescript-yaml-handling-rules require Zod validation.
Also no merge-conflict-marker preflight on either file type (cryptic YAML errors after a
conflicted pull). **Fix:** Zod schemas for config and bref; conflict-marker check with a
clear error.

**HK-02 — Two divergent hook installers.** `packages/blobsy/src/cli.ts:676-722`
(init/setup path: shim runs bare `blobsy` from PATH, dynamic re-imports) vs
`commands-stage2.ts:1349-1362,1447-1450` (hooks install/doctor path: absolute
`detectBlobsyPath()`), different hook-list shapes.
Identical repos end up with different shims depending on which command installed them,
with different failure modes (PATH-less GUI clients vs moved binaries).
**Fix:** One shared hooks module; pick one shim strategy (bare name on PATH matches the
Git LFS precedent and the implementation-notes doc).
Fold the ownership fixes from HK-03 and the worktree-safe path resolution from HK-04
into the same consolidation.

**CLI-03 — `doctor` fire-and-forget async calls misreport results.**
`packages/blobsy/src/commands-stage2.ts:1202` (`void loadConfigFile(globalPath)` then
reports “valid”), `:1424` (`void chmod(...)` then reports “fixed”). A corrupt global
config or read-only hook is reported healthy/fixed; rejections become unhandled.
**Fix:** Await both; make the enclosing checks async.

**CLI-04 — `mv` overwrites an already-tracked destination and can’t cross filesystems.**
`packages/blobsy/src/cli.ts:1599-1674`. No check that `dest.bref` exists (silently
destroys the destination’s tracking metadata, leaving a dangling gitignore entry);
`rename()` throws raw `EXDEV` across mount points.
The design specifies a dest-exists check (blobsy-design.md:1557-1558). **Fix:** Refuse
when dest or dest.bref exists (offer `--force`); fall back to copy+unlink on EXDEV.

**CLI-05 — `rm --local` deletes files without checking they’re tracked.**
`packages/blobsy/src/cli.ts:1398-1411`. The `--local` branch runs before the `.bref`
existence check and unconditionally unlinks — `blobsy rm --local somefile` deletes an
untracked file (unrecoverable; blobsy has no copy anywhere).
Composes with SEC-02: the path is not even confined to the repository.
**Fix:** Require a `.bref` before any `rm` variant touches the payload.

**CLI-06 — `sync` prints nothing for failed modified-file pushes.**
`packages/blobsy/src/commands-stage2.ts:491-493`. `errors++` with no message; user sees
only “…, 1 errors.” (contrast with the new-file path at :452-455). **Fix:** Print the
failure with path and error, as the other branch does.

**CLI-07 — Overlapping commands (see design assessment).** `check-unpushed` vs
`pre-push-check` (same question, one adds blame/one adds exit codes), `health` vs
`doctor`, `readme`/`docs`/`skill`, `setup`/`init`, `add`/`track`. Consolidate per the
table above; each merge shrinks help text, docs, skill text, and golden surface.

**BE-07 — Built-in S3 health check requires write permission and can strand objects.**
`packages/blobsy/src/backend-s3.ts:182-201`. Put+delete probe: read-only credentials
(common for CI pull-only) fail the health check that `sync` runs by default; a failed
delete strands `.blobsy-health-check-*` objects.
AwsCliBackend correctly uses `head-bucket`, and the design specifies
HeadBucket/ListObjectsV2. **Fix:** HeadBucket (or ListObjectsV2 MaxKeys=1); if a write
probe is ever needed, make it opt-in.

**BE-08 — Command backend assembles `{remote}` as `/key` when no bucket configured.**
`packages/blobsy/src/backend-command.ts:134,150,176`. Leading slash corrupts user
command paths. **Fix:** Omit the separator when bucket is empty.

**BE-09 — Backend inconsistencies.** LocalBackend push is a direct `copyFile` (partial
blob on interrupt) while the design specifies temp+rename
(blobsy-backend-and-transport-design.md:597-603) — and `transfer.ts:320` delegates
uncompressed-pull atomicity entirely to the backend rather than enforcing
temp+verify+rename at the coordinator.
S3 `exists()` misses `NoSuchBucket`/404-status signals (`backend-s3.ts:173-179`).
`which` in the command-backend health check breaks on Windows
(`backend-command.ts:200`), and the probed binary is extracted from the raw template so
`$TOOL`-style templates probe a literal `$TOOL` (`:194-196`). **Fix:** Atomic local
push; enforce pull atomicity in `transfer.ts`; broaden not-found detection; use
platform-aware lookup on the *expanded* argv[0].

**LIB-03 — `template.ts` warns to stderr regardless of `--json`/`--quiet`.**
`packages/blobsy/src/template.ts:75`. Unknown template variables emit unstructured
stderr into machine-parsed output streams.
**Fix:** For alpha, make unknown variables a hard `ValidationError` (simpler and safer
than warn-and-continue with a literal `{var}` in the remote key — which is also what the
design says should happen only for the deferred `{git_branch}`).

**TEST-02 — Dead test infrastructure.** `packages/blobsy/package.json` `test:e2e` +
`vitest.e2e.config.ts` reference `tests/e2e/**` which does not exist; root
`compile-template` script references a missing `admin/` directory (template leftover).
**Fix:** Delete both, or create the e2e directory when real S3 e2e tests land.

**TEST-06 — Promised error golden tests are missing.** The testing design specifies
auth-errors, permission-errors, and network-errors golden tests with full expected
output (blobsy-testing-design.md:298-301); none exist.
Only validation, not-found, conflict, and partial-failure error tests are implemented —
cloud/credential failure UX has zero coverage.
The echo/command backend can simulate these without credentials.

**TEST-07 — Fragile interactive tests in `rm.test.ts`.**
`tests/commands/rm.test.ts:158,203,244` race a fixed 100 ms `setTimeout` against the
confirmation prompt before writing stdin (flaky on slow CI); `:87-89,127-130` return
early when push didn’t set `remote_key`, silently passing without testing remote
deletion at all. **Fix:** Wait for the prompt text on stdout; replace early returns with
`expect(bref.remote_key).toBeDefined()`. (Note both blocks are obsolete when DS-04
removes `rm --remote` from the alpha surface.)

**TEST-08 — Test tooling/metadata drift.** The golden coverage matrix
(`docs/project/specs/active/golden-test-coverage-matrix.md`) claims 49 files vs 65 on
disk and references a nonexistent `prime` test; `check-golden-coverage.sh` currently
exits 1 (flags the bare `...` elisions in `readme`/`docs` tryscripts) and is not run in
CI; the vitest+tryscript coverage merge described at blobsy-testing-design.md:117-121 is
unwired; the testing design’s paths (`tests/unit/`, `tests/golden/tryscript.config.ts`)
don’t match the actual layout.
**Fix:** Regenerate the matrix (or automate it from the file listing), fix the `...`
elisions, then add the coverage script to CI; update the testing-design paths.

**DOCS-03 — Hooks documented three contradictory ways.** README.md:250-251 and the
implementation agree (pre-commit verifies, pre-push uploads); blobsy-design.md:2510-2515
and blobsy-implementation-notes.md:99-141 both describe pre-commit *pushing*. Fix the
two design docs.

**DOCS-04 — QA playbook drift.** `testing/qa/blobsy-end-to-end.qa.md` instructs manual
backend-dir creation (auto-created since `cli.ts:600-606`), uses nonexistent
`track --force` / `sync --force` flags (:981,1015,1018), and expects a top-level
`backend: default` key that `init` does not generate (:268 — design doc shows it too;
either generate it or update both docs).

**DOCS-05 — Spec hygiene.** 6+ of 11 files in `docs/project/specs/active/` are marked
Complete/Implemented — move them to an archive so “active” means active.
The review history (rounds 1–6) plus `issues-history.md` are good practice; keep that
pattern by resolving this round the same way.

### Low

- **L-01** Trash entries flatten paths with a `Date.now()` suffix (`cli.ts:1297,1420`)
  vs the design’s path-preserving layout (blobsy-design.md:1439-1447); same-ms
  collisions overwrite.
  Preserve relative paths under `.blobsy/trash/`.
- **L-02** `--json` declared both globally and on `status`/`verify`/`doctor`, papered
  over with `Boolean(opts.json) || globalOpts.json`. Keep the global only.
- **L-03** `coerceConfigValue` uses `Number()`: `0x10` → 16, `Infinity` → Infinity.
  Use a strict decimal regex.
- **L-04** Duplicated status rendering between `handleStatus` and `handleDoctor`;
  `relBref` misnomer + no-op `.replace()` in `handleMvDirectory` (`cli.ts:1589-1590`).
- **L-05** Deprecated wrappers `localPush`/`localPull`/`localBlobExists`/
  `localHealthCheck` (`backend-local.ts:162-193`) — update tests, delete.
- **L-06** ~75 lines of near-identical `exec` logic in AwsCliBackend and RcloneBackend —
  extract a shared `execBackendTool` helper.
- **L-07** Dynamic `await import()` of already-imported modules
  (`cli.ts:697,1305,1499,1635`; `commands-stage2.ts:1359`) against project TS rules.
- **L-08** `marked.use()` mutates global state per call; double `as unknown as` cast
  (`markdown-output.ts:33,37`).
- **L-09** `sanitizeKeyComponent` strips leading dots per segment → `.hidden.csv` and
  `hidden.csv` collide on remote keys (`template.ts:43-44`). Document or encode.
- **L-10** `findTrackableFiles` silently skips all dotfiles (`paths.ts:131`) —
  intentional but undocumented; `filterFilesForExternalization` (`externalize.ts:46-55`)
  is production-dead code with subtly different (no `dot:true`) matching — remove or
  align.
- **L-11** Dual error hierarchies (`BlobsyError` with category/suggestions vs
  `UserError` with hint/format, `types.ts:173-231`) — unify on one before the API is
  public.
- **L-12** S3 prefix/key concatenation relies on an undocumented trailing-slash
  invariant from `parseBackendUrl` (`backend-s3.ts:56-58` and mirrors) — normalize in
  constructors.
- **L-13** `CommandBackend.exists` returns `false` when `exists_command` is unset —
  every push re-uploads with no explanation.
  Log why, once.
- **L-14** README omits the `--color` global option and any Node version prerequisite
  (engines say >=22.15).
- **L-15** Missing docstrings on major exported functions (`handlePush`, `handleSync`,
  `resolveTrackedFiles`, `computeFileStates`, …) per project TS rules.

## Testing and CI Assessment

**The two-layer strategy is right and the infrastructure is good; the problem is
under-wiring, not over-engineering.** The tryscript golden approach (sandboxed markdown
scripts, pattern placeholders, a 91-line echo backend, local-backend integration) is
lightweight, readable, and proportionate.
Unit test quality is generally solid where tests exist (`backend-command`,
`backend-local`, `hash`, `ref-parser`, `config`, `transfer` test behavior, not
implementation).
The pieces simply aren’t connected: 65 golden files and a coverage-check
script exist, CI runs one of them (TEST-01), and the harness can’t prove which binary it
tested (DX-01) — with measurable drift already accumulated as a result.

Test presence by module (unit tests; golden coverage exists for nearly all CLI behavior
but is unenforced until TEST-01 lands).
This is a *test-presence* observation, not measured coverage: overall vitest coverage at
head is **24.2% lines / 21.5% branches** (CI coverage report; the golden suite is
excluded from that figure, so it understates end-to-end coverage — another reason to
land the TEST-01 wiring and the coverage merge described in the testing design):

| Area | State |
| --- | --- |
| Substantive unit tests present | `config`, `transfer`, `backend-command`, `backend-local`, `backend-url`, `gitignore`, `paths`, `ref`, `template`, `compress`, `externalize`, `hash` |
| Partial | `cli.ts` (init/setup/hooks/rm via integration), `backend-s3` (exists/health only, with false-pass bugs — TEST-03), `backend-rclone` (heavily mocked), `types` |
| Zero unit tests | `commands-stage2.ts` (1,703 lines: push/pull/sync/doctor — golden tests cover it once enforced), `stat-cache.ts` (TEST-04), `backend-aws-cli.ts` (TEST-04), `format.ts` (TEST-04) |

**Biggest coverage hole vs.
the blockers:** there is no test — unit or golden — for the two-user desync scenario at
the heart of DS-01 (`two-user-conflict.tryscript.md` is a single user force-pushing and
re-pulling), none for pull-refuses-modified (DS-02), none for push-hash-mismatch
(DS-03), and none asserting the pre-push hook fails on upload error (HK-01). The blocker
fixes should each land with a golden test reproducing the scenario; the local backend
makes all four testable without credentials.

**Priority order (test work only):** make the harness hermetic (DX-01 — nothing else can
be trusted until the tested binary is provable) → wire the golden suite into CI and
re-record the six stale files (TEST-01) → fix S3 false-pass tests and add S3/aws-cli
push-pull tests (TEST-03) → write `stat-cache.test.ts` ahead of the DS-01 fix (TEST-04)
→ add the missing error-scenario goldens (TEST-06) → add tests to release.yml (TEST-05).
Defer past alpha: coverage merge, `format.ts` unit tests (golden covers it), binary
fixture, matrix regeneration automation.

## Documentation Actions (summary)

Action IDs (not severity-scored findings, but stable for tracking):

1. **DOCS-01** Single-source the skill text; lead with `add`; add frontmatter.
2. **DOCS-02** Fix README threshold; **DOCS-03** hooks contradictions; **DOCS-04** QA
   playbook.
3. **DOCS-06** Design-doc alignment: split V2/deferred material out of blobsy-design.md;
   fix the determinism-principle wording (weakness 1); state the immutability invariant
   (weakness 6); fix the `az://`→`azure://` scheme reference; align `rm --remote`
   documentation with the DS-04 decision.
4. **DOCS-07** Git LFS migration guide.
   **DOCS-08** “Joining an existing blobsy repo” guide plus recovery drills —
   clone/pull, stale-local conflict, remote corruption, credential failure, interrupted
   transfer, rollback to an older commit — exercised in the QA playbook before broad
   migration guidance is written.
   **DOCS-09** Copy-paste GitHub Actions example.
5. **DOCS-05** Archive completed specs out of `specs/active/`.

## Alpha-Exit Matrix

Gate = must land before alpha.
Everything not listed as a gate item explicitly trails into or past alpha.
Order within the table is the recommended execution order (prerequisites first).

| # | Item | Gate | Acceptance test |
| --- | --- | --- | --- |
| 1 | DX-01 hermetic harness | Yes | Fresh clone: `pnpm install && pnpm build && pnpm test` green with no global link; harness prints tested binary path+version |
| 2 | TEST-01 golden suite in CI | Yes | Full tryscript suite green in both Node lanes (non-root) after six re-records |
| 3 | TEST-04 stat-cache tests | Yes | The 16 designed cases implemented and green (prerequisite for DS-01) |
| 4 | DS-01 three-way sync | Yes | Two-user desync golden: stale copy never overwrites newer push; conflict exits 2 |
| 5 | DS-02 pull refuses modified | Yes | Golden: modified local + pull → exit 2; `--force` overwrites |
| 6 | DS-03 push hash sanity | Yes | Golden: tracked-then-edited file → push refused with three-option error |
| 7 | HK-01 pre-push hook honesty | Yes | Golden: failed upload → nonzero hook exit; `git push` aborted |
| 8 | DS-04 remove/hide `rm --remote` | Yes | No prompt anywhere; remote deletion absent from alpha surface (or `--force`-only, labeled history-breaking) |
| 9 | BE-03 remote_key containment | Yes | Traversal key rejected in unit + golden test |
| 10 | SEC-02 repo path containment | Yes | Absolute/`../`/symlink-out paths rejected in every path-taking command |
| 11 | HK-03 hook ownership | Yes | Mixed user hook preserved on install and uninstall (test) |
| 12 | SEC-03 command-backend trust | Yes | Threat model in design docs; command backend requires user-level grant; hooks never auto-execute untrusted backends |
| 13 | CLI-01 `--no-hooks` honored | Yes | Golden: no hook files after `setup --auto --no-hooks` |
| 14 | LIB-01 nested `.bref` gitignore | Yes | Golden: `.bref` two levels below an ignored dir is committable |
| 15 | CLI-02 truthful dry-run | Yes | Dry-run output matches real plan in sync/pull goldens |
| 16 | TEST-03 S3 false-pass tests | Yes | Error tests fail when code stops throwing |
| 17 | TEST-05 tests before publish | Yes | release.yml runs unit + golden suites |
| 18 | BE-01 transfer timeout | Yes | 500 MB local-backend transfer completes; no 60 s kill on transfer paths |
| 19 | BE-04 streaming + multipart S3 | Yes | Forced-multipart small-threshold test; interrupted-upload cleanup test |
| 20 | BE-02 parallelism decision | Yes | Either async pool honoring `sync.parallel`, or the config key deleted and docs updated (decision itself closes the gate) |
| 21 | DOCS-01 single skill text | Yes | One source; installed skill leads with `add` |
| 22 | DOCS-02 README defaults | Yes | README matches shipped 200 KB default; default-config golden added |
| — | HK-04, LIB-02, BE-05–BE-09, SEC-01, CFG-01–03, HK-02, CLI-03–07, LIB-03, TEST-02/06/07/08, DOCS-03–09, L-01–L-15 | No | Trail into alpha (HK-04 and LIB-02 first — HK-04 is cheap and worktrees are the agent norm); command consolidation and the simplification pass are strongly recommended pre-beta |

## Suggested Order of Work for Alpha

1. **CI trust first:** DX-01 (hermetic harness — later verification depends on it),
   TEST-01 (golden suite in CI + six re-records), TEST-03, TEST-05.
2. **Data safety:** TEST-04 (stat-cache tests, the DS-01 prerequisite), then DS-01,
   DS-02, DS-03, HK-01, DS-04 (remove/hide `rm --remote`), BE-03, CLI-01, CLI-02 — each
   landing with a golden test reproducing its scenario (the local backend makes all of
   them testable without credentials).
3. **Trust boundaries:** SEC-02 (repo path containment), HK-03 (hook ownership), SEC-03
   (threat model + command-backend trust gate).
4. **Real-world transfer viability:** BE-01 (timeout), BE-04 (streaming multipart S3),
   BE-02 (async exec + backend reuse; decide on parallelism vs deleting
   `sync.parallel`).
5. **Correctness cleanup (trails into alpha):** HK-04, LIB-02, BE-05..BE-09, CFG-01..03,
   HK-02, CLI-03..06, SEC-01.
6. **Simplification pass:** command consolidation (CLI-07 + design table), cli.ts
   reorganization, config-hierarchy reduction decision, error-class unification.
7. **Docs alignment:** documentation actions above.

Items 1–4 are the alpha gate (the matrix above is the authoritative list); 5 can trail
into alpha; 6–7 determine whether the alpha *feels* like the design’s promise: one
primitive, one obvious workflow, minimal complexity.

## Corrections from v1 (and counter-review claims not adopted)

This section exists so the document’s own error history is auditable (counter-review
finding R11).

**Withdrawn from v1:**

- SEC-01’s claim that the prototype-polluted structure “is serialized into
  `.blobsy.yml`.” Verified false: the `__proto__` walk mutates `Object.prototype`
  in-process and never creates an own property; YAML output is unaffected.
  Severity Blocker → Medium accordingly.

**Corrected from v1:**

- TEST-01’s evidence. v1 cited a single-file partial run (“13/14”) executed through a
  non-hermetically resolved binary — exactly the DX-01 failure mode.
  Replaced with a full-suite, fresh-build, pinned-version run at head (appendix).
  The drift conclusion *stands* and is now stronger: **six** stale files, not five (v1
  missed `json/push-pull-json`, which pins `"compressed": "gzip"` outright), with the
  root cause identified (gzip→zstd default change in `a1b3d06`, 2026-02-23, never
  re-recorded because the suite doesn’t run in CI).
- DX-01’s failure count (49) is environment-specific, not a stable fact; reframed around
  the hermeticity/false-green mechanism per the counter-review.
- BE-03 promoted to Blocker, CLI-01 demoted to High, DS-04 re-centered on reachability
  (counter-review R9/R1) — the severity taxonomy is now applied consistently.
- Command-consolidation arithmetic: 22 → **14** public commands (13 with `sync`
  deferred), not “~13”; the final list no longer double-counts `track`.
- The PR description’s “12 High” count was wrong at v1 (16) and is updated for v2 (20).

**Counter-review claims checked and not adopted:**

- *“All 65 golden files pass at head `c2830b1`; the five 32 B files are not stale”*
  (R2). Not reproducible against a verified fresh build at that exact head: the full
  suite yields 581 passed / 10 failed (appendix run G), and on any Node ≥ 22.15 this
  source compresses the CSV fixture with zstd (21 B measured), while those goldens
  record gzip output (32 B measured; `push-pull-json` names gzip explicitly) — a default
  that changed five months before this review.
  An all-pass run therefore exercised a gzip-era binary, which is the DX-01 false-green
  mechanism biting a second reviewer.
  The counter-review’s *systemic* point — that non-hermetic resolution invalidates naive
  golden evidence, v1’s included — is correct and adopted throughout.
- *“50 vitest failures with a sanitized PATH, not 49.”* This environment measures 49
  (appendix run V2). The number is environment-dependent; both counts are consistent
  with the finding and neither is canonical.
  DX-01 now says so instead of asserting either number.

## Reproducibility Appendix

**Revisions reviewed:** base `main` @ `8bebb0a5a6a77458b6d3264b8beabd4aeaad3954`; head
`c2830b128a97ab3fc38b9a2c986a373585f595cb` (PR #4). All measured claims re-verified at
head with a freshly built CLI, version stamp `0.1.0-dev.111.c2830b1`.

**Environment:** Linux container, **run as root** (caveat below); Node v22.22.2; pnpm
10.29.3; vitest 4.0.18; tryscript 0.1.7.

**Runs:**

| Run | Command | Result |
| --- | --- | --- |
| B | `pnpm install && pnpm build` | OK (build 3.6 s) |
| V1 | `vitest run` with `blobsy` resolvable on PATH via pnpm global link | 253/253 pass — **untrusted**: the linked shim carried stamp `0.1.0-dev.108.8bebb0a-dirty` (stale build) at the time, and the suite passed anyway |
| V2 | `vitest run` with `blobsy` absent from PATH | 204 passed, 49 failed (5 files, spawn errors) |
| G | fresh `pnpm build`, then `tryscript run tests/golden/**/*.tryscript.md` with the checkout build first on PATH (verified via `blobsy --version` → `0.1.0-dev.111.c2830b1`) | **581 passed, 10 failed** across 9 files — drift: `commands/check-unpushed`, `commands/push-pull`, `commands/status`, `json/push-pull-json`, `workflows/branch-workflow`, `workflows/fresh-setup`; root-only: `commands/health`, `commands/sync`, `errors/partial-failure` |
| Z | `node -e` with `node:zlib` on the 12-byte fixture content (`"second file\n"`) | gzip = **32 B**, zstd = **21 B**, brotli = 16 B — matching the stale goldens (32), current output (21), and `compression-algorithms.tryscript.md`’s brotli case (16) respectively |

**Root caveat:** permission-revocation scenarios (`chmod -w` directories) cannot fail
for root, so the three “root-only” golden failures above are an artifact of this
environment, not drift — and a reason TEST-01’s CI wiring must run as a non-root user
(GitHub-hosted runners do).

**CI state at head `c2830b1`:** GitHub Actions `test (22)` ✓, `test (24)` ✓, Cursor
Bugbot ✓, DeepSource (secrets) ✓; coverage comment: 24.17% lines / 21.54% branches
(vitest only).
Green CI does not validate this document’s behavioral claims — the PR diff
is documentation-only.
