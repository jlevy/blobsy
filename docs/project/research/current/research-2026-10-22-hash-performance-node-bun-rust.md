# Research: Hash Performance — Node vs Bun vs Rust, SHA-256 vs BLAKE3

**Date:** 2026-10-22

**Author:** Claude (round 9 follow-up), measured in the review session

**Status:** Complete for one machine; cross-hardware runs still needed (see Open
questions)

## Question

How fast can blobsy hash content in each runtime (Node, Bun, Rust)?
And how much does the hash choice (SHA-256 vs BLAKE3) matter compared with the runtime
choice?

## Setup

- **Machine:** an Intel cloud VM with 4 vCPUs, AVX2 and AVX-512, and **no SHA-NI**
  (`/proc/cpuinfo`: no `sha_ni` flag), so SHA-256 runs in software.
- **Runtimes:** Node v22.22.0, Bun 1.4.2, Rust 1.97 (`--release`).
- **Input:** one 1 GiB random file, read from the page cache.
  Every number is the better of two runs.
  `cat` reads the file in 0.16 s, so I/O is not the limit.
- **Libraries:**
  - Node/Bun SHA-256: built-in `node:crypto` (OpenSSL in Node, BoringSSL in Bun);
    `Bun.CryptoHasher`.
  - Node/Bun BLAKE3: `@napi-rs/blake-hash` 1.4.0 (a native addon; Rust `blake3` behind
    N-API; 14 prebuilt platforms), and `hash-wasm` 4.12.0 (WASM).
  - Rust: `ring` 0.17 SHA-256, `sha2` 0.10 with the `asm` feature, and `blake3` 1.x
    (single-thread streaming, and `update_mmap_rayon` across all cores).
- **Scripts:** session scratchpad `hashbench/` (`bench.mjs`, `bunbench.mjs`,
  `bunnative.mjs`, `bigread.mjs`, `rs/src/main.rs`).

## Results

### File hashing, 1 GiB, MB/s (higher is better)

| Hash | Node 22 | Bun 1.4 | Rust | Notes |
| --- | --- | --- | --- | --- |
| SHA-256, `fs.readSync` 1 MB reads | **337** | 283 | — |  |
| SHA-256, `createReadStream` | 330 | 279 | — |  |
| SHA-256, `Bun.CryptoHasher` + `Bun.file().stream()` | — | 262 | — |  |
| SHA-256, `ring` | — | — | **315** |  |
| SHA-256, `sha2` (asm) | — | — | 209 |  |
| SHA-256, `sha256sum` (coreutils) | — | — | — | ~330 MB/s (3.1 s) |
| BLAKE3 native, `fs.readSync` 1 MB reads | **2,851** | **2,733** | — |  |
| BLAKE3 native, `createReadStream` | 2,340 | 1,118 | — | Bun’s `node:fs` streams deliver small chunks |
| BLAKE3 native, `Bun.file().stream()` | — | 730 | — | worst: many small N-API calls |
| BLAKE3, Rust single-thread stream | — | — | **2,953** |  |
| BLAKE3, Rust mmap + rayon (4 cores) | — | — | **11,873** | multi-core inside one file |
| BLAKE3 WASM (`hash-wasm`) | 465 | 213 | — |  |

In memory (256 MB–1 GiB buffer): native BLAKE3 ran at 4.5 GB/s in both Node and Bun, and
SHA-256 at 300–340 MB/s in both.

### What the numbers say

1. **The hash matters far more than the runtime.** Native BLAKE3 is **~8.5× faster**
   than SHA-256 per file in every runtime on this CPU (2.85 GB/s vs 337 MB/s in Node).
2. **For SHA-256, runtime choice is irrelevant.** Node, Bun, Rust `ring` and coreutils
   all land at 280–340 MB/s, because they all use hand-written assembly.
   Rust’s `sha2` was slower than Node.
3. **For single-threaded BLAKE3, Node and Bun match Rust** (2.7–2.85 vs 2.95 GB/s). That
   only holds with large direct reads (`fs.readSync` / `fs.read` into a 1 MB buffer).
   The I/O pattern matters more than the language:
   - Node’s `createReadStream`: −20%.
   - Bun’s `node:fs` streams: −60%.
   - Bun’s `Bun.file().stream()`: −75%. It delivers small chunks, and each one crosses
     into the native addon separately.
4. **Rust’s real advantage is multi-core hashing *within* one file:** 11.9 GB/s on 4
   cores, about 4× single-thread.
   - This only matters for single very large files on storage faster than ~3 GB/s.
     Otherwise the disk is the limit.
   - It is reachable from JS only if the addon exposes a parallel API.
     `@napi-rs/blake-hash` doesn’t appear to; not verified.
   - For many-file workloads (collections, snapshots), JS can parallelize *across* files
     with `worker_threads` or a native thread pool.
     That closes most of the gap.
5. **WASM BLAKE3 is not worth it.** At 1.4× SHA-256 in Node and 0.75× in Bun, it is only
   useful as a fallback when the native addon can’t load.

## Implications for blobsy

- **The hash choice (decision D15 / plan K3) is real:** an ~8× speedup on hardware
  without SHA-NI, which is common on cloud VMs and CI runners like this one.
  With SHA-NI the gap should narrow; OpenSSL SHA-256 reaches roughly 1.5–2 GB/s per core
  on recent Apple, AMD and Intel CPUs [I, not measured here]. This needs measuring on
  that hardware before deciding.
- **The language choice is not decided by hashing.** With native BLAKE3 and large reads,
  a TypeScript CLI hashes at Rust’s single-thread speed.
  That reinforces round 9 §7.4: stay TypeScript.
  Rust would add only in-file multi-core hashing.
- **Do now, whatever the hash:**
  - read files with `fs.read` into 1 MB buffers, not `createReadStream`;
  - parallelize hashing across files (a bounded pool of worker threads);
  - wire the stat/hash cache, so unchanged files are never re-hashed.
- **Bun single-binary builds** (round 9 §7.4):
  - Hash through `node:fs` `read` with large buffers, never `Bun.file().stream()`.
  - The native addon loads fine in Bun.
  - Check that `bun build --compile` embeds the `.node` addon on each platform
    [I, not tested].

## Open questions

- Repeat on Apple M-series (ARMv8 SHA2 extensions), AMD Zen (SHA-NI), AWS Graviton, and
  a GitHub-hosted runner.
  Decision rule from the plan: adopt BLAKE3 if it is ≥3× faster on at least two of the
  four.
- Does `@napi-rs/blake-hash` expose multi-threaded hashing?
  If not, is a small napi-rs binding over `blake3::Hasher::update_rayon` worth
  maintaining?
- Is the native addon embedded correctly by `bun build --compile`, and by Node SEA?

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
