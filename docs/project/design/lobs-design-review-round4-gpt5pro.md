I’m going to (1) order the remaining Round‑3 items by dependency so you don’t thrash the
spec, (2) give you a “paste‑into‑Jira” checklist of concrete doc edits, and (3) call out
the few genuinely big design decisions with the key tradeoffs and decisions needed.

## Recommended incorporation sequence (minimize rewrites)

This is the order I’d have the team update the **design doc** (and where needed,
add/adjust tickets), because later items depend on earlier semantics.

1. **Lock the V1 product promise for versioning + deletions** *Tickets:* `lobs-cx82`,
   `lobs-05j8` Why first: it touches **Versioning**, **Sync semantics**, **Corner
   cases**, and multiple examples, and it currently contradicts itself in a few places.

2. **Finalize directory identity in Git (manifest digest in pointer)** *Ticket:*
   `lobs-mlv9` Why next: it simplifies conflict detection (no “ETag since last pull”
   state needed), makes diffs/merges meaningful, and is a prerequisite for clean
   “promotion” and “check-remote” flows.

3. **Define the branch merge/promotion contract + CI guardrail** *Ticket:* `lobs-a64l`
   (and I strongly recommend adding a dedicated ticket for `lobs check-remote` if it’s
   not already tracked) Why next: without an explicit promotion story, `branch` mode
   breaks normal PR merges (pointer lands on `main`, data stays under
   `branches/feature-x`).

4. **Lock down compression + transfer mechanics** *Ticket:* `lobs-lsu9` Why next: you
   can’t simultaneously promise “per-file compression, user never sees compressed bytes
   locally” *and* “delegate directory sync to aws s3 sync/rclone sync” without
   specifying staging vs orchestration.
   This is the biggest “implementation trap” left.

5. **Decide single-file conflict detection scope** *Ticket:* `lobs-7h13` Why next: the
   doc currently references a “remote hash Z” without a concrete portable retrieval
   mechanism; either add metadata/sidecar or remove from V1.

6. **Security trust model for repo configs** *Ticket:* `lobs-vj6p` Why next: it affects
   what config is allowed in `.lobs/config.yml`, what needs an explicit trust step, and
   which examples are safe to keep.

7. **Atomic writes + temp cleanup story** *Ticket:* `lobs-rel2` Why next: it’s an
   implementation detail, but the spec needs to state the invariants and how temp files
   are handled, especially for built-in SDK downloads.

8. **P1 polish and correctness completion** *Tickets:* `lobs-u4cs`, `lobs-y72s`,
   `lobs-q2dd` (+ optional: “status offline vs online”, “ns ls sizes”) Why last: these
   don’t reshape the core semantics, but they prevent footguns and improve ship quality.

* * *

## Quick, actionable doc fixes (do immediately; mostly search/replace + small section edits)

These are “doc-only edits” you can hand to someone and they can update the spec quickly.

### A) Remove current contradictions (direct edits to existing text)

* **Fix the time-travel / restore-old-version claim** in *Versioning and Branch
  Lifecycle* (currently says you can checkout an old pointer and pull because “namespace
  still contains data” and “never deletes remote objects”).

  * Replace with language consistent with whichever choice you make in `lobs-cx82`:

    * If “latest mirror”: explicitly state old commits are **not guaranteed**
      retrievable unless using `version` mode or backend bucket versioning.
    * If “immutable snapshots”: explicitly state pointers reference immutable snapshot
      IDs and are retrievable.
      *(This is currently a correctness bug in the doc, not just a “to decide” note.)*

* **Resolve the delete contradiction** in *Sync Semantics → Push (Directories with
  manifest)*: step “remove deleted files from remote” conflicts with “never deletes
  remote objects” elsewhere.

  * Make the default non-destructive and require explicit flags (details below).

* **Remove or gate “remote hash Z” language** in *Conflict Detection (Single files)*
  until there is a real mechanism.

  * Either: delete the `Z` comparison entirely for V1, or define metadata/sidecar
    precisely.

### B) Make directory pointers meaningful in Git (schema + examples)

* Update the **Directory pointer** example to include:

  * `manifest_sha256: <64-lower-hex>`
  * (optional but recommended) `file_count`, `total_size`
  * Keep stable key ordering promise.

* Update all **example sessions and scenarios** that currently say “pointer timestamp
  changes on push” so they instead say “pointer `manifest_sha256` changes (and updated
  timestamp changes)”.

  * This is especially important for Scenario 2 (directory) and Scenario 5 (branch
    lifecycle).

### C) Tighten the “promotion after merge” story in the scenarios

* In Scenario 5 (“Branch Lifecycle”), add an explicit, named step after merge:

  * Either “**Promote** the feature namespace to main” (preferred), or “Push on main to
    republish data” (fallback).

* Add a short callout box:

  * “In `branch` mode: merging pointer changes into `main` does **not** automatically
    move data. You must promote/publish.”

### D) Clarify where delegated `sync` is actually used

* In *Transfer Delegation*, replace the blanket line “aws s3 sync/rclone sync handle
  incremental directory transfers” with conditional wording:

  * delegated `sync` is only valid when local/remote representations match (e.g., **no
    per-file compression mapping**)
  * and/or only in `manifest: false` mode (if that’s the design you choose).

### E) Add one “Safety & Trust” section (even if brief)

* Add a dedicated section titled something like **Security & Trust Model**:

  * repo config is untrusted by default
  * `command` backend and `compression: command` require explicit trust / only allowed
    in user config
  * describe the UX: error with clear message, how to override (`lobs trust`, or
    `--allow-unsafe-config`) This is critical for adoption (supply-chain safety).

* * *

## Medium-sized fixes (still doc work, but needs careful spec wording)

These are “medium” because they touch multiple sections and must be internally
consistent, but they don’t require a full architectural pivot.

### 1) Define explicit prune flags and defaults (`lobs-05j8`)

Make the behavior unambiguous and safe:

* **Default `push`**: does **not** delete remote objects.

  * For directory manifests: deleted local files are removed from the *new manifest* (so
    they no longer materialize on future pulls), but remote blobs are left unless
    pruning is enabled.

* **Default `pull`**: does **not** delete local files.

* Add explicit flags:

  * `lobs push --prune-remote` (delete remote keys that were present in previous
    manifest but are absent in new manifest)
  * `lobs pull --prune-local` (delete local files absent from manifest)

* Update “Bidirectional sync is deferred” language to point to these flags as the reason
  it’s deferred.

### 2) Replace “ETag since last pull” directory conflict check with pointer-based logic (enabled by `manifest_sha256`)

Once `manifest_sha256` is in the pointer:

* Specify directory push conflict detection as:

  * Fetch remote manifest
  * Compute its SHA-256 (over canonical bytes)
  * If remote manifest SHA-256 ≠ pointer `manifest_sha256`, fail with exit code 2
    (“remote advanced; pull/reconcile first”) This avoids needing to store “last seen
    ETag” locally and makes the spec portable across backends.

### 3) Add “check-remote” command spec (strongly recommended alongside `lobs-a64l`)

Round 3 calls out the “pointer committed but data not pushed” failure mode and suggests
a CI verifier. Add:

* `lobs check-remote [path...]` (or `lobs verify-remote`)

  * For files: confirm the expected remote object exists in the resolved namespace (and
    optionally has expected size; full hash verification is optional and can be
    expensive).
  * For dirs: confirm manifest exists; optionally confirm every referenced object
    exists.
  * Exit non-zero if missing.

* Document recommended CI usage:

  * After a PR merge (or before), ensure data exists in target namespace.

### 4) Atomic write invariants for built-in SDK (`lobs-rel2`)

Add explicit guarantees:

* built-in downloads must write `*.lobs-tmp-*` then rename atomically into place
* pointer files and stat-cache writes are atomic (temp+rename)
* define cleanup: on startup or `lobs clean` deletes orphaned temp files This aligns
  with the research: aws-cli and rclone already do this; the SDK does not.

### 5) Tool auto-detection robustness (`lobs-y72s`)

Update the `auto` spec from “installed?”
to “capable?”:

* Add capability check:

  * for aws-cli, something like head-bucket / endpoint reachability / auth sanity check
  * if fails, fall through to rclone, then built-in

* Add `lobs doctor` output contract (backend, endpoint, tool chosen + why, resolved
  namespace/prefix).

* * *

## Big design questions to prioritize (Round‑3 “ambiguous” items)

These are the ones where you need an explicit decision, because they change the shape of
the spec and the code.
I’m listing the key decision and what “done” looks like in the doc.

### 1) `lobs-cx82` — Versioning semantics: “latest mirror” vs “immutable snapshots”

**Decision to make:** What does the system promise when you checkout an old commit and
run `lobs pull`?

* **Option A (recommended for V1): latest mirror per namespace**

  * Remote keys are path-based and mutable; overwrites happen.

  * Old pointer checkout does **not** guarantee old bytes exist.

  * “History” comes from:

    * `namespace.mode: version` (treat versions as immutable by convention), or
    * backend bucket versioning (optional, backend-dependent).

  * **Doc changes required:** remove/replace all “time travel works” claims; make
    pruning behavior explicit and safe by default.

* **Option B: immutable snapshots (stronger Git-like semantics)**

  * Directory pointers reference `manifest_sha256` snapshot IDs; file pointers reference
    `sha256`.
  * Remote layout stores data under immutable keys (e.g.,
    `snapshots/<manifest_sha256>/...`), and namespaces become refs.
  * **Doc/code impact:** introduces snapshot storage + lifecycle/GC complexity; but
    gives true reproducibility.

**What I’d ship:** Option A in V1 (matches your “transparent path mirror” stance), but
explicitly reserve Option B as a V2 direction.

* * *

### 2) `lobs-lsu9` — Compression + transfer mechanics (staging vs file-by-file orchestration)

**Decision to make:** How do you reconcile “local uncompressed” with “remote compressed
objects” while still “delegating” transfers?

You need one consistent rule set:

* **Option 1: staging directory**

  * Push: compress into staging tree that mirrors remote representation, then run
    `aws s3 sync`/`rclone sync` from staging → remote
  * Pull: sync remote → staging, then decompress staging → working dir
  * Pros: fewer subprocess calls; uses battle-tested `sync`; simpler correctness story
    for transfers
  * Cons: requires disk overhead; staging cleanup; more moving parts

* **Option 2 (recommended): manifest-driven file-by-file orchestration**

  * With `manifest: true`, LOBS decides exactly which files to transfer and uses the
    tool as a **copy engine** (`cp`/`copy`) per object (parallelized).
  * With `manifest: false`, allow true delegated `sync`, but require `compression: none`
    (or explicitly say staging is required).
  * Pros: no staging disk overhead; spec is precise; consistent with “manifest is the
    coordination primitive”
  * Cons: needs batching/parallelization story (and may motivate s5cmd later)

Also, backing-store research strongly supports **client-side compression by file
extension** and avoiding HTTP `Content-Encoding` behaviors (GCS/R2 transcoding edge
cases), which is aligned with your `.zst` suffix approach.

**What “done” looks like in the doc:** a small matrix/table that says, for each combo of
`{manifest: true/false} × {compression: none/on}`, which transfer method is used and
which tools are supported.

* * *

### 3) `lobs-a64l` — Branch merge/promotion workflow

**Decision to make:** After a PR merges pointer changes from `feature-x` into `main`,
how do we ensure `branches/main/` has the data?

You need to explicitly choose the contract and tooling:

* **Contract (Round‑3 recommendation):** branch namespaces are workspaces; merged data
  must be promoted/published into the target branch namespace.

* **Mechanism choices:**

  * Add `lobs promote` / `lobs ns copy` (S3 server-side copy when possible)
  * Add `lobs check-remote` to enforce in CI
  * Ensure `lobs push` uploads missing remote objects even if local matches pointer
    (pointer unchanged)

**What I’d do for V1:** add `lobs promote` (or `ns copy`) + `lobs check-remote` spec,
and update Scenario 5 to show it.

* * *

### 4) `lobs-7h13` — Single-file remote conflict detection scope

**Decision to make:** Do you want the “X/Y/Z” conflict check in V1, and if so, how is Z
obtained?

* **Option A (recommended for V1): defer remote-hash conflict detection**

  * Remove the `remote hash = Z` logic from the doc for V1.

  * Rely on:

    * Git pointer merge conflicts for coordination
    * `pull` refusing to overwrite local modifications unless `--force`
    * (optionally) `check-remote` for “missing remote object” detection

  * Pros: portable and simple; avoids metadata inconsistencies across
    aws-cli/rclone/custom

  * Cons: fixed-namespace concurrent writers are “last write wins” unless teams
    coordinate

* **Option B: implement a portable remote digest mechanism**

  * Store SHA-256 as:

    * a sidecar object (portable across all backends), or
    * object metadata (backend/tool dependent and messy with multipart/ETag differences)

  * Pros: enables true remote-vs-pointer conflict detection without downloading data

  * Cons: must be fully specified and implemented consistently across transfer engines

**Key doc requirement if you keep it:** define exactly where that remote digest lives
and how it is fetched (HEAD/GET of sidecar).

* * *

### 5) `lobs-vj6p` — Security / trust model for command execution

**Decision to make:** Can `.lobs/config.yml` in a repo cause code execution by default?

Round‑3 recommendation is clear: **no**—require explicit trust or restrict to user
config.

**What “done” looks like in the doc:**

* Define which config keys are “unsafe” (`backend.type: command`,
  `compression.algorithm: command`, custom commands).
* Default behavior: refuse with an actionable error.
* Define `lobs trust` (or equivalent) and/or `--allow-unsafe-config`.

* * *

## Reconcile with your existing ticket list (what to tell the team)

Below is a clean mapping from your tickets to doc changes, in the same dependency order:

* **`lobs-cx82` (P0)** — Update *Versioning* section + remove time-travel claims unless
  you pick immutable snapshots; align all examples.
* **`lobs-05j8` (P0)** — Add `--prune-remote` / `--prune-local` flags; rewrite push step
  5 + any “never deletes” wording.
* **`lobs-mlv9` (P0)** — Add `manifest_sha256` (+ `file_count`, `total_size`) to
  directory pointer schema; update scenarios.
* **`lobs-a64l` (P0)** — Add promotion story + command (`lobs promote` / `ns copy`) +
  update Scenario 5; add CI verifier (`check-remote`).
* **`lobs-lsu9` (P0)** — Add the compression×manifest transfer matrix; specify staging
  vs orchestration.
* **`lobs-7h13` (P0)** — Either remove “remote hash Z” in Conflict Detection or fully
  specify sidecar/metadata design.
* **`lobs-vj6p` (P0)** — Add Security & Trust section; constrain repo config execution.
* **`lobs-rel2` (P0)** — Add atomic write invariants + cleanup story (built-in engine).
* **`lobs-u4cs` (P1)** — Add branch name sanitization spec to Namespace section.
* **`lobs-y72s` (P1)** — Expand `auto` tool selection with capability checks; add
  `lobs doctor` spec.
* **`lobs-q2dd` (P1)** — Make version mode strict (error if missing), add explicit
  cleanup (`lobs ns rm versions/<id>`).
* **`lobs-0itg` (P1 epic)** — stays as umbrella.

### Two “missing but high leverage” sub-tickets I’d add

* **(New) `lobs-check-remote` (P0/P1 depending on appetite):** CI/agent-friendly remote
  existence verification.
* **(New) `status --offline` / online semantics (P1):** make it explicit whether status
  fetches remote manifest or relies on local cache/pointer.

* * *

If you want, I can also give you a “search strings” checklist (exact phrases to grep for
in the doc) so someone can do a fast consistency sweep once these decisions land.
