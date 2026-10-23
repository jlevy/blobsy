# Blobsy v3 design review — simplicity and architecture lens

Reviewer stance: principal engineer, 2026-10-23. Reviewed `blobsy-design.md` (v3),
`plan-2026-10-22-blobsy-v3-redesign.md`, round 9 + `complexity.md` +
`redteam-findings.md`, the v2 archive, `packages/blobsy/src/`, and the Gat /
tree-manifest research.
No repo files were modified.
Severity: **must-change** (contradiction, or a concept that will force more concepts
later), **should-change** (real simplification, low cost), **consider** (judgment call).

## 0. Concept inventory of v3 as written

| Class | v3 items | Count | Verdict |
| --- | --- | --- | --- |
| Public commands | setup, add, rm, mv, push, pull, sync, status, diff, resolve, snap publish, snap restore, snap ls, snap show, gc, cache status, cache prune, import lfs, doctor, config, docs | 21 (18 “public” + sub-verbs) | → 13 (§P) |
| Hidden commands | hook, merge-driver (+ `--jj` form) | 2 | keep |
| Nouns | entry, ref, target, file ref / directory ref / pin ref, store, object, key, encoding, snapshot, cache snapshot / asset snapshot, name, stanza, tree_id, manifest (store), ref.yaml, hash cache, synced records, content cache, recoverability rule, validator, merge driver, managed gitignore block, large-file guard | 25 | → ~15 |
| Ref row kinds | `f x t l:<target> d` (two “snapshots only”) | 5 + a context rule | 5, no context rule |
| `extra` column meanings | `-`, `zstd`, snapshot name, (store manifest: mtime etc.) | 4 | 1 meaning ("storage locator") |
| Status states | `✓ ~ ↓ ↑ ! ?` + `remote: present/missing` | 6 + 2 | 5 |
| Config scopes / files | `~/.blobsy.yml` (+`$BLOBSY_HOME`), `.blobsy.yml`, `git-dir/blobsy/config.yml` | 3 | 2 (project YAML + git config) |
| Project config keys | backend, hash, compress.{min_size,always,never}, externalize.{min_size,always,never}, ignore, git_max_file_size, snapshots.<n>.{path,name,exclude,fallback} | 14 leaf | 9 |
| Machine config keys | cache.dir, cache.on_add, hydrate.fetch, parallelism, trust grants, backend override | 6 | 5 |
| Store-side formats | CAS object, `data.tar.zst`, `manifest.tsv.zst` (TSV + extra columns), `ref.yaml` (YAML) | 4 kinds, 3 syntaxes | 3 kinds, 1 syntax |
| Local state | hashcache (path→stat+hash **and** synced records), objects cache, local config | 3 | 2 |
| Flags (non-global) | setup ×3, add ×2, rm ×1, pull ×3, status ×4, resolve ×2, snap publish ×2, snap restore ×2, gc ×2, cache prune ×2, doctor ×2, config ×3, docs ×1 | 29 | ~17 |
| Hooks | pre-commit, pre-push, post-checkout, post-merge, post-rewrite | 5 | 5 |
| Env vars | BLOBSY_HOME, BLOBSY_NO_HOOKS, trust env | 3 | 2 |

v3 is a large improvement over v2 (~80 nouns → ~50), but it still carries one
contradiction, two formats that claim to be one, two caches that hold three kinds of
knowledge, and roughly eight commands/flags that exist only because v2 had them.

* * *

## 1. Findings

### 1. must-change — §9 / §11 / §17: `hydrate.fetch` puts the network inside git operations

**Problem.** Principle 8 ("network transfers happen only in commands that name them …
and the opt-in pre-push upload") and non-goal §17 ("network inside git operations") are
both violated by `hydrate.fetch: true`, which makes
`post-checkout`/`post-merge`/`post-rewrite` run a networked `pull`. It also adds a
config key, a hook branch, and a failure mode (a hung checkout on a dead network).

**Proposal.** Delete `hydrate.fetch`. §9 row 3 becomes:
“`blobsy pull --cache-only --quiet`. Never touches the network; never fails the git
operation; prints one line naming the entries still absent.”
Keep `pull` as the only way bytes arrive.

### 2. must-change — §4.4 / §4.2: the “one format” claim is false by two files; make it true

**Problem.** The store holds three text artifacts in two syntaxes: the `.bref` TSV, a
`manifest.tsv.zst` with *additional* columns (mtime “restore metadata”), and a YAML
`ref.yaml` with aggregates and provenance.
That is a second parser, a second validator, a second place `tree_id` is written, and a
YAML dependency on the hot restore path.
`ref.yaml` exists only because the manifest was assumed too large to be the commit
object; the mtime columns exist only because the tar was made deterministic (fixed
in-archive mtime) — and determinism of the archive buys nothing, since the archive is
stored under a *name*, not under its content hash.

**Proposal.**
- The snapshot’s store-side manifest **is a `.bref` file**: same header, same five
  columns, same parser/validator, same `tree_id` function.
  Name it `snap/<name>/manifest.bref` (zstd optional, by `.zst` suffix).
- It is written **last**, create-only; it *is* the commit point.
  Immutable, never merged, so aggregates are allowed in `#` header lines:
  `#files 14711`, `#bytes …`, `#archive data.tar.zst 39895989`, `#created 2026-…`,
  `#by ci@runner-7`, `#commit 04a3d1a`. Delete `ref.yaml`.
- The tar carries real mtimes (no deterministic-tar code).
  Whether restore applies them or sets “now” is a restore flag (`--mtime preserve|now`),
  decided after the cargo experiment.
- Publish race: on 412, read the existing manifest’s header `#tree_id`; equal → success.

Replacement text for §4.4 layout block:
```text
<prefix>/snap/<name>/data.tar.zst     archive of entries whose storage column is `pack`
<prefix>/snap/<name>/manifest.bref    written LAST, create-only; a .bref with header aggregates
```

### 3. must-change — §4.1: define the fifth column once, as “storage”

**Problem.** `extra` means encoding for `f/x`, snapshot name for `t`, nothing for
`l:`/`d`, and restore metadata in the store manifest.
Four meanings in one column is exactly the “overloading” the one-format claim must
avoid; every reader needs a `switch (kind)`.

**Proposal.** Rename `extra` → `storage` with one definition: *where/how the bytes are
kept; never part of identity (excluded from `tree_id`)*. Values:

| kind | storage | meaning |
| --- | --- | --- |
| `f`, `x` | `-` | own CAS object, raw |
| `f`, `x` | `zstd` | own CAS object, zstd |
| `f`, `x` | `pack` | inside the enclosing snapshot’s `data.tar.zst` (store manifests only) |
| `l` | `<link target>` | the symlink’s content is its target |
| `d` | `-` | — |
| `t` | `snap:<name>` | manifest at `snap/<name>/manifest.bref` |

Side effect: `kind` becomes exactly one character (`l:<target>` no longer smuggles data
into the kind column).
`size`/`hash` for `l` and `d` must be specified: `0` and `-`; the canonical line still
has four columns so `tree_id` is total.

### 4. must-change — §4.4 / §7.4: assets should not be forced into one tar

**Problem.** The headline UC-5 example is a 16 GB model directory pinned as one
`data.tar.zst`. For 10 × 1.6 GB `.safetensors` shards this is strictly worse than the
directory ref the design already has: no partial restore, no dedup between `v2` and `v3`
(which share most shards), a 16 GB archive duplicated in the content cache, and zstd on
incompressible data.
Packing is right for 15k tiny files (UC-3) and wrong for 10 huge ones.

**Proposal.** Packing is a *storage choice per snapshot*, not the definition of a
snapshot. `snap publish` writes a manifest whose rows use `pack` (archive) or `-`/`zstd`
(per-file CAS objects, exactly like `push`). Default: `pack` for cache stanzas, per-file
for `--name` assets; `--packed`/`--unpacked` override.
Restore: rows with `pack` come from the archive, others through the ordinary entry loop.
This is ~1 branch in restore and reuses `push`’s transfer wholesale.
It also means a directory ref and an asset snapshot of the same directory store the same
objects once (promotion is free, as §4.2 already promises).

### 5. should-change — §6: delete `sync`

**Problem.** `sync` is “pull then push, no logic of its own”.
No workflow in §7 uses it; the perf table (§15) still cites “no-op `sync`”. An agent now
has three verbs for two actions, and D3’s “keep it as the one recommended verb”
contradicts principle 1 (`add`, commit, `push`; clones `pull`).

**Proposal.** Remove the row.
§15: “`status` on 10k entries ≤ 1 s warm”.
If a one-verb convenience is ever wanted, it is a shell alias.

### 6. should-change — §6 / §10: `rm` should never delete payload bytes

**Problem.** `rm` deletes local files under the recoverability rule, so it needs
`--keep-local`, a second caller of the recoverability check, and an exit-2 path.
Principle 8 says “removal is never implied”; deleting bytes is removal.

**Proposal.** `blobsy rm <path>…` = remove the ref (or rows) and the ignore line,
`git add` the result, leave the working-tree bytes untouched (they are now an ordinary
untracked file; the large-file guard stops them reaching git; the user deletes or
re-adds them explicitly).
Drop `--keep-local`. §10 then has exactly one destructive command: `pull`.

### 7. should-change — §6 / §11: delete `add --each` and the `externalize` rules

**Problem.** `--each` is v2’s `track <dir>` surviving as a flag.
It needs three config keys (`externalize.{min_size,always,never}`), a second threshold
next to `git_max_file_size`, the “suggestion when > 200 refs” heuristic, and the §4.2
rule “a directory ref covers *every* file; mixed directories use `--each`”. Each is a
special case of `add`.

**Proposal.** `add <file>…` makes file refs; `add <dir>` makes a directory ref.
Mixed directories are `blobsy add data/*.parquet` or `find … | xargs blobsy add`. The
pre-commit guard’s refusal message prints the exact `blobsy add <paths>` to run, which
is the only “externalize rule” a user needs.
Delete `externalize.*`; `git_max_file_size` is the one size threshold (rename to
`max_git_file_size` so it reads as a limit).

### 8. should-change — §4.6 / §10: one cache for per-path facts, one for per-hash facts

**Problem.** The hash cache holds two unrelated things: per-path stat accelerators (per
worktree) and “synced records” (per hash, which logically belong to the whole repo: if
worktree A pulled hash H, worktree B may overwrite H). The content cache separately
holds bytes per hash.
So “do I know hash H is recoverable?”
consults two stores.

**Proposal.** Hash cache = per-path `path → size,mtime,ctime,hash` only.
Content cache (common-dir, shared) = per-hash: `objects/<algo>/xx/yy/<hash>` (bytes) and
`objects/<algo>/xx/yy/<hash>.known` (zero-byte marker: pushed or pulled here, bytes may
have been pruned). Recoverability (a) = marker exists; (b) = bytes exist; (c) = remote
`exists`. Restore writes markers for every file in the tree, which also closes a gap:
files inside a *packed* snapshot have no per-file object, so (c) can never apply to
them.

### 9. should-change — §4.6 / §6: no `cache` command, no `cache.on_add`

**Problem.** `cache status|prune` is a noun with two verbs for an implementation detail;
`cache.on_add` is a third knob for “when is the cache filled”.

**Proposal.** Fill on every `pull` and `push` (reflink makes it free where it matters;
the copy on ext4 is the price of the recoverability guarantee).
`cache.max_size` (default e.g. `20gb`) with LRU prune after each write.
`doctor` reports cache size.
Delete the `cache` command and `cache.on_add`.

### 10. should-change — §11 / §6: two config scopes, and machine config lives in `git config`

**Problem.** Three YAML scopes mean three files, `$BLOBSY_HOME`, a merge order, a
project-only-keys enforcement list, and a `config` command with `--global|--local|
--show-origin`. Every machine-scope key is a scalar: backend override, cache dir/size,
parallelism, trust grants.
`setup` already writes `merge.blobsy.driver` into git config.

**Proposal.** Committed `.blobsy.yml` (the only YAML; the only place for anything that
affects bytes or keys) + `git config blobsy.*` for machine settings, which gives global
vs per-repo layering, `--show-origin`, and env override for free, and puts trust grants
out-of-repo by construction (`git config blobsy.trustCommandBackend true` lives in
`.git/config`). Delete `~/.blobsy.yml`, `$BLOBSY_HOME`, `git-dir/blobsy/config.yml`, and
the `blobsy config` command; `doctor` prints the effective config.

### 11. should-change — §10: merge `?` into `↑`

**Problem.** `↑` “matches, no record of the object in the store” and `?` “matches, not
synced from this machine” are the same fact (no local evidence the store has it) with
different histories.
Both say “run `status --remote` or `push`”; `push` on either is a harmless
exists-then-put.

**Proposal.** Five states: `✓ ok`, `~ modified`, `↓ absent`, `↑ unsynced`, `! invalid`.
`--remote` resolves `↑` to `✓` or `remote missing`.

### 12. should-change — §4.2: make the header static for real

**Problem.** Line 1 is “a free comment” whose example embeds the target path
(`run: blobsy
status data/model.bin`). That line changes on every rename, so `mv` must rewrite ref
content, and two regenerating sides can differ.

**Proposal.** One header line, no free text:
`#blobsy-ref 1 blake3 https://github.com/jlevy/blobsy`. (A reader who wants help runs
`blobsy docs`.) The validator requires exactly this line.

### 13. should-change — §6: positional arguments to `snap` are polymorphic across namespaces

**Problem.** `snap publish <stanza|path>` and `snap restore <stanza|name|pin-path>`
accept a stanza key, a repo path, or a store name in one slot.
The design’s own example has a stanza named `target` *and* a directory `target`.

**Proposal.** Positional = repo path, always.
The stanza is found by `path:`; store names only via `--name`.
`snap restore target --name cache/target/…` is the fully explicit form.
Also unify `pull --include <glob>` and `snap restore --only <glob>` into one flag
(`--only`).

### 14. should-change — §4.1: drop “snapshots only” for `l` and `d`

**Problem.** A kind that is valid in one container and rejected in another is a context
rule in the validator and a second code path in `pull` vs `restore`.

**Proposal.** One validator, one rule set.
Directory refs may contain `l`/`d`; `pull` creates them with the same code `restore`
uses (symlink targets are confined to the repo either way).
They will be rare in collections and cost nothing.

### 15. should-change — §6 / plan Phase 1: defer `mv`; defer `diff`; drop `snap show` and `status --keys`

- `mv` is pure metadata (keys never change) and has five sub-cases (file↔file, row
  within, row between, into, out of a collection).
  With #6, `mv src dst && blobsy rm src && blobsy
  add dst` covers all five with no new code.
  Ship `mv` later as sugar if asked.
- `diff` is sugar over `git diff` of a TSV (rows already show path and size).
  Keep deferred.
- `snap show` = `status`/`diff` against a store manifest; fold in later or drop.
- `status --keys` duplicates `--dry-run --json`, which already prints resolved keys.

### 16. should-change — plan Phase 1 delete list: add the gitignore conflict/rewrite machinery

**Problem.** `gitignore.ts` (326 LOC: conflict detection + rewriting user patterns into
globs with negations) is not in the Phase 1 delete list.
With one ignore line per ref, written in the ref’s own directory, blobsy never needs to
rewrite a user’s pattern.

**Proposal.** Delete it.
`doctor` reports “`<ref>` is ignored by git (pattern X in Y)”; the user fixes their own
`.gitignore`. `doctor --fix` regenerates only the managed block.

### 17. should-change — plan Phase 1: ship directory refs in Phase 1; drop the K3 gate

**Problem.** The “one entry loop” claim is only tested when two containers exist; Phase
1 as written ships eleven commands but only file refs, and adds a temporary validator
rule ("directory and pin rows are rejected until Phases 2 and 3"). Separately, Phase 1
is gated on a cross-hardware benchmark (K3) that needs machines you may not have; the
algorithm is already named in the header and configurable, so the default is a one-line
change later.

**Proposal.** Phase 1 = the format (f/x/l/d rows; `t` rejected until Phase 3), hashing,
store, content cache, recoverability, `setup add rm push pull status doctor docs`, the
two guard hooks. Both file and directory targets.
Default `blake3` now; re-benchmark when convenient.
Phase 2 = merge driver + `resolve` + validator-in-CI (collection *merge* polish).
Phase 3 = snapshots (`t`, `snap publish|restore|ls`). Phase 4 = hydration hooks (cache
is already in P1). Phase 5 = `gc`, `import lfs`.

### 18. consider — §4.4: content-addressed snapshots with names as pointers

v3 stores everything under `snap/<name>/` so a lifecycle rule on `snap/cache/` expires
caches with no GC. The alternative (`snap/<tree_id>/…` + `names/<name>` → tree_id) is
more uniform (everything content-addressed; the pin row would need no `snap:` locator)
and dedups identical trees published under two names, but requires GC to reclaim expired
trees.
The lifecycle-rule simplicity is worth more today; keep v3’s layout, but write the
trade-off into §4.4 so it is a decision, not an accident.

### 19. consider — §11: compression knobs

`compress.{min_size,always,never}` plus “keep if ≥5% smaller” is four controls for one
decision that is recorded per row anyway.
`always` is subsumed by the trial.
Keep `min_size` and a built-in incompressible-suffix list
(`.zst .gz .zip .parquet .png .jpg
.mp4 …`) that users may extend with `compress.never`; drop `always`.

### 20. consider — §12: trim the Backend interface

`health()` is `list(prefix, limit=1)`; `capabilities.metadata` is “try and ignore
failure”. Minimal interface: `get`, `putIfAbsent`, `exists(keys[])`, `list(prefix)`,
`delete`, `capabilities: { conditionalPut }` (probe-set).
Keep the sentinel key fixed (`<prefix>/.blobsy-probe`) so the probe is idempotent and
never pollutes the CAS prefix.

### 21. consider — §4.4: snapshots are trees, not “trees or single files”

A single-file asset is a file ref (CAS, immutable, dedup’d) or a one-file directory.
Dropping “or single file” removes a case from publish, restore, pin validation and docs.

### 22. consider — §4.2: the `.` row

`.` as “the target itself” is the least bad encoding for a one-row ref (the alternative,
repeating the basename, duplicates the filename and breaks on rename).
Keep it, but state the rule precisely in the validator: “`.` is permitted only as the
sole row, with kind `f`, `x` or `t`.”

### 23. consider — §8 / §6: `resolve` first, driver second

Both are ~50 lines over one `merge3(base, ours, theirs)`. `resolve` works on every host
with no git config and is the repair path for driverless merges; the driver is the
zero-step sugar.
If Phase 2 must be cut further, ship `resolve` + validator and defer the
driver and `.gitattributes` wiring.
Also defer `--ours|--theirs <path>`: a conflicting row is one line, edited by hand.

### 24. consider — §7.3: the `snapshots:` stanza is optional sugar

`snap publish target --name "cache/target/{os}-{arch}/{hash:Cargo.lock}" --exclude …` in
CI yaml is fully explicit.
Keep the stanza (it gives `snap restore target`), but say it is a convenience and keep
`fallback:` as a flag only, not a stanza key.

### 25. consider — §16 table: count honestly

“18 public commands” vs v2’s 22 overstates the win because v2 had 14 visible.
After this review: 13 (incl.
sub-verbs), 9 in Phase 1.

* * *

## Proposed minimal v3

**Model (four nouns).** *Entry* `path kind size hash storage`; `tree_id` over the first
four columns. *Ref*: a `.bref` text file (one header line + sorted entries) named after
its target. Refs live in git next to their target, or in the store under a *name*
(`snap/<name>/manifest.bref`, the create-only commit object).
*Object*: immutable bytes at `<algo>/xx/yy/<hash>[.zst]` or inside a snapshot archive.
*Name*: a write-once store path for a ref that is not in git.
A pin is a one-row ref whose row has kind `t`, hash = tree_id, storage = `snap:<name>`.
Nothing else exists.

**Formats.** One text format everywhere (git and store); `storage` ∈ `- | zstd | pack |
snap:<name> | <symlink target>`; kinds `f x l d t`; header `#blobsy-ref 1 <algo> <url>`.
Project config: one YAML with `backend, hash, compress.{min_size,never}, ignore,
max_git_file_size, snapshots.<n>.{path,name,exclude}`. Machine config: `git config
blobsy.{backend,cacheDir,cacheMaxSize,jobs,trustCommandBackend}`.

**Commands (13).** `setup [backend] [--no-hooks|--hydrate]` · `add <path>… [--prune]` ·
`rm <path>…` · `push [paths]` · `pull [paths] [--only g] [--force] [--cache-only]` ·
`status [paths] [--remote] [--all]` · `resolve <ref>` (P2) · `snap publish <path>
[--name n] [--pin] [--packed|--unpacked]` · `snap restore <path> [--name n] [--fallback]
[--only g]` · `snap ls [prefix]` (P3) · `gc [--older-than] [--snapshots]` · `import lfs`
(P5) · `doctor [--ci] [--fix]` · `docs [--skill]`. Hidden: `hook`, `merge-driver`.
Globals: `--json --dry-run --quiet --verbose`. Exit 0/1/2. States `✓ ~ ↓ ↑ !`.

**Local state.** `git-path blobsy/hashcache` (per-path stat → hash).
`git-common-dir
blobsy/objects/<algo>/xx/yy/<hash>` (+ `.known` marker) — the only per-hash knowledge,
and the only recoverability evidence besides a remote `exists`.

**Hooks.** pre-commit (validator, payload match, size guard), pre-push (upload from
cache or working tree; abort naming commit+path), post-{checkout,merge,rewrite} = `pull
--cache-only` only. No network in any hook except pre-push.

**Layout and interfaces.**
```
cli/        commander wiring; one file per verb: plan(args) → Plan; execute(Plan); one reporter
core/       config (yaml + git config), paths, git, errors, hash (1 MB reads, worker pool), hashcache
ref/        Entry, parse/serialize/validate, treeId, merge3, walk(dir) → Entry[]
store/      Backend + s3/local/rclone/command; objectKey(); ObjectStore (cache-through, .known)
sync/       THE entry loop: plan(entries, local, store, mode) → Action[]; apply(Action[])
snap/       pack/unpack tar.zst, name templates, publish (archive → manifest, create-only), restore
doctor/     checks registry
```
```ts
type Kind = 'f'|'x'|'l'|'d'|'t';
interface Entry { path: string; kind: Kind; size: number; hash: string; storage: string }
interface Ref { algo: 'blake3'|'sha256'; entries: Entry[]; header?: Record<string,string> }
parseRef(text): Ref; serializeRef(ref): string; validateRef(ref): Issue[]; treeId(entries): string
merge3(base: Ref, ours: Ref, theirs: Ref): { merged: Ref; conflicts: string[] }
walk(dir, ignore, cache): Promise<Entry[]>                        // used by add and snap publish
interface Backend { get(key,dest); putIfAbsent(src,key,meta?); exists(keys): Promise<Set<string>>;
                    list(prefix): AsyncIterable<{key,size,mtime}>; delete(key); capabilities }
objectKey(algo, hash, storage): string                            // pure
class ObjectStore { fetch(hash, storage, dest); store(src, hash, storage); known(hash); markKnown(hash) }
type Action = { op:'upload'|'download'|'place'|'skip'|'refuse'; entry: Entry; reason?: string }
plan(entries: Entry[], base: string, mode:'push'|'pull'|'status', store: ObjectStore): Promise<Action[]>
```
`push`, `pull`, `status`, the pre-push hook, hydration, and the verification step of
`snap
restore` all call `plan()`; `add` and `snap publish` both call `walk()`; every `.bref`
in git or in the store goes through `parseRef()`. Snapshot-specific code is pack/unpack,
names, and the two-step publish — nothing else.
