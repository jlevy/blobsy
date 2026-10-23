# Research: Jujutsu (jj) and blobsy

**Last Updated**: 2026-10-22

**Status**: Reference (deep dive that extends the jj entry in the landscape refresh)

**Related**:

- [research-2026-10-22-large-file-tools-landscape-refresh.md](research-2026-10-22-large-file-tools-landscape-refresh.md)
  -- the short jj entry this doc expands on (§ “Jujutsu (jj) and Sapling”)
- [research-2026-10-22-tree-manifests-and-cache-patterns.md](research-2026-10-22-tree-manifests-and-cache-patterns.md)
  -- the collection-manifest and merge-driver design that §7 revisits
- [blobsy-design.md](../../design/current/blobsy-design.md) -- `blobsy hooks` section
- [blobsy-implementation-notes.md](../../design/current/blobsy-implementation-notes.md)
  -- hook shim and the two-phase `remote_key` flow

**Verification legend.**

- **[V]** verified in this session against a primary source: the jj repo clone at
  `attic/jj` (HEAD `c84cc0af`, 2026-10-22), jj’s GitHub issues and PRs, or an
  **empirical test** with the jj 0.46.0 release binary (§6)
- **[S]** secondary source, such as a summary of a GitHub thread whose hidden comments
  could not all be read
- **[I]** inferred by the author; treat it as a hypothesis

* * *

## 1. Summary

1. **jj never runs git hooks.** `jj git push` shells out to
   `git push --porcelain --no-verify`, and there is no `jj commit` hook.
   Under jj, blobsy’s pre-push upload, its main guard against pushing a `.bref` whose
   blob was never uploaded, **silently never runs**. The empirical test reproduced the
   resulting data loss end to end: `.bref` files reached the remote and the blob store
   was empty [V].
2. **jj snapshots almost every file in the working copy.** Any non-ignored file under
   `snapshot.max-new-file-size` (default **1 MiB**) is committed into the working-copy
   commit `@` as soon as *any* jj command runs.
   If the file existed before `blobsy add`, it **stays tracked** after blobsy adds the
   gitignore line, and gets pushed.
   The test pushed a 600 KB payload to the remote this way [V].
3. **`.blobsy/stat-cache/` is not gitignored by `blobsy setup`.** In git it is only a
   `?? .blobsy/` nuisance.
   jj auto-tracks it, so stat-cache JSON was committed and pushed in the test [V]. This
   is a blobsy bug in its own right: the design says “gitignored” and only
   `blobsy doctor --fix` adds the ignore line.
4. **jj needs no filters or `.gitattributes`, and blobsy uses neither.** jj still has no
   LFS (#80 open), no `.gitattributes` (#53 open), no partial clone, and no hooks (#405
   and #3577 open; hooks design PR #8446 unmerged) [V]. Plain `.bref` files merge,
   conflict, and resolve under jj like any text file.
   A blobsy custom git merge driver set via `.gitattributes` **would be ignored by jj**,
   but the same logic can ship as a jj merge tool for `jj resolve --tool` [V].
5. **Blobsy works in a colocated repo with workarounds.** `git add` / `git rm --cached`
   are harmless but pointless, because jj ignores the index.
   A non-colocated repo fails (`git rev-parse --show-toplevel` has no `.git`). Inside
   `jj run`’s isolated working copies, blobsy resolves the *outer* repo root, which is
   the wrong tree [V].

**Bottom line.** Blobsy’s format (a text pointer plus a gitignored payload) fits jj
better than LFS does.
Its *safety model* (hooks, index staging, write-back after push) does not.
To be jj-friendly, blobsy must be correct with no hooks at all.
Concretely: upload before the `.bref` is shared, make `.bref` final at `add` time, and
detect jj to untrack payloads that jj has already snapshotted (§8).

## 2. Project status and releases since Oct 2025

Releases ship monthly, on the first Wednesday or so; still pre-1.0 [V, `CHANGELOG.md`]:

| Version | Date | Changes relevant to blobsy |
| --- | --- | --- |
| 0.34.0 | 2025-10-01 | `jj gerrit upload` (experimental); `jj bisect run` |
| 0.35.0 | 2025-11-05 | `jj file track --include-ignored` (tracks ignored files or files over the size limit, #2837); `jj git colocation enable/disable`; per-workspace config |
| 0.36.0 | 2025-12-03 | Docs moved to `docs.jj-vcs.dev`; colocated concurrency race fixed (#6830); sub-repos (dirs with `.jj`/`.git`) no longer tracked |
| 0.37.0 | 2026-01-07 | `xyz/n` syntax for hidden and divergent change IDs |
| 0.38.0 | 2026-02-04 | Repo and workspace config **moved out of the repo** (security); conflict markers follow the file’s LF/CRLF (#7376); Watchman rescans on `.gitignore` change (#8427) |
| 0.39.0 | 2026-03-04 | `jj arrange` TUI, `jj bookmark advance`; `file track --include-ignored` works with Watchman |
| 0.40.0 | 2026-04-01 | (no highlights) |
| 0.41.0 | 2026-05-06 | `jj fix` line ranges; global `--no-integrate-operation` for background tools; `.gitignore` parity fixes |
| 0.42.0 | 2026-06-04 | mimalloc |
| 0.43.0 | 2026-07-01 | **`jj run`**: runs a command per revision in private working copies and propagates the changes |
| 0.44.0 | 2026-08-05 | Tag fetch/push stabilized |
| 0.45.0 / .1 | 2026-09-02 / 09-03 | `jj converge` (auto-resolve divergence); **colocated fix: an external `git add` after a jj command no longer corrupts the tree with duplicate entries (#9711, #8884)** |
| 0.46.0 | 2026-10-07 | **Colocated secondary workspaces via `git worktree`** (`jj workspace add --colocate`); `git.push` accepts multiple remotes; `revsets.git-push`; `.gitignore` honored outside the sparse patterns (#2289); git ≥ 2.42 required |
| Unreleased | — | `jj resolve` built-in `:editor` tool (N-sided conflicts); sign-on-push in its own transaction |

All rows are [V, `CHANGELOG.md` lines 9–1939]. The 0.45 `git add` fix matters directly
to blobsy, which runs `git add` in colocated repos.
**jj < 0.45 plus `blobsy add` could produce `git fsck: duplicateEntries`**
[V for the jj bug; I that blobsy triggers it, since its pattern is exactly “external `git add` after a jj command”].

**Activity and governance.** Since 2025-10-01: 2,051 commits from 195 authors.
Top authors are Yuya Nishihara (536) and Martin von Zweigbergk (351)
[V, `git log` on the clone]. Maintainers are elected and decisions follow
`docs/governance/GOVERNANCE.md` [V]. `docs/paid_contributors.md` lists a long
Alphabet/Google section and a newer “East River Source Control” (ERSC) section (handles
include steveklabnik, thoughtpolice, ilyagr).
Commit `892c16e6` (2026-07-06) moved martinvonz from Google to ERSC (“Today is my first
day with ERSC”) [V]. The README still carries the “not a supported Google product”
disclaimer [V]. Google use: the roadmap says “Google has an internal Jujutsu server
backed by a database” with a local caching daemon [V, `docs/roadmap.md`]. Wider claims
that Google is replacing its VCS with jj are [S].

**Roadmap items relevant here** [V, `docs/roadmap.md`, undated]: a VFS (“without needing
to download any large files … until the user asks for them”); “Better support for large
files” via content-defined chunking, “maybe … the same model as XetHub”; an open-source
cloud server and daemon; an RPC API. None has a design doc or date.
The large-file direction is **native chunked storage in jj’s own backend**, not LFS
interop [I from wording].

## 3. Large-file story

| Topic | Status | Evidence |
| --- | --- | --- |
| Auto-snapshot | Almost every jj command snapshots the working copy into `@`; `snapshot.auto-track` defaults to `all()` | [V, `docs/config.md` §Snapshot settings; `jj config list --include-defaults snapshot`] |
| Size guard | `snapshot.max-new-file-size` defaults to `1MiB`. Larger *new* files are refused with a warning and left on disk untracked. **Files already tracked are not limited.** `0` disables the limit | [V, docs + test] |
| A 500 MB new, non-ignored file | Refused with a warning (`Refused to snapshot some files … 4.8MiB`). The hint suggests `.gitignore` **or raising the limit**, so a user who follows the second hint commits the payload | [V, test with 5 MB; I for 500 MB, same code path] |
| Force-track | `jj file track --include-ignored` (0.35+) | [V] |
| Git LFS | “Git LFS: No.” Issue #80 has been open since 2022-02. martinvonz: “I’m worried about clean/smudge in general because it seems expensive to make it behave consistently”. No linked PR. Commits titled “git-lfs: add ability to ignore files based on git attributes” are cross-referenced only from forks and branches; nothing like it is on `main` | [V doc; S thread; V `git log --all --grep=lfs` empty] |
| `.gitattributes` | “No.” #53 is open (assigned 2025-12). Only a repo-wide `working-copy.eol-conversion` (`none`/`input`/`input-output`) setting exists. No filters, no `merge=` drivers, no `text`/`eol` attributes | [V `docs/git-compatibility.md`, `docs/config.md`; S #53 thread] |
| Partial clone / promisor | “Partial clones: No.” Shallow clones are partial | [V] |
| Sparse checkout | Git’s sparse checkout is not used. Native `jj sparse` path prefixes; `sparse-v2` design (patterns) pending; 0.46 fixed `.gitignore` being skipped for paths outside the sparse set | [V] |
| Submodules | Not shown in the working copy, but kept | [V] |

**Implication.** jj’s own guard stops *accidental big* files, not *intentional small*
ones.
Blobsy’s threshold for externalizing is often far below 1 MiB in data repos, so the
guard does nothing for many payloads [I]. Ordering is the only defense: the payload path
must be gitignored **before any jj command runs while the payload exists**. Background
IDE integrations (VS Code jj extensions, `jj log` watchers) shrink that window to near
zero [I].

## 4. Hooks

- **No git hooks, by design.** `lib/src/git_subprocess.rs` builds `git push` with the
  comment “Currently jj does not support commit hooks, so we prevent git from running
  them”, then `command.args(["push", "--porcelain", "--no-verify"])` [V]. `jj commit` /
  `jj describe` create commits in-process and never touch the hooks dir
  [V, test: an instrumented hook logged nothing].
- **Issues.** #405 (pre-commit.com integration, open since 2022-06), #3577 (“Generalized
  hook support”, open since 2024-04) [V]. In #3577, matts1 argues that **pre-upload**
  hooks are essential because `jj git push` bypasses wrapper workflows (“users *will*
  forget”). He also explains that commit hooks are ill-defined in jj because there is no
  single “commit” action [S].
- **Design PR #8446 “hooks: Add design doc”** (matts1, opened 2025-12-30, still open;
  last review 2026-05-28) [S]. It proposes `[hooks.pre-upload.<name>]` tables with
  `enabled`, `order`, and `command` (with `$root`), and built-in `fix` and `sign` hooks.
  jj would pass JSON on stdin: operation ID, the working-copy commit, and the commits to
  upload [S]. This is **exactly the shape blobsy needs**: a pre-upload hook that
  receives the commits being pushed and can fail the push.
  It is not shipped [V: not in CHANGELOG].
- **The “managed config” design** (`docs/design/managed-config.md`, “Pending
  implementation”) would let a repo propose config, including future pre-upload hooks,
  that users approve [V]. 0.38 moved repo config *out* of the repo for security [V]. So
  blobsy cannot commit a jj config that installs anything automatically today.
- **Hook-like mechanisms that exist:**
  - `jj fix`: rewrites file *contents* through stdin/stdout across commits.
    “The local files are not and must not be used” [V], so it cannot hash a gitignored
    payload. It can canonicalize text files such as `.bref` files, the managed
    `.gitignore` block, or a future manifest [I].
  - `jj run` (0.43): runs a command per revision in `.jj/run/<ws>/<n>/working_copy`,
    with `JJ_WORKSPACE_ROOT`, `JJ_COMMIT_ID`, and `JJ_CHANGE_ID` set, and amends any
    changes [V]. Gitignored payloads are absent there [V], so it suits `.bref`-only
    checks such as “is every key reachable?”.
  - Aliases plus `jj util exec` can wrap `blobsy push && jj git push` [V, test §6].
  - `git.sign-on-push` is the only built-in “before push” action, and it is
    signing-specific [V].
  - Third-party: `jj-pre-push` (Acarapetis; Chandler Carruth contributing) and
    `jj-hooks` (Rust, ephemeral git worktrees), both announced around May 2026
    [S, #405].

## 5. `.gitignore`, ignored files, conflicts, colocation

**`.gitignore`** [V, `docs/git-compatibility.md`, CHANGELOG 0.38–0.46]: native
implementation. Nested files, `.git/info/exclude`, and `core.excludesFile` are honored.
0.41 improved parity (trailing `/`, `\r\r\n`); 0.46 stopped following symlinked
`.gitignore` files.
The managed block (comment fences plus one name per line) is ordinary
gitignore syntax and works [V, test]. **Ignoring a file that is already tracked does
nothing.** You must run `jj file untrack <path>`, and that command *refuses* paths that
are not ignored (“Files that are not ignored will be added back by the next command”)
[V, test]. Untrack keeps the file on disk [V]. Ignored files are left alone when
switching revisions (`jj new` / `jj edit`), as in git [V]. So payloads go stale after a
switch (§6, step 9).

**Conflicts are first-class** [V, `docs/git-compatibility.md`, test]:

- Merges and rebases never stop.
  A conflicted file is stored structurally in the commit (git tree plus a `jj:trees`
  header plus `.jjconflict-base-*/` and `.jjconflict-side-*/` dirs that keep the trees
  from being GC’d). Descendants carry the conflict until it is resolved.
- On disk, jj materializes markers in `ui.conflict-marker-style`. The default, `diff`,
  shows one side as a `%%%%%%%` diff with `-`/`+` prefixes and the other as a `+++++++`
  snapshot. The alternatives are `snapshot` and `git` (diff3-like).
  Markers can be longer than 7 characters when needed (`$marker_length`).
- `jj git push` refuses conflicted commits unless forced
  (`cli/src/commands/git/push.rs`: `reasons.push("has conflicts")`) [V]. A git user who
  checks out such a commit with git sees the `.jjconflict-*` dirs, which contain `.bref`
  files [V, `git ls-tree` in the test].
- **Merge tools** [V, `docs/config.md` §3-way merge tools]: `ui.merge-editor` or
  `jj resolve --tool NAME [paths]`. `merge-tools.NAME.merge-args` substitutes `$base`,
  `$left`, `$right`, `$output`, `$path`, and `$marker_length`.
  `merge-conflict-exit-codes` allows partial resolution, and
  `merge-tool-edits-conflict-markers` seeds `$output` with markers.
  “Many Git merge drivers should be usable with `jj` as well.”
  Built-ins: `:builtin`, `:ours`, `:theirs`, and (unreleased) `:editor`. `mergiraf` is
  preconfigured. **Merge tools never run automatically** during merges or rebases.
  They run only when a user calls `jj resolve`, and they cannot be selected by path
  pattern, unlike `.gitattributes merge=`
  [V for docs; I that no auto-resolve hook exists, given no such config key in `config-schema.json`].

**Colocation** [V, docs plus test]:

- `jj git init` / `jj git clone` colocate by default.
  Git `HEAD` is detached at `@-`, and the working-copy commit `@` is invisible to git.
- jj “will ignore Git’s staging area”.
  jj adds new files as intent-to-add entries so `git diff` shows them (0.28) [V].
  Blobsy’s `git add` / `git rm --cached` therefore change nothing jj records; jj records
  whatever is on disk.
  They do no harm on jj ≥ 0.45.
- **Non-colocated repos break blobsy.** `blobsy setup` fails with “Not inside a git
  repository” because the git dir is `.jj/repo/store/git` [V].
- **0.46 secondary workspaces** are git worktrees.
  `.git` is a `gitdir:` file, and `git rev-parse --git-path hooks` points at the shared
  hooks dir. `blobsy status` and `blobsy pull` work there, and each workspace hydrates
  its own payload copies [V].
- **`jj run` pitfall.** Its working copies live *inside* the main workspace
  (`.jj/run/default/1/working_copy`), so `git rev-parse --show-toplevel` walks up to the
  outer repo. `blobsy status` run under `jj run` reported the **outer** repo’s files [V].
  Blobsy should prefer `$JJ_WORKSPACE_ROOT` when it is set [I].
- jj keeps every snapshot reachable through `refs/jj/keep/*`. The test repo had 14 such
  refs [V]. A payload snapshotted by mistake therefore stays in the local `.git/objects`
  even after untracking, until the op log is abandoned and GC runs
  [I from the mechanism]. This is a local-only form of PAIN-3.

## 6. Empirical test

**Setup** [V]: jj **0.46.0** (`jj-v0.46.0-x86_64-unknown-linux-musl` release binary),
git 2.43.0, Node 22.22, blobsy from `packages/blobsy/bin/blobsy`, a `local:` backend, a
bare local remote, and an isolated `HOME` and `JJ_CONFIG`. Scratch dir:
`/tmp/claude-0/-home-user-blobsy/0713c929-56bc-5939-ab24-7ac184df530b/scratchpad/jjtest/`.

| # | Step | Observed |
| --- | --- | --- |
| 1 | `jj git init --colocate repo; blobsy setup --auto local:../store` | Hooks installed in `.git/hooks`. `jj st` shows `.blobsy.yml` and `.claude/skills/...` added; `git status` shows them as ` A` (intent-to-add) |
| 2 | Create `data/small.bin` (600 KB) and `data/big.bin` (5 MB); run `jj st` | `small.bin` **snapshotted into `@`**. `big.bin` refused with the size warning (hint: “Add the file(s) to `.gitignore`” or raise the limit) |
| 3 | `blobsy add data/small.bin data/big.bin` | `.bref` files and the `data/.gitignore` managed block created, then `git add`. Message: “staged to git … `git commit`”. `small.bin` is **still tracked in `@`**, and `.blobsy/stat-cache/*.json` now appears as `A` (no `.blobsy/` ignore line) |
| 4 | `jj commit -m …` | The pre-commit hook **did not run** (instrumented hook, empty log) |
| 5 | `jj bookmark create main; jj git push --bookmark main` | Push succeeded. The pre-push hook **did not run**. **Store empty.** Remote tree contains both `.bref` files, **`data/small.bin` (600000 bytes)**, and **two stat-cache JSON files** |
| 6 | `jj git clone origin clone1; blobsy pull` | `no remote_key (not pushed, or pusher hasn't committed the .bref update)`; 0 pulled, exit 0. `big.bin` missing |
| 7 | In `repo`: `blobsy push` | Blobs uploaded. `.bref` files gain `remote_key`, `compressed`, `compressed_size`; stat cache rewritten. **jj snapshots all of it into `@` at once** (no staging step) |
| 8 | Fix-up: `echo .blobsy/ > .gitignore; jj file untrack .blobsy data/small.bin`; commit; `jj git push` | Untrack works only after ignoring (the first attempt errored). Payload kept on disk. New remote tree is clean, but **`small.bin` stays in remote history** (PAIN-3) |
| 9 | Fresh `jj git clone`, `blobsy pull` | Both payloads pulled; byte-identical |
| 10 | Two changes A and B from `main`, each re-adding `big.bin` with different content and adding `a.bin` / `b.bin`; then `jj new A B` | Merge commit created with **2 conflicts**: `data/big.bin.bref` (two hunks: hash/size/remote_key and compressed_size) and `data/.gitignore` (both appended at the same spot in the managed block) |
| 11 | Inspect the conflicted `data/.gitignore` | In `diff` style, side A’s line appears as `+a.bin` (not a valid ignore pattern) and side B’s `b.bin` is plain. **`a.bin` became un-ignored**; jj refused it only because 2 MB > 1 MiB. A smaller payload would have been snapshotted into the merge commit |
| 12 | `blobsy status` / `blobsy verify` on the conflict | status: `invalid .bref` / `corrupt_bref`, **exit 0**. verify: “Unresolved merge conflict markers in .bref file … Resolve the git conflict” (wording says git) |
| 13 | `jj resolve --tool union data/.gitignore` (custom tool: `git merge-file --union`); `jj resolve --tool :theirs data/big.bin.bref` | Both resolved; block now holds `a.bin`, `b.bin`, `big.bin`, `small.bin`; all synced |
| 14 | `jj new A` (switch) | `big.bin` on disk keeps B’s 4 MB (ignored file untouched). `blobsy status`: `modified`; `blobsy pull` **refuses** (“locally modified”); `blobsy sync --dry-run`: “Would pull” (stat-cache three-way merge spots ref-changed / file-unchanged correctly) |
| 15 | Flow `blobsy add → blobsy push → jj commit → jj git push`, then clone and pull | **Works in one commit**: the `.bref` already has `remote_key` when committed |
| 16 | Alias `bpush = ["util","exec","--","sh","-c","blobsy push && jj git push \"$@\"",…]` after `jj commit` | Upload happens first, but the pushed commit lacks `remote_key`. The write-back lands as `M data/n.bin.bref` in `@` (the git two-phase problem, now in jj form) |
| 17 | `jj git init --no-colocate`; `blobsy setup` | `Error: Not inside a git repository.` |
| 18 | 0.46 `jj workspace add ../ws2` (colocated worktree) | `blobsy status` / `pull` work; hooks path shared |
| 19 | `jj run --ignore-changes -r @- -- blobsy status` | Ran against the **outer** repo, not the isolated copy (`JJ_WORKSPACE_ROOT` points at `.jj/run/default/1/working_copy`) |

**What broke, ranked by severity:**

1. Hooks never fire, so `.bref` files without blobs reach the remote (data loss for
   teammates).
2. A small payload that jj snapshotted before `blobsy add` gets committed and pushed
   (PAIN-1/PAIN-3).
3. The stat cache gets committed (blobsy bug, made visible by jj).
4. A conflicted managed `.gitignore` block can un-ignore payloads.
5. Write-back after push leaves the `.bref` dirty in `@`.
6. `blobsy status` exits 0 on corrupt `.bref` files, and the messages assume git
   (`git commit`, `--no-verify`, “git conflict”).

## 7. Implications for the future designs under review

- **Collection manifest plus a custom merge driver via `.gitattributes`.** Under jj the
  driver is **ignored** [V: no `.gitattributes` support]. The manifest merges as plain
  text and conflicts are recorded in the commit.
  This already happens for GitHub’s merge button and merge queues (see the manifests
  research doc, §Implications).
  So the manifest’s **line format must be safe to text-merge and conflict-tolerant on
  its own**, and the driver is only an accelerator [I]. Ship the driver logic as a
  standalone binary with a `$base $left $right $output` interface
  (`blobsy merge-manifest`) and register it both ways:
  - git: `merge.blobsy.driver = blobsy merge-manifest %O %A %B %A`, plus
    `.gitattributes`
  - jj: `[merge-tools.blobsy] merge-args = ["merge-manifest", "$base", "$left",
    "$right", "$output"]` and `merge-conflict-exit-codes = [1]`, then
    `jj resolve --tool blobsy <manifest paths>`

  This matches jj’s “many Git merge drivers should be usable” note
  [V for the note; I for the plan]. `$left`/`$right` take raw sides, so blobsy never
  needs to parse jj’s `diff`-style markers [V for the interface].

- **Post-checkout / post-merge hydration hooks.** Under jj there is no such event: no
  hooks, and `@` changes underneath you through rebases of ancestors, `jj new`,
  `jj edit`, and `jj undo` [V/I]. Hydration must be **idempotent and on demand**:
  `blobsy sync`/`pull` can be run any time, and staleness must be detected by comparing
  the `.bref` hash with the stat cache, which `sync` already does correctly (step 14)
  [V]. `pull` and `status` should report “stale (ref changed, file unchanged) — safe to
  update” instead of “modified” [I from step 14].

- **Store-side snapshots for huge trees** (no manifest in git) are VCS-neutral and
  unaffected [I]. They are also the only design that sidesteps the auto-snapshot footgun
  completely: the tree is one ignored directory plus a small pointer.

- **Two-phase `remote_key` write-back** is worse under jj.
  With no staging area, the write-back is silently folded into whatever change is `@`,
  and `jj squash` into an already-pushed commit is blocked by `immutable_heads()`
  [I from jj defaults]. This is a strong argument for the open decision in the
  implementation notes: **make the committed `.bref` final at `blobsy add` time.** Keys
  would be derivable from content and config, and push-time facts (`compressed_size`,
  push time) would move out of the committed file or into an uncommitted receipt [I].

## 8. Recommendations for blobsy

**Must (correctness under jj):**

1. **Do not rely on hooks for correctness.** Keep the git hooks as a convenience, but
   make the documented, VCS-neutral safety net **`blobsy push` before sharing, plus a CI
   gate `blobsy pre-push-check`** (which also covers GitHub web merges).
   For jj, document the order `blobsy add → blobsy push → jj commit → jj git push` (step
   15\) and an alias such as `jj bpush` (step 16). When jj adds pre-upload hooks (PR
   #8446), ship `blobsy hook jj-pre-upload`, which reads the commits to upload from JSON
   on stdin [S for the format].

2. **Deterministic keys by default and no post-push write-back.** Then a `.bref` never
   changes after `add`, step 16 becomes correct, and pull can derive the key when
   `remote_key` is absent.
   This also removes the git two-phase problem.

3. **Gitignore `.blobsy/` in `blobsy setup`/`init`**, not only in `doctor --fix`. Also
   consider writing the managed ignore line *before* hashing or copying, so the window
   is as short as possible.

4. **Detect jj** (`.jj/` at the root, or `jj root` succeeds) and, in `blobsy add`:
   - check whether the payload is already tracked in `@` (`jj file list -r @ -- <path>`)
     and run `jj file untrack <path>` after writing the ignore line, or warn loudly
   - warn if `snapshot.max-new-file-size` was raised or `0`
   - print jj-appropriate next steps instead of “staged to git … `git commit`”

   `git add` can still run; it is harmless on jj ≥ 0.45 but could trigger #9711 on older
   versions, so skip it when jj is detected [I].

5. **Make the managed `.gitignore` block conflict-robust.** A text conflict there can
   un-ignore payloads (step 11). Options:
   - one ignore file per directory, regenerated from the `.bref` files that exist
     (blobsy owns it, so `blobsy doctor --fix` / `blobsy sync` rewrites it and never
     merges it)
   - a single wildcard-free ignore per payload written as `/<name>` lines sorted with
     gaps
   - telling jj users to resolve it with a union tool (step 13)

   The first option fits “`.bref` is the source of truth” best [I].

**Should:**

6. Make repo-root discovery jj-aware: use `$JJ_WORKSPACE_ROOT` when set (`jj run`), and
   support non-colocated repos via `jj root` with `GIT_DIR=.jj/repo/store/git` for the
   few git reads. Alternatively, declare colocated-only support and say so [I].
7. Make `blobsy status` exit non-zero on `corrupt_bref`, recognize jj conflict markers
   (`%%%%%%%`, `+++++++`, and markers longer than 7 characters) as “unresolved
   conflict”, and use VCS-neutral wording.
8. Provide `blobsy resolve <bref>` / `blobsy merge-bref BASE LEFT RIGHT OUT`. For a
   `.bref`, the only sane automatic results are “same hash on both sides” or “one side
   unchanged from base”.
   Otherwise exit 1 and let the user pick `:ours` or `:theirs`. The same binary should
   be usable as a git driver and a jj merge tool.
9. Give `pull` the “stale vs modified” distinction that `sync` already makes.

**Could:**

10. Offer a `jj fix` tool entry (`blobsy fmt`) that canonicalizes `.bref`, manifest, and
    managed-block files across a whole stack of changes without touching payloads.
11. Offer a `jj run`-compatible `blobsy check-remote` that, per revision, verifies that
    every `.bref` key exists in the store.
    With `--ignore-changes` this gives a “before push” audit over
    `remote_bookmarks()..@`.

## 9. Ideas from jj’s design relevant to UC-4

- **First-class conflicts as data.** jj stores a conflict as N sides plus a base, keeps
  working, and resolves later.
  For a collection manifest, blobsy could do the same at the *entry* level: a manifest
  line may carry multiple candidate hashes (`path → {base, sides…}`), and `blobsy
  resolve` would pick one.
  Text merges stay safe, and an unresolved entry is unambiguous to tooling, unlike
  `<<<<<<<` inside YAML [I].
- **Operation log and undo.** Each jj command is an atomic, undoable operation over the
  repo state. Blobsy’s local state (stat cache, `.blobsy/trash/`, pending uploads) could
  follow the same append-only “operation receipts” idea (round-8 receipts).
  `blobsy undo` would then restore the previous `.bref` and payload pair.
  The remote stays immutable, so only local state needs undo [I].
- **Change IDs** (a `change-id` commit header since 0.30) identify a logical change
  across rewrites [V]. Blobsy provenance (who pushed a blob for which change) could
  record the change ID instead of the commit SHA, which jj rewrites constantly [I].
- **Content-defined chunking on the roadmap** [V]: if jj ever ships CDC storage, it
  competes for PAIN-1 inside jj’s own backend.
  It would not fix PAIN-5 (pluggable backends) or git-only teammates [I].

## 10. Open questions

- Will PR #8446 land, and will pre-upload hooks see the full commit set, including
  bookmarks pushed to multiple remotes (0.46 `git.push` patterns)?
  Watch #3577.
- Should blobsy declare **colocated-only** jj support, or implement a jj backend through
  `jj` CLI calls (`jj file list`, `jj file show`)?
- How common are payloads under 1 MiB among blobsy users?
  That decides whether the auto-snapshot footgun (summary item 2) is an edge case or the
  main case.

## Sources

- jj clone `attic/jj` @ `c84cc0af` (2026-10-22): `CHANGELOG.md`;
  `docs/git-compatibility.md`; `docs/config.md` (Snapshot settings, 3-way merge tools,
  `jj fix`, EOL); `docs/roadmap.md`; `docs/design/run.md`;
  `docs/design/managed-config.md`; `docs/design/secure-config.md`;
  `docs/governance/GOVERNANCE.md`; `docs/paid_contributors.md` (commit `892c16e6`);
  `lib/src/git_subprocess.rs` (`--no-verify`); `cli/src/commands/git/push.rs` (conflict
  refusal).
- GitHub issues and PRs: [#80 Git LFS](https://github.com/jj-vcs/jj/issues/80),
  [#53 .gitattributes](https://github.com/jj-vcs/jj/issues/53),
  [#405 pre-commit hooks](https://github.com/jj-vcs/jj/issues/405),
  [#3577 generalized hooks](https://github.com/jj-vcs/jj/issues/3577),
  [PR #8446 hooks design doc](https://github.com/jj-vcs/jj/pull/8446),
  [#9711](https://github.com/jj-vcs/jj/issues/9711) (colocated `git add` corruption).
- Release binary:
  `https://github.com/jj-vcs/jj/releases/download/v0.46.0/jj-v0.46.0-x86_64-unknown-linux-musl.tar.gz`.
- Secondary:
  [Gradle blog, “The (Petty) Reason We Didn’t Use jj”](https://blog.gradle.org/the-petty-reason-we-didnt-end-up-using-jj-at-gradle)
  (eol / #53).
