# Senior Engineering Review: Blobsy Design V2

**Date:** 2026-02-20 **Reviewer:** Gemini 3.1 Pro

## High-Level Assessment

The architectural shift to a per-file `.bref` model (Git as the manifest) is an elegant,
robust solution. By eliminating centralized manifests and delegating conflict resolution
entirely to Git, you remove the most complex edge cases of bidirectional sync.
The decision to use external tools (like `rclone` or `aws-cli`) as dumb transfer engines
while Blobsy handles the state and hashing is pragmatic and highly scalable.

However, there are two critical logical flaws in the current state model that will lead
to data loss or repository corruption if not addressed before V1.

* * *

## Critical Risk 1: The `git pull` vs. Local Edit “Split-Brain” (Data Loss Risk)

The **File State Model** and `blobsy sync` algorithm have a race condition regarding how
“locally modified” files are detected.

**The Scenario:**
1. User A modifies `model.bin`, runs `blobsy sync` (pushes blob, updates `.bref`), and
   pushes to Git.
2. User B runs `git pull`. Git updates `model.bin.bref` in User B’s working tree to User
   A’s new hash. However, Git *ignores* `model.bin`, so User B’s local `model.bin` is
   still the old file.
3. User B runs `blobsy sync`.
4. According to the design: *“Algorithm for each `.bref`… 7. If local differs from ref:
   update ref, then push (combined track + push).”*

**The Result:** Blobsy sees that User B’s local `model.bin` hash differs from the new
`.bref` hash. It incorrectly assumes User B has *modified* the file locally.
It overwrites User A’s `.bref` with the old hash and pushes the old data back to the
remote. User A’s changes are effectively reverted.

**The Fix:** You must use the **Stat Cache** as the baseline to distinguish between a
user edit and a Git update.
* If `local_mtime` **matches** the stat cache: The user hasn’t touched the file.
  If the `.bref` hash differs from the stat cache hash, it means Git updated the `.bref`
  underneath us. **Action:** Pull the new blob to update the local file.
* If `local_mtime` **differs** from the stat cache: The user edited the file.
  **Action:** Hash the new file, update `.bref`, and push.

* * *

## Critical Risk 2: Timestamp Layout “Age-Based Cleanup” (Repo Corruption Risk)

**→ blobsy-3si4: Remove/revise dangerous ‘age-based cleanup’ guidance for timestamp
layout**

In **Pattern 1: Timestamp + Content Hash (Default)**, you list “Age-based cleanup: Easy
to delete blobs older than N days” as a pro.
This is highly dangerous and will corrupt repositories.

**The Scenario:**
1. A 10GB `dataset.parquet` is pushed on Jan 1st. It gets a prefix like `20260101T...`.
2. The dataset is never modified, so it remains in `main` for the entire year, still
   pointing to the `20260101T...` remote key.
3. On June 1st, an admin deletes all `202601*` prefixes to “clean up old blobs.”

**The Result:** The live `main` branch is now broken because its `.bref` points to a
deleted blob. Age of the *blob creation* does not equal age of the *reference*.

**The Fix:** Remove the claim that age-based prefix cleanup is safe.
If you want safe GC, you must rely on the `blobsy gc` approach (scanning all reachable
Git commits for active `.bref` keys), making pure CAS (`Pattern 2`) or Branch-Isolated
(`Pattern 3`) safer defaults since they don’t tempt admins into performing naive
prefix-based `rm -rf`.

* * *

## Architecture & Design Feedback

**1. Atomic Writes & Transport Delegation** The research document highlights how
critical atomic writes (`temp-then-rename`) are for interrupted pulls.
The design appropriately mandates this for the built-in SDK. However, for the `command`
backend (e.g., `curl` or `scp`), users might easily write templates that stream directly
to `{local}`, leading to corruption on interrupt.
*Recommendation:* Blobsy should abstract the temp-file creation even for `command`
backends. The template should write to an environment variable like `$BLOBSY_TEMP_OUT`,
and Blobsy performs the atomic rename upon a `0` exit code.

**2. Symlinks vs Eager Caching** The research notes Hugging Face’s use of a global
`~/.cache/` with symlinks to avoid duplicating large files across different local repos.
V2 opts for eager caching (downloading directly into the working directory).
*Recommendation:* This is the right tradeoff for V1 simplicity.
Symlinks introduce massive cross-platform headaches (especially on Windows) and break
some archiving tools.
Stick with eager materialization.

**3. Cross-Platform Command Execution** The `command` backend allows executing arbitrary
shells. Node’s `child_process` handles shell execution very differently on Windows
(`cmd.exe`) vs Unix (`/bin/sh`). *Recommendation:* Explicitly document that `command`
backends should avoid complex shell pipes or operators if they are meant to be
cross-platform, or recommend using the named tools (`aws-cli`, `rclone`) for teams with
mixed OS environments.

**→ blobsy-qk6f: Document command backend cross-platform limitations**

**4. The `.blobsy/trash/` Paper Trail** Moving untracked refs to a trash folder is a
clever way to bound the search space for `blobsy gc` without needing to walk the entire
Git reflog to find orphaned blobs.

**→ blobsy-76b0: Defer trash command to V2, keep only rm in V1** **→ blobsy-07e5: V2:
Document trash/GC optimization pattern**

* * *

## Summary

The V2 design is a massive improvement over V1. The delegation of concerns is exactly
right: Git handles manifests/conflicts, CLI tools handle transport, and Node.js handles
compression.

If you patch the split-brain state detection logic using the stat cache, and revise the
guidance on timestamp-based deletion, the architecture is structurally sound and ready
for implementation.
