# Design Review Issues History

Maps all issues raised across design reviews to their resolution.

## Review Issues Resolution

This section maps all issues raised across the design reviews to their resolution in
this consolidated design.

**Review sources:**

- [Round 1: General review](../archive/blobsy-design-review-round1-general.md) (C1-C4,
  S1-S7, M1-M11)
- [Round 2: Checksum deep-dive](../archive/blobsy-design-review-round2-checksums.md)
- [Round 3: GPT5Pro architecture review](../archive/blobsy-design-review-round3-gpt5pro.md)
- [Round 4: GPT5Pro incorporation guide](../archive/blobsy-design-review-round4-gpt5pro.md)
- [Round 5: GPT5Pro senior review](../archive/blobsy-design-review-round5-gpt5pro.md)
  (P0-1 through P0-4, P1-5/6, sections 5.1-5.9, 6.1-6.8)
- [Round 6: Opus 4.6 review](../archive/blobsy-design-review-round6-opus46.md) (3.1-3.8,
  4.1-4.3)
- [Round 6: GPT5Pro review](../archive/blobsy-design-review-round6-gpt5pro.md)
  (blobsy-pqxs, blobsy-ojz7, blobsy-m9nb, blobsy-5o3h, blobsy-j3bw, blobsy-p3u3,
  blobsy-9mpf, blobsy-93b1, blobsy-mhfd, blobsy-fxrg, blobsy-62i6, blobsy-diee)
- [Round 6: Gemini 3.1 review](../archive/blobsy-design-review-round6-gemin31.md)
  (Critical Risks 1-2, blobsy-3si4, blobsy-qk6f, blobsy-76b0, blobsy-07e5)
- [Round 6: GPT5.3 Codex review](../archive/blobsy-design-review-round6-gpt53codexextrahigh.md)
  (findings 1-6)

### Resolved by Per-File `.yref` Architecture

These issues are eliminated by the architectural shift to per-file refs and
content-addressable storage.

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-cx82` | R3 P0-1 | Versioning semantics: “latest mirror” vs “immutable snapshots” | **Resolved.** Content-addressable storage = immutable blobs. Git history of `.yref` files = full versioning. Old commits can be checked out and pulled (blobs are never overwritten). No contradiction. |
| `blobsy-mlv9` | R3 P0-3 | `manifest_sha256` for directory pointers | **Eliminated.** No manifests, no directory pointers. Each file has its own `.yref` with its own `hash`. Git diff is meaningful per-file. |
| `blobsy-a64l` | R3 P0-2 | Post-merge promotion workflow | **Eliminated.** Content-addressable blobs are not prefix-bound. After merge, `.yref` files on main point to the same blobs that were pushed from the feature branch. No promotion needed. |
| `blobsy-05j8` | R3 P0-4.2 | Delete semantics contradiction | **Eliminated.** Content-addressable storage never deletes or overwrites during sync. Old blobs remain until GC. No delete flags needed for push/pull. |
| `blobsy-7h13` | R1 C2, R3 P0-4 | Single-file remote conflict detection | **Eliminated.** No “remote hash Z” needed. `.yref` merge conflicts handled by git. Payload-vs-ref desync detected by stat cache three-way merge (see [Conflict Detection](#conflict-detection)). Content-addressable = concurrent pushes of different content produce different keys (no overwrite). |
| `blobsy-lsu9` | R3 P0-5 | Compression + transfer mechanics | **Resolved.** File-by-file orchestration (compress -> copy -> cleanup). Transfer tools used as copy engines, not diff engines. No staging directory needed. Compression is supported in the initial release via Node.js built-in `node:zlib`. |

### Resolved in Spec (Carried Forward)

These issues were resolved in the original spec and remain resolved in this design.

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-suqh` | R1 C3, R3 4.9 | Interactive init contradiction | **Resolved.** `init` is interactive without flags; all sync ops are non-interactive. See Non-Interactive by Default. |
| `blobsy-br1a` | R1 C4, R3 5 | `blobsy sync` bidirectional danger | **Simplified.** Sync = push missing + pull missing. No delete cascades. No `--strategy` flag in the initial release. |
| `blobsy-jlcn` | R1 M1, R3 4.1 | Pointer field types | **Resolved.** hash = content identifier (sha256:64-char-hex), size = bytes. See Ref File Format. |
| `blobsy-n23z` | R1 M2 | Format versioning | **Resolved.** `<name>/<major>.<minor>`, reject on major mismatch, warn on newer minor. |
| `blobsy-0a9e` | R1 M3, R3 4.10 | Command backend template variables | **Resolved.** `{local}`, `{remote}`, `{relative_path}`, `{bucket}` specified. See Backend System. |
| `blobsy-srme` | R1 M4, R3 4.8 | Which `.gitignore` to modify | **Resolved.** Same directory as tracked path. See Gitignore Management. |
| `blobsy-v9py` | R1 M5, R3 4.3 | Detached HEAD SHA length | **Mostly eliminated.** No namespace prefixes in content-addressable mode. Detached HEAD is not special -- `.yref` files reference content hashes, not branch prefixes. |
| `blobsy-bnku` | R1 M7, R3 4.4 | Push idempotency | **Resolved.** Content-addressable = inherently idempotent. Same hash = same key = no-op PUT. |
| `blobsy-q6xr` | R3 4.4 | Pull behavior on local mods | **Resolved.** Default: error on modified files unless `--force`. See Pull section. |
| `blobsy-txou` | R3 4.2 | Manifest canonicalization | **Eliminated.** No manifests. `.yref` files use stable key ordering. |
| `blobsy-v6eb` | R3 4.1 | Stable pointer key ordering | **Resolved.** Keys written in documented fixed order. See Ref File Format. |
| `blobsy-mg0y` | R3 4.9 | `--json` schema version | **Resolved.** `schema_version` field in all JSON output. |
| `blobsy-pice` | R3 4 | SDK endpoint wording | **Resolved.** Correct wording: SDK uses config object, not CLI flags. |
| `blobsy-r34j` | R1 S2 | gc safety (remote branches) | **Simplified.** Content-addressable GC scans all branches/tags for referenced hashes. No branch-prefix-based GC. |

### Still Relevant (Addressed in This Doc)

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-rel2` | R3 4.5 | Atomic writes for built-in transport | **Addressed.** Temp-file-then-rename for ALL backends (built-in SDK, external tools, command backends). Blobsy manages atomicity; does not rely on transport. See [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md#atomic-writes). |
| `blobsy-vj6p` | R3 4.10 | Security: command execution from repo config | **Addressed.** `command` backends disallowed from repo config by default. See Security and Trust Model. |
| `blobsy-y72s` | R1 S7, R3 4.6 | Auto tool detection robustness | **Addressed.** Ordered `sync.tools` list with capability check + fallthrough + `blobsy doctor`. See [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md#transfer-delegation). |

### Eliminated by Architecture Change

| Bead | Review IDs | Issue | Status |
| --- | --- | --- | --- |
| `blobsy-u4cs` | R1 S1, R3 4.3 | Branch name sanitization | **Eliminated.** No namespace prefixes in content-addressable mode. Branch names never appear in remote keys. |
| `blobsy-q2dd` | R1 S4, R3 4.3 | Version namespace mode | **Eliminated.** No namespace modes. Versioning = git history. |
| `blobsy-p8c4` | R3 4.2 | `stored_as` in manifest | **Eliminated.** No manifests. Compression state stored in `.yref`. |
| `blobsy-fjqj` | R3 4.7 | Compression skip list in repo config | **Addressed.** Compression rules in `.blobsy.yml`. See Compression Rules. |

### Resolved (Rounds 5-6)

Issues from round 5 and round 6 reviews that have been addressed in the current design.

#### Spec Contradictions Fixed

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-j3bw` | R5 P0-2, R6-codex 1, R6-gpt5pro | Sync semantics: committed vs working tree refs | **Resolved.** Working Tree vs HEAD Semantics section added. Commands read from working tree with warnings for uncommitted refs. Clear per-command table. |
| `blobsy-p3u3` | R6-gpt5pro | SHA-256 short collision math wrong (said ~16M, correct is ~2.4M) | **Fixed.** Design doc corrected to ~2.4 million for 1% collision at 48 bits. |
| `blobsy-9mpf` | R6-gpt5pro | `{iso_date_secs}` format string typo (extra `s` in `YYYYMMDDTHHMMSSsZ`) | **Fixed.** Corrected to `YYYYMMDDTHHMMSSZ`. |
| `blobsy-93b1` | R6-gpt5pro | “Batch dedup” phrasing misleading for timestamp+hash template | **Clarified.** Comparison table now says “Same path+content+timestamp” (not “batch-wide dedup”). |
| `blobsy-mhfd` | R6-gpt5pro | Node.js minimum version for zstd not specified | **Fixed.** Node.js 22.11.0 minimum documented for zstd support. |

#### Architectural Issues Resolved

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
| `blobsy-ojz7` | R5 5.1, R6-gpt5pro | Hash algorithm agility: `sha256` field bakes in algorithm | **Resolved.** `.yref` now uses `hash` field with `sha256:` prefix (e.g., `sha256:7a3f0e...`). Future algorithms can use different prefixes. |
| `blobsy-5o3h` | R5 5.5, R6-gpt5pro, R6-gemini | Atomic downloads: don’t rely on external tools for atomicity | **Resolved.** All downloads use temp file + hash verification + atomic rename, regardless of transfer engine. |
| `blobsy-pqxs` | R5 3.2, R6-gpt5pro, R6-codex 4 | Branch-isolated mode contradictions (branch sanitization “eliminated” but `{git_branch}` still in templates) | **Resolved.** Branch-isolated mode and `{git_branch}` template variable deferred to future version. |
| `blobsy-62i6` | R6-gpt5pro | Determinism as a design feature not explicit | **Addressed.** Design Decisions section added with idempotent operations, no-daemon/no-lock principles. |
|  | R6-gpt5pro 4.5 | Rename/move is P0 gap (gitignored payloads don’t move with `git mv`) | **Resolved.** `blobsy mv` command added: moves payload, moves `.yref`, updates `.gitignore`. |

#### Safety and Correctness Issues Addressed

| Bead | Review IDs | Issue | Resolution |
| --- | --- | --- | --- |
|  | R5 P1-5, R6-opus 3.1, R6-codex 2 | Push/commit coordination: most common user error mode | **Addressed.** `blobsy check-unpushed` and `blobsy pre-push-check` commands added. Pre-commit hook auto-pushes. Uncommitted ref warnings on push/sync. |
|  | R6-gemini CR-1 | Split-brain: `git pull` updates `.yref` but not payload; `blobsy sync` could revert changes | **Resolved.** Stat cache used as merge base to distinguish user edits from git-updated refs. See [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md). |
| `blobsy-3si4` | R6-gemini CR-2 | Timestamp layout “age-based cleanup” guidance is dangerous (blob age != reference age) | **Revised.** Age-based cleanup marked as “Deferred” in comparison table. GC design requires scanning reachable refs, not naive prefix deletion. |
|  | R5 P0-1, R5 5.2, R6-codex 5 | Remote key/dedup semantics inconsistent (claimed CAS but key includes path) | **Addressed.** Four layout patterns documented with explicit tradeoff comparison. Default is timestamp+hash (path-based, not pure CAS). Cross-time duplication acknowledged. Pure CAS available as Pattern 2. |
|  | R5 P0-4, R5 5.3 | Compression/remote representation mapping: `.zst` suffix not explicit in key | **Addressed.** `{compress_suffix}` template variable documented. Compression state stored in `.yref`. Suffix prevents collisions. |
|  | R5 P1-6, R5 5.8, R6-opus 3.4 | Stat cache correctness: racy files, clock skew, coarse mtime | **Addressed.** Companion doc [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md) with full design: entry format, invalidation rules, escape hatches. |
|  | R5 5.6 | Gitignore path relativity likely wrong in examples | **Addressed.** Explicit per-file entries in blobsy-managed block. Path handling documented. |
|  | R5 5.9, R6-codex 3, R6-opus 3.7 | Command backend security: path traversal, shell injection, malicious endpoints | **Addressed.** Command backends disallowed from repo config by default. Security and Trust Model section. `execFile` with args arrays recommended (no `shell: true`). |

### Deferred (P2 / Future Versions)

Includes issues from all review rounds.

| Review IDs | Issue | Status |
| --- | --- | --- |
| R1 M8 | Dictionary compression | Deferred to a future version. |
| R1 M6 | Export/import specification | Deferred to a future version. |
| R1 M9 | Team adoption workflow docs | Deferred. |
| R1 M10, R3 7 | Integration surface (library vs CLI) | Stated: standalone CLI + npm package. |
| R3 4.8 | Mixed directories: ignore vs include patterns | Resolved by externalization rules. |
| R1 M11 | `command` backend as integration point | See [blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md#backend-types). |
| R3 5 | s5cmd as future transport engine | Deferred to a future version. The initial release ships with aws-cli + rclone + template commands. |
| R1 S6, R3 4.7 | Compression suffix convention | Accepted: `.zst` suffix in remote; compression state in `.yref`. |
| R3 4.7 | Small-file compression threshold | Built in: `compress.min_size: 100kb` default. |
| R5 P0-3, R6-opus 3.6, R6-gpt5pro 4.10 | GC reachability and safety at scale | Deferred to V2. Design outlined with `--depth`, `--older-than`, dry-run safety, and template-agnostic scanning. |
| `blobsy-diee` (R6-gpt5pro) | Remote checksum support (store provider ETag/checksums in `.yref`) | Deferred to V2. |
| `blobsy-76b0` (R6-gemini) | Trash command | Deferred to V2. V1 only provides `blobsy rm`. |
| `blobsy-07e5` (R6-gemini) | Trash/GC optimization pattern documentation | Deferred to V2. |
| `blobsy-qk6f` (R6-gemini) | Command backend cross-platform limitations documentation | Deferred. |
| `blobsy-fxrg` (R6-gpt5pro) | `.blobsy.yml` merge semantics (arrays replaced vs merged) | Deferred. Needs formal documentation. |
| R6-opus 3.2 | Template system complexity (named layout presets) | Not yet simplified. Templates remain configurable. Named presets could reduce cognitive load. |
| R6-opus 3.8 | Credential exposure in command backends (env var sanitization) | Noted as risk. Command backends already restricted by trust model. |
| R6-opus 4.1, R6-codex 6 | Per-file transfer overhead for many-file workloads | Acknowledged as V1 limitation. Batch transfer engine deferred to V2. |
| R6-opus 3.5 | Edge cases: concurrent ops, partial file writes, symlink cycles, case sensitivity, Unicode normalization, 10K+ file performance | Partially addressed. Some covered by stat cache and atomic writes. Others deferred. |
