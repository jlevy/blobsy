# Blobsy Threat Model (V1)

**Status:** Active — normative for alpha

This is the trust-boundary reference the round 7 review found missing (finding SEC-03;
design weakness 7). It states who controls each input blobsy consumes and what blobsy is
allowed to do with it.
Every command’s implementation must respect these boundaries; new features should be
checked against this table before merging.

## Inputs and who controls them

| Input | Controlled by | Trust level |
| --- | --- | --- |
| CLI arguments and flags | The local user (or their agent) | Trusted intent, untrusted *values* (paths are validated) |
| `~/.blobsy.yml` (user-global config) | The local user | Trusted |
| `.blobsy.yml` (repo config) | Anyone who can commit to the repo | **Untrusted** |
| `.bref` files | Anyone who can commit to the repo | **Untrusted** |
| Blob bytes fetched from a backend | Anyone with write access to the backend | **Untrusted** until hash-verified |
| Backend credentials | The local user’s environment | Trusted, never written to the repo |
| Git hooks in `.git/hooks` | Mixed: user-owned or blobsy-managed | Blobsy touches only files carrying its exact managed marker |

## Rules

1. **Repository content never chooses an executable without an out-of-repo grant.** A
   committed `.blobsy.yml` can request a command backend, but blobsy refuses to run it
   unless the user granted trust outside the repo: `trust_command_backends` in
   `~/.blobsy.yml` (either `true` or a list of repo paths), or
   `BLOBSY_TRUST_COMMAND_BACKEND=1` in the environment (intended for CI). This applies
   everywhere backends are created, including hooks, `sync`, and `doctor` — an agent
   running `blobsy sync` in a fresh clone must never execute repo-supplied commands.
   Command templates additionally expand per-token with a strict character allowlist and
   execute without a shell (no metacharacter injection).
2. **`remote_key` never escapes the backend.** `.bref` files arrive via git from other
   contributors; a key like `../../x` must not reach read, write, or delete outside the
   configured backend location (local backend resolves and verifies containment; cloud
   backends treat the key as an opaque object name).
3. **User-supplied paths never escape the repository.** Every path-taking command
   resolves through `resolveRepoPath()`, which follows symlinks and refuses paths
   outside the repo root — “the caller typed it” is not a safety boundary when the
   caller is an agent assembling paths.
4. **Pulled bytes are hash-verified before they replace anything.** Blobs are downloaded
   to a temp file, verified against the `.bref` sha256, then atomically renamed into
   place. A backend (or attacker with backend write access) can deny service but cannot
   substitute content undetected.
5. **Hooks are only rewritten or deleted when blobsy owns them**, identified by the
   exact `# Installed by: blobsy hooks install` marker.
   User hooks — including ones that call blobsy among other commands — are never
   modified. `--no-hooks` and `BLOBSY_NO_HOOKS` opt out of installation.
6. **Remote objects are immutable under normal operations.** Once a `remote_key` is
   published, no normal command overwrites or deletes it; deletion exists only as
   `rm --remote --force` emergency plumbing, clearly labeled history-breaking, until
   reachability-aware GC exists.
7. **`--quiet` and `--json` never change a safety decision.** They affect output, not
   behavior.

## Non-goals (V1)

- Defending against a malicious local user: blobsy runs with the user’s own privileges
  and credentials.
- Confidentiality of blob contents: encryption at rest is the backend’s job (or a V2
  feature).
- Protecting against a compromised backend serving stale-but-valid blobs (rollback
  attacks): the `.bref` hash pins content, not freshness.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
