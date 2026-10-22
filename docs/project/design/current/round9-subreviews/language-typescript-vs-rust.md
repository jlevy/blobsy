# Blobsy Implementation Language Review: TypeScript vs Rust (vs hybrid)

**Date:** 2026-10-22 **Reviewed revision:** `main` @ `04a3d1a` (8,862 LOC TS in
`packages/blobsy/src`; 327 vitest tests; 71 tryscript goldens) **Question:** Should
blobsy stay in TypeScript/Node, move to Rust, or go hybrid — given the round-9 roadmap
(Phase 0 safety, Phase 1 core simplification with derived keys/create-only
writes/batched transfer, Phase 2 `.brefs` manifests + per-path merge driver, Phase 3
`tar.zst` snapshots for 15k–1M-file trees, Phase 4 mirrors, Phase 5 adoption/GC)?

**Evidence markers:** **[V]** measured or verified here (this container: 4 vCPU Xeon 2.8
GHz, no SHA-NI, 15 GB RAM, Node 22.22, bun 1.4.2, cargo 1.97); **[S]** verified by a
sub-review or a primary web source fetched this session; **[I]** inference or judgment.

All measurements and scratch code live under
`/tmp/claude-0/-home-user-blobsy/0713c929-56bc-5939-ab24-7ac184df530b/scratchpad/lang/`
(Appendix A).

* * *

## 0. Verdict

**Stay in TypeScript through Phase 3. Do not rewrite now, and do not build a napi-rs
hybrid. Spend the “Rust budget” instead on (1) fixing blobsy’s own 560 ms startup, which
is a bundling problem, not a language problem, (2) making every format and the golden
suite language-neutral so a later port or second implementation is cheap, and (3)
shipping a single-binary build (bun `--compile` today, Node SEA when it stabilizes)
alongside npm.**

Five findings drive this:

1. **Blobsy is slow to start, and Node is not the reason.** `blobsy --version` takes 560
   ms median [V]; bare Node is 39 ms [V]. The gap is eager imports: `marked-terminal`
   160 ms, `@aws-sdk/client-s3` 133 ms, `zod` 64 ms, `yaml` 36 ms [V]. A CLI that
   imports only commander+yaml+picomatch+picocolors starts in ~60–120 ms, ~140–175 ms
   with zod [V]. Rust CLIs start in 7–14 ms (Gat 8 ms, jj 14 ms, a blobsy-shaped Rust
   stub 7 ms) [V]. So the honest comparison for a merge driver or hook is ~100 ms (TS,
   done right) vs ~10 ms (Rust) — a difference that matters only for per-file
   invocation, which the proposed design avoids (the driver runs once per conflicting
   `.brefs`, never per data file).
2. **On the hot paths the roadmap actually has, Node is within 1.0–1.4× of Rust, and
   sometimes ahead.** SHA-256 of 1 GiB: Node (OpenSSL) 4.3–4.9 s vs the Rust `sha2`
   crate 6.7 s on this non-SHA-NI CPU [V]. 100k-file walk+stat: 340 ms vs 209–288 ms
   [V]. zstd-3 of a 179 MB tar: 2.1–2.3 s vs 1.7–1.8 s [V]. The only place Rust is
   dramatically faster is BLAKE3 (0.46 s/GiB single-thread; 0.12 s with rayon), which is
   a hash-choice question, not a language one, and the Gat review already recommends
   keeping SHA-256 for LFS/S3 interop.
3. **Single-binary distribution is achievable from TS.** `bun build --compile` produced
   a working 84 MB `blobsy` in 2.8 s that passes `status` on a real repo [V]. Node SEA
   is still “Stability 1.1 active development” but gained `--build-sea` (no postject) in
   25.5 and ESM support [S]. Meanwhile the biggest agent-facing CLIs (Claude Code,
   Codex) ship native binaries *through npm* with per-platform `optionalDependencies` —
   the same packaging works for a Rust binary and for a bun/SEA binary, so the install
   story is decoupled from the language choice [S].
4. **The switch cost is real but shrinking; the right time to port, if ever, is after
   Phase 1–2 when the core is a ~60-line entry loop plus spec’d formats.** A Rust port
   today would re-implement 8.9k LOC including the accidental half that Phase 1 deletes.
   A blobsy-shaped Rust crate pulls 276 crates and takes 4.6 min for a clean release
   build on 4 cores (1.6 s incremental); Gat, at 152k LOC Rust, takes ~7 min [V].
   Vitest+tryscript iterate in seconds and the goldens are already language-agnostic
   (they run `blobsy` from `$PATH`) [V].
5. **The dependency-safety argument cuts both ways.** Blobsy’s production tree is 166
   packages, 94 of them AWS SDK/Smithy [V]; a Rust equivalent is 276 crates (aws-sdk-s3
   \+ tokio + clap + serde + zstd + tar) [V]. Neither is “small”.
   Rust’s type system would catch some of the error-shape drift the complexity review
   found, but the three reproduced data-safety bugs (B-1..B-3) are policy bugs that no
   type system prevents.

**Decision rule (§8):** switch to Rust only if, *after* Phase 1 and the startup fix, a
measured workload a real user needs is still >2× over its budget and the profile shows
the runtime (not blobsy’s algorithms) at fault; or if blobsy needs in-process git
(`gix`) / embedding in non-JS hosts; or if npm+bun/SEA distribution demonstrably blocks
adoption in a target sandbox.
None of those is true today.

* * *

## 1. Distribution and install

### 1.1 What users and agents have today [V/S]

| Environment | Node | bun | cargo | Notes |
| --- | --- | --- | --- | --- |
| This Claude Code cloud sandbox | 22.22 (Jod) | 1.4.2 | 1.97 | all three present [V]; `npx blobsy` works with no install |
| GitHub Actions `ubuntu-24.04` (Aug 2026 image) | 22.23 and 24.19 in the tool cache | — | yes | [S: runner-images release notes] |
| Claude Code itself | not required: native binary; npm wrapper pulls a per-platform `optionalDependency`; “the installed `claude` binary does not itself invoke Node” |  |  | [S: code.claude.com install page]. Alpine supported via musl builds. |
| Codex CLI | Rust rewrite shipped through `npm i -g @openai/codex` (platform binaries) and Homebrew |  |  | [S] |
| Gat | `curl … install.sh \| sh`, 8 targets (x86_64/aarch64 × linux-gnu/musl, darwin, windows-msvc), checksum-verified; `cargo install` fallback; own release.yml with Zig for glibc 2.28 |  |  | [V: `attic/gat/.github/workflows/release.yml`, README] |
| jj | 31 MB static-pie musl binary from GitHub Releases |  |  | [V: `file` on the downloaded binary] |

Node release lines [S: nodejs/release README]: 22 in Maintenance until **2027-04-30**;
24 enters Maintenance **2026-10-20**, EOL 2028-04-30; 26 enters Active LTS 2026-10-28;
from 27 the cadence becomes annual.
Blobsy’s `engines: >=22.15.0` (for `node:zlib` zstd) therefore covers every supported
LTS today and for ~18 months; `>=24` (as the README says) is stricter than the code
needs.

### 1.2 Paths to a single binary from TypeScript [V/S]

| Path | Status (Oct 2026) | Size | Startup | Cross-compile | Notes |
| --- | --- | --- | --- | --- | --- |
| `bun build --compile` | Stable, used in production by many CLIs | **84 MB** (blobsy, minified) [V] | `--version` 337 ms, `status` 376 ms [V] (still pays blobsy’s eager imports; bun itself starts in 9 ms [V]) | yes: `--target bun-{linux,darwin,windows}-{x64,arm64}` [S] | Bun ≠ Node: `@aws-sdk`, `node:zlib` zstd, `child_process` worked in the smoke test [V]; full golden run under bun not done (A-4) |
| Node SEA | **Stability 1.1 “active development”**; `--build-sea` (no postject) since 25.5; `mainFormat: "module"` supported; VFS since 26.9; macOS needs ad-hoc codesign; cross-platform builds must disable snapshot/code cache | ≈ node binary (123 MB here) + bundle [V/I] | ≈ node startup + bundle | yes, with restrictions | Blob must be built with the exact Node version. Not usable from Node 22’s `--experimental-sea-config` without postject. |
| Deno compile | Mature, `--target` cross-compile; npm specifiers supported | 40–90 MB typical [S] | similar to Node | yes | Not measured; no Deno in this container |
| npm wrapper + platform `optionalDependencies` (esbuild/biome/turbo/Claude Code pattern) | The norm for native CLIs on npm | n/a | n/a | n/a | Works identically for a Rust binary or a bun/SEA binary. Breaks with `--no-optional`; pnpm needs `supportedArchitectures` for multi-platform lockfiles [S] |
| cargo-dist (`dist`) | Active: **0.33.1 released 2026-10-21**; generates shell/PowerShell installers, Homebrew, npm installer packages, MSI [S] | Rust binary 18–30 MB | 7–14 ms [V] | yes (8 targets like Gat) | Only relevant to option B/C |

**Takeaway [I]:** the “single-binary is now the norm” observation in the landscape
research is about *install UX*, and TS can meet it: publish `blobsy` on npm (for `npx`)
**and** attach bun-compiled binaries to GitHub Releases (plus an optional `curl | sh`).
Size (84 MB vs 18–30 MB) is the one visible cost; it is the same order as Claude Code’s
own binary and has not hurt adoption there.

### 1.3 Which install path is most reliable for agents? [I, grounded in 1.1]

1. **`npx blobsy@<version>`** — zero install, works wherever Node ≥22 exists, which is
   every mainstream agent sandbox and CI image measured above.
   The 500 ms+ `npx` resolution overhead on first run is a one-time cost.
   Rust cannot match “zero install” without a wrapper package — and the wrapper package
   would be the same npm package.
2. **`curl | sh` to `~/.local/bin`** — works for any language; blocked in some
   corporate/CI sandboxes (no network, no writable PATH) and needs a trust decision per
   agent policy.
3. **Homebrew / winget / apt** — nice for humans, irrelevant for agents.

For agents the deciding factor is *predictability*: a pinned `npx blobsy@x.y.z` or a
pinned release URL. Both options provide it.
**Language does not change the answer.**

* * *

## 2. Performance where it matters for the roadmap

### 2.1 Startup latency [V]

15 runs each, wall-clock, warm cache; `bench.sh` in the scratch dir.

| Command | min | median | Notes |
| --- | --- | --- | --- |
| `/bin/true` | 3 ms | 3 ms | floor |
| `git --version` | 3 ms | 4 ms |  |
| `gat --version` / `gat --help` / `gat status` | 7 / 5 / 10 ms | 8 / 6 / 12 ms | Rust, 29 MB binary, 11 MB RSS |
| `jj --version` | 12 ms | 14 ms | Rust, 31 MB static, 13 MB RSS |
| Rust stub with clap+tokio+aws-config+aws-sdk-s3 (`rsblobsy --version`) | 6 ms | 7 ms | 18 MB binary, 42 MB RSS once the SDK config loads |
| `node -e ''` | 32 ms | 39 ms | V8 + bootstrap floor; 42 MB RSS |
| `node` importing commander+yaml+picomatch+picocolors | 94 ms | 119 ms | the realistic floor for a lazily-importing blobsy |
| … plus `zod` | 147 ms | 176 ms | zod alone is 64 ms |
| **`blobsy --version` (today)** | **492 ms** | **562 ms** | 103 MB RSS |
| `blobsy --help` | 489 ms | 579 ms |  |
| `blobsy status` (1 tracked file) | 557 ms | 665–767 ms |  |
| `blobsy --version` with `NODE_COMPILE_CACHE` | 427 ms | 548 ms | no help: the cost is module evaluation, not parsing |
| `blobsy-bun --version` / `status` (bun-compiled) | 286 / 335 ms | 337 / 376 ms | 66 MB RSS; same eager imports |

Per-import cost in isolation [V]: `marked-terminal` 160 ms, `@aws-sdk/client-s3` 133 ms,
`zod` 64 ms, `yaml` 36 ms, `atomically` 18 ms, `@aws-sdk/lib-storage` 17 ms, `commander`
15 ms, `marked` 10 ms, `picomatch` 6 ms, `node:zlib` 5 ms.
`dist/cli.mjs` has **zero dynamic imports** [V]; everything is loaded for every command,
including `--version`.

**Reading [I]:** ~400 of blobsy’s 560 ms are self-inflicted.
Lazy-importing the S3 SDK (only the `s3` backend), `marked-terminal` (only `docs`), and
ideally replacing zod on the hot path (or loading it only for `config`/`doctor`) brings
`--version`/`status` to ~100–150 ms.
That is the number to compare with Rust’s ~10 ms.

**Where startup matters in the roadmap:**

- **Per-path merge driver (Phase 2).** Git runs `merge.<name>.driver` once per
  *conflicting path with the attribute*, i.e. per `.brefs` file in conflict — typically
  0–2 invocations per merge, never per data file.
  100 ms is invisible; even 560 ms is tolerable.
  Gat’s driver is the same 29 MB binary (`gat merge-driver %O %A %B`, 10 ms) [V]. A
  dedicated tiny entry point (`blobsy-merge`, imports: `node:fs` only) would run in ~40
  ms [V, from `node -e`].
- **Hooks (pre-commit verify, pre-push, opt-in post-checkout hydration).** One
  invocation per git operation.
  100–150 ms is in the range of lefthook/husky hooks users already tolerate; 560 ms is
  the kind of thing people disable.
  Fix the imports.
- **Agents calling `blobsy status --json` in loops.** Same conclusion: fix imports;
  Rust’s extra ~100 ms saving per call is not a UX tier change.

### 2.2 Hashing [V]

1 GiB random file, warm page cache, single thread unless noted.

| Implementation | Time | Throughput |
| --- | --- | --- |
| Node `crypto.createHash('sha256')`, 1 MiB stream chunks | 4.3–4.9 s | 220–250 MB/s |
| Node `readFileSync` + one `update` | 7.3–8.6 s | (1 GiB buffer alloc; don’t do this) |
| `sha256sum` (coreutils) | 3.3 s | 325 MB/s |
| `openssl speed -evp sha256` (8 KB blocks) | — | 316 MB/s |
| Rust `sha2` 0.10 streamed (release, no SHA-NI on this CPU) | 6.7 s | 160 MB/s |
| Rust `blake3` single thread | 0.46 s | 2.3 GB/s |
| Rust `blake3` mmap + rayon (4 cores) | 0.12 s | 9 GB/s |

**Reading:** Node’s SHA-256 is OpenSSL’s; it is as fast as the platform allows and
*faster* than the default Rust `sha2` crate on CPUs without SHA-NI (the `sha2` `asm`
feature or `ring` would close the gap; on SHA-NI CPUs both reach ~1.5–2 GB/s [I]). The
UC-3 sub-review’s 171 MB `node_modules` hashed in 0.99 s is consistent (≈173 MB/s with
per-file overhead). **Rust is not meaningfully better for SHA-256. It is 10–40× better
for BLAKE3**, but BLAKE3 is also available to Node via `blake3` (napi) or wasm — and the
Gat review’s recommendation to keep SHA-256 (LFS OIDs, `x-amz-checksum-sha256`,
`sha256sum`) stands.

### 2.3 Many-file walks (UC-2 10k entries, UC-3 15k–1M files) [V]

Synthetic tree: 100,000 files (100 B–2 KB each, 105 MB total) in 200×5 directories.

| Operation | Node | Rust (`walkdir`) | Ratio |
| --- | --- | --- | --- |
| readdir(withFileTypes) + stat per file, cold page cache | 1,204 ms | — |  |
| same, warm | **340 ms** | **209–288 ms** | 1.2–1.6× |
| `readdirSync({recursive:true})` no stat, warm | 386–569 ms | — |  |
| `fs/promises` unbounded async readdir+stat | 3,937–4,339 ms | — | **do not do this** (promise overhead dominates) |
| walk + read + sha256 every file, cold / warm | 9,964 / **1,488 ms** | **1,116–1,153 ms** | 1.3× warm |
| `find -type f` (no stat) | 69 ms |  |  |

**Reading:** for the 10k-entry manifest (UC-2) a correct sync walk in Node is ~35 ms;
for 1M files extrapolate ~3.5 s Node vs ~2.5 s Rust warm, and both are dominated by
cold-cache I/O (~12 s) [I]. The current code’s problems (re-hashing every file, O(N²)
gitignore rewrites, one git spawn per file) are 10–100× effects; the language is a 1.3×
effect. **Node is fast enough; Rust is marginally better.**

### 2.4 tar + zstd packing (UC-3 snapshots) [V]

Input: `tar` of this repo’s `node_modules` (179 MB, 19,929 entries).

| Operation | Node (`node:zlib` zstd, level 3, stream) | Rust (`zstd` 0.13 crate, level 3) | Ratio |
| --- | --- | --- | --- |
| compress tar | 2,066–2,290 ms → 39.4 MB | 1,681–1,795 ms → 39.4 MB | 1.2× |
| tar + zstd end-to-end from the directory | 0.5 s tar (CLI) + 2.76 s zstd = 3.3 s [S: UC-3 review] | 2,144–2,202 ms → 44.3 MB (`tar` crate) | 1.5× |
| restore (untar + symlinks + exec bits) | 4.8 s [S] | not measured |  |

Both are libzstd underneath; the difference is stream plumbing.
Node has no built-in tar, so blobsy would add `tar` (node-tar, ~1 MB, well-maintained)
or shell out — shelling out to `tar` is what the UC-3 review measured and it is the
fastest option on Linux/macOS, with a Windows caveat (bsdtar ships with Windows 10+, but
symlink handling differs) [I]. Multi-threaded zstd (`ZSTD_c_nbWorkers`) is exposed in
Rust’s crate and not in `node:zlib` [I] — a 2–3× win on 4+ cores for the UC-3 pack step
if it ever matters.

### 2.5 Concurrency for batched transfer (X-4) [I, not measured]

The current bottleneck is one *synchronous* process spawn per file (`execFileSync`) and
no SDK concurrency pool; neither is a language limit.
Node’s event loop with 8–32 concurrent `PutObject`/multipart uploads saturates any
realistic link; the AWS SDK v3 `Upload` helper does multipart with a configurable queue.
tokio would do the same with lower per-connection memory.
The real fix is batching (`rclone --files-from0`, `aws s3 cp --no-overwrite`, SDK pool),
identical in either language.

### 2.6 Memory [V]

`status` on a one-file repo: blobsy (node) 103 MB RSS; bun-compiled 66 MB; Gat 11 MB; jj
13 MB; Rust stub with the AWS SDK loaded 42 MB. For a CLI that exits in under a second
this is irrelevant except in constrained CI containers, and even there 100 MB is below
any default limit [I]. For a 1M-entry manifest, a `Map<string, Entry>` in V8 costs
roughly 150–250 MB vs ~80 MB in Rust [I]; streaming the TSV avoids both.

### 2.7 Summary per workload

| Workload | Node is fast enough? | Rust meaningfully better? |
| --- | --- | --- |
| UC-1 few files: add/push/pull/status | Yes, once startup is fixed (≈120 ms) | Only startup (≈10 ms); not user-visible |
| UC-2 10k-entry manifest: parse, diff, hash-cache check, merge driver | Yes (walk 35 ms; TSV parse of 1 MB is ~10 ms; prototype driver 0.13 s/20k lines [S]) | No |
| UC-3 snapshot of 15k files (node_modules): hash, tar, zstd, upload | Yes (≈1 s hash + ≈3 s pack measured) | 1.2–1.5× on pack; more with multi-thread zstd |
| UC-3 snapshot of 1M files | Marginal in both (I/O-bound; minutes cold) | ~1.3× on walk, more if BLAKE3; still I/O-bound |
| Merge driver / hooks | Yes if a minimal-import entry (40–120 ms) | Yes in absolute terms (10 ms) but not in user-visible terms |
| SHA-256 of multi-GB files | Yes (OpenSSL speed) | No (slower without `asm`/`ring`) |

* * *

## 3. Ecosystem

### 3.1 Object storage SDKs [V/S]

|  | TypeScript | Rust |
| --- | --- | --- |
| AWS S3 | `@aws-sdk/client-s3` (repo on 3.995; latest 3.1155 [V]) + `@aws-sdk/lib-storage` for multipart. `IfNoneMatch: '*'` on `PutObject` and `CompleteMultipartUpload` [S: UC-3 review read the source]. 94 packages, 27 MB on disk [V]. | `aws-sdk-s3` 1.154 with `if_none_match`/`if_match` [S: docs.rs]. No lib-storage equivalent: multipart is hand-rolled or via `object_store`/OpenDAL. |
| GCS / Azure natively | `@google-cloud/storage`, `@azure/storage-blob` (both support preconditions); blobsy currently delegates to rclone, which passes **no** preconditions for GCS/Azure [S] | `object_store` 0.14.2: `PutMode::Create` → `AlreadyExists` on S3/GCS/Azure/local [S]; OpenDAL 0.58 `write_with_if_not_exists` (what Gat uses [V: `gat-io/src/remote/transfer.rs:185`]) |
| OpenDAL from Node | **`opendal` 0.49.13 on npm, published 2026-10-18**, 8 platform packages (darwin x64/arm64; linux x64/arm64 gnu+musl; win32 x64/arm64) [V: `npm view`]. Gives S3/GCS/Azure/OSS/fs with conditional writes in-process without rclone. | native |
| Pluggable “command” backend (PAIN-5) | `child_process` | `std::process` — identical |

**Reading:** conditional (create-only) writes — the invariant the whole roadmap rests on
— are available in-process in both languages.
The TS path that closes the rclone-GCS/Azure gap without a port is either `opendal`
(napi, prebuilt) or the two vendor SDKs for the small commit object only (as D7
proposes).

### 3.2 Git integration

- Blobsy spawns `git` (fine; every user has it).
  Gat uses `gix` 0.88 for reads (history walks, index stages, excludes) and spawns `git`
  in 5 places [V]. `isomorphic-git` exists for JS but is not needed: for
  `merge-manifest --resolve` the three stages come from `git show :1:path` etc., three
  spawns of ~4 ms each [V `git --version` floor].
- **Merge drivers are separate executables; startup matters per conflicting file**: see
  §2.1 — it is per conflicting `.brefs`, not per entry, so ~100 ms is fine.
- jj: no hooks, no merge drivers [S: jj research]; both languages are equally affected
  (the design already demands hook-independent correctness).

### 3.3 Formats and CLI plumbing

| Concern | TS today | Rust |
| --- | --- | --- |
| YAML (`.bref`, config) | `yaml` 2.8 (36 ms import; full YAML 1.2) | `serde_yaml` is **archived**; use `serde_yaml_ng`/`serde_norway`/`serde-saphyr` [S]; Gat uses `yaml_serde` 0.10 [V] |
| TSV manifest | string ops; no dep | string ops; no dep |
| Globs | `picomatch` | `globset` |
| CLI | `commander` 14 | `clap` 4 (derive; richer help, completions) |
| Config validation | `zod` 4 (64 ms import) | `serde` + types (free at runtime) |
| Atomic writes | `atomically` | `tempfile` + `persist` |
| Markdown-to-terminal docs | `marked-terminal` (160 ms) | `termimad` or just print markdown |

### 3.4 Testing [V]

- 327 vitest tests in ~50 s; most spawn the CLI through
  `execa(process.execPath, [CLI_PATH, …])` [V `tests/helpers/cli.ts:41`], so they are
  *behavioural* tests that could be pointed at any binary with a one-line change.
  Unit tests for `hash`, `template`, `config`, `gitignore`, backends (~1,160 LOC) are
  TS-specific.
- **71 tryscript goldens (7,693 lines)** are a “TypeScript port of trycmd”
  [V package.json]; they run `blobsy …` from `$PATH` via a shim
  (`scripts/run-golden.sh`) and match stdout/stderr/exit code with regex patterns
  [V `tryscript.config.ts`]. **They are language-agnostic by construction**: a Rust
  binary on `$PATH` that prints the same bytes passes the same suite.
  The runner itself is a Node devDependency, which is fine for development in any
  language.
- Caveat: the goldens pin today’s text, including the timestamped `REMOTE_KEY` pattern
  that Phase 1 changes (~20 goldens) and 7 goldens for commands S3 deletes.
  So the suite is an asset to *keep language-neutral*, not a frozen contract.
- Gat, for comparison: 2,467 `#[test]`/`#[tokio::test]` functions, 33 integration test
  files, no trycmd/insta [V].

* * *

## 4. Correctness and safety

### 4.1 Types and errors [V/I]

- The complexity review’s error findings (three error classes with different shapes;
  `pushFile` flattening errors to strings; `process.exitCode` set in ~20 places) are
  design drift that Rust’s `Result<T, E>` + `thiserror` would make harder to commit, and
  TS’s `strict` + `exactOptionalPropertyTypes` (already on) does not prevent.
  That is a real, modest advantage for Rust.
- The three **blocker** bugs (B-1 stat-cache-as-merge-base data loss, B-2 pre-push
  ignoring pushed refs, B-3 rename commits payload) are policy/state-machine bugs.
  Neither type system prevents them; tests and a simpler design do.

### 4.2 Filesystem edge cases [V/I]

| Need | Node | Rust |
| --- | --- | --- |
| Create-only local write (`O_EXCL`) | `fs.open(path, 'wx')` / `constants.O_EXCL` [V] | `OpenOptions::create_new(true)` |
| Atomic replace | `rename` (blobsy already does temp+verify+rename [V `transfer.ts:394`]); `atomically` for small files | `fs::rename`; `tempfile::NamedTempFile::persist` |
| Reflink copy (local cache → worktree, X-3) | `fs.copyFile(src, dst, COPYFILE_FICLONE)` [V constant present] | `reflink-copy` crate (Gat uses it [V]) |
| Symlinks, exec bits, empty dirs (X-5) | `lstat`, `readlink`, `symlink`, `chmod` — all present; current code *skips* symlinks by choice [S] | same primitives |
| Windows paths/junctions, long paths | Node handles `\\?\` and junctions; symlink creation needs Developer Mode on Windows — identical for both | same |
| Signals / partial writes | both fine for a short-lived CLI |  |

No capability gap either way.
Rust’s `std::fs` is thinner (no built-in recursive copy, no FICLONE flag) but crates
fill it.

### 4.3 Concurrency safety [I]

Blobsy’s concurrency is “N parallel uploads” and “two `blobsy` processes on one repo”.
The first is trivially safe in Node (single-threaded event loop; no data races by
construction). The second is a lock-file problem in either language (Gat uses
`.gat/state/sync.lock` + SQLite [V]). Rust’s `Send`/`Sync` buys nothing here that the
design needs.

### 4.4 Supply chain [V]

|  | TypeScript (blobsy today) | Rust (blobsy-shaped stub) | Gat |
| --- | --- | --- | --- |
| Transitive production deps | **166 packages** (157 names), of which 94 are `@aws-sdk/*`/`@smithy/*`; 72 others | **276 crates** | 455 crates |
| On-disk | AWS SDK + Smithy 27 MB; `.pnpm` 201 MB incl. dev | `target/` several GB after a build |  |
| Known risk shape | npm postinstall scripts (blobsy allows only `esbuild`, `lefthook` to build [V root `package.json`]); typosquats; maintainer takeovers | build scripts (`build.rs`) and proc-macros run at compile time; `cargo-vet`/`cargo-deny` exist; crate churn is lower but audits are rarer |  |

Both trees are dominated by the cloud SDK. Dropping `@aws-sdk/*` for `opendal` would cut
the npm tree to ~75 packages but adds a native binary [I]. Neither language is clearly
safer; the remediation (lockfiles, pinned versions, `pnpm audit`/`cargo audit`, minimal
deps) is the same.

* * *

## 5. Development velocity and maintainability

- **Iteration loop [V]:** TS: `tsdown` build in seconds, `vitest --watch`, goldens in
  ~1–2 min. Rust: 4.6 min clean release build on 4 cores for a blobsy-shaped crate (13.5
  CPU-minutes), 1.6 s incremental for a trivial change; Gat’s full build was ~7 min [V].
  Debug builds and `cargo check` are faster, but integration tests that exercise the
  real binary (the golden style blobsy relies on) need the binary built.
  In a cloud agent sandbox that starts cold, the Rust first build is the single biggest
  per-session tax.
- **Primary contributors are the owner plus coding agents [I, from CLAUDE.md].** The
  evidence on agents writing Rust is thin but consistent: a 500-task repository-level
  Rust benchmark (Rust-SWE-bench, ICSE 2026) tops out at 21 % resolution, attributing
  failures to repository-wide comprehension and the type/trait system [S]; a 600-run
  13-language experiment with Claude Code found statically-typed languages slower per
  task and the only failures in them [S, weak evidence]. Agents are competent in both;
  the borrow checker adds a compile-fix loop per change that is cheap for small crates
  and expensive for a 150k-LOC one.
  For a ~10k-LOC CLI the difference is modest but nonzero.
- **Contributor pool [I]:** the owner’s other projects and tooling (tryscript, flowmark,
  tbd) are TS/Python; the git-adjacent CLI community (Gat, jj, Xet, Oxen, Lore) is Rust.
  A Rust blobsy would attract drive-by contributions from that community; a TS blobsy is
  easier for the owner’s existing ecosystem and for agents in Node-only sandboxes.
- **Library embedding [V/I]:** `dist/index.mjs` already exposes a JS API (imports in 131
  ms [V]). A Rust core would reach JS only through napi-rs (now v3 with wasm fallback
  [S]) — an extra 8-target build matrix for something no consumer has asked for.
  Xet ships Python (`pyo3`) and wasm bindings and an experimental napi example
  [V `attic/xet-core/Cargo.toml`] — that is the cost profile of a real multi-language
  core, and it is a team’s worth of work.
- **Maintainability of the current code** is a structure problem (two 2k-line files, 117
  output guards, duplicated dry-runs) that the Phase 1 reporter/plan-execute refactor
  fixes in place. A rewrite would *also* fix it, but by restarting.

* * *

## 6. Cost of switching

| Item | Estimate | Basis |
| --- | --- | --- |
| Core to port after Phase 1 (deletions S1–S3, derived keys S4, no merge base S5, reporter S6) | ≈5–6k LOC TS → ≈7–9k LOC Rust | 8.9k today minus ~400 dead, ~300 hidden commands, ~325 sync, ~150 config walk, ~300 doctor diet; Rust is typically 1.2–1.5× the line count for the same CLI [I] |
| Backends | 5 (local, S3 SDK, aws-cli, rclone, command); S10 may drop aws-cli | ~1.9k LOC; the spawn-based ones port mechanically; S3 needs multipart written by hand or OpenDAL |
| Mechanically portable | path containment, key derivation, TSV/YAML formats, externalize rules, spawn backends, threat-model rules | pure functions with goldens |
| Not mechanically portable | commander wiring + output formatting (now 117 guard sites — port *after* S6), zod schemas → serde types, `marked-terminal` docs rendering, hooks installer |  |
| Tests | 71 goldens carry over unchanged if output is byte-identical; 327 vitest tests: the ~200 that spawn the CLI can be re-pointed, the ~120 unit tests are rewritten | [V §3.4] |
| What you lose | `npx` zero-install (unless a wrapper package ships binaries), the in-process JS library, zod/yaml/marked ecosystem, sub-second iteration, the owner’s existing TS tooling |  |
| Risk | Windows parity (untested today in either language [S]), S3 multipart/retry edge cases re-learned, rclone/aws-cli quirks re-learned, a 2–6 week feature freeze during which Gat keeps moving | [I] |
| Calendar [I] | With agents: 3–6 weeks for parity on the post-Phase-1 core; +2–4 weeks for release engineering (8 targets, signing, installers) | Gat’s single maintainer produced 152k LOC in ~6 months, but with a far larger surface |

The cheapest moment to port is **after Phase 2** (formats and the entry loop are frozen
and spec’d, goldens rewritten for the new behaviour) and **before Phase 3** only if the
snapshot workload proves to need it.
Porting *before* Phase 1 means porting code that is about to be deleted.

* * *

## 7. Options against the roadmap

### A. Stay TS; npm + optional single binary (bun now, SEA later)

- Phase 0–1: unaffected; ships this month.
  Add the lazy-import fix to Phase 1 (it is a 1–2 day change that removes the only
  measurable “Node is slow” symptom).
- Phase 2: merge driver as a minimal-import entry (`blobsy merge-driver` resolving to a
  small module; ~40–120 ms).
  Fine.
- Phase 3: hash 1 s / pack 3 s / restore 5 s for 15k files [S]; shell out to `tar` or
  use node-tar; `node:zlib` zstd.
  Fine. 1M-file trees are I/O-bound in both languages.
- Distribution: npm (`npx`), plus `bun build --compile` artifacts for 6 targets attached
  to releases; SEA when Node 26’s `--build-sea` is LTS-stable.
  84 MB binaries.
- Risk: bun-compiled binary is a second runtime (Bun’s Node-compat); must run the golden
  suite against it in CI before advertising it.

### B. Full Rust rewrite

- **Before Phase 1:** rewrites 8.9k LOC of which half is being deleted; Gat-shaped
  parity takes months; Phase 0 safety fixes would be delayed or done twice.
  **No.**
- **After Phase 2:** port a ~5–6k-LOC spec’d core; goldens carry over.
  Gains: 10 ms startup, 11 MB RSS, 18–30 MB static binary, multi-thread zstd, BLAKE3 if
  wanted, `gix` for in-process git.
  Costs: §6. Worth it only if §8’s triggers fire.
- What it does *not* buy: the design properties the review says blobsy must win on
  (per-collection manifests, browsable storage, snapshots, agent UX). Gat is a
  cautionary example: 152k LOC and still no UC-3.

### C. Hybrid: Rust core via napi-rs, or a Rust helper binary for hot paths

- napi-rs core: the hot paths measured here are within 1.3× of Rust; the cost is an
  8-target native build matrix, a wasm fallback, and two languages in one 10k-LOC repo.
  For blobsy’s size this is the worst option — all of Rust’s build cost, little of its
  benefit, and it breaks `npx` on unsupported platforms [I].
- Helper binary for hash/walk/pack/merge-driver: same build matrix, plus a process
  boundary. If the only motivation is the merge driver’s startup, a minimal-import JS
  entry already solves it.
- The one hybrid worth considering is **`opendal` from npm** (prebuilt napi, 8
  platforms, released weekly [V]) to get in-process GCS/Azure conditional writes without
  rclone. That is a dependency choice inside option A, not a language change.

### D. TS now, language-neutral formats and tests so a port or second implementation is cheap

This is option A plus discipline, and it is what the round-9 review already asks for
("pin the entry format and `tree_id` definition as a normative appendix"). Concretely:

1. Normative spec for `.bref` 0.2, `.brefs` TSV (sorted bytewise, static header, no
   aggregates), `tree_id`, the snapshot layout (`data.tar.zst`, `manifest.tsv.zst`,
   `ref.yaml` written last with create-only PUT), key derivation `sha256/<hex>{suffix}`,
   and the receipt — each with **test vectors** (input bytes → expected hash/key/line)
   in a language-neutral fixture directory.
2. Deterministic tar: specify the exact tar flavour (POSIX ustar/pax, sorted entries,
   zeroed mtimes/uid/gid, symlink/exec handling) so a Rust or Go implementation produces
   the identical `tree_id` and archive.
3. Keep every behavioural test as a golden that runs `blobsy` from `$PATH`; keep unit
   tests to pure functions.
4. Keep `--json` output schemas versioned and documented; they are the agent contract
   and the port’s contract.

This is cheap now and makes option B a ~month decision later instead of a quarter.

* * *

## 8. Recommendation

**Choose A+D: stay in TypeScript, fix startup, ship a single-binary build next to npm,
and make the formats and tests language-neutral.**

### Decision rule

Switch to Rust (option B, after Phase 2) **iff at least one of these is measured to be
true** — not inferred, not “because competitors are Rust”:

1. **Performance:** after Phase 1 (hash cache wired, batching, lazy imports), a workload
   a real user runs is still more than 2× over a stated budget *and* a profile shows the
   runtime, not blobsy’s algorithm or I/O, at fault.
   Suggested budgets: `status`/`verify` on a 10k-entry manifest with a warm cache ≤ 1 s;
   `--version`/hook/merge-driver ≤ 150 ms; snapshot publish of a 15k-file/170 MB tree ≤
   10 s on a laptop; restore ≤ 10 s.
2. **Distribution:** evidence from users or agents that `npx`/Node ≥22 **and** a bun/SEA
   binary are both unacceptable in a target environment (e.g. a sandbox policy that
   forbids 80 MB binaries and lacks Node).
   Today every sandbox checked has Node 22+ [V/S].
3. **Capability:** a feature that needs in-process git (`gix`) or embedding in non-JS
   hosts (Python/Go SDKs) — i.e. blobsy becomes a library product, not a CLI.
4. **Security posture:** an npm-ecosystem incident makes the 166-package tree
   unacceptable to the owner’s users in a way a 276-crate tree would not — unlikely to
   be decisive, listed for completeness.

If none fires by the end of Phase 3, the question is settled in favour of TS for the
life of the project.

### Do now, regardless of language

1. **Lazy-load `@aws-sdk/*`, `marked-terminal`, and (if possible) `zod`** behind the
   commands that need them; add a CI budget test: `blobsy --version` < 200 ms and
   `status` on an empty repo < 250 ms.
   Expected: 560 ms → ~120 ms [V-derived].
2. **Give the merge driver and hooks their own minimal entry points** (no SDK, no YAML
   if the manifest is TSV) so Phase 2’s driver runs in ~40–100 ms.
3. **Spec the formats with test vectors** (option D items 1–2) before Phase 2 lands code
   that depends on them.
4. **Keep the golden suite CLI-only** and run it against both `node dist/cli.mjs` and
   the bun-compiled binary in CI once the latter exists; never let a test reach into TS
   internals for behaviour.
5. **Ship `bun build --compile` artifacts for linux/darwin × x64/arm64 (+ windows) as a
   release experiment**, keep npm as the primary channel, and document
   `npx blobsy@<version>` as the agent-recommended path.
   Revisit Node SEA once `--build-sea` ships in an LTS line and leaves “active
   development”.
6. **Loosen `engines` to the real floor** (`>=22.15.0` for zstd) and say so in the
   README; do not require 24.
7. **Decide the hash/pack performance question on its merits, not by language:** keep
   SHA-256 (interop); measure multi-threaded zstd need on real trees in Phase 3; if
   BLAKE3 for `tree_id` is ever wanted, the `blake3` npm package (napi + wasm fallback)
   exists.
8. **Consider `opendal` (npm) for native GCS/Azure conditional writes** in Phase 1’s
   `putIfAbsent`, as an alternative to vendor SDKs or the rclone exists-then-put
   fallback. Weigh its native-binary cost against the three-SDK alternative.

### Things that would change this recommendation [I]

- If the owner’s goal shifts from “simple CLI for agents” to “the Rust-native
  git-adjacent ecosystem” (jj integration deeper than merge-driver-free correctness, a
  `gix`-based `migrate import`, a shared core with a future server), Rust becomes the
  natural home and option B after Phase 2 is the plan.
- If a Phase-3 user needs 1M-file snapshots routinely on cold disks, neither language
  saves them; the design (package-grouped packs, range restore — already noted as v2)
  does.

* * *

## Appendix A. Measurement log

Scratch dir:
`/tmp/claude-0/-home-user-blobsy/0713c929-56bc-5939-ab24-7ac184df530b/scratchpad/lang/`

- `bench.sh N cmd…` — min/median/max wall time over N runs (`date +%s%N`), used for
  every startup number; `rss.py` — peak RSS via `RUSAGE_CHILDREN` (no `/usr/bin/time` in
  the container).
- `sha.mjs big1g.bin` — Node streamed vs buffered SHA-256 on a 1 GiB `/dev/urandom`
  file; `sha256sum` and `openssl speed -evp sha256` as references.
- `rsbench/` — Rust (`sha2` 0.10.9, `blake3` 1.8 mmap+rayon, `walkdir` 2.5, `tar` 0.4,
  `zstd` 0.13) release build; subcommands `sha`, `walk`, `walkhash`, `zst`, `tarzst`.
- `walk.mjs tree100k` — four Node walk strategies over a generated 100k-file tree
  (`tree100k/`, 396 MB on disk, 105 MB of file bytes); `echo 3 > drop_caches` before the
  first run (cold) then warm.
- `zst.mjs nm.tar out` — `node:zlib` zstd level 3 stream over a 179 MB tar of
  `/home/user/blobsy/node_modules`.
- `rsblobsy/` — blobsy-shaped Rust crate (aws-config, aws-sdk-s3, tokio, clap, serde,
  serde_yaml_ng, globset, sha2, zstd, tar, walkdir, tempfile): 276 crates in
  `Cargo.lock`; `cargo build --release` 4 m 36 s wall / 13 m 32 s user on 4 vCPU;
  incremental rebuild 1.6 s; binary 18.0 MB; `--version` 7 ms; 42 MB RSS.
- `bunout/blobsy-bun` —
  `bun build --compile --minify --target=bun-linux-x64 dist/cli.mjs`: 2.8 s, 83.9 MB,
  `status` works on `srepo/`.
- `srepo/` — scratch blobsy repo (local backend, one 300 KB tracked file) for `status`
  timing; `gatrepo/` — `gat init` repo for `gat status` timing (12 ms even when it fails
  to load config; `--version` 8 ms).
- Gat binary: `../gat-target/incremental/gat` (0.0.15, 29.4 MB, built earlier this
  session in 7 m 23 s); jj 0.46.0 static binary 31.4 MB from `../jjdl/x/jj`.
- Dependency counts: `pnpm ls --prod --depth Infinity` (670 lines; 166 unique
  name@version, 157 names, 72 non-AWS/Smithy);
  `du -sch node_modules/.pnpm/@aws-sdk* @smithy*` = 27 MB.
- Import timing: `imptime.mjs` (per-package `await import()` from `packages/blobsy`),
  and two throwaway scripts importing only the core set (with/without zod), each
  benchmarked with `bench.sh` and with `NODE_COMPILE_CACHE`.

Not measured (stated as inference): Windows behaviour; real S3/GCS/Azure throughput;
Node SEA build (needs Node ≥25.5 for `--build-sea`; container has 22.22); Deno compile;
multi-threaded zstd; napi-rs overhead.

## Appendix B. Sources consulted this session

- Node.js SEA docs (stability 1.1; `--build-sea` v25.5; `mainFormat: module`; VFS
  v26.9): https://nodejs.org/api/single-executable-applications.html
- Node release schedule (22/24/26/27 dates; annual cadence from 27):
  https://github.com/nodejs/release
- Bun executables (`--target` cross-compile list):
  https://bun.com/docs/bundler/executables
- cargo-dist releases (0.33.1, 2026-10-21):
  https://github.com/axodotdev/cargo-dist/releases
- `object_store` `PutMode::Create` (0.14.2):
  https://docs.rs/object_store/latest/object_store/enum.PutMode.html
- `aws-sdk-s3` `PutObjectFluentBuilder::if_none_match` (1.154.0):
  https://docs.rs/aws-sdk-s3/latest/
- `opendal` on npm (0.49.13, 2026-10-18, 8 platform packages): `npm view opendal`
- Claude Code installation (native binary; npm wrapper with per-platform optional deps;
  Node 22+ for npm route only):
  https://code.claude.com/docs/en/getting-started/installation
- Codex CLI Rust rewrite shipped via npm/Homebrew:
  https://www.devclass.com/ai-ml/2025/06/02/nodejs-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/1619589
  and https://simonwillison.net/2025/Aug/11/codex-upgrade/
- GitHub runner-images ubuntu-24.04 (Node 22.23 / 24.19 cached):
  https://github.com/actions/runner-images/releases
- esbuild/pnpm optionalDependencies pattern and `supportedArchitectures`:
  https://github.com/pnpm/pnpm/issues/5965
- napi-rs v3 (wasm fallback, per-target packages): https://napi.rs/blog/announce-v3
- serde_yaml archived; RUSTSEC-2025-0068 on serde_yml; alternatives:
  https://rustsec.org/advisories/RUSTSEC-2025-0068
- Rust-SWE-bench (ICSE 2026; best agent 21.2 %): https://arxiv.org/abs/2602.22764
- 13-language Claude Code experiment (600 runs):
  https://byteiota.com/ruby-beats-rust-33-ai-coding-language-benchmark-2026/
- In-repo: `docs/project/research/current/research-2026-10-22-competitor-gat.md` (§2,
  §12), `…-large-file-tools-landscape-refresh.md` (single-binary norm), scratchpad
  sub-reviews `fable-complexity-review.md` (§1, §4, §5), `fable-uc3-uc5-review.md`
  (§1.2), `fable-uc2-review.md` (§2.3).
