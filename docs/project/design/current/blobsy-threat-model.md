# Blobsy Threat Model (v3)

**Status:** Normative for design v3 ([blobsy-design.md](blobsy-design.md)). Updated
2026-10-23; replaces the V1 threat model, which described v2 mechanisms (`remote_key`,
`rm --remote --force`).

This is the trust-boundary reference.
It states who controls each input blobsy consumes and what blobsy may do with it.
Every command must respect these boundaries, and new features are checked against this
table before merging.

## Inputs and who controls them

| Input | Controlled by | Trust level |
| --- | --- | --- |
| CLI arguments and flags | The local user (or their agent) | Trusted intent, untrusted *values* (paths are validated) |
| `git config blobsy.*` (global or repo-local) | The local user | Trusted |
| `.blobsy.yml` (project config) | Anyone who can commit to the repo | **Untrusted** |
| `.bref` files and `.gitattributes` | Anyone who can commit to the repo | **Untrusted** |
| Objects, archives and store manifests fetched from a backend | Anyone with write access to the backend | **Untrusted** until hash-verified, and archives are always extracted under hardening rules |
| `_blobsy/` store metadata | Anyone with write access to the backend | Untrusted; advisory only (capabilities, repo list) |
| Backend credentials | The local user’s environment | Trusted, never written to the repo |
| Hash cache, known logs and content cache under the git dir | This machine | Trusted local state. A `blobsy.cacheDir` shared with other users is untrusted, so materialization re-verifies. |
| Git hooks in the hooks directory | Mixed: user-owned or blobsy-managed | Blobsy touches only files carrying its exact managed marker |

## Rules

1. **Repository content never chooses an executable.**
   - A committed command backend runs only with an out-of-repo grant
     (`git config blobsy.trustCommandBackend`, or `BLOBSY_TRUST_COMMAND_BACKEND=1` in
     CI). This holds everywhere backends are created, including hooks and `doctor`.
   - Command templates expand per token with a strict allowlist and run without a shell.
   - `.gitattributes` can name the `blobsy` merge driver, but the driver command comes
     only from local git config written by `setup`.
   - `setup` refuses to install hooks into a `core.hooksPath` inside the working tree.
2. **Refs and manifests can’t address arbitrary keys.**
   - Keys are derived from validated lowercase hex hashes and a fixed layout.
   - Snapshot names are validated (`[A-Za-z0-9._-]` segments, no `..`, no reserved
     segments).
   - `local:` resolves and verifies containment; cloud keys are opaque names.
3. **User-supplied paths never escape the repository.** Every path-taking command
   resolves through one function that follows symlinks and refuses paths outside the
   repo root. `pull` never follows a symlink at a target path.
4. **Fetched bytes are verified before they replace anything.**
   - Objects are downloaded to a temp file, verified against the hash named in the ref
     (BLAKE3 or SHA-256), and renamed into place.
     Decompression is bounded by the recorded size.
   - Store manifests are verified by recomputing `tree_id`, and against the pin when
     there is one.
   - Archives are extracted into a temp directory without following symlinks.
     Absolute paths and `..` segments in paths or link targets are rejected, and
     symlinks are created only after every file is verified.
   - A backend writer can deny service but can’t substitute content undetected for
     pinned or git-referenced data.
5. **Unpinned caches trust their writers.** A cache snapshot restored by stanza or
   `--fallback` is whatever an authorized writer published (CVE-2025-36852 “CREEP”).
   Mitigations:
   - write segregation, so only trusted CI writes `snap/cache/`;
   - provenance lines in manifests;
   - the hardening of rule 4;
   - the restore guard, which never replaces a path holding git-tracked files or refs.
6. **Remote content is immutable under normal operation.**
   - Writes are create-only.
   - The only overwrite is `push --repair`, and only after proving the stored object
     doesn’t match its key.
   - The only deletes are `gc` (reachability-based, with the preconditions of design
     §16) and `gc --purge`, which writes a tombstone.
7. **Hooks are only rewritten or deleted when blobsy owns them**, identified by an exact
   marker line.
   - User hooks are never modified.
   - `--no-hooks` skips installation.
   - `BLOBSY_NO_HOOKS=1` disables installed blobsy hooks at runtime.
8. **Metadata derived from repo paths is sanitized** before it reaches the store (for
   example `Content-Disposition` filenames: quotes and control characters).
9. **`--quiet` and `--json` never change a safety decision.** They affect output, not
   behavior.

## Non-goals

- Defending against a malicious local user: blobsy runs with the user’s own privileges
  and credentials.
- Confidentiality of contents: encryption at rest is the backend’s job (SSE).
- Rollback attacks by a compromised backend serving old but valid snapshots under an
  unpinned name: pins and git-referenced hashes pin content, not freshness.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
