# Blobsy v3 Design Review — Flexibility and Best-of-Breed Lens

**Date:** 2026-10-23. **Reviewed:** `docs/project/design/current/blobsy-design.md` (v3,
2026-10-22), the v3 implementation plan, round 8 and round 9, all research in
`docs/project/research/current/` (Feb and Oct 2026), and primary sources in `attic/`
(Gat docs `commands/route.mdx`, `commands/mount.mdx`, `references/configuration.mdx`;
s3lfs `README.md` and `specs/README.md`).

**Question asked:** is v3 as flexible as the best tool in each design dimension, and did
it pick the best element from every tool, while staying simple?

**Short answer.** v3 is best-of-breed in the dimensions that define the product (ref
model, merges, hook-independent safety, input-keyed snapshots, immutability, agent UX,
backend breadth) and it correctly rejects the expensive features (CDC, locking, filters,
servers). It is **under-specified or behind the best tool in six dimensions that cost
little to fix**: sparse/partial working sets (Gat selections, s3lfs sparse-checkout),
anonymous read (Nix/HF-style public caches), credentials/URL templating (Gat `${VAR}`),
materialization strategies (Gat/DVC hardlink), distribution (Gat single binary), and
Windows (Gat 3-OS CI). It also has **three correctness gaps** that are design-text
fixes: store identity in the synced records, one-store-per-repo for GC, and the content
cache being a Phase 4 item while the Phase 1 pre-push hook depends on it.
“Multiple backends per repo” should stay a non-goal for 3.0, with two cheap preparations
and one narrow exception (read-only cross-store pins) worth considering.

* * *

## 1. Dimension × tool matrix

Legend: ● strong / best-in-class · ◐ partial · ○ absent or weak · – not applicable.
Columns: LFS = Git LFS; anx = git-annex; DVC; Gat; s3l = s3lfs; Xet = HF Xet/git-xet;
Oxn = Oxen; Lor = Lore; lkF = lakeFS `lakectl local`; HFB = HF Storage Buckets; aC =
actions/cache; Bzl = Bazel remote cache/REAPI; Nix = Nix store + binary cache; rst =
restic/kopia; OCI = OCI/ORAS; rcl = rclone; jj; pro = native git promisors/partial
clone; **v3** = blobsy v3 as written.

| # | Dimension | LFS | anx | DVC | Gat | s3l | Xet | Oxn | Lor | lkF | HFB | aC | Bzl | Nix | rst | OCI | rcl | jj | pro | **v3** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Pointer/manifest model (file + collection + pin) | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ● | – | – | – | – | – | ◐ | – | – | ○ | **●** |
| 2 | Partial / sparse working sets | ◐ | ● | ◐ | ● | ● | ◐ | ◐ | ● | ◐ | ◐ | – | – | – | ● | ◐ | ● | ◐ | ● | **◐** |
| 3 | Multiple remotes / routes | ○ | ● | ● | ● | ○ | ○ | ○ | ◐ | ◐ | ○ | – | ◐ | ● | ◐ | ● | ● | – | ◐ | **○** |
| 4 | Backend pluggability | ◐ | ● | ● | ◐ | ○ | ○ | ◐ | ◐ | ◐ | ○ | ○ | ◐ | ● | ● | ● | ● | – | ◐ | **●** |
| 5 | Auth / credentials | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ● | ◐ | ◐ | ◐ | ● | ● | – | ◐ | **◐** |
| 6 | Local cache & materialization | ◐ | ● | ● | ● | ◐ | ● | ◐ | ● | ○ | ◐ | – | ● | ● | ◐ | ◐ | ○ | – | ◐ | **◐** |
| 7 | Hydration / lazy fetch | ◐ | ◐ | ◐ | ● | ◐ | ● | ◐ | ● | ◐ | ◐ | – | ● | ◐ | ◐ | ◐ | ◐ | – | ● | **◐** |
| 8 | Dedup granularity | ◐ | ◐ | ◐ | ◐ | ◐ | ● | ◐ | ● | ○ | ● | ○ | ● | ◐ | ● | ◐ | ○ | – | ◐ | **◐** |
| 9 | Compression | ◐ | ◐ | ○ | ○ | ● | ● | ◐ | ● | ○ | ● | ● | ◐ | ● | ● | ● | ◐ | – | ◐ | **●** |
| 10 | Integrity / verification (incl. without download) | ◐ | ● | ◐ | ◐ | ● | ● | ◐ | ● | ◐ | ◐ | ◐ | ● | ● | ● | ● | ◐ | – | ● | **◐** |
| 11 | Immutability & retention | ○ | ◐ | ○ | ● | ○ | ◐ | ◐ | ● | ◐ | ○ | ● | ● | ● | ● | ● | ◐ | – | ● | **●** |
| 12 | GC | ◐ | ◐ | ● | ◐ | ◐ | – | ? | ● | ● | ◐ | ● | ◐ | ◐ | ● | ◐ | – | – | ◐ | **●** |
| 13 | History import / removal | ● | ◐ | ◐ | ◐ | ● | ◐ | ◐ | ● | ◐ | – | – | – | – | ● | – | – | ● | ○ | **◐** |
| 14 | Merges in git (metadata) | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ○ | ○ | ○ | – | – | – | – | – | – | – | ● | ● | **●** |
| 15 | Locking | ● | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ | – | – | – | – | ◐ | – | – | – | ○ | **○** |
| 16 | Cross-repo sharing | ○ | ● | ● | ● | ○ | ◐ | ◐ | ◐ | ● | ◐ | ◐ | ◐ | ● | ◐ | ● | – | – | ○ | **◐** |
| 17 | Caches keyed by inputs | ○ | ○ | ◐ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ● | ● | ○ | ◐ | ○ | – | ○ | **●** |
| 18 | Snapshot / restore with tree fidelity | ○ | ◐ | ◐ | ○ | ○ | ○ | ◐ | ◐ | ◐ | ◐ | ◐ | ● | ● | ● | ◐ | ◐ | – | ○ | **●** |
| 19 | Agent / automation surface | ◐ | ◐ | ◐ | ○ | ◐ | ◐ | ◐ | ● | ◐ | ● | ◐ | ◐ | ◐ | ● | ◐ | ● | ◐ | ◐ | **●** |
| 20 | Install / distribution | ● | ◐ | ◐ | ● | ◐ | ● | ● | ● | ◐ | ● | ● | ● | ● | ● | ● | ● | ● | ● | **◐** |
| 21 | Offline operation | ◐ | ● | ● | ● | ◐ | ◐ | ● | ◐ | ○ | ○ | ○ | ● | ● | ◐ | ○ | – | ● | ◐ | **◐** |
| 22 | Windows | ● | ◐ | ● | ● | ◐ | ● | ◐ | ● | ◐ | ● | ● | ◐ | ○ | ● | ● | ● | ● | ● | **○** |
| 23 | Monorepos | ◐ | ◐ | ◐ | ● | ◐ | ○ | ● | ● | ● | – | ◐ | ● | ● | – | ◐ | – | ◐ | ◐ | **◐** |
| 24 | Hook-independent / hosted-merge safety | ○ | ◐ | ◐ | ○ | ◐ | – | – | – | – | – | – | – | – | – | – | – | ○ | ● | **●** |
| 25 | Browsable remote | ○ | ◐ | ◐ | ○ | ● | ○ | ○ | ○ | ◐ | ◐ | ○ | ○ | ◐ | ○ | ○ | ● | – | ○ | **◐** |

**Reading the matrix.** v3 scores ● on 11 of 25 dimensions, more than any single tool,
and each of its ● cells is earned by a specific adopted element (table in §2). Its ○
cells are deliberate non-goals (3, 15) or omissions (22). Its ◐ cells are where this
review focuses: 2, 5, 6, 7, 10, 16, 20, 21, 23, 25. Four of them (2, 5, 6, 20) are cheap
to turn into ● by copying an element that already exists in Gat, s3lfs, DVC or Nix.

* * *

## 2. Per-dimension assessment: who does it best, what v3 does, verdict

Complexity cost: **S** = hours to a day; **M** = days; **L** = a week or more.

| # | Dimension | Best-in-class element | What v3 does | Verdict | Cost |
| --- | --- | --- | --- | --- | --- |
| 1 | Pointer/manifest | **v3 itself**: one TSV format with three shapes (file / directory / pin), path-first rows with size and kind, static header, no aggregates. Combines LFS per-file, Gat/s3lfs manifest, lakeFS `.lakefs_ref.yaml` pin. Gat’s lock is a single repo-wide hotspot; s3lfs lacks sizes; DVC puts the manifest outside git. | As described. | **Keep.** Add one sentence: “sharding a huge collection = choosing finer directory refs (`data/images/cats.bref`, `data/images/dogs.bref`)”, since refs don’t nest. `add` should hint above ~20k rows. | S |
| 2 | Partial/sparse working sets | **s3lfs**: applies the user’s `git sparse-checkout` rules via `git sparse-checkout check-rules` (one source of truth for source + assets). **Gat**: saved `selections` with a default that hooks honor. git-annex preferred content; restic `--include`. | `pull --include <glob>` only. No persistence; `--hydrate` hooks pull everything; `status` shows `↓` for every un-pulled entry. | **Adopt both, minimally** (§3 S1): honor sparse-checkout cone when active; one local-scope `working_set:` glob list (not named selections). | S–M |
| 3 | Multiple remotes / routes | **git-annex** (N remotes, location log, `numcopies`); **Gat** named remotes + path-prefix routes + `--remote` override; Nix substituter list; rclone `union`. | One `backend:` URL; local scope may override it; routes deferred; multiple backends a non-goal. | **Confirm non-goal for 3.0** with two preparations (§3 M1, C1). Keys already prefix-free, so mirroring is `rclone copy` + URL change (good). | S |
| 4 | Backend pluggability | **blobsy** (S3 SDK + rclone + local + command) and **git-annex** external special-remote protocol. Gat’s OpenDAL is a closed set with no SSO. | S3 SDK, rclone, local, command; OpenDAL npm later for GCS/Azure preconditions. | **Keep.** Add a read-only `https://` backend (§3 S2) — the one backend shape every public-cache system (Nix, HF, OCI) has and blobsy lacks. | S |
| 5 | Auth / credentials | **AWS credential chain** (profiles, SSO, `credential_process`, OIDC) via the SDK; **Gat** `${VAR}` in URLs with strict once-only expansion; **rclone** config; **OCI** credential helpers. | `?profile=` on S3 URLs; local scope for machine-specific URL; IAM-based write segregation documented. | **Adopt** `${VAR}` URL interpolation and s3lfs’s per-permission doctor probe (§3 S3). | S |
| 6 | Local cache & materialization | **Gat**: ordered `materialization_strategy` `[reflink\|hardlink\|symlink\|copy]`, 0444 cache objects, `cache.location`; **DVC** cache types; **Bazel/Nix** shared stores. | Reflink-else-copy, never hardlink; cache under git-common-dir or `cache.dir`; prune by size/age. | **Adopt a strategy list** with `hardlink` opt-in (§3 S4). Reject `symlink`. Keep per-repo default location; document global `cache.dir` for cross-repo dedup. | S |
| 7 | Hydration / lazy fetch | **Gat** cache-only hooks honoring `core.hooksPath`; **HF/git-lfs-fuse/Lore** lazy range reads; promisors lazy fetch. | Explicit `pull`, opt-in restore hooks (`pull --cache-only`), `--include`. | **Keep.** Reject FUSE/VFS. `blobsy cat --range` is a later nicety (§5 C4). | – |
| 8 | Dedup granularity | **Xet/Lore/restic** CDC. Whole-file CAS everywhere else. | Whole-file CAS, cross path/branch/time. | **Confirm reject CDC** (non-goal). State the target scale (MB–few GB files) in §17 so the choice is explicit. | – |
| 9 | Compression | **s3lfs** adaptive (sample, store raw if incompressible); **Nix** records compressed+uncompressed hash/size; LFS 3.8 zstd transfer. | zstd-or-none decided at `add`, keep only if ≥5% smaller, encoding in the key. | **Keep.** Note the trade: a rule change yields two objects for the same hash (harmless); compressed objects can’t use provider checksums (see 10). | – |
| 10 | Integrity / verification | **Bazel** digest = (hash,size), size mismatch rejected; **S3** stored SHA-256 on single-part PUT, `HeadObject ChecksumMode` → verify without download (Quilt does this); **s3lfs** `verify --revision --base`; **restic check**. | Hash on download before replace; `status --remote` presence only; `doctor --ci` existence at HEAD; size-mismatch report on existing object. | **Adopt** server-side SHA-256 when `hash: sha256` and encoding `-` (§3 S9). This is a real input to K3: BLAKE3 forfeits free remote verification. | S |
| 11 | Immutability & retention | **S3** `If-None-Match` + bucket policy + Object Lock; **R2** bucket locks; **Nix** signed narinfo. | Create-only writes, doctor probe (sentinel twice), lifecycle on `snap/cache/`, provenance + reserved signature field. | **Keep.** Doctor could print the enforcing bucket policy and recommend Object Lock on `snap/assets/` (doc-level). | S |
| 12 | GC | **Gat** history-aware with `--repository` peers (no grace); **restic/kopia** prune with locks; **s3lfs** in-flight claim registry; **S3** conditional delete. | Reachability over all branches/tags + working tree, grace period, dry-run, refuse on unparsable ref. | **Keep; add** one-store-per-repo invariant (§3 M2) and conditional deletes (§3 S12). | S |
| 13 | History import / removal | **git lfs migrate**; **filter-repo**; **Lore** typed obliteration tombstones. | `import lfs` forward-only; history import deferred; removal = filter-repo + gc. | **Keep deferral.** Add an emergency purge path (§3 S10): assets are “never deleted by blobsy” and content objects wait for the gc grace period — a leaked secret has no removal story. | S |
| 14 | Merges | **v3**: Gat’s per-path rules + markers + validator + jj merge-tool mode. | As described. | **Keep.** Add `merge.blobsy.recursive` for criss-cross merges (§3 S13). | S |
| 15 | Locking | **Lore** causal locks; **LFS** locks. | Non-goal. | **Confirm reject.** | – |
| 16 | Cross-repo sharing | **Gat mounts** (import another repo’s rows pinned at `rev_lock`, read-only ownership); **DVC import**; **lakeFS** refs; **Nix/OCI** any cache/registry. | Pin refs to asset snapshots, same store only. | Pins already are the cleaner mount (no clone of the other repo needed). **Document it; consider** cross-store read-only pins (§3 S8, C2). | S–M |
| 17 | Input-keyed caches | **actions/cache** key + ordered `restore-keys`; **Nix/Bazel** input hash → result → CAS; **rust-cache** prune-before-save. | Pure template vars, `--fallback` newest under parent prefix, write segregation, lifecycle expiry. | **Keep.** Consider ordered `fallback: [...]` list (§5 C3). Reject AC→CAS indirection (§4 R9). | S |
| 18 | Snapshot/restore | **NAR/REAPI** canonical trees (exec bit + symlink only); **restic/kopia** packs + index, full fidelity; **OCI** manifest-last. | Deterministic tar.zst + manifest + create-only `ref.yaml` last; `f/x/l/d` kinds; mtime as restore metadata; temp-extract, verify, two renames. | **Keep.** Packs with range restore stay deferred. Note `--only` still downloads the whole archive in v1. | – |
| 19 | Agent surface | **v3** (`--json`, `--dry-run`, docs `--skill`, refusals); **HF Buckets** plan/apply; **LFS 3.7** `fetch --json` URLs; **restic --json**. | As described, plus `status --remote --keys`. | **Keep.** Reject plan/apply files (§4 R8). | – |
| 20 | Install / distribution | **Gat/jj/Lore**: single static binary, checksum-verified installer, 8 targets. | npm, Node ≥ 24; `bun build --compile` deferred. | **Promote** the single binary to Phase 1 (§3 S5): hooks and the merge driver run in every clone and CI. | M |
| 21 | Offline | **git-annex/DVC/Gat**: full offline operation from cache. | `pull --cache-only`; recoverability refuses offline without local evidence (correct); `status` is offline. | **Keep.** State explicitly that `status`, `add`, `diff`, `resolve` never touch the network. | S |
| 22 | Windows | **Gat/LFS/DVC**: CI on Windows; symlink fallbacks. | Not mentioned in v3 (round 9 §5.6 content was dropped). | **Add a section** (§3 S6). | M |
| 23 | Monorepos | **Gat** routes + selections; **Bazel/Nix** by construction; lakeFS per-dir refs. | Root config only; `pull <path>`; snapshot stanzas; subdirectory configs removed. | **Mostly fine**: per-directory rules are path-prefixed globs in one root file. Needs 2 (sparse) and, later, routes. Document `git clone --filter=blob:none` + `blobsy pull --include` as the monorepo recipe. | S |
| 24 | Hook-independence | **v3** (validator in pre-commit/doctor/CI, recoverability rule, `doctor --ci`). Gat has none; LFS depends on filters. | As described. | **Keep.** | – |
| 25 | Browsable remote | **s3lfs** `assets/<sha>/<path>`; **rclone**/annex `exporttree` path mirroring. | Hash-shaped keys + `blobsy-path` metadata + `Content-Disposition` + `status --remote --keys`. | **Keep** (dedup and rename-stability win). Browsability by path is UC-6’s job (deferred). | – |

* * *

## 3. Ranked recommended changes to v3

Severity: **must** = correctness or a stated goal fails without it; **should** = high
flexibility per unit of complexity; **consider** = worth it if cheap in practice.

### Must

**M1. Synced records must carry store identity** (§4.6, §10). Recoverability (a) says
“the hash cache records that this exact hash was pushed or pulled on this machine”.
With the local scope allowed to override `backend:` (§11), a hash pushed to store A is
recorded as synced, then the machine is pointed at store B and `pull` overwrites bytes
that B does not hold.
Fix: record `(algo, hash, store_id)` where `store_id` is the canonical backend URL with
query credentials/profile stripped; (a) applies only when the current store matches.
Cost: S.

**M2. One store prefix belongs to one repo, or GC must know its peers** (§5, §14).
Content-addressed keys invite sharing one prefix across repos (identical bytes stored
once), and nothing in v3 forbids it.
`gc` computes reachability from *this* repo’s history and would delete every other
repo’s objects. Add invariant 7: “A backend prefix is owned by exactly one repository.
`gc` on a shared prefix is unsafe.”
Make `setup` write a tiny `blobsy-store.yaml` at the prefix root (`format`, `algo`,
`owner: <origin
url>`), create-only, and have `gc` refuse when `owner` differs unless `--peer <git-url>`
(Gat `--repository`) is supplied for every other owner.
The marker also fast-fails an `algo` mismatch between two repos pointed at one prefix.
Cost: S (marker) + M (peers, can be deferred; the refusal alone is enough for 3.0).

**M3. Move the content cache’s fill-on-push and fill-on-pull into Phase 1** (plan, not
design). The Phase 1 pre-push hook promises to upload “from the cache or the working
tree” for every ref in the pushed range (B-2). Without the cache, pushing a branch that
is not checked out always aborts, which recreates the B-2 bug as a usability wall.
The plan already lists this as an open question; the answer is yes.
`cache prune` and `cache.on_add` can stay in Phase 4. Cost: moves M-sized work earlier,
adds none.

### Should

**S1. Sparse and persistent working sets** (§6 `pull`, §9 hooks, §10 `status`, §11). Two
small elements:

- *s3lfs*: when `git sparse-checkout` is enabled, filter every entry loop through
  `git sparse-checkout check-rules` (git ≥ 2.42); fall back to “everything” with a
  warning. One source of truth for source files and assets; no new pattern language.

- *Gat selections, reduced to one*: a local-scope setting (never project scope, so a
  committed config can’t hide files from a clone):

  ```yaml
  # $(git rev-parse --git-dir)/blobsy/config.yml
  working_set: ["data/images/cats/**", "models/**"]
  ```

  `pull`, `status`, `sync` and the `--hydrate` hooks honor it; `--all` ignores it;
  `status` prints “N entries outside working set” instead of N `↓` rows; `push` is never
  filtered. Also expose `blobsy pull --include` as today and `--exclude`. Cost: S–M.
  Flexibility: this is what makes collections of 50k files and monorepos usable from one
  config; it is the single largest ◐→● move available.

**S2. Read-only `https://` backend** (§12). `get` = GET, `exists` = HEAD (batched),
`list` = unsupported (so `--fallback` and `gc` refuse), `put` = refuse with “read-only
backend”. Combined with M1 and the local scope, a public repo can commit
`backend: https://assets.example.com/project` for anonymous readers and CI, while
maintainers set `s3://…` locally to push.
Nix binary caches, HF, OCI registries and `actions/cache` all have anonymous or ambient
read; blobsy currently requires cloud credentials even to clone-and-pull a public
dataset. Cost: S (~80 lines, no SDK).

**S3. `${VAR}` interpolation in `backend:` and per-permission doctor probes** (§11, §12,
§13). Gat’s grammar: `${NAME}` only, expanded exactly once, no defaults, error naming
the variable when unset; never written back.
Lets a committed config say `s3://${BLOBSY_BUCKET}/project` for per-environment buckets
without a local override file.
Doctor probes `list`, `read`, `write`, `delete` separately (s3lfs) so a read-only PR
credential is diagnosed as “read-only: pull works, push will fail” rather than a generic
health error; this is also how write segregation (CREEP) becomes checkable.
Cost: S.

**S4. Materialization strategy list with hardlink opt-in** (§4.6).
`cache.materialize: [reflink, copy]` default; allowed values
`reflink | hardlink | copy`, ordered fallback (Gat).
`hardlink` is opt-in and requires cache objects to be 0444 (they already are “read-only
original bytes”), so an in-place edit fails loudly rather than corrupting the cache.
Rationale: ext4 (most Linux CI and many laptops) has no reflink, so v3’s default doubles
disk for every pulled collection; DVC users rely on hardlinks for exactly this.
Reject `symlink` (tool breakage, Windows, `git add -A` traps).
Cost: S.

**S5. Single-binary distribution in Phase 1, not deferred** (§17 → §6/§15). Hooks, the
merge driver and `doctor --ci` run in every clone and every CI job; `npx blobsy` cannot
meet the 150 ms budget and requires Node ≥ 24 on every machine that merges a `.bref`.
Gat, jj, Lore, git-xet and LFS all ship binaries; the research calls it the category
norm. Ship `bun build --compile` (or SEA) per platform with a checksum-verified install
script alongside npm, run the golden suite against it (the plan already says so), and
make `setup` write hooks that resolve `blobsy` from PATH with a clear error when absent
(Gat’s silent `gat: not found` is the anti-pattern).
Also make the hash addon embedding a release gate.
Cost: M.

**S6. Windows section** (new §, restoring round 9 §5.6). Minimum content: hook shims run
under Git for Windows’ `sh`; snapshot symlinks fall back to copies with a warning when
Developer Mode is off; `add` detects case-insensitive collisions within a directory ref
and refuses; reflink is available on ReFS/Dev Drive only; `\\?\` long paths;
CRLF-tolerant ref reading (Gat lock-v1 rule) with LF writes.
Add a Windows job to CI. Cost: M.

**S7. Torn-read protection in hashing** (§4.5). Stat before and after hashing; if size
or mtime changed, re-hash (or refuse in `add`/`push`). Gat’s “coherent observation” and
s3lfs’s `_changed_during_hashing` both exist because agents and build tools write files
while a hash is in flight; v3’s racy-clean rule covers cache trust but not the hash
itself. Cost: S.

**S8. Document pins as the cross-repo mechanism; consider cross-store pins** (§4.4,
§7.4, §17). Repo B pins `assets/llama-3-8b/v2` published by repo A; nothing else is
needed when both use one store.
That is Gat’s `mount` without cloning the other repo and without row ownership rules.
Say so, and add “restore of a pin verifies `tree_id` regardless of publisher”.
The narrow extension worth considering: allow the pin row’s `extra` to be an absolute
snapshot URL (`s3://other-bucket/prefix/snap/assets/x/v2`), read-only, excluded from GC,
using the same URL parser and credential chain.
It is the only place where a second backend adds flexibility without touching push, GC
or the synced records.
Cost: S (doc) + M (cross-store).

**S9. Server-side checksum when it is free** (§4.3, §10, K3). For `hash: sha256`, single
part, encoding `-`: send `ChecksumSHA256` on PUT (S3 validates and stores it) and let
`status --remote --verify` compare `HeadObject` checksums without download.
For multipart or zstd objects, skip.
Record in K3 that BLAKE3 gives ~8× hashing speed but forfeits server-side verification
and zero-rehash LFS import; the benchmark should weigh both.
Cost: S.

**S10. Emergency purge path with tombstone** (§14, §13, Lore §19). `blobsy gc --purge
<hash>|--snapshot <name> --force` deletes immediately (no grace), requires the ref to be
absent from HEAD, and writes a tiny `<key>.purged` object (`who`, `when`, `reason`).
`pull` of an old commit then reports “purged 2026-… by …” rather than a bare 404.
Without this, “asset snapshots are never deleted by blobsy” and the gc grace period mean
a leaked secret or a wrongly licensed asset stays in the store until someone uses the
console. This is threat-model rule 6’s “emergency plumbing” reinstated for v3. Cost: S.

**S11. Repo mutation lock** (§4.6). A lock file under `$(git rev-parse --git-path
blobsy)/lock` held by `add`, `rm`, `mv`, `pull`, `snap restore` and the hooks; stale
after N minutes (restic).
s3lfs and Gat both have one; blobsy’s audience is parallel agents in one worktree.
Ref writes are atomic, but two concurrent `add`s rewriting the same directory ref or
ignore block are not.
Cost: S.

**S12. Conditional deletes in GC** (§14). `If-Match: <etag>` (S3, 2025-09) or
`ifGenerationMatch` (GCS) so gc deletes only the generation it judged unreachable, and
gc refuses on backends without `list`. Cost: S.

**S13. jj-aware `add` and root discovery** (§7.5, §8). Round 9 §8 recommended: detect
jj, skip `git add`, run `jj file untrack` for payloads jj already snapshotted (or warn),
prefer `$JJ_WORKSPACE_ROOT`, use VCS-neutral wording.
v3 kept only the merge-tool mode.
Also set `merge.blobsy.recursive = blobsy` so criss-cross merges use the driver.
Cost: S.

### Consider

**C1. Route-ready config shape, no routes yet** (§11, §17). Keep `backend:` as a string.
When routes land, add `routes: {<path-prefix>: <url>}` with most-specific-prefix-wins
(Gat); keys are already prefix-independent, so the only code change is dispatch in the
entry loop and per-store reachability in gc.
M1 is the prerequisite.
No change to v3 text beyond a sentence.

**C2. Cross-store read-only pins** — see S8.

**C3. Ordered fallback list for cache snapshots** (§4.4): `fallback: ["cache/target/
{os}-{arch}/{hash:rust-toolchain.toml}/", "cache/target/{os}-{arch}/"]` (actions/cache
`restore-keys`). v3’s single parent prefix covers 90%; the list is a few lines.

**C4. `blobsy cat <path> [--range a-b]`** streaming from the store or cache without
materializing; useful for agents inspecting a 4 GB parquet header.
Not a mount. Later.

**C5. Doctor emits the hardening recipe**: an S3 bucket policy requiring
`s3:if-none-match`, Object Lock / R2 bucket lock for `snap/assets/`, lifecycle rule for
`snap/cache/`, and a `0d` GCS soft-delete policy for cache buckets.
Documentation plus a `doctor --print-policy` flag.

**C6. OpenDAL npm spike** limited to the GCS/Azure commit objects (as v3 says).
Do not replace the AWS SDK: its credential chain (SSO, `credential_process`, OIDC) is
the best-in-class element in dimension 5, and Gat’s OpenDAL path lacks it.

**C7. Stored-size column or accept the gap** (§4.3): “an existing object whose size
mismatches is reported” works only for encoding `-`; for `zstd` objects the ref holds
the original size, not the stored size.
Either accept (download-time hash verification still catches corruption) or add the
stored size to `extra` (`zstd:39895989`). Lean accept.

**C8. Recoverability (c) must try both keys** (§10): for a locally modified file the
encoding is unknown, so `exists(key(hash, '-'))` and `exists(key(hash, 'zstd'))` must
both be checked before refusing.
One-line clarification.

**C9. Escape-hatch recipe as a test** (s3lfs): “restore any file with only `aws s3 cp` /
`rclone copy` + the `.bref`” and “move stores with `rclone copy` + change URL”, both in
docs and as golden tests.
Correctness is a marketing surface.

**C10. Compression sampling** (s3lfs `compression: auto`): v3 already compresses once
and keeps the result only if ≥5% smaller, which is the same outcome at the cost of one
compression pass per candidate.
Fine as is; mention `compress.min_size` is the knob.

* * *

## 4. Reject list (popular features v3 should keep out, with reasons)

| # | Feature (who has it) | Why reject |
| --- | --- | --- |
| R1 | Multiple backends / routes in 3.0 (Gat, DVC, annex) | Touches every entry loop and GC reachability; demand is monorepo buckets, which `rclone copy` + a local URL override and, later, C1 serve. Keep deferred; do M1 now. |
| R2 | Location tracking and `numcopies` (git-annex) | Needs a merged location log (annex’s union-merged branch) and N-remote awareness. The single-store recoverability rule is the one-remote analog of “at least one copy exists”. Mirrors are `rclone copy`; `status --remote --backend <url>` can verify a mirror later. |
| R3 | Pipelines, params, metrics, run-cache (DVC) | Different product. Snapshot stanzas with pure templates are the whole of blobsy’s “pipeline” surface. |
| R4 | CDC / sub-file dedup (Xet, Lore, restic, casync) | Index + chunk store + non-canonical addresses; pays off for multi-GB files edited in place, which is outside the stated MB–few-GB scale. Revisit only with measured demand (checkpoints). |
| R5 | LFS pointer-format compatibility (lfs-s3, git-xet) | Re-engages GitHub LFS quota, smudge filters and `.gitattributes filter=lfs` — PAIN-4 again. `import lfs` is the on-ramp. |
| R6 | Smudge/clean filters, FUSE/VFS mounts (LFS, git-lfs-fuse, Everest, Lore VFS) | Fragile, platform-specific, and break jj and hosted merges. Explicit `pull` + cache + hooks cover the need. |
| R7 | File locking (Lore, LFS) | Requires a server for enforcement. Advisory conditional-create lock objects are possible later; no demand yet. |
| R8 | Plan/apply files (HF Buckets) | `--dry-run --json` already prints the exact plan with keys; CAS operations are idempotent, so re-running is “apply”. Persisting plans adds a file format for no new capability. |
| R9 | AC→CAS indirection for snapshots (`names/<key>.ref` → `snapshots/<tree_id>/…`, Nix/Bazel style) | v3’s “everything under the name” makes lifecycle rules and `snap ls` trivial. Cross-name dedup of identical trees is rare; package-grouped packs (deferred) are the real dedup lever. |
| R10 | Hash-bucketed shards (Gat `shard_levels`, Oxen vnodes) | Unreadable PR diffs, cross-shard invalid merges even with the driver (Gat l′). Finer directory refs are the readable shard. |
| R11 | `merge=union` for refs (annex logs, s3lfs `.gitignore` block) | Silently duplicates paths and loses delete-vs-modify (verified). Regenerate the ignore block instead; per-path driver for refs. |
| R12 | Per-clone `.git/info/exclude` ignores (Gat) | Breaks linked worktrees, leaves fresh clones unprotected. Committed ignore lines are the hook-independent guard. |
| R13 | Symlink materialization (instaclone, DVC `symlink`) | Tools and `git add -A` mis-handle symlinks; Windows needs privileges. Reflink/hardlink/copy suffice (S4). |
| R14 | Aggregates (counts, totals, tree hash, timestamps) in committed refs (DVC `.dvc`) | Every concurrent edit conflicts. v3’s static header is right; aggregates live in `snap` refs and receipts, which are never merged. |
| R15 | Named remote maps in `.blobsy.yml` now (Gat, DVC, rclone) | Premature without routes; one URL + local override + `${VAR}` cover 3.0. Re-add with C1. |
| R16 | Client-side encryption (git-annex, restic, rudolfs) | Identity is the plaintext hash, so encryption needs a key-management story and breaks browsability and provider checksums. SSE at the backend is the answer; state it in non-goals. |
| R17 | Mutable “latest” names / tags (OCI tags, BuildKit refs, DVC) | v3’s write-once names plus `--fallback` (newest under a prefix) and `snap ls` give the same UX without a second mutable primitive. |
| R18 | Mirror/run-archive mode in 3.0 (round 8) | D8 (c) stands: receipts first. Path-shaped keys are a second storage discipline. |
| R19 | First-class conflict rows (jj-style N-sided entries) | Markers + validator already make an unresolved merge unambiguous and uncommittable; a second row grammar is not worth it. |
| R20 | Union/bidirectional sync of append-only shared tool caches (round 8 R10) | Contradicts immutable snapshots. Out of scope; but see §5 — say so explicitly. |

* * *

## 5. Missing use cases and flexibility points

1. **UC-8 Anonymous / public read.** Open-source repos and public datasets want
   contributors and CI to `blobsy pull` with no cloud credentials.
   S2 (`https://` backend) plus M1 covers it; it also makes GitHub Pages, Cloudflare R2
   public buckets and any CDN a valid read backend.
2. **UC-9 Cross-repo asset consumption.** A model or fixture set published by one repo
   and pinned by several (Gat mounts, DVC import, Nix caches).
   Same-store pins already work and should be documented as the mechanism (S8);
   cross-store read-only pins are the one justified exception to “one backend per repo”.
3. **Append-only shared tool caches** (round 8 R10: derived, add-only, union-merged,
   never pruned, lifecycle-expired).
   Neither immutable snapshots nor refs model this.
   v3 should list it under non-goals explicitly ("cache the package-manager store as a
   snapshot instead") rather than leave it implicit.
4. **Parallel agents in one worktree.** No repo lock (S11); `add`/`pull` races on the
   same directory ref or ignore block are plausible with multi-agent setups.
5. **Emergency removal** of a published asset or object (secret, license) — S10. Today
   assets are “never deleted” and content objects wait out the grace period.
6. **Windows** — S6. Also case-insensitive collisions inside a directory ref (macOS and
   Windows), which the manifests research raised and v3 dropped.
7. **Huge collections** (≥ 50k rows): guidance on splitting into finer directory refs,
   and a stated parse budget (the 10k-entry status target is there; nothing for 100k).
8. **Partial restore cost**: `snap restore --only <glob>` downloads and streams the
   whole archive in v1. State it, so users don’t size snapshots expecting range restore.
9. **Monorepo recipe**: `git clone --filter=blob:none --sparse` + `git sparse-checkout
   set` + `blobsy pull` (with S1 honoring the cone).
   One paragraph in §7.
10. **`--fallback` on backends without `list`** (command backends, `https://`): must
    refuse with a clear message rather than silently miss.
11. **Non-colocated jj repos** and `jj run` working copies (round 9 §8): declare
    colocated-only or support `jj root`; either is fine, silence is not.
12. **Store migration and escape hatch as tested recipes** (C9).

* * *

## 6. Explicit confirmations (v3 picked the best element and should not move)

- **Derived, prefix-free keys** (Gat) with filename as metadata — enables mirrors,
  renames, promotion between shapes, and `import lfs` at zero re-upload.
- **Per-path merge rules + markers + validator** (Gat rules, blobsy UX), committed
  `.gitattributes` with silent text-merge fallback, jj merge-tool mode.
- **Recoverability rule** (s3lfs `_recoverable`, strengthened) in place of a merge base.
- **Racy-clean hash cache** (git/s3lfs) under the git dir; nothing committable.
- **Manifest-last, create-only commit point** for snapshots (restic/OCI/Nix/Lore/Xet),
  with a doctor probe because S3-compatibles lie about `If-None-Match`.
- **Pure input-derived cache names + write segregation + provenance** (actions/cache,
  Nix, CREEP lesson); lifecycle expiry instead of tool-side deletion.
- **Canonical tree id over sorted entry lines, kinds `f/x/l/d`, mtime excluded** (NAR,
  REAPI, git trees), deterministic tar.
- **Guard hooks (pre-commit, pre-push over pushed ranges) plus `doctor --ci`** — the
  union of blobsy’s and s3lfs’s hooks that Gat lacks, with correctness never depending
  on them.
- **`--json`, `--dry-run`, refusals with choices, `docs --skill`** — nobody else in the
  set has this surface.
- **Three config scopes, project-only keys for anything affecting bytes or keys** (Gat).
- **Non-goals**: server, filters, locking, CDC, mutable names, network in git ops.
