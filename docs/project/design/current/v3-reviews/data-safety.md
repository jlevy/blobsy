# Blobsy design v3: adversarial correctness and data-safety review

**Date:** 2026-10-23. **Reviewed:** `docs/project/design/current/blobsy-design.md` (v3,
2026-10-22), the v3 implementation plan, the round 9 review and its sub-reviews, the
threat model, and the three October research docs.
**Stance:** principal engineer, hunting for data loss, silent corruption,
unrepresentable states, races, and underspecification that would make two implementers
diverge. For every hole the fix proposed is the *simplest* one I could find that closes
it; where a simpler fix exists at a cost, the cost is named.

**Evidence markers.** **[E]** verified by experiment in `scratchpad/v3safety/` (git
2.43, Node 22.22, ext4-class FS). **[R]** reasoning from the design text plus cited
research. **[S]** stated in a research or sub-review doc, trusted.

**Severity.** **must-fix** = loses or permanently corrupts bytes, or creates an
unrepairable state, in an ordinary workflow.
**should-fix** = a gap the owner will trip on, or two implementers would resolve
differently with safety consequences.
**consider** = judgment call or polish.

**Headline.** The v3 shape is right and most round-9 blockers are fixed by construction.
The design is still *unsafe in five places* that are each one or two sentences away from
safe: the merge driver in criss-cross merges (reproduced), the recoverability rule
trusting records that GC/lifecycle can invalidate, uploads from a mutable working tree
poisoning a create-only key forever, snapshot publish races that permanently break a
write-once name, and `snap restore`’s swap having no “is this really a cache?”
guard. Everything else is specification tightening.

* * *

## 1. Recoverability rule (§10, §5 inv. 5)

### F1. Rule (a) trusts a “synced” record that GC, lifecycle, or a backend switch can make false — **must-fix** [R]

**Section:** §10 (a); §14; §11 local backend override.
**Scenario.**
1. Alice edits `model.bin` (v2), `blobsy add`, `blobsy push` → synced record “v2
   pushed”. She commits on branch `wip`, never pushes git, later deletes `wip` (or
   rebases it away).
2. 31+ days later anyone runs `blobsy gc`: v2 is unreachable from every ref → deleted.
3. Alice checks out `main` (ref says v1). `model.bin` is still v2 on disk (ignored files
   survive checkout). `blobsy pull` (or the `post-checkout` hook with `--hydrate`): rule
   (a) says v2 is recoverable → overwrites with v1. v2 exists nowhere.
   Variants: a lifecycle rule misconfigured on the content prefix; local config pointing
   at a different backend/profile (§11 allows “a different backend URL” locally while
   also saying prefix changes are project-only — contradictory; a synced record from
   backend A is meaningless for backend B). **Why it matters.** §10 was introduced
   precisely so that nothing but *evidence the bytes exist* licenses destruction.
   A stale record is not evidence.
   **Simplest fix (two parts, both small).**
- (i) Never destroy without a local copy.
  Replace the paragraph after “Recoverability rule” with: *“Before `pull`,
  `pull --force` or `rm` replaces or deletes a local file whose bytes differ from its
  entry, it first moves those bytes into the content cache (a rename or reflink; no
  hashing beyond what status already did).
  Only then does it apply the rule below to decide whether that cache copy may later be
  pruned.”* and add to §4.6: *“`cache prune` never removes an object that has no synced
  record (bytes only this machine holds) unless `--include-unsynced` is given.”* This
  makes every destructive path reversible for the cache retention period, with no trash
  directory and no new state: the content cache already exists and is already
  content-addressed.
- (ii) Make (a) and (c) consistent with remote reality: *“When online, `pull` and `rm`
  check (c) with a batched `exists` and ignore (a); (a) and (b) are consulted only with
  `--cache-only` or when the backend is unreachable.
  Synced records are keyed by backend URL and are ignored for any other backend.”* Cost:
  one extra batched `exists` per destructive command when online (already required for
  `status --remote`).

### F2. Rule (b) “content cache holds the bytes” can be the only copy, and `cache prune` can delete it — **must-fix** (folds into F1) [R]

**Scenario.** `cache.on_add: true`. `blobsy add` v2 (copied to cache),
`git checkout -- x.bref` (the B-1 variant).
`pull` → (b) holds → overwrite.
`cache prune --older-than 7d` a week later deletes v2 from the cache.
v2 is gone. The design says the cache “is never required for correctness” (§4.6) while
§10 uses it as a safety input.
**Fix:** the `cache prune` sentence in F1(i). Also strike “never required for
correctness” and write *“never required for reads; it is a safety input to §10 and is
pruned accordingly.”*

### F3. Rule (c) “exists in the store” is a presence check, not a bytes check — **should-fix** [R, S]

`exists` by `list`/HEAD tells you a key exists, not that it is intact.
A truncated object on a non-atomic backend (F13), a corrupted upload, or a versioned
bucket whose current version is a delete marker (HEAD → 404, which is the safe
direction) are the cases.
Only the first is unsafe: local bytes destroyed, remote object unreadable.
With F1(i) the bytes are still in the local cache, so the exposure is bounded; add one
cheap check anyway: *“`exists` returns size; for entries with encoding `-`, a size
mismatch counts as missing.”* Also state consistency explicitly: *“S3, GCS, Azure and R2
give strong read-after-write consistency; command and rclone backends are assumed
consistent.”*

### F4. Offline behavior is specified for `pull` but not for `rm`, hooks or `--cache-only` — **consider** [R]

State once: *“`--cache-only`, hooks and offline runs use (a) and (b) only; they never
make a network call and never destroy bytes they cannot prove recoverable.
A refusal from a hook is a one-line message, exit 0.”*

### F5. `add --prune` destroys entries for files that were never pulled — **should-fix** [R]

§7.2 says a user who pulled `cats/**` must not lose the rest on `add`, and then offers
`add --prune` for “entries whose files are gone”.
After a partial pull, *every* non-included entry is “gone”.
`--prune` would drop them from the ref and the next commit silently shrinks the
collection; `gc` later deletes the objects.
The round 9 review kept the “not pulled vs missing” distinction (§5.3) exactly for this;
v3 §10 dropped it (one `↓ absent` state).
**Fix:** *“`--prune` removes only entries whose file was previously materialized in this
worktree (the hash cache has a record for the path) and is now absent.
Entries never materialized here are kept; `--prune --all` removes them too.”* Add a
`status` state or a note: `↓ absent (never pulled here)` vs `↓ missing (was here)`.

### F6. `rm` on a directory ref: which files does it delete? — **should-fix** [R]

“Deletes local files” is ambiguous for a directory target containing files not in the
ref (new files not yet `add`ed, `ignore`-pattern files).
Two implementers diverge; one of them deletes un-added work.
**Fix:** *“`rm` deletes only files that match an entry (same hash).
Other files in the target are left in place and listed.
The directory is removed only if empty.”*

### F7. `pull` replacing a directory with a file (or vice versa), symlinks at the target path — **consider** [R]

A ref can change shape (file ref ↔ directory ref ↔ pin) between commits.
State: *“`pull` never removes a directory to place a file unless every file inside is
recoverable under §10; it never follows a symlink at the target path and refuses if the
target is a symlink.”*

* * *

## 2. Derived keys, create-only, compression (§4.3, §4.5)

### F8. Upload from a mutable working tree can poison a content key forever — **must-fix** [R]

**Scenario.** `blobsy add big.bin` → hash H recorded.
A process (training job, editor autosave) rewrites `big.bin` between the hash and the
upload, or during the upload.
`push` “verifies each file against its entry first” — but the stat-cache fast path
(§4.5, §9 pre-commit) can skip the re-hash, and even a real re-hash is a TOCTOU against
a streaming PUT. The bytes streamed to key H are not H. Create-only then forbids ever
replacing them. Every clone’s `pull` of H fails verification forever; `gc` never deletes
it (it is reachable).
The same applies to the pre-push hook uploading “from the working tree”.
**Fix (simplest):** upload only from immutable bytes, which the design already half-says
("copied before upload"). Make it normative in §4.3: *“`push` never streams from the
working tree. It copies the file into the content cache, hashing as it copies; if the
hash differs from the entry the file is reported as modified and skipped.
The upload reads the cache object.
For `--no-cache` environments, hash the bytes as they stream and abort the request (or
the multipart upload) on mismatch.”* And add the one legitimate overwrite (see F14).

### F9. `#blobsy-ref 1 <algo>` strict reader + per-repo algorithm switch bricks history operations — **should-fix** (becomes must-fix the first time anyone switches) [R]

“Strict reader: exactly version 1, and the repo’s configured hash algorithm.”
After `hash:` changes from sha256 to blake3: every historical ref fails to parse → `gc`
“refuses to run if any ref in history fails to parse” (forever), the pre-push hook
reading refs “from the commits” aborts pushes that touch old commits,
`blobsy diff <old>` fails, and `pull` after `git checkout <old>` fails.
Also `add` on an existing directory ref with a different configured algo must re-hash
every entry, including entries not materialized locally (partial pull) — impossible.
**Fix:** *“The header’s algorithm must be one blobsy supports (`blake3`, `sha256`);
readers use the algorithm named in the ref.
`hash:` in config applies only when `add` creates a ref.
`add` on an existing ref keeps the ref’s algorithm; `add --rehash` rewrites it with the
configured one and requires every entry to be materialized.”* Keys already embed
`<algo>/`, so mixed algorithms in one store are fine.

### F10. Encoding decision is deterministic in theory, not in practice; add/add merges and reads should tolerate both encodings — **should-fix** [R]

The 5% rule depends on the zstd implementation and level; two machines near the
threshold decide differently, and a `compress.*` rule change mid-life makes two machines
that both `add` the same new bytes (common: a generated file on two branches) emit
`H zstd` vs `H -`. Consequences: (1) the per-path merge rule sees “changed differently
on both sides” for identical bytes → false conflict; (2) after a merge picks one row,
the other machine’s object sits under the other key and `pull` reports missing until
someone re-pushes. **Fix (two sentences):** §8: *“Rows are compared on the first four
columns; if only `extra` differs, take ours.”* §4.3: *“Readers (`pull`, `exists`,
`status --remote`) try the recorded encoding first, then the other; a hit under either
counts as present.”* Also: *“`add` on an unchanged file (same hash) keeps the existing
row, including its encoding, so rule changes cause no churn.”* Zstd non-determinism of
the compressed bytes is otherwise harmless: identity is the original hash and the 412
loser is discarded.

### F11. Decompression needs a size bound and the `.zst` object can’t be verified remotely — **consider** [R]

State: *“Decompression stops and fails once `size` bytes have been produced or the
stream ends short; the hash is checked over the decompressed bytes.”* Note in §4.3 that
compressed objects have no server-side checksum matching the ref, so `doctor --ci`
checks presence (and size only for `-` objects); a `--deep` verify downloads.

### F12. Multipart create-only gaps and exists-then-put races are benign only because keys are content keys — **consider** [R, S]

Worth one sentence so an implementer doesn’t “fix” it: *“Where create-only is
unavailable (GCS XML multipart, R2 multipart completion, B2, rclone to GCS/Azure,
command backends) two writers of a content key write identical bytes (or identical
decompressed bytes), so last-writer-wins is harmless.
Snapshot objects are made safe by F16, not by conditionals.”* Keep the doctor probe
tolerant of read-only credentials (*"probe skipped: no write access"*) and keep its
sentinel outside `<algo>/` and `snap/` so `gc` and `list` ignore it.

### F13. Local and command backends must write atomically or a crash leaves a permanent truncated object — **must-fix** [R]

`local:` is the test and offline backend.
A direct `open(O_EXCL)` + write that dies mid-way leaves a short object under a content
key; create-only then protects the corruption forever (F14). **Fix:** §12 `local:`:
*“write to a temp name in the destination directory, fsync, then `link()` to the final
key (EEXIST = already exists); never open the final key for writing.”* Command backends:
*“`put` is documented as atomic; blobsy additionally verifies size (encoding `-`) after
put.”*

### F14. There is no path to repair a corrupt object under a reachable content key — **should-fix** [R]

Create-only + “only gc deletes” + “gc deletes only unreachable” means a bad object (F8,
F13, bit rot, a misbehaving S3-compatible) is stuck.
**Fix:** §6/§5 inv. 1: *“The one overwrite blobsy performs is `push --repair <path>`: it
downloads the existing object, and only if its verified hash differs from the key does
it replace it (unconditional PUT) with verified bytes.
`doctor --ci --deep` reports such objects.”* Note Object Lock would block this; that is
acceptable.

### F15. Hash cache fast path: size+mtime+ctime is sound on ext4 but say what “write time” means — **consider** [E, R]

Measured here: timestamp granularity ≈120 µs, 0/2000 same-size rewrites collided.
Coarse filesystems (HFS+ 1 s, FAT 2 s, some NFS) make the racy-clean rule load-bearing,
and the rule compares file mtime to “the cache entry’s write time”: specify that this is
the *filesystem* mtime of the cache file after writing (same clock domain), not
wall-clock. Also: `add` must stat before and after hashing and re-hash on any change
(closes the F8 TOCTOU at the source); `ctime` is not settable by users on POSIX, so
`mv`/`cp -p`/`touch -r` can’t spoof the triple.
Windows: `ctime` is change time via libuv; fine.

* * *

## 3. Ref format and merge driver (§4.2, §8)

### F16. Criss-cross merges: the driver’s markers become the merge base, and the design’s own strict parser then turns the merge into Gat’s data-dropping bug — **must-fix** [E]

**Experiment** (`cc_none/`): base has rows a,b,c; branches x and y change c differently,
each merges the other (resolving oppositely), then x adds d, y adds e, x merges y. Two
merge bases → git builds a virtual ancestor by calling the registered driver (`%L=9`).
The per-path driver writes `<<<<<<<`-marked c and exits 1. Git uses that output as the
*base* of the real merge.
A blobsy-style strict parser rejects the base → driver exits 2 → git leaves `%A` as
**ours**: `c=cXXX`, `d`, and **no `e`** and no markers.
`git add d.bref && git commit` silently drops y’s clean addition.
This is exactly §8’s “differs from Gat deliberately” promise, broken by criss-cross
alone. `recursive=text` reproduces the same failure (`cc_text/`). Criss-cross merges are
routine on long-lived branches that merge main repeatedly in both directions.
**Fix (verified, `cc_inner/`):** register a second driver for the inner merge:
`merge.blobsy.recursive = blobsy-inner`,
`merge.blobsy-inner.driver = blobsy merge-driver --inner %O %A %B %P`. §8 text: *“In an
inner (virtual-ancestor) merge the driver omits every conflicting path from its output
and exits 0. A path missing from the virtual ancestor and present differently on both
sides is then an add/add conflict in the real merge, so no conflict is hidden and no
marker reaches a parser.”* Result in the experiment: clean a,b,d,e plus a single marked
c. (`recursive=binary` also produced the right answer here, but by relying on
undocumented ort behavior; the inner driver is explicit.)
**And:** *“If the driver cannot parse any input, it writes a whole-file conflict (ours
between `<<<<<<<`/`=======`, theirs after) and exits 1; it never leaves `%A` as ours.”*

### F17. Clean git merges create states the validator calls illegal; `doctor --ci` must check cross-ref overlap and git-tracked files inside targets — **should-fix** [E]

**Experiment** (`nest/`): branch a adds directory ref `data/images.bref`; branch b adds
file ref `data/images/cats/002.jpg.bref` and a plain git file `data/images/README.md`.
Plain git merges cleanly; the result nests a ref inside a ref target and tracks a git
file inside it. §8’s validator checks a ref’s *own* body; §4.2’s “refs don’t nest” is
enforced by `add`/`doctor`. State explicitly that the pre-commit validator and
`doctor --ci` check (1) no ref target contains another ref, (2) `git ls-files` has no
path inside any ref target except the ref itself, (3) every ref target is covered by an
ignore line. Otherwise the next `pull` of `data/images` would have to replace a
git-tracked `README.md` and a file-ref’d `002.jpg` and the design does not say what
wins.

### F18. Rename detection moves refs away from payloads and un-ignores them — **should-fix** [E]

**Experiment** (`ren/`, `dren/`): `git mv model.bin.bref model-v1.bin.bref` on one
branch, edit of `model.bin.bref` on the other → clean merge, edit applied to the new
name; `model.bin` (300 KB, ignored, possibly unpushed) stays on disk with no ref.
ort’s directory rename detection does the same for a new ref added on the other side
(with a “file location” notice).
After `doctor --fix` regenerates the ignore block from refs present, the orphan payload
becomes an untracked file; `git add -A` commits it if under `git_max_file_size` (it is
not “inside a ref target”). **Fix:** *“`doctor` reports ignored payload files with no
ref ('orphans'); the regenerated ignore block keeps a line for each orphan until it is
deleted or re-added.
The pre-commit guard also refuses a staged file whose hash matches any entry in any ref
at HEAD or in the hash cache.”* (The second clause is one lookup and catches every
“payload escaped its ref” variant of B-3.)

### F19. Path escaping and sorting are underspecified; two implementers will produce different `tree_id`s — **should-fix** [R]

§4.1: “NFC-normalized, escape control characters as `\xhh`”. Open questions an
implementer must answer, each changing `tree_id` and merge behavior: Is `\` itself
escaped (it must be, or `\x09` in a real filename is ambiguous)?
Are `\t`, `\n`, `\r` escaped (tab must be, it is the delimiter)?
Hex case? Is sorting on the raw bytes or the escaped column?
Does a path beginning with `#`, `<`, `=`, `>`, `|` get escaped (a row starting with `#`
is a header; one starting with `<<<<<<<` is a marker)?
Does NFC normalization apply to on-disk names on Linux, where the NFD file then never
matches its row (pull creates an NFC twin; macOS sees one file, Linux two)?
What about `l:<target>` targets?
**Fix (pin it):** *“Paths and symlink targets are UTF-8. Escape `\` as `\\`, and every
byte < 0x20, 0x7F, and a leading `#`, `<`, `=`, `>`, `|`, as `\xhh` lowercase.
Rows sort bytewise on the escaped `path` column.
No normalization is applied; `add` refuses a directory containing two names that are
equal after NFC or case folding, or a name that is not valid UTF-8 (it would be
unportable).”* Add test vectors.

### F20. Header mismatch must be a conflict in the driver — **should-fix** [R]

“The header is taken from ours (it is static).” After F9, two sides can carry different
algorithms (one side ran `add --rehash`). Taking ours’ header over theirs’ rows yields
keys derived with the wrong algorithm for every row from theirs: nothing is lost, but
every pull 404s with no clue.
**Fix:** *“If the header lines differ, the driver emits a whole-file conflict.”*

### F21. Merge rules: enumerate the remaining cases so implementations agree — **consider** [R]

Add to §8: add/add identical → keep; add/add different (same first four columns,
different extra) → F10; file ref ↔ directory ref shape change (`.` row deleted on one
side, rows added on the other) → per-path rules apply unchanged, and the gitignore line
changes from `x` to `x/` via `doctor --fix`; an empty body (zero rows) is a valid empty
directory ref (or forbid it; pick one).
Rebase/cherry-pick/stash go through the same driver [S]. jj: the `--jj` mode receives
raw sides, never jj’s `%%%%%%%` markers [S]; the validator must also recognize jj marker
styles and markers longer than 7 characters in files jj wrote.
GitHub web edits: the validator rejects unsorted/duplicate rows in CI; say that
`blobsy add <dir>` re-canonicalizes a hand-edited ref without network.

### F22. Ignore lines should be anchored — **consider** [R]

`model.bin` in `data/.gitignore` also ignores `data/sub/model.bin` and any deeper
`model.bin` that belongs to git, silently.
Write `/model.bin` and `/images/`.

### F23. `↑ unpushed` vs `? unknown remote` are the same observable condition offline — **should-fix** [R]

Both are “local matches; no synced record”.
The design gives different next actions.
Either define `↑` as “this machine added the row (an `added` record in the hash cache)”
or drop `?`. Agents key on these.

* * *

## 4. Hooks (§9)

### F24. Pre-push must enumerate every ref *blob* in the range, not the endpoint diff — **should-fix** [E]

**Experiment** (`rl/`): commits c2 (v2) and c3 (v3) pushed together.
`git diff remote..local` sees only v3;
`git rev-list --objects remote..local | awk '$2 ~ /\.bref$/'` lists both blobs.
A hook built on the endpoint diff lets v2 reach the remote with no object;
`git checkout c2 && blobsy pull` then 404s forever (and with `cache.on_add` off, nobody
has v2 bytes). **Fix text:** *“For each stdin line with a non-zero local sha: skip
deletions; for a new ref use `--not --remotes=<remote>` as the lower bound; enumerate
distinct `.bref` blobs with `git rev-list --objects`; parse each; batch `exists`; upload
what is missing from the content cache or from the working tree only when the
working-tree file’s hash equals the entry (then via the F8 copy-to-cache path);
otherwise abort naming commit and path.”* Shallow clones: `rev-list` stops at the graft;
everything below was fetched from a remote and is treated as already pushed.

### F25. Pushing a history with intermediate versions requires the bytes of versions no longer in the working tree — **should-fix** [R]

Sequence: `add` v1, commit, `add` v2, commit, `git push`. The hook needs v1’s bytes;
they are in the content cache only if `cache.on_add: true` (default false per §4.6).
Default behavior would be: abort the push, with no remedy except `--no-verify` (which
the design then relies on CI to catch).
**Fix:** make `add` always place bytes in the content cache (reflink when possible; it
is what makes F1(i), F8 and this work) and drop `cache.on_add` as an option, or default
it to true with a `cache.on_add: false` escape for huge files on non-reflink
filesystems.

### F26. Pre-commit “refs match local payloads” blocks merge, revert and cherry-pick commits — **should-fix** [R]

After `git merge` (teammate’s new hash, not yet pulled) the staged ref differs from the
local payload by design.
A guard that compares them refuses the merge commit and teaches `--no-verify`. **Fix:**
*“The payload check refuses only when the local file exists, differs from the staged
row, and the staged row’s hash has no synced record and is not in the content cache.
Absent files are skipped.”*

### F27. Large-file guard: legitimately large text and the CI backstop — **should-fix** [R]

`git_max_file_size: 5mb` refuses lockfiles, SQL fixtures and generated JSON that belong
in git; the escape is `--no-verify`, after which `doctor --ci` presumably fails the same
check on HEAD forever.
Specify: *“`git_max_file_size.allow: [globs]`; the guard checks only blobs newly added
in the staged change (pre-commit) or in the pushed/PR range (`doctor --ci --range`),
never all of HEAD.”* Make `--range` the recommended CI form: it also catches
intermediate commits with missing objects (jj users run `blobsy push` from the working
tree, so v1-in-history is never uploaded and HEAD-only `doctor --ci` passes).

### F28. Hook stdin edge cases — **consider** [R]

Say explicitly: deletions (local sha zero) are skipped; tags are ranges like branches;
force-pushes are tree ranges, not ancestry; multiple remotes share one store;
`BLOBSY_NO_HOOKS=1` disables all hooks including guards (so CI is the only check).

* * *

## 5. Snapshots (§4.4)

### F29. Two publishers racing with different trees under one name permanently break the name — **must-fix** [R, S]

Objects under `snap/<name>/` are `data.tar.zst`, `manifest.tsv.zst`, `ref.yaml`, each
create-only, each written by both writers.
Interleaving: A writes data (tree A). B’s data → 412, skipped.
B writes manifest (tree B) *before* A does; A’s manifest → 412, skipped.
A writes ref (tree_id A). Final state: ref=A, manifest=B, archive=A. Restore: manifest’s
recomputed tree_id ≠ ref → refuse.
The name is write-once, so nothing can repair it; `publish` from A says “already
published” (ref matches A). For caches: a permanent miss at that key until lifecycle
expiry. For `--name` assets: permanent, and the pin commit referencing tree A can never
restore.
Non-deterministic builds make this a daily race in CI, and the sub-review’s “412
on data is skipped” rule is what makes it silent.
**Fix (one layout change):** `snap/<name>/<tree_id>/data.tar.zst`,
`snap/<name>/<tree_id>/manifest.tsv.zst`, `snap/<name>/ref.yaml`. The ref names the
tree_id; archive and manifest are consistent by construction; the loser’s orphaned
`<tree_id>` directory is expired by lifecycle or `gc --snapshots`. Nothing else in the
design changes. (Also honest under exists-then-put backends, where the ref may be
overwritten: whichever tree the ref names is complete.)

### F30. `snap restore` swaps a directory with no check that it is a cache — **must-fix** [R]

`snap restore <stanza>` renames `<path>` away and the restored tree in.
A stanza typo (`path: src` instead of `target`), a stale stanza after a repo
reorganization, or an attacker-controlled `.blobsy.yml` (untrusted per the threat model)
deletes real work. Caches are “safe to lose” only if the path is actually a cache.
**Fix:** *“`snap restore` refuses to replace a path that contains any git-tracked file,
any ref or ref target, or is not ignored by git, unless `--force`. The displaced tree is
kept at `<path>.blobsy-old-<rand>` until the restore completes and is only then deleted;
on failure the renames are reversed.
Leftover `.blobsy-old-*`/`.blobsy-restore-*` siblings are reported by `doctor` and
removed by `doctor --fix`.”* For pin refs restored by `pull`, the per-file
recoverability rule applies to the displaced tree (F1 moves displaced files into the
cache anyway).

### F31. Extraction hardening is absent from the design — **must-fix** [R, S]

For cache snapshots nothing in git pins the tree_id, so an archive/manifest written by
anyone with bucket write access (or a first-writer under CREEP) is trusted at
extraction. Tar-slip (`a -> /etc`, then `a/passwd`), absolute symlink targets, `..`
segments, and hardlinks out of the tree are all one-line checks.
The sub-review listed them; v3 §4.4 dropped them.
**Fix:** *“Publish refuses absolute symlink targets and targets that resolve outside the
tree. Restore extracts into the temp directory without following symlinks, rejects any
entry whose path or link target contains `..` or is absolute, and creates symlinks after
all regular files are verified.
Pinned restores additionally require manifest tree_id == pin.”*

### F32. ref.yaml can outlive its data; a ref without data must be a miss — **should-fix** [R, S]

Lifecycle rules expire per object by creation age; the archive is minutes older than the
ref. Also `gc --snapshots` deleting a prefix while a restore reads it.
State: *“If the ref exists but manifest or archive is missing, caches report a miss (and
`--fallback` continues); assets report an error naming the object.”* Under F29 the
window still exists; the rule is what matters.

### F33. Publish must hash and pack in one pass — **should-fix** [R]

A tree modified during publish (a build still running, a watcher) gives a manifest whose
hashes disagree with the archive; restore verification fails; with F29 the name is not
corrupted but the key is dead until expiry.
*“The entry hash is computed from the bytes written into the archive; `tree_id` is
computed after packing.”*

### F34. Snapshot names: reserved segments, empty segments, prefix relations, unset `{env:}` — **consider** [R]

Validate: no empty segment, no trailing `/`, no segment equal to
`ref.yaml`/`manifest.tsv.zst`/`data.tar.zst` or a 64-hex string (reserved for F29).
Define a name’s objects as exactly its keys, so `gc`/`--fallback` of `cache/a` never
touches `cache/a/b`. `{env:NAME}` unset → refuse (an empty string would merge distinct
caches under one name).
`{hash:file}` differs under `core.autocrlf` → harmless miss; say so.

### F35. `--only <glob>` cannot be an atomic swap — **consider** [R]

A partial restore merges into the existing tree; specify that it overwrites only
matching paths, leaves others, applies F30’s refusals, and that a pinned tree after
`--only` reports `~ modified` (status) rather than ok.

### F36. Local snapshot cache keyed by `tree_id`: corrupt entry must evict, not fail — **consider** [R]

Two names with one tree_id can hold byte-different archives (zstd versions); any archive
that verifies against the manifest is fine.
If a cached archive fails verification, evict and refetch before failing.

* * *

## 6. GC (§14)

### F37. “Reachable from all branches and tags” is clone-local; unfetched branches, other clones’ pushed-but-unmerged work, stashes and reflogs are not covered; shared prefixes are deleted across repos — **must-fix** (as written) [R, S]

`gc` runs in some clone.
Its view: local branches, remote-tracking refs *as last fetched*, tags.
Not covered: branches on the remote never fetched here; a teammate’s `blobsy push`
(objects uploaded) whose git branch is pushed later or never; `refs/stash` beyond the
newest entry (reflog-only); jj’s `refs/jj/keep/*` in colocated repos; and *other
repositories* configured with the same backend URL (dedup across repos is explicitly a
feature of content keys, and nothing in the store says which repo owns an object).
The grace period protects uploads younger than 30 days only; a long-lived WIP branch
with `blobsy push` 60 days ago loses its objects, and with F1 unfixed the pusher’s own
machine then destroys the local copy on the next `pull`. Gat has the same weakness
(§13.9 of the Gat doc); v3 should not repeat it.
**Fix (precondition + two mechanics):** *“`gc` (1) runs `git fetch --all --tags --prune`
first and refuses if any remote is unreachable; (2) treats as reachable every object
referenced from any ref including `refs/stash`, reflogs (`--reflog`), and `refs/jj/*`,
plus the working tree and index; (3) refuses to run unless the bucket has versioning
(S3/GCS/Azure/B2) or the user passes `--no-recovery-window`; (4) is documented as unsafe
when more than one repository writes the same prefix, and `doctor` warns when the prefix
contains objects older than the repo’s first commit that no ref reaches (a cheap
heuristic for ‘someone else uses this prefix’).”* Also use conditional delete
(`If-Match`/`ifGenerationMatch`) per the research, so a concurrent re-upload is not
deleted.

### F38. Dedup defeats the grace period — **should-fix** [R]

An object uploaded long ago, unreferenced, is re-referenced today by a new `add` of
identical bytes: push gets 412 “already exists” → success, no LastModified change.
`gc` (listing done before the new commit is fetched) sees an old unreachable object →
deletes it → today’s commit points at nothing, and the pusher’s synced record says it
exists (F1). Mitigation without new state: *“`gc` re-reads refs after listing and
immediately before each delete batch; on `412`/exists for an object older than the grace
period, `push` re-uploads it (unconditional copy-in-place is fine for a content key) so
LastModified reflects the latest reference.”* Alternatively accept and document “run
`gc` when no pushes are in flight”.

### F39. `gc` and refs it cannot parse — **consider** [R]

Good rule (refuse). With F9 it stays viable across algorithm switches.
Also exclude the doctor probe sentinel and `snap/` from the content sweep.

* * *

## 7. Local state (§4.6)

### F40. Cache materialization must verify or the cache must be trusted explicitly — **should-fix** [R]

Pull “download → verify → cache → materialize by reflink/copy”.
A cache object corrupted later (disk error, a shared `cache.dir` across users/repos, a
bug) is materialized without verification, violating inv.
4\. Hashing at 2 GB/s during the copy is cheap.
*“Materializing from the cache re-hashes the bytes being copied (reflink: hash the
source) and evicts the object on mismatch.”*

### F41. Concurrent blobsy processes and the hash cache file — **consider** [R]

Two worktrees, a hook and a manual `pull` can run at once.
State: cache objects are written temp+rename (idempotent, same bytes); the hash cache is
written atomically and a lost update only loses records (safe direction: more
re-hashing, more refusals).
Synced records are machine facts; consider storing them in the common dir rather than
per worktree so a second worktree does not refuse what the first just pushed.

### F42. Worktrees: `git rev-parse --git-path blobsy` in a linked worktree and under `jj run` — **consider** [R, S]

`--git-path` resolves per worktree (good).
Under `jj run`, `--show-toplevel` walks up to the outer repo [S]; prefer
`$JJ_WORKSPACE_ROOT`. Non-colocated jj is unsupported; say so.

### F43. `add` on symlinks, sockets, empty directories — **should-fix** [R]

Kinds `l`/`d` are “snapshots only”; v2 silently skipped symlinks and lost exec bits
(M-2). Specify: *“`add` refuses a directory containing symlinks or special files (lists
them; `--skip-symlinks` to ignore); a file target that is a symlink is refused.”* Never
silently skip: the other machine’s pull would produce an incomplete tree with no
indication. Windows: *“where the filesystem has no mode bits, `add` preserves the
existing row’s kind.”*

* * *

## 8. Threat model consistency (§13, `blobsy-threat-model.md`)

### F44. Threat model references v2 mechanisms and misses v3 surfaces — **should-fix** [R]

- Rule 2 (`remote_key` escape): replace with *“keys are derived from validated hex and
  validated snapshot names; snapshot manifests from the store are untrusted until
  `tree_id` verification, and are extracted under F31 rules regardless.”*
- Rule 4: “verified against the `.bref` sha256” → “the ref’s named algorithm”.
- Rule 6: `rm --remote --force` no longer exists; `gc` and `push --repair` (F14) are the
  only deletes/overwrites.
- Add: the content cache and hash cache are trusted local state *except* a `cache.dir`
  outside the git dir shared with other users, which is why F40 verifies on materialize.
- Add: `.gitattributes` is repo content and only names a driver; the driver command
  comes from local config written by `setup`, so a repo cannot choose an executable.
  `setup` must refuse to install hooks into a `core.hooksPath` that lives inside the
  repo working tree (a repo-supplied hooks dir is repo-chosen code).
- Add: `Content-Disposition` filenames derived from repo paths are sanitized (quotes,
  control chars).
- CREEP: the design’s mitigation is credentials only; add F31 as defense in depth and
  state that `--fallback` restores unpinned content by design.

* * *

## 9. Smaller underspecifications (each one line in the design)

- `sync` = `pull` then `push`: say whether `push` runs when `pull` refused some entries
  (recommend yes) and that exit is 2 if any refusal.
- `status` exits 2 when any ref is invalid or has markers (jj research #7).
- `blobsy add .` (repo root as target) and a target whose `.bref` sibling is already a
  git-tracked non-ref file: refuse.
- Single-file snapshots: the manifest has exactly one row with path `.`.
- `import lfs` with `sha256`: verify the LFS object’s hash while copying rather than
  trusting the pointer.
- `setup` installing hooks: honor `core.hooksPath` but refuse one inside the worktree
  (F44).
- `mv`: refuse an existing destination; rewrite the ignore line; the hash cache entry
  moves with the path.
- Pre-commit validator runs on staged content (`git show :path`), not the worktree file.

* * *

## 10. Prioritized must-fix list

| # | Finding | Fix size |
| --- | --- | --- |
| F16 | Criss-cross merges drop the other side’s clean rows via the driver (reproduced) | `recursive = blobsy-inner`; `--inner` omits conflicting paths; never leave `%A` as ours |
| F1+F2 | Recoverability (a)/(b) trust records GC, lifecycle, backend switch or `cache prune` invalidate | Move displaced bytes into the content cache first; prune never deletes unsynced objects; online destroy checks `exists` |
| F8 | Upload from a mutable file poisons a create-only key forever | Push only from a verified cache copy (hash while copying) |
| F13 | Local/command backends can leave permanent truncated objects | temp + `link()`; size check |
| F29 | Snapshot publish race leaves ref/manifest/archive inconsistent under a write-once name | `snap/<name>/<tree_id>/…` for data and manifest |
| F30 | `snap restore` swap has no “is this a cache?” guard | Refuse paths with git-tracked files or refs, or not ignored |
| F31 | No extraction hardening for untrusted archives | Reject `..`, absolute, symlink-traversal; links after files |
| F37 | GC reachability is clone-local and prefix-unaware | fetch first, include stash/reflog/jj refs, require versioning, document single-repo prefix |

Should-fix items most likely to bite early: F5 (`--prune` after partial pull), F9
(algorithm switch bricks gc/push), F17 (merge-created nesting), F24/F25 (pre-push needs
every blob in range and the bytes of intermediate versions), F26 (pre-commit blocks
merge commits), F19 (escaping/sorting vectors).

## Appendix: experiment index (`scratchpad/v3safety/`)

- `fakedriver.sh`, `perpath.mjs`: blobsy-style per-path driver with logging;
  `innerdriver.sh`, `perpath_inner.mjs`: inner variant omitting conflicts.
- `cc_none/`, `cc_text/`, `cc_binary/`, `cc_inner/`: criss-cross runs; `driver.log` in
  each shows O/A/B per invocation (`%L=9` marks the inner merge).
- `nest/`: clean merge producing nested refs and a tracked file inside a directory-ref
  target.
- `ren/`, `dren/`: rename and directory-rename detection moving refs away from payloads.
- `ts.mjs`: timestamp granularity (≈120 µs; 0/2000 same-tick collisions).
- `rl/`, `rl_shallow/`: `rev-list --objects` enumerating both `.bref` blobs in a
  two-commit push range vs the endpoint diff seeing one; shallow-clone behavior.
