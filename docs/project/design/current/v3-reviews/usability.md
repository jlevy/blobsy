# Blobsy design v3 — usability, onboarding and end-to-end workflow review

**Date:** 2026-10-23 · **Reviewed:** `docs/project/design/current/blobsy-design.md` (v3,
2026-10-22), the v3 implementation plan, the round 9 review and sub-reviews, the jj /
Gat / hash research, and the current user-facing docs (README, SKILL.md, joining, CI,
LFS migration). **Lens:** install, onboarding and every daily journey (humans and
agents), walked exactly as v3 writes them.
**Baseline:** pre-alpha, no backward compatibility (`CLAUDE.md`), so every fix below is
a direct change to the design text, not a transition.

**Severity:** **must** = a user or agent will lose data, commit payloads, be blocked, or
be taught a destructive habit; **should** = real friction or ambiguity on a common path;
**consider** = polish or a judgment call.

**Overall verdict.** v3’s *model* is the right one and is far simpler than v2: derived
keys, one ref format, refs final at `add`, a recoverability rule, snapshots.
What the document does not yet contain is the *operational contract*: how blobsy is
installed and found by hooks, what `--json` and refusals look like, where the gitignore
line goes, what `add <dir>` does to files git already tracks, how read-only CI survives
`doctor`, and a status model that still shows a teammate’s update with the same symbol
as a local edit. None of these needs a model change; they need ~40 concrete decisions
written down. The findings below propose each one.

* * *

## Part A — Install and first run

### 1. (must) No install story; hooks will call a `blobsy` that is not on PATH — §6, §9, §17

**Problem.** v3 never says how blobsy is installed.
The current docs say `npm install -g blobsy`; the language sub-review recommends
`npx blobsy@<version>` for agents; §17 defers the single binary.
But §9 installs hooks that run `blobsy hook <name>`. For an `npx` user, a CI image, or a
teammate who cloned and never installed, every `git commit` fails with
`blobsy: not found` (pre-commit) and every `git push` is blocked (pre-push).
Gat has exactly this failure (`post-checkout: gat: not found`), and for blobsy the
*guard* hooks make it worse: the hook that protects data blocks all git work until
blobsy is installed.

**Fix.** Add a §"Installation and distribution" with three supported paths and one rule
for hooks:

```text
npm install -g blobsy            # humans; hooks find `blobsy` on PATH
npx blobsy@1.x <cmd>             # agents and CI; nothing installed; pin the major
<github release binary>          # bun-compiled, for sandboxes without Node (ship in Phase 1 as an experiment, promote when goldens pass)
Requires Node >= 22.15 (node:zlib zstd). Not 24: that is the dev floor only.
```

The hook shim written by `setup` must be POSIX `sh`, must never need blobsy to decide
*whether* blobsy is needed, and must record how it was installed:

```sh
#!/bin/sh
# blobsy-hook v1 (managed; do not edit)        <- exact marker line
[ -n "$BLOBSY_NO_HOOKS" ] && exit 0
if command -v blobsy >/dev/null 2>&1; then exec blobsy hook pre-push "$@"; fi
if command -v npx >/dev/null 2>&1 && [ -z "$BLOBSY_HOOK_NO_NPX" ]; then exec npx -y blobsy@1 hook pre-push "$@"; fi
# blobsy is not installed. Only block if this push touches refs.
if git diff --name-only "$(cat)" 2>/dev/null | grep -q '\.bref$'; then  # pre-push: stdin has the ranges
  echo "blobsy: this push changes .bref files but blobsy is not installed." >&2
  echo "        npm install -g blobsy   (or: npx blobsy@1 push, then git push --no-verify)" >&2
  exit 1
fi
exit 0
```

(The pre-commit shim does the same with `git diff --cached --name-only`; the restore
hooks always exit 0.) State in §9: “A hook never blocks git when blobsy is absent and
the operation touches no `.bref`.”

### 2. (must) Native BLAKE3 fallback is invisible, and the WASM path is slower than SHA-256 on Bun — §4.5

**Problem.** `@napi-rs/blake-hash` ships 14 prebuilt targets, but `npm i --no-optional`,
`--ignore-scripts`, an air-gapped mirror, Alpine without the musl build, or an
unverified `bun build --compile` embedding all land users on `hash-wasm` at 465 MB/s
(Node) or **213 MB/s (Bun)** — below SHA-256. The design calls the fallback “correct but
slow” and never surfaces it.
A user adding a 20 GB dataset would wait 90 s instead of 7 s with no explanation.
Also: `hash:` is per repo and immutable in practice (every ref would need re-adding),
yet `setup` never asks, and `import lfs` wants `sha256`.

**Fix.**
- `blobsy doctor` and `setup` print the active hasher: `hash: blake3 (native)` or
  `hash: blake3 (wasm fallback — ~6x slower; see blobsy docs hashing)`.
- `add`, `status --verify`, `snap publish` print a one-time warning when the WASM path
  hashes more than 256 MB in one run.
- `--version --json` reports `{ "hasher": "native" | "wasm" }`.
- `setup --hash sha256` is a first-run flag; the LFS guide says to use it; `setup`
  refuses `--hash` on an existing project config ("hash is fixed once refs exist; re-add
  every ref to change it").
- Make the native addon a normal dependency with the WASM package as the fallback, and
  have the install never fail when the addon is unavailable (test `--no-optional` and
  `--ignore-scripts` in CI).
- Resolve the research open question (does `bun build --compile` embed the `.node`
  addon?) before claiming a binary.

### 3. (must) `doctor`’s create-only probe writes to the store, so read-only clones and PR builds fail `doctor` — §6, §7.3, §12

**Problem.** §12: “`conditionalPut` is set by a doctor probe (write a sentinel twice;
expect success, then 412)”. §7.3: laptops and PR builds get read-only credentials.
§7.6 says CI runs `doctor --ci`. So the recommended CI recipe fails (403 on the
sentinel) on exactly the machines the design says must be read-only.
The probe also needs `delete`, and leaves objects behind if it can’t.

**Fix.**
- Split checks by *credential posture*: `doctor` first does `health()` (read) and infers
  posture from a `HeadObject`/`ListObjects` success plus whether `putIfAbsent` is
  attempted. The probe runs only in `setup` (first run, by the person creating the repo)
  and in `doctor --probe`. `doctor` and `doctor --ci` never write.
- Record the probe result in **project** config
  (`backend_capabilities: {conditional_put: true}`), because it is a property of the
  bucket, not of the machine; `doctor` warns if it is absent ("run
  `blobsy doctor --probe` once with write credentials").
- Sentinel key: `<prefix>/_blobsy/probe/<random>` and delete it; document that this
  prefix may be lifecycle-expired.
- `doctor --ci` = validate every ref at HEAD, overlaps, markers, large files in HEAD’s
  tree, and batched remote *existence* (read-only).
  It never checks hooks, drivers or local config (there are none in CI); `doctor`
  without `--ci` does.

### 4. (must) `setup` in a clone modifies the working tree (agent docs), and “a clone needs only `blobsy pull`” contradicts §7.1 — §3, §6, §7.1

**Problem.** Principle 1 says “A clone needs `blobsy pull`. Nothing else is required.”
§7.1 shows `git clone … && blobsy setup && blobsy pull`. Both are true in different
senses (correctness vs convenience), but a reader sees a contradiction, and nothing
tells a user who skips `setup` what they gave up (no guards, no driver, no restore
hooks). Worse, `setup` “installs agent docs”: on a *join* that writes
`.claude/skills/blobsy/SKILL.md` and edits `AGENTS.md` in the teammate’s working tree —
untracked files or an unexpected diff, and every teammate re-generates them.

**Fix.**
- Reword principle 1: “**Correctness needs nothing per clone.** A clone can
  `blobsy pull` and push with plain git.
  `blobsy setup` adds the guards, driver and restore hooks; CI’s `doctor --ci` catches
  what unguarded clones miss.”
- Split `setup` by state: **first run** (no `.blobsy.yml`): writes `.blobsy.yml`,
  `.gitattributes` lines, agent docs, and runs `git add` on all of them (v2 forgot to
  stage the config). **Join** (config exists): touches only the git dir (hooks,
  `merge.blobsy.driver`, local config) and prints what it did.
- Every blobsy command prints a one-time hint per clone when hooks are absent:
  `hint: guard hooks are not installed in this clone; run blobsy setup` (suppressed by
  `BLOBSY_NO_HOOKS`, `--quiet`, `--json`, and after the hint is shown once, recorded in
  local config).
- `setup` with no `<backend>` in a fresh repo must fail with the URL forms, and suggest
  the zero-credential path: `blobsy setup local:../blobsy-store` (see finding 40).

### 5. (should) Credentials are never mentioned — §12, §13

**Problem.** The design never says where S3/rclone credentials come from, which
permissions are needed (read-only vs write), or what a missing credential looks like.
The committed URL form `s3://bucket/prefix?profile=…` bakes one person’s profile name
into project config, and §11 says a *different backend URL* may live in local config
while also saying the prefix is project-only (contradiction; see finding 30).

**Fix.** Add §12.1 “Credentials”:
- S3: standard SDK chain (env, `~/.aws`, SSO, OIDC in CI). rclone: its own
  `rclone.conf`. `local:` none.
- Minimum IAM: read = `s3:GetObject`, `s3:ListBucket` (for `exists` batching and `gc`);
  write = `+ s3:PutObject` (no `s3:DeleteObject`, which only `gc` needs).
  Give the IAM snippet for a read role and a write role scoped to `snap/cache/*`
  (finding 24).
- `?profile=`, `?endpoint=`, `?region=` are *connection* parameters and belong in
  **local** or **global** config; `setup` warns if `profile` appears in the project URL.
- Draft the message:

```text
error: cannot reach backend s3://my-bucket/my-project (us-east-1)
       credentials not found (checked: env, AWS_PROFILE, ~/.aws, SSO, IMDS)
       -> for S3 see `blobsy docs credentials`; in CI use OIDC (aws-actions/configure-aws-credentials)
       -> read-only credentials are enough for pull; push and snap publish need write
```

### 6. (should) Time-to-first-success is undefined; publish a golden path and test it — §7

**Problem.** The workflows in §7 are correct but scattered; nothing states the shortest
path from zero to “a teammate pulled my file”, and nothing tests it as a whole.
The appendix gives four ten-minute paths; the design should adopt them as its own §7.0
and the golden suite should run each one end to end (plan testing strategy item 1
already does the first).

* * *

## Part B — Daily loops (UC-1, UC-2, UC-3, UC-5)

### 7. (must) `add <dir>` externalizes files git already tracks — §6, §7.2

**Problem.** In v2, `blobsy add data/` externalized the large files and kept the small
ones in git. In v3, `add <dir>` makes the whole directory a directory ref and ignores it
with one line. A user (or agent) who types `blobsy add data/` on a directory of source
and data will have every tracked file — code, READMEs, JSON — moved into a `.bref` and
gitignored. `git status` then shows them as deleted.
Nothing in §6 refuses this.

**Fix.** `add <dir>` on a directory that is not already a ref target:
- **refuses** if any file inside is tracked by git (`git ls-files <dir>` non-empty):
  `error: data/ contains 14 files tracked by git (data/README.md, data/schema.json, …). A directory ref owns every file in the directory. Use: blobsy add --per-file data/ (externalize only large files, keep the rest in git) or git rm -r --cached data/ && blobsy add data/ (move everything out of git).`
- **refuses** if it is the repo root, contains a `.bref`, or sits inside a snapshot path
  or another ref (overlap rule, §5).
- prints the plan before acting:
  `data/images: 10,312 files, 4.2 GB → directory ref data/images.bref (one gitignore line)`.

### 8. (must) `add --prune` deletes entries a partial pull never materialized — §6, §7.2

**Problem.** `--prune` “drops entries whose files are gone.”
After `blobsy pull data/images --include 'cats/**'`, 9,000 entries are “gone” locally.
`add --prune data/images` then removes them from the ref — the exact loss §7.2 says
`add` must prevent. The name also collides with `cache prune` and GC vocabulary.

**Fix.** Define *gone* as “the hash cache records this path was materialized on this
machine and the file is now absent”.
Entries never materialized here are *absent*, not gone, and `--prune` leaves them,
printing `kept 9,000 entries that were never pulled here (absent, not deleted)`. If the
user really wants to drop them: `blobsy rm data/images/dogs` (explicit paths).
`status` must show the two states differently (finding 11). Keep the flag name `--prune`
only with this definition; otherwise rename to `--drop-deleted`.

### 9. (should) `rm` deletes bytes by default — §6

**Problem.** `blobsy rm <path>` “removes a ref … and deletes local files”;
`--keep-local` to keep.
The most common intent behind “rm” in this tool is *stop tracking* (demote back to git,
or just drop the ref), and the recoverability rule only protects bytes that were synced
— an agent that `rm`s a freshly added, unpushed file gets a refusal it did not expect;
one that `rm`s a pushed file loses the local copy it may still want.
Git’s `rm` deletes too, but git’s bytes are always in history; blobsy’s are not.

**Fix.** Make `rm` keep the bytes and `--delete` remove them (`blobsy rm data/model.bin`
→ “stopped tracking data/model.bin (300 MB). The file is now visible to git; do not
commit it. Delete with --delete or move it out of the repo.”). Keep the recoverability
check on `--delete`. If the owner prefers git parity instead, name the keep flag
`--cached` (what every git user already types), not `--keep-local`.

### 10. (must) A teammate’s update still shows as `~ modified`, and the refusal text still leads with `--force` — §10

**Problem.** The state table defines `~ modified` as “local bytes differ from the
entry”, next action “`blobsy add` (keep) or `pull --force` (discard)”. After `git pull`
brings a teammate’s new hash, the local file differs from the entry — so it is
`~ modified`, with `--force` offered, which is H-3 and the agent trap from round 9 §8
again. The recoverability rule already knows the difference: the local hash is a synced
one.

**Fix.** Split the state:

| Symbol | State | Meaning | Next action |
| --- | --- | --- | --- |
| `⇣` | stale | Local bytes are an older *synced* version; the ref moved (teammate, merge, checkout) | `blobsy pull` (safe) |
| `~` | modified | Local bytes are not recoverable from store or cache: your edit | `blobsy add` to keep · `blobsy pull --force` to discard |

`pull` on `⇣` just works.
`pull` on `~` refuses with:

```text
refused: data/model.bin — your local file differs from the ref and its bytes exist nowhere else
         local  312,004 B  1a7e…   (not pushed, not cached)
         ref    300,000 B  9f2c…   (in store)
  keep yours:     blobsy add data/model.bin        # records your version; commit it
  keep a copy:    cp data/model.bin data/model.bin.mine && blobsy pull
  discard yours:  blobsy pull --force data/model.bin
exit 2
```

`--force` is listed last and labelled.
`status --json` carries `"state": "stale" | "modified"`.

### 11. (should) `↑ unpushed` vs `? unknown remote` is not decidable as written; `absent` hides “deleted here” — §10

**Problem.** Both `↑` and `?` mean “matches the entry, but this machine has no sync
record”. The table does not say how blobsy tells them apart.
The only usable rule: `↑` when the hash cache shows *this machine wrote the row* (an
`add` record), `?` otherwise.
`?` also means “unknown” in every other CLI. Separately, `↓ absent` conflates “never
pulled here” with “was here and is now deleted” (finding 8 needs that distinction).

**Fix.** Write the rule into §10. Rename: `↑ unpushed` (added here, no push record),
`· unverified` (from git, not synced here; run `--remote`), `↓ absent` (never
materialized here), `✗ deleted` (materialized here, now missing).
Human `status` prints counts per ref:

```text
data/model.bin.bref       file  300 MB   ✓ ok
data/images.bref          dir   10,324 entries · 4.2 GB   ✓ 10,250  ⇣ 3 stale  ~ 1 modified  ↓ 44 absent  ↑ 12 unpushed  ✗ 2 deleted
models/llama-3-8b.bref    pin   assets/llama-3-8b/v2  16 GB   ✓ ok
3 refs · 2 need attention: blobsy pull (3 stale) · blobsy add or pull --force (1 modified)
```

### 12. (must) No `--json` schema, no error codes, no plan schema — §3 (principle 10), §6, §7.7

**Problem.** “Every command supports `--json`” is the agent contract, and the language
sub-review names versioned `--json` schemas as the thing that makes a port cheap.
v3 defines none. Agents will parse whatever the first implementation prints.

**Fix.** Add §6.1 “Machine output” with one envelope for all commands:

```json
{ "blobsy": 1, "command": "status", "ok": true,
  "refs": [ { "ref": "data/images.bref", "shape": "dir", "target": "data/images",
              "counts": {"ok":10250,"stale":3,"modified":1,"absent":44,"unpushed":12,"deleted":2},
              "entries": [ {"path":"cats/001.jpg","kind":"f","size":48213,"hash":"07ab…","encoding":"-",
                            "state":"stale","remote":"present","key":"blake3/07/ab/07ab…"} ] } ],
  "problems": [ { "code": "E_MODIFIED_UNRECOVERABLE", "path": "data/images/cats/009.jpg",
                  "message": "…", "choices": [ {"cmd":"blobsy add data/images/cats/009.jpg","effect":"keep yours"},
                                              {"cmd":"blobsy pull --force data/images/cats/009.jpg","effect":"discard yours"} ] } ] }
```

- Errors: `{"blobsy":1,"ok":false,"error":{"code":"E_…","message":"…","choices":[…]}}`
  with the same exit codes (1/2). Publish the code list (`E_REFUSED_UNRECOVERABLE`,
  `E_CONFLICT_MARKERS`, `E_OVERLAP`, `E_OBJECT_MISSING`, `E_NO_CREDENTIALS`,
  `E_OFFLINE`, `E_FORMAT`, `E_TRACKED_IN_GIT`, `E_LARGE_FILE`, …).
- `--dry-run --json`:
  `{"plan":[{"op":"upload|download|overwrite|skip|refuse|delete","path":…,"hash":…,"key":…,"size":…,"reason":"…"}],"totals":{"upload_bytes":…}}`.
  `pull --dry-run` lists the refusals it *would* make.
- Entries are only included for file refs, pins, or with `--all`; directory refs give
  counts by default.
- Paths in JSON are always repo-root-relative POSIX.

### 13. (should) Partial success semantics for `pull`, `push`, `sync` are undefined — §6

**Problem.** `pull data/images` on 10k entries where 3 are `~ modified`: does it pull
9,997 and exit 2, or stop?
`sync` = “pull then push” — does push run after a refused pull?
Agents need the answer to loop.

**Fix.** State: every verb does all safe work, collects refusals and errors per entry,
prints a summary, and exits 2 if any refusal, else 1 if any error, else 0. `sync` runs
push even when pull refused some entries (push never depends on pull).
Add `--fail-fast` for CI.

### 14. (should) Path arguments: cwd-relative in, root-relative out; subpaths scope directory refs — §6

**Problem.** §6 takes `[<path>…]` everywhere but never says whether a path inside a
directory ref (`blobsy pull data/images/cats/001.jpg`) scopes to that entry, whether
paths are cwd- or root-relative, or what `blobsy add data/images.bref` means.

**Fix.** Like git: arguments are cwd-relative; output is repo-root-relative (JSON
always; human output too, for agent legibility).
A path inside a ref’s target scopes the verb to matching entries (`add` = update those
entries only). A `.bref` path given as an argument is accepted and means its target.
Globs are shell-expanded; `--include` is the blobsy-side glob.

### 15. (must) Where the gitignore line lives is unspecified; `.bref` needs `eol=lf` — §4.2, §8, §9

**Problem.** §4.2 lists a “gitignore line” per shape but never says which file: root
`.gitignore`, a sibling `.gitignore` next to the ref (v2’s managed block), or
`.git/info/exclude` (rejected).
§7.4 commits `.gitignore` at the root; §8 says the block is regenerated by
`doctor --fix`. Under jj a text conflict in a managed block un-ignored a payload
(research §6 step 11). Separately, `.bref` is TSV committed as text: with
`core.autocrlf=true` on Windows, checkout rewrites it with CRLF and the strict reader
fails or hashes differ.

**Fix.**
- One managed block per *directory that holds refs*, in that directory’s `.gitignore`,
  with anchored patterns: `/model.bin`, `/images/`, `/llama-3-8b/`. Sibling placement
  keeps churn local, matches the ref’s adjacency, and keeps `git status` from
  descending.
- Block delimiters `# >>> blobsy (managed; regenerated from .bref files) >>>` …
  `# <<< blobsy <<<`. The validator (pre-commit, `doctor`, `--ci`) checks every ref has
  its line and the block has no markers; `doctor --fix` rewrites the block.
  The large-file guard is the backstop.
- `setup` writes to `.gitattributes`: `*.bref merge=blobsy text eol=lf` and the reader
  rejects `\r` with “re-run blobsy add”.

### 16. (should) `pull --include` is forgotten on the next plain `pull` — §7.2

**Problem.** A user who pulled `cats/**` from a 40 GB collection will later run
`blobsy pull` (as every doc tells them to after `git pull`) and download the remaining
36 GB. There is no per-clone sparse setting; Gat has selections, LFS has `fetchinclude`.

**Fix.** `pull --include` on a directory ref records the pattern in **local** config
(`sparse: {data/images: ['cats/**']}`) and later pulls honor it; `status` shows
`sparse: cats/** (1,324 of 10,324 entries)`; `pull --all` or `pull --include '**'`
clears it. Restore hooks respect it.
Consider only if the owner wants the state; otherwise document the trap loudly in the
skill.

### 17. (should) Conflicts: define what `resolve` does for a file ref and what `status` says during a merge — §6, §8

**Problem.** `resolve <ref> [--ours|--theirs] [<path>…]` is specified for directory
refs. For a one-row file ref both sides changed, there is nothing to auto-merge; the
design should say `resolve` without a flag prints the candidates and exits 2.

**Fix.** Draft:

```text
$ blobsy resolve data/model.bin.bref
conflict: data/model.bin.bref — both sides changed the file
  ours    (HEAD)      312,004 B  1a7e…  2026-10-21 you      "Retrain v3"
  theirs  (feature)   298,110 B  c4d1…  2026-10-22 alice    "Smaller model"
  pick:  blobsy resolve data/model.bin.bref --ours | --theirs
  then:  git add data/model.bin.bref && git commit && blobsy pull data/model.bin
exit 2
```

For directory refs, `resolve` with no flag applies the per-path rules and lists only the
remaining conflicts; `--ours`/`--theirs` with `<path>…` applies to those rows.
`status` during a conflicted merge shows `!` and the same hint; it exits 2 (v2 exited 0
on corrupt refs).

### 18. (should) Big uploads happen inside `git push`; say so and offer the escape — §7.1, §9

**Problem.** With the pre-push hook on, `git push` after adding a 16 GB model blocks for
the upload with no warning that Ctrl-C aborts the push.
Users will `--no-verify` and never learn that the blob did not go.

**Fix.** The hook prints before uploading:
`blobsy: uploading 1 object (16.0 GB) referenced by the pushed commits; Ctrl-C aborts the push (not the commit). Tip: run blobsy push first for large uploads.`
The skill rule becomes “for anything over ~1 GB, `blobsy push` before `git push`”.

### 19. (should) `sync` keeps a name whose safety differs from `pull`’s — §6

**Problem.** `sync` is fine as `pull` then `push`, but after v2 users will read it as
“make everything match” and expect it to resolve `~ modified`. It will refuse exactly
like `pull`. Say so in its help: “`sync` = `pull` then `push`; it refuses what `pull`
refuses.” No other change.

### 20. (must) Snapshot miss has no defined exit code; the recipe needs `|| true` — §7.3

**Problem.** `blobsy snap restore target || true     # hit, fallback, or miss`. If a
cache miss exits non-zero, every CI script must add `|| true`, which also swallows real
errors (credentials, corruption).
The sub-review said miss = exit 0 for caches; the main design dropped it.

**Fix.** `snap restore <cache stanza>`: hit → 0, fallback → 0 (prints which name), miss
→ 0 with `miss` on stdout and `{"result":"miss"}`; `--require` makes miss exit 1. Errors
(network, verify failure, overlap) exit 1 regardless.
`snap restore <asset|pin>`: miss exits 1 (a pinned asset must exist).
Remove `|| true` from §7.3.

### 21. (should) `snap restore <stanza|name|pin-path>` is ambiguous; `{os}`/`{arch}` values are unspecified — §4.4, §6

**Problem.** A stanza named `assets`, a name prefix `assets/…`, and a path
`models/llama-3-8b` can all be typed in the same position.
`{os}` and `{arch}` need a canonical vocabulary or two machines derive different cache
names.

**Fix.** Resolution order: stanza name → path that has a pin ref →
`--name <snapshot-name>` (explicit flag for raw names; a bare string containing `/` that
is not a path is an error with the hint).
Define `{os}` ∈ `linux|darwin|windows`, `{arch}` ∈ `x64|arm64` (Node’s
`process.platform`/`arch` normalized), and `{hash:<file>}` = first 16 hex of the repo
hash of the committed file (error if the file is untracked or dirty).
Also rename the example stanza from `target` to `cargo-target`: “target” is already the
term for “what a ref points to” throughout §4.

### 22. (must) `blobsy add` on a pinned directory, and `push` of a pin, are unspecified — §4.2, §6, §7.4

**Problem.** A pinned asset directory `models/llama-3-8b/` is gitignored and has a
`.bref` next to it.
`blobsy add models/llama-3-8b` matches §6’s rule “a directory becomes
a directory ref” and would silently convert the pin into a 3-row directory ref and
upload 16 GB as objects.
`blobsy push` for a `t` row has no object to upload; the pre-push hook must still verify
the snapshot exists.

**Fix.** `add` on a target whose ref is a pin refuses:
`models/llama-3-8b is pinned to snapshot assets/llama-3-8b/v2. To publish your changes: blobsy snap publish models/llama-3-8b --name assets/llama-3-8b/v3 --pin`.
`push`/pre-push for `t` rows: `HEAD snap/<name>/ref.yaml`, compare `tree_id`; missing or
mismatched → abort the push with
`pin models/llama-3-8b.bref names assets/llama-3-8b/v3, which is not published (or has a different tree). Run: blobsy snap publish … --name … --pin`.
`status` for a pin uses the hash cache; `--verify` walks the tree.

### 23. (should) `stash`, `reset`, `checkout -- x.bref` behaviour should be stated once, in user terms — §7.5

**Problem.** §7.5 says these “fire no hooks; status reports N files behind their refs” —
but what the user needs to know is that gitignored payloads are never stashed, so after
`git stash` the ref reverts and the payload stays new; `status` shows `~ modified`,
`pull` refuses, and `git stash pop` puts the ref back.
That is safe but surprising.

**Fix.** Add to §7.5: “Payloads are gitignored, so git never stashes, resets or checks
them out. After any of these, `blobsy status` tells you whether the working file is
`⇣ stale` (run `pull`) or `~ modified` (your unpushed bytes; `pull` refuses).
`git stash pop` restores the ref; nothing was lost.”
Put the same two lines in the skill.

* * *

## Part C — Team, CI, platforms

### 24. (must) CI recipe: write segregation, cache the content cache, and publish only from protected branches — §7.3, §7.6, §13

**Problem.** §7.6 is two lines.
The actual recipe needs: OIDC roles split read/write, `doctor --ci` without the probe
(finding 3), `actions/cache` on the *content cache* (now at a stable path under `.git`),
partial pulls, and cache-snapshot publish gated to `main`. The current
`docs/ci-github-actions.md` caches on `.bref` hashes but names no `path`.

**Fix.** Ship this as `blobsy docs ci` and in the design:

```yaml
jobs:
  test:
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: arn:aws:iam::…:role/blobsy-read, aws-region: us-east-1 }
      - uses: actions/cache@v4            # local content cache; keyed by the refs
        with: { path: .git/blobsy/objects, key: blobsy-${{ hashFiles('**/*.bref') }}, restore-keys: blobsy- }
      - run: npx blobsy@1 doctor --ci                         # refs valid, no markers, objects exist (read-only)
      - run: npx blobsy@1 pull --include 'test-fixtures/**'
      - run: npx blobsy@1 snap restore cargo-target           # miss exits 0
      - run: cargo test
      - if: github.ref == 'refs/heads/main'
        uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: arn:aws:iam::…:role/blobsy-cache-writer, aws-region: us-east-1 }
      - if: github.ref == 'refs/heads/main'
        run: npx blobsy@1 snap publish cargo-target            # "already published" exits 0
```

IAM sketch: `blobsy-read` = `s3:GetObject`, `s3:ListBucket` on the prefix;
`blobsy-cache-writer` = read + `s3:PutObject` on `<prefix>/snap/cache/*` only; humans
who `blobsy push` = read + `s3:PutObject` on `<prefix>/<algo>/*` and
`<prefix>/snap/assets/*`; nobody but the GC operator has `s3:DeleteObject`. Bucket
versioning or Object Lock on `snap/assets/`.

### 25. (should) PR review: give each ref shape’s diff and a `blobsy diff --markdown` for the PR comment — §6, §7.1, §7.2

**Problem.** §7.1 shows the one-line file-ref diff (and omits the `extra` column that
§4.2 says is present).
Nothing shows what a reviewer sees for a directory ref creation (10k added lines: GitHub
collapses it), a batch add, a rename, or a pin bump; and `blobsy diff` “suitable as a PR
comment” has no output format.

**Fix.** Add §7.1.1 “What reviewers see”:
- file ref change: `-.	f	300000	9f2c…	zstd` / `+.	f	312004	1a7e…	zstd` (one hunk, path
  in the file name);
- directory ref batch add: `+cats/041.jpg	f	48213	07ab…	-` × 40 (GitHub renders; a
  10k-line creation is collapsed, so the PR comment carries the summary);
- `mv` inside a collection: one `-` and one `+` row with the same hash (reviewer can see
  it is a rename);
- pin bump: one row, `assets/llama-3-8b/v2` → `v3`, size delta visible.

`blobsy diff origin/main...HEAD --markdown` prints:

```markdown
**blobsy: 3 refs changed**
| Ref | Change | Files | Size |
| --- | --- | --- | --- |
| data/model.bin.bref | modified | 1 | 300.0 MB → 312.0 MB (+4.0%) |
| data/images.bref | +40 added, ~3 changed, -1 removed | 10,324 | +2.1 MB |
| models/llama-3-8b.bref | pin assets/llama-3-8b/v2 → v3 | 3 | 16.06 GB → 16.40 GB |
Largest new object: data/images/tables/2026-10.parquet (734 MB)
```

and `--json` the same data.
Add `--fail-above <size>` so CI can block a 4 GB accident.

### 26. (should) jj users have no workflow section — §7, §8

**Problem.** The jj research marks four items “Must”; v3 covers only the merge tool and
`doctor --ci`. Nothing tells a jj user the order of operations, that `add` must untrack
a payload jj already snapshotted (<1 MiB files are committed by the first `jj st`), that
`git add` is pointless under jj, or that `$JJ_WORKSPACE_ROOT` matters under `jj run`.

**Fix.** Add §7.8 “jj (colocated)”:

```bash
blobsy add data/model.bin     # detects .jj/: writes the ignore line first, runs `jj file untrack` if jj already tracks the payload, skips `git add`, prints jj next steps
blobsy push                   # jj runs no hooks: upload before sharing
jj commit -m "Add model" && jj git push
# teammates: jj git fetch && jj new main@origin && blobsy pull
# conflicts in a directory ref: jj resolve --tool blobsy data/images.bref   (setup writes the [merge-tools.blobsy] stanza into the user's jj config on request: `blobsy setup --jj`)
```

Rules: prefer `$JJ_WORKSPACE_ROOT` for the root; non-colocated repos are unsupported
with a clear error; `doctor --ci` is the only guard, say so.

### 27. (should) Windows is absent — §4.4, §4.6, §9, §12

**Problem.** v3 does not contain the word Windows.
Round 9 §5.6 listed the issues: hook shims under Git for Windows, snapshot symlinks need
Developer Mode, case-insensitive collisions in directory refs, reflink unavailable on
NTFS, `link()` for the local backend, long paths, CRLF (finding 15).

**Fix.** Add §"Platforms": hooks are `sh` scripts (Git for Windows ships sh); snapshot
restore falls back to copying symlink targets with a warning and records `l:` fidelity
loss in the restore summary; `add` to a directory ref refuses two paths that differ only
by case (`E_CASE_COLLISION`) on all platforms; content cache materializes by copy where
reflink fails; local backend uses `O_EXCL` (never `link`) on Windows; paths are stored
with `/` and NFC. CI matrix includes `windows-latest` for the golden suite.

### 28. (should) Monorepos and multiple backends: say what is and is not supported, and how to share assets — §11, §17

**Problem.** One backend per repo is a non-goal, subdirectory configs are gone.
A monorepo team will ask (a) can two repos share one bucket prefix (assets shared across
repos), (b) what happens to `gc` if they do.
(b) is dangerous: `gc` computes reachability from *this* repo’s history and deletes
everything else under the prefix — including the other repo’s objects.

**Fix.**
- Document the supported pattern: several repos may point `backend:` at the *same*
  prefix to share objects and asset snapshots (dedup is free; pin refs may name any
  asset under the prefix).
- `gc` **refuses** unless the project config says `gc: {owner: sole}` ("this repo is the
  only writer of this prefix") or the operator passes `--also-repo <url>…` so the keep
  set includes those repos’ histories (Gat’s `--repository`). Default is refuse with the
  explanation.
- Note that `gc` must run from a clone with every remote branch and tag fetched
  (`git fetch --all --tags --prune`), and that `--older-than` (default 30d) is what
  protects unpushed branches on teammates’ machines.

### 29. (should) Repos with existing LFS: overlap and ordering rules — §2 (UC-7), §4.5, §6

**Problem.** `import lfs` is Phase 5; until then the manual guide stands.
Even after, the design does not say that a path cannot be both `filter=lfs` and a ref
target, that `git lfs uninstall --local` and the `.gitattributes` edit must precede
`add`, or that the hash should be chosen first.

**Fix.** `doctor` and `add` detect `filter=lfs` attributes on a target
(`git check-attr filter`) and refuse with the two steps.
`import lfs` rewrites pointers in the working tree only (history import deferred),
copies `.git/lfs/objects` into the store, and prints the `.gitattributes` lines to
delete. The LFS guide’s step 4 becomes `blobsy setup --hash sha256 s3://…` with the
reason.

### 30. (must) Local-scope backend override contradicts “prefix is project-only” — §11

**Problem.** §11: local config may hold “a different backend URL or profile”; the same
section says “the backend prefix when it changes object location” is project-only.
A different URL always changes location.
Agents and CI need one answer (CI commonly points at a replica or a scratch bucket).

**Fix.** `backend:` (bucket + prefix) is project-only.
Local/global may set `backend_options: {endpoint, region, profile}` (connection, not
location). For a replica or scratch store, local config may set
`backend_override: s3://…` which `doctor` reports loudly and `push`/`snap publish` print
on every run (`→ s3://ci-scratch/… (local override)`), so a laptop can never silently
push to the wrong place.
Delete `BLOBSY_BACKEND_URL` or define it as the same override.

* * *

## Part D — Agents

### 31. (must) The skill must be rewritten for v3 and must carry the traps, not just the verbs — §7.7

**Problem.** The current `SKILL.md` teaches `track`, `--auto`, `docs --readme` and
`rm --remote --force` — all removed in v3. §7.7’s four rules are right but thin.
The traps an agent will hit in v3, in order of likelihood: (1) `--force` learned from a
refusal; (2) `add <dir>` on a mixed directory (finding 7); (3) not running `pull` after
`git pull/checkout/merge/rebase`; (4) `rm` deleting bytes (finding 9); (5)
`snap restore` replacing a directory wholesale; (6) `git push` blocking on an upload and
reaching for `--no-verify`; (7) `gc`; (8) forgetting that `.blobsy.yml` and
`.gitattributes` must be committed; (9) jj’s missing hooks; (10) `pull --include` then a
full `pull`.

**Fix.** Replace `packages/blobsy/SKILL.md` with this (≤60 lines; `blobsy docs --skill`
prints it, with the repo’s `backend:` and `hash:` substituted in):

```markdown
---
name: blobsy
description: Large files outside git, versions inside git (.bref refs). Use when a repo has .bref files or .blobsy.yml, when files are too big for git, or when the user says blobsy, bref, LFS alternative, snapshot/cache a build tree.
---
# blobsy (v3)

Install: `npm i -g blobsy` or `npx blobsy@1 …`. Config is committed in `.blobsy.yml`; local state is under `.git/`.
State first: `blobsy status --json` (never guess). Plan first: add `--dry-run --json` to any command that moves bytes.

## The loop
1. `blobsy add <file|dir>` — hashes, writes `<path>.bref`, gitignores the payload, stages both. No network.
   - `add <dir>` makes the whole directory one ref; it refuses dirs with git-tracked files. For mixed dirs: `add --per-file <dir>`.
2. `git commit` → `git push` (the pre-push hook uploads; for >1 GB run `blobsy push` first).
3. After ANY `git pull|checkout|merge|rebase|stash pop`: `blobsy pull`. It only overwrites files whose bytes are recoverable.
4. Fresh clone: `blobsy setup && blobsy pull`.

## Rules
- Never add `--force` because a message mentioned it. A refusal (exit 2) lists choices; `blobsy add <path>` keeps the user's bytes.
- Never `git commit --no-verify` or `--no-hooks` to get past a blobsy hook; read its message.
- `blobsy rm <path>` stops tracking and KEEPS the file; `--delete` removes it. The store is never changed by rm.
- `blobsy snap restore <stanza>` REPLACES that directory. `snap publish` needs write credentials (usually CI only).
- `blobsy gc` deletes from the store. Only with the user's explicit instruction, `--dry-run` first.
- Commit `.blobsy.yml`, `.gitattributes` and every `.bref`; never commit payloads (the pre-commit guard refuses files inside a ref or over `git_max_file_size`).
- Conflicts: `blobsy resolve <ref> [--ours|--theirs]`, then `git add`, then `blobsy pull`.
- jj: no hooks run. `blobsy add → blobsy push → jj commit → jj git push`.

## Commands (all take --json --dry-run --quiet)
add · rm · mv · push · pull [--include g] [--offline] · sync · status [--remote] · diff [rev..rev] · resolve · snap publish|restore|ls|show · doctor [--ci] · config · docs <topic>
Exit codes: 0 ok · 1 error · 2 refused (data protection) or unresolved conflict.
```

### 32. (should) `--dry-run --json` must be the universal “explain” and must include refusals — §7.7

Covered by finding 12; add to §7.7: "Agents should run `pull --dry-run --json` after any
git operation and act on `plan[].op == "refuse"` before running `pull`."

### 33. (consider) `blobsy docs --skill` should render dynamic context — §6

Print the backend, hash, hasher status, ref count by shape, whether hooks are installed
in this clone, and whether credentials resolve, as a 6-line preamble.
An agent then has orientation in one call.

* * *

## Part E — Discoverability and naming

### 34. (should) Flag and command names — §6

| Current | Issue | Proposal |
| --- | --- | --- |
| `add --each <dir>` | “each” says nothing about *what* is created | `add --per-file <dir>` |
| `add --prune` | collides with `cache prune`/GC vocabulary; dangerous with partial pulls (finding 8) | keep only with the materialized-here definition; otherwise `--drop-deleted` |
| `rm --keep-local` | the safe choice should be the default (finding 9) | `rm` keeps; `rm --delete` deletes (or `--cached` for git parity) |
| `pull --cache-only` | reads as “pull into the cache” | `pull --offline` |
| `setup --hydrate` | jargon; the user wants “pull after checkout” | `setup --auto-pull`; config `auto_pull: {network: false}` instead of `hydrate.fetch` |
| `gc --snapshots` | assets are snapshots too and are never deleted | `blobsy snap gc [--older-than]` (under the `snap` noun); `blobsy gc` = content objects only |
| `cache` (local) vs “cache snapshot” (remote, UC-3) vs “hash cache” | four caches in one doc | local: **object cache** (`blobsy cache …`); UC-3: **build caches** (always “cache snapshot” in prose, `snap/cache/` in keys); hash cache: **stat cache** |
| `snap` | agents will type `snapshot` | keep `snap` (short, no alias), but `--help` and errors say “snapshot” and `blobsy snapshot` prints `did you mean: blobsy snap` |
| `status --all` | “all” could mean all refs | `--entries` |
| `doctor --ci` | fine, but define it as “no writes, no local checks” (finding 3) | keep |
| snapshot `exclude:` vs ref `ignore:` | two words for one concept | `ignore:` in both |
| `resolve` | good | keep; see finding 17 |
| `config --local` | good (git parlance) | keep |

Also: no state symbol should be `?` (finding 11); add `--ascii` (or honor
`NO_COLOR`/non-UTF-8 locale) to print
`ok/stale/modified/absent/unpushed/deleted/conflict` words instead of glyphs.

### 35. (should) The first generated `.blobsy.yml` should be minimal and self-documenting — §11

**Problem.** §11’s example is the full schema.
If `setup` writes all of it, every repo carries 20 lines of defaults that drift.

**Fix.** `setup` writes exactly:

```yaml
# blobsy project config -- https://github.com/jlevy/blobsy -- `blobsy docs config` for every option
backend: s3://my-bucket/my-project
hash: blake3            # fixed once refs exist
# externalize.min_size: 200kb    (used by `add --per-file`)
# git_max_file_size: 5mb         (pre-commit guard)
# snapshots: {}
```

Unknown keys are errors with “upgrade blobsy or fix the key” (strict schema doubles as a
forward-version check).

### 36. (consider) `blobsy --help` should print the 6-command path first

```text
blobsy — large files outside git, versions inside git
  setup <backend>   once per repo (and once per clone)       add <path>   track   push/pull   sync
  status  diff  resolve  snap  doctor  gc  cache  config  docs
First time? blobsy docs quickstart      Agents: blobsy docs --skill
```

* * *

## Part F — Missing workflows

### 37. (should) Changing or moving the backend — §5.6 of round 9 is not in v3

Add §"Moving the store": `rclone copy <old>/<prefix> <new>/<prefix>` (or `aws s3 sync`),
change `backend:` in one commit, run `blobsy doctor --ci` on a clone to confirm every
object at HEAD exists at the new location.
No ref changes (keys are path-independent).
Renaming the git repo or host changes nothing.
Consider a convenience `blobsy push --to <url>` only if users ask.

### 38. (should) Deleting large data from history (PAIN-3) is a one-liner in §14 and needs the full recipe

```bash
git filter-repo --path data/old-dump.parquet.bref --invert-paths   # and the gitignore line
# everyone re-clones; then, from a fresh full clone:
git fetch --all --tags --prune
blobsy gc --dry-run            # lists orphans older than 30d with sizes
blobsy gc
```

State the preconditions (finding 28), that bucket versioning gives the recovery window,
and that `gc` refuses if any historical ref fails to parse.

### 39. (should) Offline work needs one paragraph and one message — §10

`add`, `status`, `diff`, `resolve`, `pull --offline` and `snap restore` from the object
cache work offline. `pull` on a `~ modified` file cannot check rule (c) offline and
refuses:

```text
refused: data/model.bin — cannot verify your local bytes are recoverable (offline; not in the object cache)
  retry online, or: blobsy add data/model.bin (keep yours) · blobsy pull --force (discard yours)
```

`push` offline: exit 1 `E_OFFLINE` with “your refs and commits are safe; run blobsy push
when online”.

### 40. (should) A zero-credential first try — §7.1

Every first-run doc leads with S3. Lead with `blobsy setup local:../blobsy-store` (a
directory beside the repo), which exercises the whole flow in two minutes with no
account, then “switch to a bucket: edit `backend:` and `blobsy push`” (finding 37).
`setup` prints this when it sees no credentials for an `s3://` URL.

### 41. (should) Reclaiming disk: a verb to drop materialized payloads safely — §6

There is `cache prune` for the object cache and `rm` for refs, but nothing to say “free
the 40 GB of `data/images` on my laptop, keep tracking it”.
Add `blobsy clean <path>…`: deletes materialized payloads whose bytes are recoverable
(rule §10), keeps refs, refuses `~ modified` and `↑ unpushed`; `snap status <stanza>`
prints “local tree matches published tree — safe to delete”.
Name mirrors `git clean` (removes what the VCS can recreate).

### 42. (consider) Rotating credentials, suspected corruption, recovering a GC’d object

One short “Recovery” topic in `blobsy docs`: credentials are the SDK's/rclone's business
(`doctor` diagnoses); a hash mismatch on pull never replaces the local file and names
the key (restore from bucket versioning or re-push from a machine with the bytes:
`blobsy push <path>` works because the key is derived); an object deleted by `gc` makes
old commits unrestorable by design (`status --remote` shows `missing`).

### 43. (consider) Two blobsy processes on one clone — §4.6

Restore hooks plus an agent running `pull` concurrently will race on the stat cache and
temp files. Add a lock file under `$(git rev-parse --git-path blobsy)/lock` with a clear
“another blobsy command is running (pid N)” message.

### 44. (consider) Interrupted snapshot swap

Crash between the two renames leaves `<path>.blobsy-old-<rand>`; `doctor --fix` should
remove or restore it.
Name the temp dirs in §4.4 so users recognize them.

### 45. (consider) `#blobsy-ref 1` as the only version signal

Fine for refs. For config, the strict schema (finding 35) is the forward check.
For the store, add `<prefix>/_blobsy/layout` = `1` written by `setup --probe`, so an
older client pointed at a newer layout fails fast instead of 404-ing on every key.
Low priority.

* * *

## Appendix — Golden paths (first ten minutes)

### (a) A human starting a repo

```bash
npm install -g blobsy                              # or brew/binary later
cd my-project
blobsy setup local:../blobsy-store                 # 2-minute try: no credentials. Later: blobsy setup s3://bucket/prefix
#  ✓ wrote .blobsy.yml (hash: blake3 native)   ✓ wrote .gitattributes (*.bref merge=blobsy eol=lf)
#  ✓ installed pre-commit / pre-push hooks     ✓ store reachable (create-only: yes)
#  ✓ staged .blobsy.yml .gitattributes .claude/skills/blobsy/SKILL.md
#  next: blobsy add <file or dir>, git commit, git push
blobsy add data/model.bin                          # → data/model.bin.bref + /model.bin in data/.gitignore, both staged
blobsy add data/images                             # whole directory → data/images.bref (10,312 rows). Refused if git tracks files there.
blobsy status
git commit -m "Track model and image set"
git push                                           # hook: "uploading 10,313 objects (4.5 GB)…"  (or blobsy push first)
```

### (b) A teammate joining

```bash
git clone … && cd …
npm install -g blobsy
blobsy setup                                       # join: hooks + driver only; prints backend, posture (read-only), hasher
#  hint: no credentials for s3://… → see blobsy docs credentials
blobsy pull --include 'images/cats/**'             # partial; remembered for this clone
blobsy status                                      # ✓ ok / ↓ absent (sparse) — nothing to fix
# every day:
git pull && blobsy pull                            # stale files replaced; your edits never overwritten
blobsy add data/model.bin && git commit -am "Retrain" && git push
```

### (c) An agent

```bash
npx blobsy@1 docs --skill                          # orientation: rules + repo context (backend, hash, hooks installed?)
npx blobsy@1 status --json                         # state before touching anything
npx blobsy@1 add data/new-dataset.parquet --dry-run --json   # plan: encoding, key, size
npx blobsy@1 add data/new-dataset.parquet
git commit -m "Add dataset" && npx blobsy@1 push && git push
# after any git op:
npx blobsy@1 pull --dry-run --json                 # act on plan[].op == "refuse" (never --force blindly)
npx blobsy@1 pull
```

### (d) CI (GitHub Actions, read-only PRs, write on main)

```yaml
- uses: actions/checkout@v4
- uses: aws-actions/configure-aws-credentials@v4     # read role via OIDC
- uses: actions/cache@v4
  with: { path: .git/blobsy/objects, key: blobsy-${{ hashFiles('**/*.bref') }}, restore-keys: blobsy- }
- run: npx blobsy@1 doctor --ci                      # validates refs, markers, overlaps, remote existence; no writes
- run: npx blobsy@1 pull --include 'test-fixtures/**'
- run: npx blobsy@1 snap restore cargo-target        # miss → exit 0
- run: cargo test
- if: github.ref == 'refs/heads/main'
  uses: aws-actions/configure-aws-credentials@v4     # cache-writer role, PutObject on snap/cache/* only
- if: github.ref == 'refs/heads/main'
  run: npx blobsy@1 snap publish cargo-target
- run: npx blobsy@1 diff origin/main...HEAD --markdown > blobsy-diff.md   # post as the PR comment
```

* * *

## Summary of “must” items (15)

1 hooks when blobsy is absent · 2 hasher visibility and `--hash` at setup · 3 read-only
`doctor --ci` (probe moves to `setup`/`--probe`) · 4 `setup` join vs first run;
principle 1 wording · 7 `add <dir>` refuses git-tracked files · 8 `--prune` only drops
materialized-here entries · 10 `⇣ stale` vs `~ modified`, refusal text · 12
`--json`/error/plan schemas · 15 gitignore placement + `eol=lf` · 20 cache miss exits 0
· 22 `add` on a pin refuses; pre-push verifies pins · 24 CI recipe with write
segregation · 28 `gc` refuses on shared prefixes · 30 backend override scoping · 31
rewrite the skill.
