# Blobsy Design and Implementation Review — Round 7 (Alpha Readiness)

**Status:** Active review — findings to be addressed

**Date:** 2026-07-27

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

**Method:** Full read of all five current design docs; exhaustive line-by-line review of
all 26 source files by focus area (CLI commands, core library, backends, tests/CI,
docs/onboarding); fresh-clone build/test run; cross-checking every doc claim against
code. Every finding below was verified against the actual source before being recorded.

## Verdict

**Not alpha-ready yet — but close, because the architecture is right.**

The core design is genuinely good: one file, one `.bref`, one blob; git is the manifest;
the remote is a dumb blob store.
That model is simpler than Git LFS and DVC and is the correct foundation.
Most of the implementation is competent and the golden-test infrastructure is unusually
good for a project at this stage.

What blocks alpha is that **the safety layers the design promises are not actually wired
in**. The stat cache is written but never read, so `sync` cannot detect payload-vs-ref
desync and will silently revert teammates’ changes.
`pull` overwrites local modifications without `--force`. `push` skips its designed hash
sanity check and can poison the remote.
The pre-push hook — the design’s primary data-loss prevention — swallows failures and
reports success. Each of these is a localized fix; none requires redesign.

The second theme is **drift**: three divergent versions of the agent skill text, a
README that documents a different externalize threshold than the code ships, hooks
described three different ways across three docs, 65 golden tests that never run in CI,
and a `pnpm test` that fails on a fresh clone.

The third theme is **complexity creep against goal #4**: 22 CLI commands (with several
overlapping pairs), a two-file CLI implementation split with no organizing principle, a
five-level config hierarchy with surprising replace-semantics, and a 3,400-line design
doc with V2 specifications interleaved into V1 sections.

Recommended path: fix the seven blockers, wire the golden suite into CI, consolidate the
command surface (~22 → ~13), and align the three skill-text variants.
That is a clean alpha.

## Design Assessment

### What the design gets right

- **The `.bref` primitive.** Adjacent pointer file + per-file gitignore entry + dumb
  remote is the simplest workable model in this space.
  It beats Git LFS (no server, no smudge/clean filters, no provider lock-in) and DVC (no
  Python dependency, no opaque cache, browsable remote).
  Git-native merges of `.bref` files are a real differentiator.
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

That yields ~13 public commands:
`setup add track untrack rm mv push pull sync status verify config doctor hooks docs` —
with `sync` optionally deferred (see above).
Each cut directly serves goal #4 and shrinks the skill text agents must absorb.

### Implementation structure

The `cli.ts` (2,017 lines) / `commands-stage2.ts` (1,703 lines) split has no organizing
principle: `track/add/untrack/rm/mv` live in cli.ts while `push/pull/sync/doctor/hooks`
live in commands-stage2.ts, everything is statically imported (no lazy-load benefit),
and the split has already caused real divergence — two hook installers with different
behavior (HK-02) and duplicated status rendering.
Reorganize by domain (`commands/track.ts`, `commands/sync.ts`, …) or merge and extract
shared helpers. The core library modules (config, ref, hash, paths, stat-cache,
gitignore, compress, template, transfer) have clean boundaries and are the strongest
part of the codebase.

## Findings

Severity: **Blocker** (data loss / security / core promise broken), **High** (real-world
failure or goal violation), **Medium** (correctness/UX defect), **Low** (polish).
IDs are stable for tracking.
`file:line` references are to the current branch head.

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
This is the single highest-priority fix.

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

**HK-01 — Pre-push hook swallows upload failures and lets `git push` proceed.**
`packages/blobsy/src/commands-stage2.ts:1648-1685`. `handlePrePushHook` ignores
`result.success === false`, prints “all blobs uploaded.”
unconditionally, and never sets a nonzero exit code — so the hook that exists to prevent
committed-ref-without-blob data loss (the design’s “Prevention (Primary)” layer)
approves the push on network failure, missing credentials, or any backend error.
Collaborators then hit “missing (no remote!)”. **Fix:** Collect failures, print each
with its error, set `process.exitCode = 1` when any push fails so git aborts the push.

**CLI-01 — `--no-hooks` does nothing; hooks are always installed.**
`packages/blobsy/src/cli.ts:137,146,671`. Commander maps `--no-hooks` to
`opts.hooks === false`, but the code checks `!opts.noHooks`, which is always true.
Both `setup --auto --no-hooks` and `init --no-hooks` install hooks anyway — surprising
in exactly the situations (hook managers, CI) where users opted out.
**Fix:** Check `opts.hooks !== false`. Add a golden test asserting no hook files exist
after `--no-hooks`.

**SEC-01 — Prototype pollution via `blobsy config` keys.**
`packages/blobsy/src/cli.ts:1989-2000` (`setNestedValue`),
`packages/blobsy/src/config.ts:255` (`unsetNestedValue`). Key paths are split on `.` and
traversed with no filtering, so `blobsy config __proto__.x 1` pollutes
`Object.prototype` for the process, and the polluted structure is serialized into
`.blobsy.yml`. Also reachable via crafted config keys in automation.
**Fix:** Reject `__proto__`, `constructor`, and `prototype` as path segments in
`setNestedValue`, `getNestedValue`, and `unsetNestedValue`; validate keys against the
known config schema (see CFG-03).

**DS-04 — `rm --remote`: interactive prompt violates the non-interactive contract, and
`--quiet` silently bypasses the confirmation.** `packages/blobsy/src/cli.ts:1426-1440`.
The design commits to “No command ever prompts” (blobsy-design.md:2965-2978), yet
`rm --remote` opens a readline prompt — and the guard is
`if (!force && !globalOpts.quiet)`, so `blobsy rm --remote --quiet` (the natural
agent/script invocation) **permanently deletes the remote blob with no confirmation**.
`--quiet` must never imply consent.
Note also the README documents `--remote` while the design doc states remote blobs are
never touched by rm — the design doc needs updating to match the (intended)
implementation. **Fix:** Remove the prompt.
Require `--force` for remote deletion; without it, error with instructions (exit 1).
Never branch safety behavior on `--quiet`.

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

**BE-03 — `LocalBackend` path traversal via `remote_key`.**
`packages/blobsy/src/backend-local.ts:27,54,120,125`. `join(this.remoteDir, remoteKey)`
with a `.bref`-supplied `remote_key` like `../../…` escapes the backend directory for
read, write, and delete (`rm --remote` reaches `delete`). `.bref` files arrive via git
from other users — this is attacker-influenceable input.
**Fix:** Resolve and verify containment (`resolve(remoteDir, key)` must start with
`resolve(remoteDir) + sep`); reject otherwise.
Consider validating `remote_key` shape at `readBref` time for all backends.

**BE-04 — Built-in S3 backend buffers entire files in memory.**
`packages/blobsy/src/backend-s3.ts:66-91` (push `readFile`), `:117-120` (pull chunk
accumulation + `Buffer.concat` — ~2× file size).
Multi-GB files OOM the default Node heap.
This is the fallback backend when no CLI tool is installed — i.e., the lowest-friction
path for new users. **Fix:** Stream: `createReadStream` as `PutObject` Body;
`pipeline(response.Body, createWriteStream(tmp))` on pull.

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

**TEST-01 — The golden test suite does not run in CI, and has already drifted.**
`packages/blobsy/vitest.config.ts` (includes only `tests/**/*.test.ts`),
`.github/workflows/ci.yml:48-53` (runs exactly one tryscript file, the rclone
lifecycle).
65 `.tryscript.md` golden tests — the testing design’s centerpiece ("CI fails
on any unintentional output change", blobsy-testing-design.md:1993 promises “All unit
tests (vitest) and golden tests (tryscript) run on every PR”) — never execute in CI. The
consequence is already observable: at least five golden files carry stale size
expectations (`32 B` where the fixture now yields `21 B`) and fail when run —
`commands/status.tryscript.md:105`, `commands/push-pull.tryscript.md:59`,
`commands/check-unpushed.tryscript.md:54`, `workflows/branch-workflow.tryscript.md:57`,
`workflows/fresh-setup.tryscript.md:70` (verified by running
`npx tryscript run tests/golden/commands/status.tryscript.md`: 13 passed, 1 failed).
The suite is currently ornamental: it documents intended behavior without enforcing it,
and `--json` shape breaks for agents would ship silently.
**Fix:** Add a `test:golden` script running the full tryscript suite; repair the five
stale files (`--update` after verifying the new output is correct); wire the script into
ci.yml (both Node lanes) and the lefthook pre-push gate.

**DX-01 — Fresh clone fails `pnpm test` (49 failures across 5 files).**
`tests/hooks.test.ts`, `setup.test.ts`, `init.test.ts`, `commands/rm.test.ts`,
`errors/user-error.test.ts` spawn `blobsy` from PATH; only CI’s undocumented
`pnpm link --global` step (ci.yml:40-42) makes that work.
CLAUDE.md and docs/development.md say `pnpm install && pnpm build && pnpm test`.
**Fix:** Point tests at the built binary (`node dist/cli.mjs` or execa with the package
bin path) instead of relying on a global link — removing the CI link step too.

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

**CLI-02 — `sync --dry-run` and `pull --dry-run` misreport the plan.**
`packages/blobsy/src/commands-stage2.ts:408-417` (sync dry-run omits the
locally-modified→push case entirely, reporting “Everything up to date”); `:304-321`
(pull dry-run counts already-up-to-date files it would skip).
`--dry-run` is the primary trust mechanism for agents and scripts; it must match the
real plan — especially while DS-01/DS-02 make the real plan destructive.
**Fix:** Run the same per-file decision logic in dry-run mode and print its actions.

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
safely; aws-cli and format tests follow.

**TEST-05 — `release.yml` publishes to npm without running tests.**
`.github/workflows/release.yml` builds and `pnpm -r publish`es with no test step
(publish.yml has one; both trigger on version tags).
**Fix:** Add `pnpm test` (and the golden suite once TEST-01 lands) before publish, or
consolidate the two workflows.

### Medium

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
**Fix:** Require a `.bref` before any `rm` variant touches the payload.

**CLI-06 — `sync` prints nothing for failed modified-file pushes.**
`packages/blobsy/src/commands-stage2.ts:491-493`. `errors++` with no message; user sees
only “…, 1 errors.” (contrast with the new-file path at :452-455). **Fix:** Print the
failure with path and error, as the other branch does.

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

**CLI-07 — Overlapping commands (see design assessment).** `check-unpushed` vs
`pre-push-check` (same question, one adds blame/one adds exit codes), `health` vs
`doctor`, `readme`/`docs`/`skill`, `setup`/`init`, `add`/`track`. Consolidate per the
table above; each merge shrinks help text, docs, skill text, and golden surface.

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
`expect(bref.remote_key).toBeDefined()`. (Note both blocks are obsolete if DS-04 removes
the prompt.)

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
script exist, and CI runs one of them (TEST-01) — with measurable drift already
accumulated as a result.

Coverage by module (unit tests; golden coverage exists for nearly all CLI behavior but
is unenforced until TEST-01 lands):

| Area | State |
| --- | --- |
| Well covered | `config`, `transfer`, `backend-command`, `backend-local`, `backend-url`, `gitignore`, `paths`, `ref`, `template`, `compress`, `externalize`, `hash` |
| Partial | `cli.ts` (init/setup/hooks/rm via integration), `backend-s3` (exists/health only, with false-pass bugs — TEST-03), `backend-rclone` (heavily mocked), `types` |
| Zero unit tests | `commands-stage2.ts` (1,703 lines: push/pull/sync/doctor — golden tests cover it once enforced), `stat-cache.ts` (TEST-04), `backend-aws-cli.ts` (TEST-04), `format.ts` (TEST-04) |

**Biggest coverage hole vs.
the blockers:** there is no test — unit or golden — for the two-user desync scenario at
the heart of DS-01 (`two-user-conflict.tryscript.md` is a single user force-pushing and
re-pulling), none for pull-refuses-modified (DS-02), none for push-hash-mismatch
(DS-03), and none asserting the pre-push hook fails on upload error (HK-01). The blocker
fixes should each land with a golden test reproducing the scenario; the local backend
makes all four testable without credentials.

**Priority order (test work only):** wire golden suite into CI + repair the five stale
files (TEST-01, ~30 min) → fix S3 false-pass tests and add S3/aws-cli push-pull tests
(TEST-03) → write `stat-cache.test.ts` ahead of the DS-01 fix (TEST-04) → add the
missing error-scenario goldens (TEST-06) → add tests to release.yml (TEST-05). Defer
past alpha: coverage merge, `format.ts` unit tests (golden covers it), binary fixture,
matrix regeneration automation.

## Documentation Actions (summary)

1. Single-source the skill text; lead with `add`; add frontmatter (DOCS-01).
2. Fix README threshold (DOCS-02), hooks contradictions (DOCS-03), QA playbook
   (DOCS-04).
3. Split V2/deferred material out of blobsy-design.md; fix determinism-principle wording
   and the `az://`→`azure://` scheme reference; document `rm --remote` in the design or
   remove it from the CLI.
4. Add for alpha: Git LFS migration guide, “joining an existing blobsy repo” section,
   copy-paste GitHub Actions example.
5. Archive completed specs out of `specs/active/` (DOCS-05).

## Suggested Order of Work for Alpha

1. **Data safety (blockers):** DS-01, DS-02, DS-03, HK-01, DS-04, CLI-01, SEC-01 — with
   golden tests for each scenario (the two-user desync scenario currently has no test;
   `two-user-conflict.tryscript.md` exercises a single user force-pushing).
2. **CI trust:** TEST-01 (golden suite in CI + repair five stale goldens), DX-01
   (fresh-clone tests), TEST-03 (S3 false-pass tests), TEST-05 (tests in release.yml),
   CLI-02 (truthful dry-run), TEST-04 (`stat-cache.test.ts` as the DS-01 prerequisite).
3. **Real-world transfer viability:** BE-01 (timeout), BE-04 (streaming S3), BE-02
   (async exec + backend reuse; decide on parallelism vs deleting `sync.parallel`).
4. **Correctness cleanup:** LIB-01, LIB-02, BE-03, BE-05..BE-09, CFG-01..03, HK-02,
   CLI-03..06.
5. **Simplification pass:** command consolidation (CLI-07 + design table), cli.ts
   reorganization, config-hierarchy reduction decision, error-class unification.
6. **Docs alignment:** documentation actions above.

Items 1–3 are the alpha gate; 4 can trail into alpha; 5–6 determine whether the alpha
*feels* like the design’s promise: one primitive, one obvious workflow, minimal
complexity.
