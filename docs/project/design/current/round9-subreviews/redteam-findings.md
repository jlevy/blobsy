# Red-team findings: round-9 review (`blobsy-design-review-round9-use-cases.md`)

Reviewer stance: skeptical principal engineer.
Checked against source at `04a3d1a`, the five sub-reviews, the six research docs, round
7/8, and by running the built CLI in `scratchpad/redteam/`. Severity: **must-fix**
(wrong, contradictory, or misleading on a load-bearing point), **should-fix** (gap or
overstatement the owner will trip on), **consider** (polish or judgment call).

What held up under spot-check (so the owner can trust it): B-1 reproduces in all three
variants (stash / `checkout -- bref` / pushed-uncommitted) once `.blobsy/` is
gitignored; H-1 (`git add -A` commits `.blobsy/stat-cache/*.json`); L-1
(`local:../g1rem` rejected for repo `g1`); H-6 (20k per-file ignore lines: 1.3–1.6 s vs
0.013 s for one wildcard here — ≈100×, same order as the review’s 0.82 s vs 0.009 s);
startup 0.55–0.62 s vs 0.03 s bare node; 13 `resolveConfig` call sites all pass
`(repoRoot, repoRoot)`; 8 hidden + 14 visible = 22 commands; ◐ ◑ ⊗ never emitted
(`getFileState` returns only missing/modified/synced/new); `getCachedHash` has no
callers; `decideSyncAction` has 9 outcomes; bead `aad8`’s spec path does not exist; the
design doc says `.blobsy/` “is committed to git” (l.2679) while `doctor` errors unless
it is gitignored (`commands-stage2.ts:993+`); jj creator moved to ERSC 2026-07-06; Gat
facts (152k LOC, 2,467 tests, ~629 stars, no pre-commit/pre-push guard, `core.hooksPath`
ignored) match the research doc.

* * *

## Must-fix

### 1. “Twelve owner decisions” vs thirteen in §11

- **Location:** Verdict, last paragraph ("Twelve owner decisions gate this (§11)").
- **Problem:** §11 lists D1–D13. First thing the owner reads; it reads as sloppy.
- **Edit:** “Thirteen owner decisions gate this (§11); four of them (D1, D2, D3, D5)
  gate Phase 1, the rest can wait.”
  (see #19 for the gating split).

### 2. The headline complexity claim is not supported by the review’s own numbers

- **Location:** Verdict ¶ and item 3 ("about half of the code is accidental complexity
  created by two early choices"; “covers all five use cases with less total complexity
  than blobsy has today”); §7.1–§7.3.
- **Problem:** The owner’s question is “too complex?”. The review answers with two
  claims the evidence doesn’t carry.
  (a) The S1–S10 table sums to roughly S1 150 + S3 300 + S5 325 + S8 300 + S10 176 + S4
  (write-back paths, a few hundred) ≈ 1.3–1.9k of 8,862 LOC — 15–20 %, not half.
  The complexity sub-review’s “roughly half” counts *concepts and patches* across three
  choices (it names a third: per-file adjacency), not deletable lines.
  (b) Phases 2–4 add a manifest parser/validator/driver/`--resolve`, tar.zst
  pack/unpack, `snap publish/restore/ls/gc/status/pin/fallback`, a local cache,
  `Backend.list/putIfAbsent/batch` on five backends, a capabilities probe, mirrors with
  receipts, `import-lfs`, `migrate`, GC. The UC-3/5 sub-review alone sizes snapshots at
  1.5–2× mirror mode. Net LOC goes *up*, probably by more than Phase 1 removes.
- **Edit (Verdict item 3):** “Two early choices (push-time timestamped keys; a
  bidirectional `sync` with a stat-cache merge base) account for most of the shipped
  *concepts* an agent must learn and for all three safety bugs; removing them deletes
  roughly a fifth of the source outright and lets the rest of the mode-specific code
  collapse into one entry loop.”
  **Edit (Verdict ¶):** replace “with less total complexity than blobsy has today” with
  “with fewer concepts per use case than today — but more code in total; §10 names the
  smallest cut of each phase.”
  Then actually add that smallest-cut column (see #17).

### 3. Two incompatible “canonical entry” formats inside one document

- **Location:** §5.3 (manifest `#columns path size sha256 mode stored`; “Tree id =
  sha256 over the first four columns”) vs §5.4 ("canonical entry `path ⇥ kind ⇥ size ⇥
  sha256` (kind `f|x|l:<target>|d`) … `tree_id = sha256` of the lines … shared with UC-2
  manifests and round-8 receipts, so ‘receipt matches manifest’ is a string compare") vs
  §6.1 ("one entry format (`path, kind, size, sha256`)").
- **Evidence:** The research doc (§6c) and the UC-2 sub-review define
  `path\tsize\tsha256\tmode`; the UC-3/5 sub-review proposes an *amendment* to
  `path\tkind\tsize\tsha256` (§3.1, “where I differ”). The main review adopted both
  without saying so. Column order and the `mode` (`-|x`) vs `kind` (`f|x|l:|d`)
  vocabulary differ, so the two tree ids of the same tree differ, and the “string
  compare” claim is false as written.
  Phase 1 says “pin the entry format … as a normative appendix” — the review itself
  presents two.
- **Edit:** Pick one in §6.1 and propagate.
  Recommended: `path ⇥ kind ⇥ size ⇥ sha256` with `kind ∈ {f, x, l:<target>, d}`;
  `.brefs` adds `stored` as a fifth column excluded from the id; `.bref` 0.2 gains
  `kind: x` only when the exec bit is set.
  Rewrite the §5.3 example and the §5.3 “Tree id” sentence accordingly, and add one
  line: “This supersedes the research doc’s and UC-2 sub-review’s
  `path size sha256 mode` order.”

### 4. The “known-synced rule” licenses overwrites that lose unpushed bytes — in plain git, not just jj

- **Location:** §4.2 UC-1 ("overwrite iff the local hash is one this path has had in git
  history or was last synced here"); §5.2; D3.
- **Problem:** “In git history” is treated as evidence that the bytes are recoverable.
  It isn’t: a hash reaches history at `git commit`, the blob reaches the remote only at
  `git push` *if* the pre-push hook ran.
  Scenario, hooks installed, nothing exotic: edit → v2, `blobsy add`, `git commit` (not
  yet pushed), `git revert HEAD` (or `git checkout
  <older>`, or a teammate’s branch) → pointer is v1, working file is v2, v2 ∈ history →
  rule says overwrite → v2 bytes gone, blob never uploaded.
  Under jj, `--no-verify`, a failed hook, or the B-2 gap the same thing happens *after*
  a push. These are exactly the X-1 workflows the review says must be safe.
  The sub-review’s justification ("a hash in HEAD’s history is by construction something
  a blob exists for (or should)") is the “(or should)”. The rule also leaves `--all` vs
  HEAD-ancestry unspecified, which changes the answer for branch switches.
- **Edit (§5.2):** “Replace the merge base with a *recoverability* rule: `pull`
  overwrites a local file only if its bytes are known to be recoverable — (a) the hash
  cache records that this hash was pushed or pulled on this machine, or (b) with derived
  keys, `exists(key(localHash))` on the backend (one HEAD; `status --remote` and the
  pre-push check already do this).
  Git history is used only to word the refusal ('your local content matches commit X,
  which was never pushed'), never as a license.
  Offline with no cache evidence → refuse and print the two explicit choices.
  This fixes B-1 (all variants) and H-3 (teammate update / revert / cherry-pick: the old
  hash was pulled here or exists remotely) without a merge base.”
  Update §4.2 UC-1/UC-2 and D3 to the same wording.

### 5. Phase 0’s “one-line” B-1 fix leaves one reproduced variant open

- **Location:** §3 last sentence ("B-1 needs only a one-line policy change to stop the
  bleeding (write the cache only after a successful push or pull)"); §10 Phase 0.
- **Evidence:** Reproduced variant C (`edit; track; push` uncommitted; `git checkout --
  f.bref; sync`): the cache is written *after a successful push*, so the proposed rule
  still yields base = v2, local = v2, ref = v1 → pull → working file reverted; v2 exists
  only at `20261022T160319Z-fea1…/f.bin.zst`, a timestamped key nothing records.
  The sub-review calls this “data loss in practice” and the review’s own B-1 row cites
  it ("and after an uncommitted push [S]").
- **Edit:** “Phase 0 closes the stash and discard variants.
  The pushed-but-uncommitted variant stays open until keys are derivable (D2): as an
  interim, `sync` prints the recorded key from the cache entry before overwriting, and
  `pull --force`’s message names it, so the bytes are recoverable by hand.”
  And drop “one-line”.

### 6. §4.3 says every Gat scenario was run; the source doc marks five cells as inferred

- **Location:** §4.3 ("every scenario below was run with the real binary"); the “Gat (no
  driver…)” column.
- **Evidence:** `research-2026-10-22-competitor-gat.md` §7: “In the ‘without driver’
  column, rows a and b, h, h2 and i are [V:run]. The other ‘without driver’ cells are
  [I].” That covers the review’s rows “Both edit the same file”, “Delete vs modify”,
  “Rename vs edit”, “Identical change”, “Rebase / cherry-pick (Likely conflicts)”.
- **Edit:** “every *driver-installed* scenario below was run with the real binary; in
  the no-driver column only the same-gap/adjacent, fresh-clone and prefix-collision rows
  were run, the rest are standard git text-merge behaviour [I].” Mark those cells [I].

### 7. Invariant 2 vs “custom `key_template` stays available with its two-phase cost”

- **Location:** §5.1 last bullet; §6.2 invariant 2 ("no push-time state is ever written
  into a committed file"); §7.3 S4 ("Removes … write-back, 4 duplicated paths, 3
  audits"); §9.3.
- **Problem:** If non-derivable templates (`{iso_date_secs}`) remain legal, the four
  upload-then-write-back paths, `track` clearing keys, the “commit your keys” messaging
  and the `remote_key`-present audits all have to stay — S4’s deletions and invariant 2
  are both false. The review wants the simplification and the escape hatch.
- **Edit (§5.1 + D2):** “`.bref` 0.2 templates may use only entry-derived variables
  (`{content_sha256}`, `{content_sha256_short}`, `{filename}`, `{compress_suffix}`,
  optionally `{repo_path}`); `{iso_date_secs}` is rejected.
  Every template is therefore derivable and push never writes back.
  Browsability by date is dropped, not demoted to an option.”
  Then S4 can honestly list the write-back machinery as removed.

### 8. Phase 0 is not decision-free for B-2 and B-3, and B-3’s fix is hook-dependent

- **Location:** §10 Phase 0 ("no design decisions needed"; “B-2 (pre-push hook reads
  pushed refs; interim: scan the commits in `<remote>..<local>` for pointers)”; “B-3
  (pre-commit large-file guard)”); §5.1 ("a pre-push hook that reads the pushed refs
  from stdin (B-2), which only works once keys are derivable"); §4 X-1.
- **Problem:** (a) §5.1 and the sub-review (§3.3) say the real B-2 fix *depends on* D2;
  Phase 0 says no decisions are needed.
  The interim isn’t specified: for a pointer in a pushed commit on another branch the
  payload is not in the working tree, so the hook can only *refuse*. (b) B-3’s fix is a
  pre-commit hook; X-1 says correctness may not depend on hooks (jj, `--no-verify`,
  clones without `setup`). As written, the Blocker’s fix is something the review
  elsewhere says cannot be relied on, and §5.1 then proposes making ignore lines
  *non*-load-bearing on the strength of that hook.
- **Edit (Phase 0):** “B-2 interim: the hook reads the ref lines from stdin, lists
  `*.bref` in `<remote>..<local>`, uploads from the working tree when the working-tree
  file’s hash equals the committed pointer’s, and otherwise **aborts the push** naming
  the commit and path (today it silently succeeds).
  The upload-from-any-commit form needs D2. B-3: a pre-commit guard plus a CI/`doctor`
  check; committed per-file ignore lines remain the only hook-independent protection and
  stay load-bearing until a CI check exists.”
  Remove “(no design decisions needed)” or qualify it.

* * *

## Should-fix

### 9. “Stat cache written in 9 places” is 12 call sites in 7 writers

- **Location:** §2.3 ("written in 9 places and read on one line"); §7.2.
- **Evidence:** `createCacheEntry`/`writeCacheEntry` pairs at `cli.ts:949, 977, 1077,
  1092, 1719` and `commands-stage2.ts:340, 493, 723, 752, 792, 837, 2118` — track (4
  sites), mv, push, pull, sync (4), and the pre-push hook, which the sub-review’s count
  omits. Read at one line (`stage2:583`) is correct.
- **Edit:** “written at 12 call sites by every mutating command and the pre-push hook,
  and read on one line”.

### 10. “Loosen `engines` to Node ≥ 22.15” is already true

- **Location:** §7.4 “Do these now” bullets; D13.
- **Evidence:** `packages/blobsy/package.json` `"engines": {"node": ">=22.15.0"}`;
  README l.14 “Requires Node.js >= 22.15”. Only `CLAUDE.md`/`.nvmrc` (dev toolchain) say
  24\. The language sub-review misread the README.
- **Edit:** delete the bullet, or “`engines` already is ≥ 22.15; keep it there and say
  so in CLAUDE.md, which still implies 24 for users.”

### 11. Wrong evidence marker and source for the 50k gitignore number

- **Location:** §3 H-6 ("50k entries 10.9 s [S]; s3lfs reports 70 s at 100k").
- **Evidence:** Both numbers come from `research-2026-10-22-competitors-other.md` (l.42,
  500, 503), not from a sub-review.
  Fine numbers; wrong citation class.
- **Edit:** “[research, competitors-other §3]”. Also state that the ratio (~100×) is the
  claim, since absolute times vary 2× across machines (I measured 1.3–1.6 s at 20k).

### 12. D2 (pure CAS default) silently contradicts design principles 5 and 6

- **Location:** D2; §5.1 ("Key derived: `sha256/<hex>{suffix}` (pure CAS default)");
  §9.3 ("`{content_sha256_short}/{filename}`-style templates stay available").
- **Problem:** The design doc’s principles 5–6 promise “Files are stored with their
  original names … Even with content-addressable layout, each blob retains its original
  filename.” Pure CAS breaks that promise; `{content_sha256}/{filename}` keeps it and is
  equally derivable (cost: a rename re-uploads).
  The review hedges in §9.3 but D2 asks the owner to choose only between
  “date-browsable” and “pure CAS”, and D1 rewrites principle 9 but not 5/6.
- **Edit (D2):** “Default key template: (a) `sha256/{content_sha256}{suffix}` (max
  dedup, opaque remote; principles 5–6 must be reworded) or (b)
  `{content_sha256}/{filename}{suffix}` (keeps names in the console, renames re-upload,
  still derivable). Recommendation: (b) as default, (a) documented; both close `pqyt`.”
  Add principles 5–6 to D1’s reword list.

### 13. `merge-manifest --resolve` does not apply to the two driverless hosts it is offered for

- **Location:** §4.2 UC-2 ("Without the driver (web merge, fresh clone, jj) … `blobsy
  merge-manifest --resolve <file>` re-runs the same algorithm from the three index
  stages git leaves behind"); §4.3 row “Resolve tooling”.
- **Problem:** A GitHub web-UI conflict is resolved in the browser and committed on the
  server; no index stages exist locally afterwards — only the validator catches a bad
  hand-merge. jj does not use git index stages; §8 already says the driver must be a
  `$base $left $right $output` tool for jj.
  So `--resolve` covers one case: a local driverless `git merge`.
- **Edit:** “Without the driver: a local driverless merge (fresh clone) is repaired by
  `blobsy merge-manifest --resolve` from the index stages; a web-UI merge is checked by
  the validator in CI/pre-commit (the user re-runs the merge locally if it fails); jj
  invokes the same algorithm as a 4-argument merge tool.”

### 14. Reachability GC as described would delete every legacy object

- **Location:** §5.5 item 3 ("reachable = all hashes in all pointers/manifests across
  refs; orphans = listed − reachable"); §7.3 S4; complexity sub-review §3.1 ("simpler
  than scanning stored `remote_key` strings").
- **Problem:** Every object pushed before 0.2 lives at a timestamped key recorded only
  in a `remote_key` field somewhere in history.
  A hash-set GC classifies all of them as orphans.
  The review tells existing users “zero migration” (§5.1) and then proposes a GC that
  would delete their blobs.
- **Edit:** “reachable = { key(entry) for every entry in every `.bref`/`.brefs` across
  all refs } ∪ { every `remote_key` string in every `.bref` across all refs }. Until
  `migrate-keys` has re-homed a repo, legacy objects are reachable only through the
  second set; GC must refuse to run if any bref in history lacks both a derivable key
  and a `remote_key`.” Add the “existing users” paragraph (#21).

### 15. UC-2 sub-review and S5 are not reconciled in the text

- **Location:** §5.3 (commands list, no `sync`; “Merging as in §4”) vs UC-2 sub-review
  §3.5/§7.1 item 2 ("`sync` on collections, reusing `decideSyncAction` and the stat
  cache unchanged"; the “not pulled vs missing” distinction keyed on stat-cache
  presence); §5.2/S5 deletes `decideSyncAction`’s merge base; D3.
- **Edit (§5.3, after “Merging as in §4”):** “Status, pull and sync on collections use
  the recoverability rule of §5.2; the UC-2 sub-review’s reuse of `decideSyncAction` and
  the merge base is superseded.
  The `not pulled` vs `missing` distinction survives: it keys on whether the hash cache
  has ever recorded the path (written on pull), which S5 keeps.”

### 16. Four disciplines are presented as settled; “defer or fold mirrors” is never offered

- **Location:** §5.4 ("Mirror mode (UC-6) stays as round 8 proposed, narrowed"); §6.1;
  D8 ("Approve narrowed; sequence by trading-repo demand"); Verdict.
- **Problem:** The owner asked whether blobsy is too complex and listed five use cases.
  The review adds UC-6, UC-7, X-1..X-8 and a fourth discipline.
  The UC-3/5 sub-review’s own Q1 asks “three disciplines or two?
  … fold mirrors into snapshots by giving snapshots an unpacked layout?”
  and §4.4 of the complexity sub-review calls mirrors “a different loop”.
  D8 presents only “approve narrowed”.
  The trading repo already has a working tool; the only thing it asked for first was the
  receipt schema (§10 Phase 1).
- **Edit (D8):** “Options: (a) approve mirrors narrowed (round 8); (b) fold into
  snapshots as `snap publish --unpacked` (path-shaped keys, no tar) and drop receipts as
  a separate concept — the receipt *is* the snapshot `ref.yaml`; (c) defer: ship only
  `blobsy receipt write|verify <dir>` (tree_id + receipt, ~100 LOC) and an rclone
  recipe, build mirrors only if the trading repo commits to adopting.
  Recommendation: (c) now, (b) if demand materialises.
  Three disciplines → two (in-git entries; named snapshots).” Update §6.1/§6.2
  accordingly.

### 17. No “minimal viable cut” per phase, though the owner’s concern is complexity

- **Location:** §10.
- **Edit:** add a “Smallest shippable” line to each phase:
  - Phase 0: B-1 cache-after-push/pull; H-1 by moving machine-local state to
    `$(git rev-parse --git-path blobsy)` (see #24) instead of a gitignore line; B-3
    guard; B-2 refuse-or-upload; M-1; L-1; README; SKILL.
  - Phase 1: S1–S3, S4 (with #7’s template restriction), S5 (#4’s rule), hash cache
    wired. **Defer** S6/S7 reporter/plan-execute until the first second container lands
    (do it as part of Phase 2, not before), S8–S10, `Backend.list`, capabilities probe,
    batched transfer (needed at UC-2 scale, not for UC-1).
  - Phase 2: manifest format + parser/validator; `add --collection`, `add`, `status`,
    `push`, `pull`, `verify` over the entry loop; one ignore line; validator in
    pre-commit/doctor; batched transfer.
    **Defer** the merge driver and `--resolve` (plain text merge is safe by the review’s
    own analysis; ship the driver when a real collection hits the clustered-adds
    conflict), `blobsy diff`, `--include` globs, promotion/demotion, CI action.
  - Phase 3: `snap publish|restore|ls` with one `tar.zst` + create-only `ref.yaml` on
    local and S3 only; exists-then-put elsewhere.
    **Defer** `fallback`, `gc`, `status`, pins, the local archive cache, provenance
    fields, the capabilities probe, mtime policy (validate on `target/` first, as §10
    already says).
  - Phase 4: per #16, receipts only.
  - Phase 5: `import-lfs` first; GC only with bucket versioning as the safety net;
    `migrate import` last.

### 18. The owner asked for per-UC workflows; the main doc gives only merge workflows

- **Location:** §4.2 (merge only); §5.x (design, not flow).
  The only end-to-end UC-1 lifecycle is in the sub-review (§1), and there is none for
  UC-2/3/5 anywhere.
- **Problem:** The owner’s suspicion is that UC-1/2/3 “haven’t been thought through as
  separate flows”. The review asserts they are distinct (§1.2) but never shows the flows
  side by side.
- **Edit:** insert a §4.0 table, one column per UC-1/UC-2/UC-3/UC-5, rows: declare
  (`add f` / `add --collection d` / `snapshots:` stanza / `snap publish --version`),
  what git holds, commit, publish (`push` on pre-push / `push` / `snap publish` from CI
  / `snap publish`), clone or CI (`pull` / `pull [--include]` /
  `snap restore [--fallback]` / `snap restore` verifying the pin), change (`add` /
  `add d` / rebuild + publish / `--version v3`), merge (one pointer / per-line /
  lockfile / one pin line), delete and GC (reachability / reachability / lifecycle TTL /
  never). Twenty lines; it is the answer to the owner’s actual question.

### 19. Mark which decisions gate Phase 1 and which can wait

- **Location:** §11.
- **Problem:** Thirteen decisions with equal weight; several (D5–D8, D10, D12) cannot be
  decided well before Phase 1 ships and do not block it.
- **Edit:** add a “Blocks” column: D1, D2, D3, D11 → Phase 1; D4, D10 → Phase 2; D5–D8 →
  Phase 3/4; D9, D12, D13 → none.
  Put the four Phase-1 decisions first.

### 20. “Compression decided at track time and kept only if smaller” needs trial compression at `add`

- **Location:** §5.1 bullet; D10; Phase 0 M-1 (push-time).
- **Problem:** “Only if smaller” is unknowable at track time without compressing (or
  sampling) then; rule-based (name/size) decisions are what the sub-review proposes.
  M-1 in Phase 0 is a push-time check; under S4 the decision moves to `add`, where it
  costs CPU for every externalised file and must be deterministic across machines (the
  key depends on it).
- **Edit:** “At `add`, decide by rule; for candidates, compress once and keep the result
  only if ≥ 5 % smaller (the file is being hashed anyway).
  Record the decision in the pointer; push must not revisit it.”
  State that the Phase 0 M-1 fix is push-time and is replaced in Phase 1.

### 21. The “existing users” story is scattered; collect it

- **Location:** §5.1 (0.1 brefs keep working), §3 H-1 (stat caches already committed),
  §5.5 (GC), §7.4 (goldens).
- **Edit:** one paragraph “What changes for repos that use blobsy today”: 0.1 brefs read
  forever via `remote_key`; `doctor --fix` runs `git rm --cached .blobsy/` where stat
  caches were committed; existing timestamped objects stay reachable (#14) and are
  re-homed only by an explicit `migrate-keys`; the default template changes in one
  release for every clone (the sub-review’s “must land together with derive-when-absent”
  rule); hidden commands print “renamed” for one release.

### 22. `.git/info/exclude` should be rejected, not “considered”

- **Location:** §5.1 “Ignore entries” item (3).
- **Evidence:** §4.3/§9.1 list Gat’s “worktrees clobbering each other’s exclude blocks”
  as a bug of exactly this mechanism; §8 says jj honours `.gitignore` but nothing says
  it reads `info/exclude` for colocated worktrees; X-1 forbids depending on `setup`
  having run.
- **Edit:** “(3) Gat’s `.git/info/exclude` approach was evaluated and rejected: it is
  per-clone, breaks in linked worktrees, and makes unprotected clones the default.”

### 23. Existence checks at UC-2 scale are unaddressed

- **Location:** §5.1 ("`status --remote` and the pre-push check HEAD the keys"); X-4.
- **Problem:** One HEAD per entry is one request (SDK) or one process (aws-cli, rclone,
  command) per file; at 10k entries that is the same per-file cost the review condemns
  for transfer. The UC-2 sub-review proposes a local pushed-marker cache; `list(prefix)`
  over a flat `sha256/` prefix is the batched alternative.
  Command backends without `list_command` cannot do either.
- **Edit (X-4):** “…no per-file process spawn — for transfer *and* for existence checks
  (batched `list` over the CAS prefix, or the hash cache’s pushed marker; command
  backends without `list` degrade to per-file HEAD).”

### 24. H-1’s fix: move machine-local state under `.git/` instead of gitignoring `.blobsy/`

- **Location:** §3 H-1; Phase 0; §2.3.
- **Problem:** After S2 deletes trash, `.blobsy/` holds only the stat cache.
  A machine-local directory that must be gitignored is a standing foot-gun (H-1, the
  design-doc contradiction, the `doctor` check, jj’s auto-snapshot of it).
  Gat and LFS keep such state under the git dir.
- **Edit:** “H-1: store the hash cache at `$(git rev-parse --git-path blobsy)/cache/`
  (worktree-local by construction, never committable, no gitignore line, no doctor
  check); delete `.blobsy/` entirely with S2.” Offer as the Phase 0 option; it is
  smaller than the gitignore route.

### 25. Verdict calls Gat’s UC-4 story “strong”; §4.3/§9.1 show it loses data

- **Location:** Verdict item 4 ("a strong UC-1/UC-2/UC-4 story") vs §4.3 ("the other
  side’s clean changes are omitted; a naive `git add` silently dropped an independent
  addition") and §9.1 ("a data-losing conflict UX; invalid locks from hosted or sharded
  merges").
- **Edit:** “a complete UC-1/UC-2/UC-4 story whose merge UX is unsafe at the edges”.

### 26. Coverage gaps the owner will ask about

- **Location:** §1.3, §5, §10 (main review only; some appear in sub-reviews).
- **Problem:** zero mentions in the main doc of: **Windows** (snapshot symlinks need
  Developer Mode; hook shims; case-insensitive path collisions in manifests — the
  sub-review’s Q8); **credentials/CI** (read-only creds for PRs and laptops, write creds
  only for protected-branch CI — this is the X-7 mitigation and the sub-review’s §5 has
  it; the main review names X-7 and never says what to do); **large single files /
  multipart** (`IfNoneMatch` on `CompleteMultipartUpload`; GCS XML multipart rejects
  preconditions; >5 GB file-mode objects); **backend migration** (with derived keys,
  moving from S3 to GCS is `rclone copy` + a config change with no pointer rewrite — a
  genuine PAIN-5 win worth one sentence); **one backend per repo** (S1 removes subdir
  config; say monorepos with two buckets are out of scope); **partial clone / sparse
  checkout** (pointers and manifests are tiny, so they compose; snapshots don’t care).
- **Edit:** a ten-line “§5.6 Cross-cutting: CI and credentials, Windows, large objects,
  moving backends, scope limits” section, or rows in §1.3.

* * *

## Consider

### 27. Phase 2 before Phase 3 is asserted, not decided

- §9.3 says UC-3/5 is “where blobsy is not crowded” and §9.3 says UC-2 “should ship
  bundled with blobsy’s differentiators, not as the headline”; §10 then builds UC-2
  first. The stated reason (shared entry format) does not force an order; the trading
  repo wants `tree_id`/receipts first.
  Add D14: “Phase 2 or Phase 3 first?”
  with the honest trade-off (UC-2 is cheaper on the entry loop; UC-3/5 is the
  differentiator).

### 28. D3 should say what `sync` is allowed to contain

- With the recoverability rule, `pull` and `sync` share one decision; `sync` is `pull`
  then `push`. State that `sync` owns **no** decision logic and exits 2 only on a
  refusal `pull` would also make; otherwise the 9-state table will grow back.
  If that is the rule, keeping it as the agent’s one verb is fine.

### 29. “.bref: a 3–4 line text file” describes the proposed 0.2 pointer, not today’s

- §4.1 first row. Today’s bref is 8 lines (2 comment lines + 6 fields; see any scratch
  repo). Say “a 6-field YAML file today, 3 fields after §5.1”.

### 30. §2.2 reproducibility

- The 1,000-file benchmark is lead-[V] but Appendix A lists no script path, unlike the
  sub-reviews. Add the path.
  Also “`track data/coll`” vs the sub-review’s “`blobsy add`” — name the command
  actually run.

### 31. B-1 repro note for the owner’s own attempt

- With `.blobsy/` committed (what `setup` + `git add -A` produce today — H-1), `git
  stash` also restores the stat cache and variant A does *not* trigger; the repro needs
  `.blobsy/` gitignored first.
  One sentence in §3 saves the owner a confusing non-reproduction (I hit it).

### 32. X-4 wording

- “one synchronous process per file” is the CLI-backend half; the SDK and local backends
  are also one-at-a-time because the push/pull loops are `for … await` (`transfer.ts:57`
  documents transfers as sequential).
  Say “transfers are sequential by construction (a `for…await` loop; CLI backends
  additionally spawn synchronously)”.

### 33. §7.4 SHA-256 comparison is slightly tilted

- “Node 4.3–4.9 s vs Rust `sha2` 6.7 s” is the default `sha2` crate without `asm` on a
  CPU without SHA-NI (the sub-review says so).
  Fair sentence: “parity; neither language is the bottleneck”.

### 34. Readability

- Verdict: good that it is first; add a 3-line box answering the owner’s three questions
  verbatim ("Are UC-1/2/3 distinct flows?
  Yes — pointer, manifest, snapshot; §4.0. How do merges work per UC vs Gat?
  §4.3 table. TS or Rust?
  Stay TS; §7.4 rule.").
- Glossary (10 lines) for: entry, discipline/container, known-synced/recoverability
  rule, create-only PUT/412, `tree_id`, receipt, entry asset, mirror/attach point, X-n.
  “Discipline” alone is used five ways.
- §8 (jj) and §9.2 (other tools) are evidence, not decisions; move to appendices and
  keep two sentences each in the body.
  §4.3’s 13×5 table is dense but is the owner’s core ask — keep it, but bold the three
  cells that matter (same-dir adds, both-edit, prefix collision).
- The review adds ~4,400 lines of docs while §7.5 asks for an ≤800-line spec; say in
  §7.5 that rounds 7–9 and the sub-reviews move to `reviews/` as the first act.
