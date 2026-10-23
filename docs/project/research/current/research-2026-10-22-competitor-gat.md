# Research: Competitor Deep Dive — Gat (getgat.dev)

**Date:** 2026-10-22

**Status:** Reference.
This is the definitive design reference for Gat as of `main@982a3db` (2026-10-13, crate
version 0.0.15). It closes with a design judgment for blobsy.

**Related:**

- [research-2026-10-22-large-file-tools-landscape-refresh.md](research-2026-10-22-large-file-tools-landscape-refresh.md)
  (§ Gat and the matrix; this doc supersedes that section and corrects it)
- [research-2026-10-22-tree-manifests-and-cache-patterns.md](research-2026-10-22-tree-manifests-and-cache-patterns.md)
  (§4 manifest merge, §6a `.btree` proposal)
- [blobsy-design.md](../../design/current/blobsy-design.md),
  [blobsy-design-review-round8-run-sync-workflows.md](../../design/current/blobsy-design-review-round8-run-sync-workflows.md)

**Evidence key:** **[V:src]** = read in Gat source (path:line cited).
**[V:docs]** = Gat’s own docs (`docs/*.mdx` in the repo, mirrored at getgat.dev).
**[V:run]** = observed by running a Gat binary built from source (see Appendix A).
**[V:web]** = GitHub or HN pages fetched on 2026-10-22. **[I]** = inference or judgment.
Source paths are relative to the Gat repo root (clone in `attic/gat`).

* * *

## 1. Summary

1. **Gat is a well-engineered, very young, single-maintainer Rust tool.** It does
   exactly blobsy’s “LFS replacement” job with a different shape.
   It has one committed manifest (`gat.lock`: `blake3<TAB>path` rows) instead of a
   pointer per file. Remote keys are content-addressed and derived from the hash, never
   stored. It keeps a local CAS cache, post-checkout/merge/rewrite hooks that hydrate the
   working tree, and a semantic three-way merge driver for the lock.
   It ships as a single static binary [V:src, V:run].
2. **Maturity:** repo created 2026-09-07, first release v0.0.10 on 2026-09-12, latest
   tagged release v0.0.14 on 2026-09-26. Main is at 0.0.15. There are 47 squashed
   commits and ≈629 stars.
   All human PRs come from one author (`davnn`); the rest are Dependabot.
   It has about 152k lines of Rust, 2,467 tests, and CI on Linux, macOS, and Windows.
   Two Show HN posts drew 1 and 7 points with 0 comments [V:web, V:src]. That much code
   in about six weeks from one person suggests heavy AI assistance [I].
3. **Its merge driver works as specified.** In tests it cleanly merged adjacent-sort
   adds, adjacent edits, identical adds, rebases and cherry-picks.
   Plain git text merge reports false conflicts on all of these [V:run]. Its conflict UX
   has a real hazard, though.
   On a same-path conflict it leaves *ours* untouched, with no markers and none of the
   other side’s clean changes.
   A naive `git add gat.lock` then silently drops *theirs’* independent additions
   [V:run].
4. **Merges without the driver** (fresh clone without `gat init`, GitHub web merge,
   merge queue) fall back to git’s text merge [V:run, I for GitHub]. That fallback can
   produce an **invalid lock that Gat then refuses to read**, with an opaque “Could not
   read gat.lock” error.
   Even `gat rm` refuses, so the only repair is hand-editing hex TSV [V:run]. Sharded
   locks have the same hole across shards *even with* the driver installed [V:run].
5. **Hooks:** Gat only hydrates.
   It has **no pre-commit or pre-push guard**. We committed a lock whose object was
   never pushed, and nothing stopped `git push` [V:run]. Hooks go into
   `$GIT_COMMON_DIR/hooks`, **ignoring `core.hooksPath`**, so husky and lefthook users
   silently get no hooks [V:run].
6. **Other bugs and gaps found:**
   - The executable bit is lost on clone [V:run].
   - Edits to a tracked payload are invisible to `gat status` and `gat diff` until
     `gat add` [V:run].
   - Linked worktrees clobber each other’s `.git/info/exclude` block, so materialized
     payloads appear as untracked `?? d/` files [V:run].
   - `gat fetch` aborts the whole batch on the first missing object [V:run].
   - Cherry-pick does not hydrate [V:run].
   - There is no JSON output [V:docs].
   - Remote keys are opaque (`blake3/xx/yy/<oid>`) [V:run].
   - There is no compression, and no custom-command or rclone backend [V:src].
7. **Verdict:** for the “serverless LFS replacement” core (UC-1, UC-2, UC-4), Gat’s
   design is **better than blobsy’s current design on five of the twelve decisions in
   §12**: derived CAS keys (no two-phase commit), a local CAS cache, a shipped merge
   driver, a three-scope config, and a single binary.
   It also wins on one manifest for large collections.
   Blobsy is **better on four**: SHA-256 interop, remote browsability, pluggable
   backends and agent UX. It also wins on guard-rail hooks, compression, and
   hosted-merge robustness for per-file pointers.
   **Gat has no UC-3 at all.** Blobsy should adopt Gat’s key derivation and lock rigor,
   and ship a better-behaved UC-2 manifest driver than Gat’s. It should not try to
   out-Gat Gat as a generic LFS clone; §11 has the list.

* * *

## 2. Project facts

| Item | Value |
| --- | --- |
| License | Apache-2.0 [V:src `LICENSE`, `Cargo.toml`] |
| Language / MSRV | Rust 2024 edition, MSRV 1.91; release built with pinned Rust and Zig for glibc/musl [V:src `Cargo.toml`, `.github/workflows/release.yml`] |
| Size | ≈152.6k lines of `.rs`: `gat-io` 46.6k, `gat-engine` 36.6k, root `src` (CLI/output) 23.6k, `tests` 20.0k, `gat-core` 12.5k, `gat-command` 8.3k, tools 4.0k [V:src, `wc`]. Blobsy: ≈8.9k lines of TS. |
| Tests | 2,467 `#[test]`/`#[tokio::test]` functions; nextest; `task coverage` via llvm-cov (not gated in CI). Clippy `pedantic`, `nursery` and `cargo` are all `deny` [V:src] |
| CI | fmt, clippy, docs-drift check, installer tests, and a test matrix on ubuntu, macos and windows; CodeQL [V:src `.github/workflows/checks.yml`] |
| Release targets | x86_64/aarch64 × linux-gnu, linux-musl, darwin, windows-msvc (8 targets); `curl … install.sh \| sh` with checksum verification [V:src release.yml, README] |
| Binary | 29 MB (`incremental` profile, stripped); a clean build took about 6 min on 4 cores [V:run] |
| History | v0.0.10 2026-09-12 (initial), .11 09-13, .12 09-16, .13 09-18, .14 09-26; main = 0.0.15 [V:web releases page]. *Correction:* the landscape doc said “no tagged release visible”; releases exist. |
| Activity | 47 commits on main (squash merges), 72 PRs total, 11 open (all Dependabot); single human author `davnn` [V:web] |
| Community | ≈629 stars, 34 forks. Show HN 2026-09-08 (1 pt) and 2026-09-27 (7 pts), no comments [V:web, HN Algolia] |
| Lifecycle labels | Experimental: `gc`, `system`, `mount`, `route`, `selection`, `lock.shard_levels`, `cache.ingest_strategy=hybrid` [V:docs `references/feature-lifecycle.mdx`, `configuration.mdx`] |
| AI posture | `AGENTS.md` asks agents to follow CONTRIBUTING and run `task check`, and says “Prefer the cleanest design over preserving existing formats, APIs, or behavior” [V:src]. The docs site exposes a **docs-search MCP server** (`https://getgat.dev/mcp`). It cannot run commands [V:docs `guides/use-gat-mcp.mdx`] |

### 2.1 Architecture and dependencies

The workspace is layered with strict dependency direction
[V:src crate `Cargo.toml` descriptions]:

- **`gat-core`**: pure domain values.
  It holds lock grammar, codec, merge, paths, globs, OIDs, config schema and history
  requests. No I/O. Deps: `serde`, `blake3`, `glob`.
- **`gat-io`**: physical I/O. Filesystem, atomic publish, SQLite state, CAS cache,
  OpenDAL remotes, and gix (Git).
  Deps include `opendal 0.58` with features `services-s3`, `services-azblob`,
  `services-gcs`, `services-oss`, `services-fs` and `layers-concurrent-limit`;
  `gix 0.88` (no `git` binary needed for reads); `rusqlite` (bundled); `blake3` (mmap,
  rayon); `reflink-copy`; `tokio`; `rayon`.
- **`gat-engine`**: workflows.
  Sync planning and execution, transfer scheduler (presence, upload, download), GC,
  mounts, maintenance.
- **`gat-command`**: use-case orchestration.
  **`src/`**: clap CLI, rendering, error mapping and redaction.

Gat uses `gix` (pure-Rust git) for history walks, lock snapshots at revisions, config
edits and excludes. The `git` CLI is not required for its reads
[V:src `gat-io/Cargo.toml`].

* * *

## 3. Data model

### 3.1 `gat.lock` (lock-v1) — real example [V:run]

```text
version https://getgat.dev/spec/lock-v1
70e2e309fe28131da2cd7c825c67df15974aaab935bd01585604450021772b55	data/f1.dat
e8b000bfac8d0d8d6883ceb9fc5e866489ebaa17143ab85b59f7c9f40a882011	data/f2.dat
d1fbb7735770fe35d4a39b90f515abf4f764ee0877e04efc676c661dba97cc4c	models/m1.bin
```

Normative rules
[V:docs `spec/lock-v1.mdx`; enforced in `gat-core/src/lock/codec.rs`, `reader.rs` with SIMD kernels `reader/kernels/{x86,aarch64}.rs`]:

- **Row format:** `<64 lowercase hex BLAKE3><TAB><escaped path><LF>`, digest first.
  The only escapes are `\xhh` for U+0000–U+001F. Everything else is literal, including
  quotes and spaces. Backslash is otherwise invalid.
- **Header:** the exact line `version https://getgat.dev/spec/lock-v1`. A BOM is
  rejected. The header alone means an empty map.
  Readers accept CRLF; writers emit LF.
- **Ordering and validity:** rows are strictly increasing by decoded path bytes.
  There is no Unicode normalization and no case folding.
  Duplicates are rejected.
  A path may not be both a file and a directory prefix (`foo` vs `foo/bar`), and this
  must be detected even when the rows are not adjacent (`foo`, `foo.bar`, `foo/bar`).
- **Not recorded:** size, mode/executable bit, mtime, storage location, compression and
  symlinks. Symlinks are refused at `gat add`
  [V:src `gat-io/src/worktree.rs` `UnsupportedLeafSymlink`]. The executable bit is
  **lost** on materialization (`-rwxr-xr-x` in clone A became `-rw-r--r--` in clone B)
  [V:run].
- **Hash:** BLAKE3-256 over whole-file bytes.
  No chunking and no CDC
  [V:src `gat-io/src/cache/layout.rs` `OBJECT_HASH_NAMESPACE = "blake3"`].
- **Size:** about 79 bytes per entry.
  3,000 entries made a 237 KB lock, and a one-file change produced a 1-line diff
  [V:run].

**Sharding** (`lock.shard_levels` 0–2, experimental): `gat.lock/` becomes a directory of
complete lock-v1 documents.
A row’s shard is chosen from the leading bytes of `BLAKE3(path)`: `gat.lock/<h0>.tsv` or
`gat.lock/<h0>/<h1>.tsv`. Shape is detected per revision, and the logical map is
identical in either shape [V:docs spec]. With 6 files at depth 1 we got 6 one-row shards
named `13.tsv`, `3d.tsv`, `82.tsv`, … [V:run]. Shard names carry no directory meaning
for reviewers, and related files scatter [V:run, I].

### 3.2 `gat.yaml` — config in three scopes [V:docs `references/configuration.mdx`, V:run]

The scopes are global `~/.gat/gat.yaml`, project `<repo>/gat.yaml` (committed, the
default), and local `<repo>/.gat/gat.yaml` (not committed).
General settings inherit field by field; same-named resources replace whole definitions.
Typical file after `gat remote add` and `gat remote default` [V:run]:

```yaml
version: 1
remotes:
  default: store
  store:
    url: file:///…/remote
```

Other keys:

- `network.{readiness,operation,io}_timeout_seconds` (default 5/30/60) and
  `network.request_concurrency` (default 256)
  [V:src `gat-core/src/settings.rs:254-257`].
- `cache.location`, `cache.materialization_strategy` (ordered list of
  `reflink|hardlink|symlink|copy`, default `[copy]`) and `cache.ingest_strategy`
  (`safe|hybrid|mmap`).
- `sync.{trust_state,auto_fetch,auto_repair}` (all default false).
- `selections.*`, `lock.shard_levels`, `mounts.*` (url, target, path, rev, `rev_lock`
  pin, include, exclude), `routes.*` (path → remote) and `git.ignore_patterns`.

Remote URLs support `${VAR}` interpolation, with exactly-once expansion and no defaults
[V:docs `references/remote-providers.mdx`].

### 3.3 Local layout [V:run]

```text
.gat/.gitignore              "*"  (keeps all local storage out of git)
.gat/objects/blake3/xx/yy/<oid>   CAS objects, mode 0444 (gat-io/src/cache/object.rs:1839)
.gat/objects/cache.sqlite3   oid → StatProof (size + mtime ns); a derived accelerator, never a GC root
.gat/state/state.sqlite3     per-path desired/materialized ledger (WAL)
.gat/state/sync.lock         repository lock file
.git/info/exclude            managed block "# >>> gat >>>" with one "/path" per tracked file
.git/info/attributes         managed block: /gat.lock merge=gat-lock text eol=lf (+ /gat.lock/**)
.git/hooks/post-{checkout,merge,rewrite}   managed block: gat hook <name> "$@" || exit $?
.git/config                  merge.gat-lock.driver = gat merge-driver %O %A %B
```

`state.sqlite3` schema [V:src `gat-io/src/state/schema.rs:73-190`]:

- `state(path PK, desired_oid, desired_shard_id, materialized_oid, materialized_proof,
  dirty GENERATED STORED)`, with a partial index on `dirty = 1`.
- `lock_shards(shard_id, identity = BLAKE3(raw shard bytes), proof)`, so unchanged
  shards are never re-parsed.
- `reconciliation_meta`: an XOR set-accumulator fingerprint of the desired lock (O(k)
  update per changed shard), plus a fingerprint of the exclude block.
  A clean `gat sync` is O(1); 3,000 files took 0.034 s [V:run].
- `StatProof` is `(size, mtime_secs, mtime_nanos)` and is accepted only from a “coherent
  observation” (stat, read, stat again; it fails closed if they differ)
  [V:src `gat-io/src/file_state.rs:54-64`].

### 3.4 Remote layout [V:src, V:run]

The key is `<url-prefix>/blake3/<h0h1>/<h2h3>/<64-hex oid>`, built by
`gat-io/src/cache/layout.rs` `object_key_oid`. The same layout serves the local cache
and every remote. A file remote after one push:

```text
remote/blake3/03/e0/03e05031a3a5dc38bcefb4af91ed2a388b44c995b851487a1b4516a3d2bde550
remote/blake3/70/e2/70e2e309fe28131da2cd7c825c67df15974aaab935bd01585604450021772b55
```

- **No filename, extension, path or metadata** is stored anywhere in the remote.
  It is not browsable, and reverse mapping needs a lock from git [V:run].
- **No compression**: grep for `zstd|compress` finds nothing [V:src].
- **No tree or manifest object** is stored remotely.
  The lock lives only in git.
- **Keys are never stored in the lock.** Route or remote selection is config, and the
  key is a pure function of the OID. This means there is no two-phase commit: `gat add`
  writes the final lock row before any upload [V:src, V:run].

* * *

## 4. Command lifecycles

The CLI surface is `init add rm remote selection config status diff ls-files push fetch
pull gc sync system mv mount route`, plus hidden `hook` and `merge-driver`
[V:run `gat --help`; V:src `src/cli.rs:309-906`]. The only global flag is
`-o/--full-output`. There is **no `--json`**. `ls-files` is documented as “a human
report, not a plain path stream for scripts” [V:docs `commands/ls-files.mdx`].

| Command | Lifecycle (what it reads → writes) |
| --- | --- |
| `init [--no-hooks] [--no-merge-driver] [--example-config]` | Idempotent convergence. It installs or removes the three hook blocks, the `merge.gat-lock.*` git config and the `info/attributes` block, and creates `.gat/`. It never touches an existing `gat.yaml` [V:src `src/cli.rs:310-357`, `gat-engine/src/initialization.rs:186-240`]. It must be re-run in every clone [V:docs]. |
| `add PATH…` | Expands paths, dirs and quoted globs, filtered by `.gatignore` and git ignores (`--force` bypasses only within scope). It refuses git-tracked files, symlinks and `.git`/`.gat`/`gat.lock`/`gat.yaml`. **Ingest** is `safe` by default: copy into the cache, then hash the copy, so the OID describes the published bytes. It then publishes lock rows atomically, records materialized ownership in `state.sqlite3`, and regenerates the `.git/info/exclude` block. **No network** [V:docs `commands/add.mdx`, `guides/improving-performance.mdx`]. Took 0.59 s for 3,000 × 2 KB files [V:run]. |
| `rm [--cached] PATH…` | The lock is updated first, then working files are deleted (`--cached` keeps them). A partial failure is reported per stage and repeating the command does not resume it [V:docs `commands/rm.mdx`]. |
| `mv SRC DEST` | Moves the lock rows and the files. OIDs are unchanged. It rolls back on a publish failure [V:docs `commands/mv.mdx`]. |
| `status [--remote]` | Compares the **working lock with the index’s staged lock**. It does **not** inspect payload bytes: an edited `models/m1.bin` showed “no changes” in `gat status`, `gat diff` and `git status` [V:run]. `--remote` checks object presence for the current lock or a history selection. |
| `diff [REV [REV]]` | Semantic map diff of lock versions (`M big/f0042.bin changed`) [V:run]. |
| `push` | Objects for the **current working lock** only, unless history flags (`--rev/--branches/--tags/--all-history/--depth/--since…`) are given. Per object: re-verify the cached object in batches of 128 (`gat-engine/src/transfer/publish.rs:20`), presence check (`exists` = HEAD; `gat-io/src/remote.rs:649-654`), then a **create-only write** (`if_not_exists` when the backend supports it; a conflict counts as success; `gat-io/src/remote/transfer.rs:185,250-262`). Multipart starts at 64 MiB with 8 MiB parts × 4 (`gat-io/src/remote/tuning.rs:79-95`). Mount-owned paths are skipped. A `file://` remote stages and renames, which “may replace an existing object” [V:docs remote-providers]. |
| `fetch` | Downloads into the cache and **verifies BLAKE3 before publishing** (`HashMismatch`; `gat-engine/src/transfer/receive.rs:15`, `download.rs:125`). History flags prefetch older versions. **Fail-fast:** one missing object aborted the batch after 282/2,999 objects [V:run]. |
| `pull` | `fetch` then `sync`. It worked in a fresh clone **without** `gat init` [V:run]. |
| `sync [--fetch] [--repair] [--force] [--trust-state] [--rematerialize] [--dry-run]` | Plans per path from (lock, state ledger, disk) into Materialize, Replace, Remove, Rematerialize, Conflict, MissingObject or Corrupted [V:src `gat-engine/src/workspace/sync/mod.rs:209-246`]. It uses the cache only unless fetch is enabled, never overwrites local edits without `--force`, and exits 1 when incomplete [V:run]. |
| `gc [--remote R] [--unsafe] [--repository LOC…] [history flags] [--no-history] [--dry-run]` | Keep set = objects referenced by the selected history (default: all refs, full ancestry) plus the current working lock, plus HEAD or history of each listed `--repository` (bare-cloned temporarily). Remote deletion requires `--unsafe`. There is **no grace period or age check**, so a concurrent push or unpushed branches elsewhere are unprotected [V:docs `commands/gc.mdx`; V:src no `grace`/`mtime` in `gat-engine/src/gc.rs`; V:run “requires --unsafe”]. |
| `system inspect\|repair\|clean` | Lock, state, cache and Git health; repairs interrupted lock-reshape transactions; `clean --purge-objects` [V:docs, V:run]. |
| `remote`, `route`, `selection`, `mount`, `config` | Typed resource CRUD over the three config scopes. `mount add NAME GIT_URL [TARGET]` imports another repo’s lock rows, pinned by `rev_lock`, read-only by ownership [V:docs `guides/consuming-gat-assets.mdx`]. |
| `hook <name> [args]` (hidden) | A `sync` run with the default selection. **Hook args are ignored** (`src/app.rs:836`). It reads stdin for post-rewrite and swallows auto-fetch errors (`gat-command/src/sync.rs:207-217`). It never fails for per-file problems [V:src]. |
| `merge-driver %O %A %B` (hidden) | See §6. |

**Interrupts:** the first Ctrl-C is a cooperative cancel (exit 130). A journaled lock
reshape or mount update finishes its critical section first
[V:docs `how-gat-works.mdx`].

* * *

## 5. Git integration and hook flow

| Event | Gat behavior | Evidence |
| --- | --- | --- |
| `git checkout`/`switch` | `post-checkout`: sync from the cache. Branch switching removed and materialized files correctly | [V:run] |
| `git merge`, `git pull` (merge) | `post-merge`: sync. A stopped (conflicted) merge runs no hook, so you `gat pull` after resolving | [V:run, V:docs] |
| `git rebase`, `commit --amend` | `post-rewrite`: sync. Rebase also fires `post-checkout` when it checks out the base. We saw one sync at the start and one at the end, not one per picked commit | [V:run] |
| `git cherry-pick`, `reset --hard`, `restore`, `stash` | **No hook.** After a cherry-pick, `d/t1.bin` was in the lock but missing on disk until the next checkout or sync | [V:run, V:docs] |
| `git commit` | **No pre-commit check.** A modified-but-unadded payload commits silently | [V:run] |
| `git push` | **No pre-push check.** `gat status --remote --rev HEAD` reported “1 of 2 object(s) missing” and nothing stopped `git push` | [V:run] |
| `core.hooksPath` set | Hooks are still written to `.git/hooks` (`gat-io/src/git/integration.rs:150-160` uses `common_dir/hooks`), so **they never run** | [V:run] |
| `gat` not on PATH | `.git/hooks/post-checkout: 3: gat: not found`, but the checkout still completes | [V:run] |
| Fresh clone, no `gat init` | No driver, no attributes and no hooks. Text merges; nothing hydrates | [V:run] |
| Linked worktree | It gets its own `.gat/` (own cache, so it re-downloads everything). But the `info/exclude` block is in the **common dir**. A `gat sync` in the main worktree rewrote the block from main’s lock, and the linked worktree then showed `?? d/`, so `git add -A` there would commit payloads into git | [V:run; V:src `gat-io/src/git/exclude.rs:135`] |
| CI | `gat init` is not needed for `gat pull`. Use `--path`/selections to limit the working set. Credentials come from the environment, AWS profiles or ADC. **AWS SSO and `credential_process` are not loaded directly**; the docs suggest `aws configure export-credentials` | [V:run, V:docs remote-providers] |

Gitignore handling uses **one exact rule per tracked file** in `.git/info/exclude`.
`git.ignore_patterns` can collapse these into directory rules.
Nothing is committed, so other git clients, IDEs and fresh clones see payloads as
untracked until `gat init` or `gat add` runs
[V:docs `guides/improving-performance.mdx`; I]. `.gatignore` filters ingest only.

* * *

## 6. The merge driver (source)

**Installation** [V:src `gat-io/src/git/integration.rs:11-13,212-290`]:

- git config `merge.gat-lock.name` and
  `merge.gat-lock.driver = gat merge-driver %O %A %B`.
- `$GIT_COMMON_DIR/info/attributes` gets `/gat.lock merge=gat-lock text eol=lf` and
  `/gat.lock/** merge=gat-lock text eol=lf`.
- **Nothing is committed** to `.gitattributes`.
- `%P` and `merge.gat-lock.recursive` are not set.
  Git then uses the same driver for virtual-ancestor merges [I: git semantics].

**Algorithm** (`gat-core/src/lock/merge.rs:66-112`, wrapped by
`gat-engine/src/merge_driver.rs:59-72`):

1. Read each stage. An absent or empty stage means an empty lock
   (`merge_driver.rs:42-57`). Each stage is strictly parsed, so a malformed side fails
   the driver.
2. Build the union of paths across O, A and B with values `Option<Oid>`
   (`merge.rs:69-74`).
3. Per path (`merge.rs:80-95`):
   - `ours == theirs` → keep it (line 80). This includes both sides deleting it, or
     identical adds.
   - else `ours == ancestor` → take theirs (82).
   - else `theirs == ancestor` → take ours (84).
   - else → `Conflict{path, ancestor, ours, theirs}` (87). This covers modify/modify,
     add/add with different content, and modify/delete.
4. If there are any same-path conflicts, return `MergeConflict::Paths` (105) **before**
   the prefix check. Otherwise check the merged map for a file/directory-prefix collision
   (`directory_prefix_conflict`, 107-112, 119-145).
5. On success, publish canonical sorted output atomically to `%A` (`merge_driver.rs:68`)
   and exit 0. On failure, **leave `%A` byte-for-byte unchanged** (test
   `merged_prefix_conflict_preserves_ours_byte_for_byte`), print the conflicting paths
   to stderr with the hint “resolve the conflicting paths manually in the merged
   gat.lock, then stage it” (`src/error/map/commands/merge_driver.rs:63`), and exit
   non-zero.
6. With sharding, git invokes the driver **once per shard file**. The driver validates
   only that file. Cross-shard prefix conflicts and shards git merged without the driver
   are left to the next lock read
   [V:docs `guides/branching-and-merging.mdx`; V:run (l)].

* * *

## 7. Merge workflows in Gat (tested)

**Setup:** a real `gat 0.0.15` binary, `file://` remote, git 2.43, fresh repo per
scenario. The base tracks `assets/2026-10-01-batch.bin`, `assets/2026-10-02-batch.bin`,
`d/a.bin`, `d/b.bin` and `d/c.bin`. Scripts and full transcripts are in Appendix A.
Rules are cited by `merge.rs` line.

- The “with driver” column is all [V:run].
- In the “without driver” column, rows a and b (via `run2.sh` 1b: same-gap adds and
  adjacent edits), h, h2 and i are [V:run].
- The other “without driver” cells are [I]: standard git text-merge behavior, where
  changes to the same or adjacent lines conflict.

| # | Scenario | With driver (`gat init` done) | Without driver (text merge) | Rule |
| --- | --- | --- | --- | --- |
| a | Both add adjacent-sorting files `2026-10-03-batch-left/right.bin` | **Clean**; both rows; post-merge hook materialized the new file | Conflict (same gap) [run2 1b] | 82/84 |
| b | Edit `d/a.bin` vs edit `d/b.bin` (adjacent rows) | **Clean**; hook replaced 1 file | Conflict (adjacent lines) | 82/84 |
| c | Both edit `d/b.bin`; theirs also adds `d/z.bin` | **Conflict**; `UU gat.lock`; file = ours, unchanged; **`d/z.bin` absent** | Conflict with markers | 87 |
| d | Delete `d/c.bin` vs modify it (both directions) | **Conflict**: `ours=blake3:…, theirs=deleted` | Conflict | 87 |
| e | `gat mv a→a-renamed` vs edit `a` | **Conflict** on `d/a.bin` (modify vs delete). Rename is not tracked as a rename | Conflict | 87 |
| e′ | `gat mv` vs edit of another file | **Clean** | Usually clean | 82/84 |
| f | Identical add of `d/new.bin` both sides | **Clean** | Clean (git sees an identical change) | 80 |
| f′ | Same path, different content | **Conflict** | Conflict | 87 |
| g | `git rebase main` (2 lock commits each side) | **Clean**. Hooks synced at the start (`post-checkout`) and the end (`post-rewrite`) | Likely conflicts | 82/84 |
| g′ | `git cherry-pick` of a lock commit | **Clean** lock, but **no hydration** (`d/t1.bin` missing on disk) | — | — |
| g″ | Cherry-pick touching a path changed here | **Conflict** (`UU gat.lock`) | Conflict | 87 |
| h | Fresh clone, no `gat init`: adjacent edits plus adds | — | **Conflict with markers** in `gat.lock` | n/a |
| h2 | Repo **commits** `.gitattributes` `merge=gat-lock`, driver undefined locally | — | Silent fallback to text merge, same conflict as (h). No error about the missing driver | n/a |
| h3 | Same clone after `gat init` | **Clean**; hook then reported “Missing objects: 7” (empty cache) until `gat pull` | — | — |
| i | Ancestor `assets/p.x`; left adds file `assets/p`, right adds `assets/p/inner.bin` | **Refused**: “Merge would track a file and its descendant” | **“Merge made by ort”** → **invalid lock**; hook prints “✗ error: Could not read gat.lock”; `gat status`, `gat sync` and `gat rm` all refuse (“gat.lock is corrupted”) | 107 |
| j | Fast-forward to a teammate’s branch whose object is not cached, plus a local edit to a payload the branch changes | Hook: “Missing objects: 1 … Conflicts: 1”. `gat pull` fetched and materialized the rest and kept the edit as a conflict; `--force` needed to overwrite | — | sync |
| l | Sharded (depth 1): both edit `d/b.bin`, plus independent adds | Conflict **localized to `gat.lock/50.tsv`** (`UU`); the new shard `a8.tsv` merged without the driver | — | 87 |
| l′ | Sharded: left adds file `q`, right adds `q/inner.bin` (different shards) | **Clean merge despite the driver** → invalid lock → “Could not read gat.lock” | — | gap |

**(j) Hydration and network.** The merge driver never touches the network or payloads
[V:src]. Hydration happens only in the `post-merge`, `post-checkout` and `post-rewrite`
hooks, from the cache.
Fetching happens only if `sync.auto_fetch` is true; fetch errors in hooks are swallowed
(`gat-command/src/sync.rs:207-217`). Otherwise the user runs `gat pull`. A conflicted
merge runs no hook, so the user must `gat pull` after committing the resolution
[V:docs]. Locally modified payloads are never overwritten without `--force`, and
corrupted cache objects need `--repair` [V:run].

**(k) Conflict UX, exactly as shown** [V:run]:

```text
$ git merge --no-edit left
✗ error: gat.lock semantic merge conflict (1 path(s) changed incompatibly on both sides)

  d/b.bin: ours=blake3:67d5f186…, theirs=blake3:70bc18ae…

hint: resolve the conflicting paths manually in the merged gat.lock, then stage it
Auto-merging gat.lock
CONFLICT (content): Merge conflict in gat.lock
$ git status --short
UU gat.lock
$ git diff            # combined diff is EMPTY: the file equals ours
$ gat status          # shows "M d/b.bin" vs the index; nothing says "conflict"
$ gat sync --dry-run  # "Sync preview (no changes)"
```

- **There is no `gat resolve` and no `--ours`/`--theirs` per path.** The documented
  procedure is to `git show :1:/:2:/:3:gat.lock`, hand-edit the 64-hex TSV in canonical
  order, `git add`, `gat pull`, and then commit [V:docs `branching-and-merging.mdx`].
- **Hazard [V:run]:** the conflicted file contains *ours only*. *Theirs’* independent
  clean changes (`d/z.bin`) are in none of the working-tree text.
  Running `git add gat.lock && git commit` succeeded and **silently dropped `d/z.bin`**.
  The driver computed the clean part of the merge and then threw it away.
- The docs warn that a conflicted lock “can still look syntactically valid”; blobsy’s
  prototype avoids this (§10).

**(i) GitHub web merges, merge queues and server-side rebases** do not run local merge
drivers
[I: driver config lives in each clone’s `.git/config`; GitHub’s server merge has no hook for custom drivers].
They behave like scenario (h)/(i): either a false conflict the user resolves in the web
editor (hex rows), or a clean text merge.
A clean text merge is usually correct for sorted rows
[V:run (h): independent non-adjacent changes merged], but can be invalid (prefix
collisions) [V:run (i)].

**Takeaways for blobsy:**

1. A path-keyed driver turns all the “false conflicts” of sorted manifests (a, b, g)
   into clean merges. This is the main value, and Gat proves it works.
2. The driver is opt-in per clone and invisible to hosted merges.
   A design must (i) stay correct under plain text merge, and (ii) validate the merged
   result in a pre-commit or CI check, which Gat lacks.
3. Leaving `%A` untouched on conflict is the wrong choice.
   Write the merged result with per-path conflict blocks so a careless `git add` is
   caught by validation.

* * *

## 8. Push, pull and sync semantics; failure modes

- **Atomicity:**
  - Cache publish is staged and renamed.
  - Lock publish is atomic, with journaled reshape transactions recoverable by
    `gat system repair`.
  - Remote writes are create-only where OpenDAL reports `write_with_if_not_exists`.
  - A per-repo `sync.lock` serializes mutations.
  - `add`, `rm` and `mv` publish the lock first and then do cleanup.
    Failures are stage-reported, not rolled back.

  [V:src, V:docs `commands/rm.mdx`, `add.mdx`]

- **Verification:** the cache is re-verified before upload.
  Downloads are hashed before cache publish.
  `StatProof` lets unchanged files skip hashing.
  `gat status --remote` checks presence only and never rehashes remote bytes [V:src].

- **Partial or sparse:** `--path/--include/--exclude` and saved `selections` (with a
  default) apply to sync, pull, fetch, push, status, diff and ls-files.
  Hooks honor the default selection.
  Excluded paths keep stale versions [V:docs `concepts/path-selection`].

- **Concurrency:** up to 256 requests, 128 local transfer workers
  (`gat-engine/src/limits.rs:34`) and batched presence checks.
  3,000 small files pushed to `file://` in 0.58 s and pulled in 1.25 s [V:run]. Small
  files are still one object each, with no packing [V:src].

- **Many small files and PAIN-2:** a 3,000-file collection is one lock file.
  A one-file update is a 1-line diff, and `git status` stays fast (0.06 s with 3,000
  exclude rules) [V:run].

- **Removal and history (PAIN-3):** removal is `gat rm` plus `gat gc --remote …
  --unsafe` with history protection.
  History keeps only paths and hashes.
  There is no history-rewrite tooling and none is needed [V:docs].

- **LFS and DVC migration:** documented step-by-step guides (`git lfs pull`, then
  `untrack`, `git rm --cached`, `gat add`). They migrate only the current revision, with
  no history import
  [V:docs `guides/migrating-from-git-lfs.mdx`, `migrating-from-dvc.mdx`].

- **Failure modes observed [V:run]:**
  1. A missing remote object makes `fetch` fail fast (282/2,999 fetched).
  2. An invalid merged lock blocks every command except hand-edits, with no reason shown
     (`gat system inspect lock` says only “could not load the live lock”).
  3. A missing `gat` binary in hooks is non-fatal noise.
  4. Unpushed objects are discoverable only via `gat status --remote --rev HEAD`.

* * *

## 9. Agent-friendliness

**Good** [V:run, V:docs]:

- The CLI is non-interactive; there are no prompts.
- Human output is consistent (`✓`, `!`, `✗`, `hint:`), meaningful exit codes are set
  (`sync` exits 1 when incomplete), and lifecycle notices go to stderr only.
- `NO_COLOR` is honored, `--dry-run` is widely available, and the docs site has an MCP
  search server.

**Weak:**

- There is no `--json`, and `ls-files` is explicitly not machine-readable.
- Output truncates rows by default (`-o` shows everything).
- Error messages hide causes (“Could not read gat.lock”).
- There is no in-repo skill, and the pointer files are not self-describing (the lock has
  no comment header).
- An agent cannot ask “what is unpushed?”
  cheaply without history flags.

Blobsy’s `--json`, skill text and self-documenting `.bref` header are a clear advantage.

* * *

## 10. What blobsy would ideally do for merges (vs Gat)

The blobsy UC-2 prototype (`scratchpad/uc2-merge/merge-manifest.mjs`, reviewed
read-only) uses the **same per-path rules as Gat** (`merge.rs:80-95`). It differs in
conflict handling:

- **Gat:** if any path conflicts, `%A` is left as ours.
  Theirs’ clean changes are lost from the working text.
  There are no markers, and a naive `git add` drops data [V:run].
- **Prototype:** it writes the **full merged result**, with per-path `<<<<<<<` blocks
  only for conflicting paths, and exits 1. A naive `git add` commits markers that a
  validator (pre-commit or `blobsy doctor`) rejects.
  It also keeps the header from `%A` and re-sorts, so insertion position cannot
  conflict.

Recommended blobsy rules, combining the best of both:

1. Use Gat’s per-path rules.
   Also check the merged result for the file/directory-prefix collision
   (`merge.rs:107`), and treat it as a per-path conflict block rather than a whole-file
   failure.
2. Write merged output plus per-path markers, as in the prototype.
   Add `blobsy merge resolve <manifest> [--ours|--theirs] [PATH…]`, which re-parses a
   marker file (also from GitHub’s editor) and applies choices.
3. Put `merge=blobsy-manifest` in the **committed** `.gitattributes`. Undefined drivers
   fall back to text merge silently [V:run (h2)], so committing is safe.
   Every clone with blobsy installed then gets the driver after `blobsy setup`, and
   nothing has to be redone per clone except the git config line.
4. Use the pre-commit hook and a CI check (`blobsy manifest check`) to validate
   ordering, duplicates, prefix collisions and markers.
   This catches hosted-merge outcomes (scenario i) that no driver can see.
   Gat has no such guard.
5. Keep manifest rows path-first with size and mode
   (`path<TAB>size<TAB>sha256<TAB>mode`). Text merges then behave like Gat’s rows, but
   reviewers see the path first and the size, and the exec bit survives.
6. Hydrate after merge only from cache, and only in an opt-in hook.
   Never fetch inside the driver.
   This matches Gat and is right.

* * *

## 11. Comparison with blobsy by pain point and use case

|  | Gat | Blobsy today | Who is better |
| --- | --- | --- | --- |
| PAIN-1 no big files in git | Yes; every tracked file is excluded | Yes; gitignore line plus `.bref` | Tie |
| PAIN-2 file counts, PR noise | One lock; 1 line per changed file; shards at scale | One `.bref` file per payload, so N files in the PR | **Gat** (until blobsy ships `.btree`) |
| PAIN-3 removal | `rm` plus history-aware remote GC (needs `--unsafe`) | Delete remote object; GC | Tie; Gat’s history-protected GC is more complete [I] |
| PAIN-4 not LFS | No filters, no server | Same | Tie |
| PAIN-5 pluggable backends | 5 OpenDAL schemes, closed set; no command or rclone backend; no AWS SSO | S3 SDK, aws-cli, rclone (GCS/Azure/…), local, command templates | **Blobsy** |
| UC-1 per-file refs | Lock rows (one file holds all) | `.bref` beside each file | Blobsy for discoverability and driverless merges; Gat for scale |
| UC-2 one manifest for N files | Native | Not yet (`.btree` proposed) | **Gat** |
| UC-3 trees with no manifest in git | **None** | Round 8 mirror mode proposed | Blobsy (if built) |
| UC-4 merges | Semantic driver, but opt-in per clone, unsafe conflict UX, invalid locks from hosted merges | Text merges of independent `.bref` files: always clean and valid on any host; same-file conflicts are tiny YAML | **Gat for UC-2-shaped data; blobsy for UC-1 robustness** |
| UC-5 immutable named assets | Partially: `mount` pins another repo’s lock at `rev_lock` (experimental); CAS is immutable | Immutable keys (invariant 12); no naming layer | Neither complete |

* * *

## 12. Design comparison: is Gat’s design better?

| Decision | Gat | Blobsy | Better | Why |
| --- | --- | --- | --- | --- |
| **Unit of reference** | One lock (sharded at scale) | One `.bref` per file | **Neither alone. Gat for UC-2 and scale; blobsy for UC-1** | One lock removes PAIN-2 noise and is fast (O(1) clean sync). But it concentrates every change in one conflict hotspot that needs a per-clone driver, and hosted merges can corrupt it [V:run i, l′]. Per-file brefs merge trivially everywhere and sit beside the payload. Blobsy’s planned dual model (`.bref` for UC-1, `.btree` for UC-2) is the best of both, *if* `.btree` gets Gat-grade rigor. |
| **Key derivation vs stored `remote_key`** | Key = f(OID); nothing stored | Timestamped template result stored in `.bref` after push | **Gat** | Derived keys remove the two-phase commit (track, push, re-commit), make `.bref`/manifest final at `add` time, and make dedup and presence checks trivial. Blobsy should derive keys. Browsable layouts can still be derived, e.g. `{sha256}/{filename}` is a function of committed data. |
| **Hash function** | BLAKE3 | SHA-256 | **Blobsy (keep SHA-256)** | BLAKE3 is faster, but SHA-256 matches Git LFS OIDs (zero-rehash LFS import), S3/GCS native checksum headers (`x-amz-checksum-sha256`) for server-side verification, `sha256sum` everywhere, and Node’s built-in crypto with no native or wasm dependency [I]. Gat’s speed advantage matters at TB scale, which is not blobsy’s target. |
| **Local CAS cache** | `.gat/objects`, shareable, reflink/hardlink materialization, offline branch switching | None (payload only in the working tree) | **Gat** | Branch switches and merges hydrate offline. Re-adding identical bytes is free. The cache enables verified prune. Cost: 2× disk with `copy` (reflink avoids it). Blobsy should add an optional shared cache. |
| **Hook set** | post-checkout, post-merge, post-rewrite (hydrate) | pre-commit verify, pre-push upload | **Neither; union is ideal; blobsy’s is more important** | Gat lets unpushed and unadded content escape [V:run]. Blobsy has no hydration. Blobsy also honors `core.hooksPath`; Gat silently doesn’t [V:run]. |
| **Merge driver** | Shipped, rigorous rules, tested | None | **Gat today; blobsy’s prototype UX is better** | The rules are identical. Gat’s keep-ours-on-conflict UX loses data on naive resolution and has no resolve command; markers plus validation are safer (§10). |
| **Config model** | Global/project/local YAML, typed resources managed by CLI, `${VAR}` URLs | File/dir/repo/home `.blobsy.yml` hierarchy (subdir configs being dropped) | **Gat** | Three scopes plus `--local` cover machine-specific URLs and credentials without per-directory walks. Blobsy should converge on this, keeping only rule lists such as compression patterns. |
| **Backend abstraction** | OpenDAL in-process (S3, Azure, GCS, OSS, fs) | S3 SDK, aws-cli, rclone, local, command templates | **Blobsy for pluggability; Gat for in-process robustness** | Gat gets conditional writes, multipart and retries, but a closed set: no SSO, no rclone breadth, no escape hatch. Blobsy’s command backend is unique (PAIN-5). Adopt create-only conditional PUT in the S3 path. |
| **Single binary** | 8 targets, checksum-verified installer | Node ≥24 | **Gat** | It is the category norm. Blobsy should ship a SEA or `bun --compile` build. |
| **PR diff readability** | 1 line per change, but 64-hex first and path last; no size; hash-named shards | One small YAML diff per file; path in filename; size shown | **Gat at scale; blobsy per entry** | The ideal is blobsy’s planned path-first TSV with size, in one file, with readable shard names (by top directory). |
| **Remote browsability** | Opaque `blake3/xx/yy/oid`, no names | Path-shaped or `{hash}/{filename}` options | **Blobsy** | This is a stated blobsy principle; Gat buckets are unreadable without git. |
| **Agent UX** | Human-only output, docs MCP | `--json`, skill, self-documenting brefs | **Blobsy** | Agents need structured status and unpushed reports. |

**Tally:** Gat is better on 5 decisions (key derivation, CAS cache, merge driver as
shipped, config model, single binary) and on UC-2 scale.
Blobsy is better on 4 (hash interop, browsability, agent UX, backend pluggability) and
on safety hooks. Two are split (unit of reference, PR diff).

* * *

## 13. Gaps, bugs and design weaknesses in Gat (with evidence)

1. **Naive conflict resolution drops the other side’s clean changes.** The driver leaves
   `%A` as ours (`merge_driver.rs:59-72`). Tested in (c): `d/z.bin` was lost [V:run].
2. **Hosted or driverless merges can produce an invalid lock** that blocks all gat
   commands, with an error that names no cause [V:run i]. The same happens across shards
   *with* the driver [V:run l′].
3. **`core.hooksPath` is ignored**, so hooks are silently inert [V:run].
4. **Linked worktrees** share `info/exclude` but have separate locks and state, so
   payloads appear untracked in sibling worktrees.
   Each worktree also has its own cache and re-downloads [V:run].
5. **No pre-push or pre-commit guards.** Unpushed objects and unadded edits ship
   silently. `gat status` and `gat diff` never look at payload bytes [V:run].
6. **The executable bit is not recorded**, and symlinks are unsupported [V:run, V:src].
7. **`fetch` fails fast** on the first missing object [V:run].
8. **Cherry-pick, reset, restore and stash do not hydrate** (no hook exists)
   [V:run, V:docs].
9. **Remote GC has no grace period.** It protects only refs visible locally (including
   remote-tracking refs) plus listed repositories.
   Objects a teammate uploaded with `gat push` but whose commits are not yet in any
   visible ref are deletable with `--unsafe`. So are uploads that race the GC
   [V:docs, I].
10. **Every clone must run `gat init`.** The merge attributes are local, not committed,
    and nothing warns when they are absent [V:run h, h2].
11. **No size in the lock**, so there are no review-time size signals, no download-size
    planning and no cheap truncation check [V:docs spec].
12. **Credentials:** no direct AWS SSO or `credential_process` support.
    S3 requires an explicit region [V:docs].
13. **Maturity risk:** v0.0.x, one maintainer, a very large codebase, and many
    experimental features [V:web, I].

* * *

## 14. Borrow, differentiate, interoperate

### 14.1 Borrow (concrete)

1. **Derived keys.** Default `key_template` becomes a pure function of committed data,
   e.g. `sha256/{content_sha256}` or `{content_sha256}/{filename}`. Drop `remote_key`
   from new `.bref`s, or keep it only as an override.
   This kills `blobsy-pqyt`’s two-phase commit.

2. **Lock rigor for `.btree`.** Adopt the following from Gat:
   - an exact version line;
   - strict bytewise ordering;
   - control-only `\xhh` escaping;
   - CRLF-tolerant reads with LF writes;
   - duplicate and prefix-collision rejection, including non-adjacent cases;
   - semantic equivalence across shard shapes;
   - shape detected per revision.

   Keep the columns path-first, with size and mode.

3. **Merge rules** from `merge.rs:80-112`, with blobsy’s marker and validation UX (§10).

4. **Sync planning taxonomy**: Materialize, Replace, Remove, Conflict, MissingObject and
   Corrupted, with a `--dry-run` that prints it.
   A **coherent stat proof** (size + mtime ns, re-stat after read).
   A **desired-state fingerprint** for O(1) clean status.

5. **Hydration hooks** (post-checkout, post-merge, post-rewrite) as opt-in.
   Cache-only by default, honoring `core.hooksPath`, and never failing git.
   Keep blobsy’s pre-commit and pre-push hooks.

6. **Optional shared CAS cache** with reflink-then-copy materialization.

7. **Create-only conditional writes** (`If-None-Match: *`). Gat treats a conflict as
   success, which is right for CAS.

8. **Config scopes** global/project/local with `--local`, and `${VAR}` URL templating
   with strict grammar.

9. **History-aware GC** with explicit `--repository` peers and a dry-run default.
   Add the grace period Gat lacks.

10. **Single-binary distribution** with a checksum-verified installer.

### 14.2 Differentiate (keep)

- Per-file `.bref` for UC-1. It merges on every host with no driver.
- Browsable remotes.
- Command and rclone backends.
- Compression.
- Pre-commit and pre-push guard rails.
- `--json` and the skill.
- UC-3 mirror mode with receipts, which Gat lacks entirely.
- SHA-256 for LFS and S3 checksum interop, including an LFS history-aware import Gat
  lacks.

### 14.3 Interoperate?

Reading `gat.lock` is about 50 lines (TSV plus `\xhh` decode).
But BLAKE3 OIDs do not match blobsy’s SHA-256, so an import must download and rehash,
and Gat’s user base is tiny today [V:web]. **Recommendation:** no interop work now.
Revisit if Gat passes roughly 2k stars or a 0.1 release [I]. Do not adopt lock-v1
itself: it is digest-first, sizeless and modeless, and blobsy should not inherit those
choices.

### 14.4 Does Gat make parts of blobsy’s roadmap redundant?

Partly, yes. A “serverless LFS replacement with one manifest and a merge driver for
S3/GCS/Azure” already exists and is better tested (2.4k tests, 3-OS CI) than blobsy
would be for months [V:src, I]. Building `.btree` plus a driver only to match that would
be redundant. **`.btree` is justified only bundled with blobsy’s differentiators:**
path-first rows with size, guard-rail hooks, driver-independent validation, browsable
keys, command backends, `--json`, and sharing UC-3 mirror infrastructure.
UC-3 and command backends are uncontested by Gat.

* * *

## 15. Overall verdict

Gat’s design is **better engineered and more coherent than blobsy’s current design for
the repo-files core (UC-1, UC-2, UC-4)**. It derives keys instead of storing them, keeps
collections in one manifest, caches content locally, hydrates on checkout, and ships as
one binary. Those are design wins, not just implementation polish.

Gat is **weaker** on four fronts:

- **Safety at the edges:** no push or commit guards, a data-losing conflict UX, invalid
  locks from hosted merges, worktree exclude clobbering, and ignoring `core.hooksPath`.
- **Transparency:** opaque remote, no size or mode, human-only output.
- **Pluggability.**
- **UC-3**, which it does not cover at all.

Blobsy should treat Gat as proof that the manifest-plus-driver model works.
It should copy its key and lock decisions and compete on safety, transparency,
pluggability, agent UX and UC-3.

### 15.1 What should change in blobsy because of Gat

1. Make **derived, content-addressed keys** the default and drop the stored `remote_key`
   (resolves the two-phase commit).
2. Ship UC-2 **`.btree`** with lock-v1-grade strictness, path-first rows with size and
   mode, Gat’s per-path rules, **prototype-style markers**, `merge resolve`, a committed
   `.gitattributes`, and pre-commit/CI validation.
3. Add **opt-in hydration hooks** (post-checkout, post-merge, post-rewrite), cache-only,
   honoring `core.hooksPath`.
4. Add an **optional shared CAS cache** with reflink materialization.
5. Use **create-only conditional PUT** in the S3 path.
6. Collapse config to **global/project/local** scopes with `${VAR}` templates; drop
   subdirectory configs (consistent with Round 8).
7. Build a **single-binary** distribution.
8. Add a **desired-state fingerprint and coherent stat proofs** for O(1) clean status.

### 15.2 Keep as differentiators

- Per-file `.bref` for UC-1.
- SHA-256.
- Browsable or derived-browsable remotes.
- Command and rclone backends.
- Compression.
- Pre-commit and pre-push guards.
- `--json`, the skill and self-documenting pointers.
- UC-3 mirror mode with receipts.
- LFS history-aware import.
- Recording size and exec bit.

* * *

## Appendix A — Reproduction

- **Build:** `CARGO_TARGET_DIR=<scratch>/gat-target cargo build --locked --profile
  incremental --bin gat` in `attic/gat` (clone left unmodified).
  Result: `gat 0.0.15`, 29 MB.

- **Scripts** (session scratchpad, ephemeral):
  `/tmp/claude-0/-home-user-blobsy/0713c929-56bc-5939-ab24-7ac184df530b/scratchpad/exp/`
  - `run1.sh`: init, add, push, clone, pull, exec bit, edit visibility, branch-switch
    hook.
  - `run2.sh`: merge basics, text-merge fallback, `core.hooksPath`, sharding.
  - `run3.sh`: worktrees, push ordering, missing binary, 3,000-file scale, fetch
    fail-fast.
  - `merge.sh`: scenarios (a)–(l).

  Each has a matching `*.out` transcript.
  Environment: git 2.43, Linux, `file://` remotes only.
  Cloud backends were not exercised.

## Appendix B — Sources

- Source: `attic/gat` @ `982a3db` (shallow clone of https://github.com/getgat-dev/gat).
- Docs: `docs/` in repo (= https://getgat.dev), especially `spec/lock-v1.mdx`,
  `concepts/how-gat-works.mdx`, `concepts/automatic-sync.mdx`,
  `guides/branching-and-merging.mdx`, `guides/improving-performance.mdx`,
  `references/remote-providers.mdx`, `references/configuration.mdx` and
  `commands/*.mdx`.
- Releases: https://github.com/getgat-dev/gat/releases.
  PRs: https://github.com/getgat-dev/gat/pulls (fetched 2026-10-22).
- HN: https://hn.algolia.com/api/v1/search?query=getgat&tags=story (items 49609050,
  49868710).
- Blobsy UC-2 prototype (read-only): `scratchpad/uc2-merge/merge-manifest.mjs`,
  `run.sh`.
