# Blobsy Testing Design

**Date:** 2026-02-21

**Status:** Draft

## Key Principles

1. **Tests are documentation.** Each tryscript golden test is a readable markdown file
   that shows exactly what blobsy does -- the commands a user types and the output they
   see. A new contributor can read the test files to learn the CLI without touching the
   source.

2. **Show everything, hide nothing.** Golden tests capture the full output of every
   command. No `grep`, no `jq`, no assertion on a single field.
   If blobsy’s output changes -- a status label, an error message, a field in JSON --
   the diff shows it. This catches regressions that narrow assertions miss entirely.

3. **One test replaces dozens.** A single end-to-end workflow scenario (init, track,
   push, clone, pull, verify) exercises every layer of the system in sequence.
   It replaces the equivalent of 30-50 narrow integration tests, with less code and
   better coverage of interactions between components.

4. **The echo backend makes internals visible.** By configuring a command backend that
   echos its transport calls, the golden test output includes the exact backend
   operations blobsy performed.
   This turns the transport layer into a transparent, testable surface without any
   test-specific code in the production path.

5. **Diffs are the test oracle.** When behavior changes intentionally, you run
   `tryscript run --update`, review the diff, and commit it.
   The diff is a precise, reviewable description of what changed.
   When behavior changes unintentionally, CI fails and the diff shows exactly what went
   wrong. No debugging needed -- the answer is in the output.

6. **Unstable fields are named, not ignored.** Timestamps, hashes, and temp paths are
   matched with named patterns (`[HASH]`, `[TIMESTAMP]`, `[TMPFILE]`) rather than broad
   wildcards. This keeps the tests strict: only fields that are genuinely
   non-deterministic are allowed to vary.

7. **Inspect the filesystem, not just the CLI.** After major operations, run
   `find . -not -path './.git/*' | sort` (or similar) and `cat` key files to show the
   exact filesystem state: what files exist, what was created, what was deleted.
   Blobsy’s behavior is defined by the files it creates and modifies, not just the
   messages it prints. The filesystem listing in the golden test catches unintended side
   effects -- leftover temp files, missing gitignore entries, unexpected directory
   structures.

8. **No test infrastructure in production code.** The echo backend is just a config
   file. The local backend is a real backend.
   The golden tests exercise the same code paths as production.
   There is no mock mode, no test flag, no conditional logic that diverges test behavior
   from real behavior.

## References

- **[tryscript](https://github.com/jlevy/tryscript)** -- Markdown-based CLI golden
  testing framework. Run `npx tryscript@latest docs` for full syntax reference (patterns,
  elisions, sandbox, config).
- **[Golden Testing Guidelines](https://github.com/jlevy/tbd)** -- Methodology for
  session-level golden testing (`tbd guidelines golden-testing-guidelines`). Covers
  transparent box testing, stable/unstable field classification, event modeling, and
  anti-patterns.
- **[blobsy-stat-cache-design.md](blobsy-stat-cache-design.md)** -- Stat cache design
  (referenced by stat cache unit tests below).
- **[blobsy-backend-and-transport-design.md](blobsy-backend-and-transport-design.md)**
  -- Backend types, transport delegation, error handling, health checks.
  Defines the error message format used in error golden tests.

## Testing Philosophy

### Two-Layer Testing Strategy

Blobsy uses two complementary testing approaches:

1. **Unit tests (vitest)** -- Isolated function-level tests for core logic: hashing, ref
   parsing, config merge, stat cache operations, path resolution.
   Fast, focused, no I/O beyond temp files.

2. **Golden tests (tryscript)** -- End-to-end CLI tests that capture complete command
   output in markdown files.
   These are the primary integration and regression tests.
   Every user-facing command is tested with full output capture, not narrow assertions.

The golden tests follow the “transparent box” approach from the golden testing
guidelines (see References above): capture broad state so that any change -- intentional
or accidental -- shows up in diffs.
This replaces the traditional approach of writing hundreds of narrow integration test
assertions.

### Three Backend Strategies for Testing

Golden tests use three different backend configurations, each serving a distinct
purpose:

1. **Local backend** (`type: local`) -- Full end-to-end testing against a real
   filesystem. Files are actually copied, hashes verified, stat cache updated.
   This tests the complete system behavior.
   Used for all workflow scenarios.

2. **Echo backend** (`type: command`) -- A command backend whose push/pull templates
   simply echo the command that would be executed, then perform a local copy.
   This makes the transport layer fully observable: every backend call appears in the
   golden test output, showing exactly what blobsy asked the transport to do.
   The only unstable field is the temp file path.
   Used for transport-layer visibility tests.

3. **Real cloud backends** (optional, nightly) -- Actual S3 or R2 tests with real
   credentials. Not run in CI on every PR. Used to catch SDK-level regressions.

### Coverage Strategy

Unit tests (vitest) and golden tests (tryscript) exercise different code paths.
Vitest covers core logic directly; tryscript covers the CLI entry points, argument
parsing, error formatting, and end-to-end flows.
Coverage is merged using tryscript’s `--merge-lcov` flag:

```bash
vitest run --coverage                                  # unit test coverage
tryscript run --coverage --merge-lcov coverage/lcov.info tests/golden/  # merge
```

Requires sourcemaps enabled in the tsdown build config.

## Stable vs. Unstable Field Classification

Every value in blobsy’s output must be classified.
Stable fields are compared exactly in golden tests.
Unstable fields are matched with tryscript elision patterns.

### Stable Fields (exact match)

- Command names and subcommands
- File relative paths (within test fixture)
- Exit codes
- Status symbols and labels (`ok`, `modified`, `not synced`, etc.)
- Hash values when using fixed test data with known content
- File sizes when using fixed test data
- Error categories (`authentication`, `network`, `permission`, etc.)
- Error resolution suggestions (troubleshooting text)
- `--json` output keys and structure
- `--help` text
- Config field names and default values
- `.yref` file content (format version, field names, key ordering)
- Echo backend command strings (except the temp file path)

### Unstable Fields (matched with patterns)

| Field | tryscript pattern | Example |
| --- | --- | --- |
| SHA-256 hashes (computed at runtime) | `[HASH]` | `sha256:e3b0c44298fc...` |
| Timestamps | `[TIMESTAMP]` | `2026-02-21T05:35:07Z` |
| Duration / timing | `[..]` | `Done in 1.2s` |
| Absolute paths (sandbox, temp dirs) | `[CWD]` | `/tmp/tryscript-xxx/` |
| Temp file paths in echo backend | `[TMPFILE]` | `/tmp/blobsy-dl-a8f3c2.tmp` |
| Remote keys with timestamps | `[REMOTE_KEY]` | `20260221T053507Z-abc123/data/model.bin` |

### Custom Patterns

Defined in tryscript config or per-file frontmatter:

```yaml
patterns:
  HASH: 'sha256:[0-9a-f]{64}'
  SHORT_HASH: '[0-9a-f]{12}'
  TIMESTAMP: '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?'
  REMOTE_KEY: '\d{8}T\d{6}Z-[0-9a-f]+/.+'
  TMPFILE: '/tmp/blobsy-[a-z]+-[0-9a-f]+\.tmp'
```

## The Echo Backend

The echo backend is a `command`-type backend that does two things on every transport
call:

1. **Echoes** the exact command blobsy constructed (bucket, remote key, local path).
2. **Copies** the file to a local `.mock-remote/` directory, creating a fully
   inspectable “remote” filesystem.

This gives golden tests two layers of visibility: the transport commands in stdout, and
the actual remote contents on disk via `find .mock-remote/`.

### Configuration

```yaml
# fixtures/echo-backend.blobsy.yml
backends:
  default:
    type: command
    push_command: >-
      echo "PUSH {local} -> {bucket}/{remote}" &&
      mkdir -p "$(dirname ./.mock-remote/{remote})" &&
      cp {local} ./.mock-remote/{remote}
    pull_command: >-
      echo "PULL {bucket}/{remote} -> {local}" &&
      cp ./.mock-remote/{remote} {local}
    bucket: test-bucket
    prefix: ""
```

### What It Reveals

With the echo backend, golden test output shows three things:

1. The exact transport command blobsy issued (via the `echo`).
2. The blobsy CLI output (status messages, warnings).
3. The remote filesystem state (via `find .mock-remote/`).

````markdown
```console
$ blobsy push data/model.bin
PUSH [TMPFILE] -> test-bucket/[REMOTE_KEY]
Pushed data/model.bin (13 B)
Updated data/model.bin.yref (remote_key set)
? 0
```

```console
$ find .mock-remote/ -type f | sort
.mock-remote/[REMOTE_KEY]
? 0
```

```console
$ cat .mock-remote/[REMOTE_KEY]
hello blobsy
? 0
```
````

The temp file path (`[TMPFILE]`) is the only unstable field.
The remote key structure, bucket name, and all other command parameters are stable and
compared exactly. Any change to how blobsy constructs backend commands shows up
immediately in the diff.

Since `.mock-remote/` is just a directory on disk, `find .mock-remote/ -type f | sort`
is the remote listing.
It shows exactly what blobs exist after each operation -- duplicate uploads, missing
blobs, wrong key paths, orphaned objects all become visible without any special tooling.

### When to Use Echo vs. Local Backend

- **Echo backend:** When you need to see the exact backend calls and inspect the remote
  filesystem. The echo output shows what blobsy asked for; `find .mock-remote/` shows
  what landed.
- **Local backend:** Full end-to-end behavior without transport-layer echo.
  The `remote/` directory is still inspectable via `find remote/`, but you don’t see the
  transport commands in the output.

Both backends produce a local directory that serves as the “remote.”
The difference is whether the transport commands are echoed.
Most workflow scenarios use the local backend.
Transport-specific tests use the echo backend.

## Golden Tests (tryscript)

### Test File Organization

```
tests/
  golden/
    tryscript.config.ts                    # Shared config (patterns, path, env)
    commands/
      init.tryscript.md                    # blobsy init
      track.tryscript.md                   # blobsy track (single, directory, idempotent)
      status.tryscript.md                  # blobsy status (all state combinations)
      push-pull.tryscript.md               # blobsy push / blobsy pull
      sync.tryscript.md                    # blobsy sync (push, pull, up-to-date, conflict)
      verify.tryscript.md                  # blobsy verify (ok, mismatch, missing)
      doctor.tryscript.md                  # blobsy doctor (diagnostics, --fix)
      rm.tryscript.md                      # blobsy rm (file, --local, --recursive)
      mv.tryscript.md                      # blobsy mv
      untrack.tryscript.md                 # blobsy untrack
      config.tryscript.md                  # blobsy config
      hooks.tryscript.md                   # Pre-commit hook behavior
      help.tryscript.md                    # --help for all commands
    json/
      status-json.tryscript.md             # blobsy status --json
      sync-json.tryscript.md               # blobsy sync --json
      verify-json.tryscript.md             # blobsy verify --json
      doctor-json.tryscript.md             # blobsy doctor --json
      push-pull-json.tryscript.md          # blobsy push/pull --json
    workflows/
      fresh-setup.tryscript.md             # init -> track -> push -> clone -> pull -> verify
      two-user-conflict.tryscript.md       # Conflict detection end-to-end
      modify-and-resync.tryscript.md       # Modify tracked file -> track -> push
      doctor-fix.tryscript.md              # Doctor diagnoses and repairs
      compression.tryscript.md             # Compression round-trip
      branch-workflow.tryscript.md         # Feature branch -> merge -> sync
      multi-file-sync.tryscript.md         # Many files, partial failures
    echo-backend/
      push-commands.tryscript.md           # Verify exact push command construction
      pull-commands.tryscript.md           # Verify exact pull command construction
      sync-commands.tryscript.md           # Verify sync issues correct push/pull calls
      compression-commands.tryscript.md    # Verify compression temp file handling
    errors/
      auth-errors.tryscript.md             # Missing/invalid/expired credentials
      permission-errors.tryscript.md       # Missing PutObject, GetObject
      not-found-errors.tryscript.md        # Bucket missing, blob missing
      network-errors.tryscript.md          # Timeout, DNS, connection refused
      conflict-errors.tryscript.md         # Three-way merge conflicts
      validation-errors.tryscript.md       # Malformed .yref, bad config, bad format version
      partial-failure.tryscript.md         # Some files succeed, some fail
    fixtures/
      small-file.txt                       # "hello blobsy\n" (known content, 13 B)
      another-file.txt                     # "second file\n" (known content, 12 B)
      binary-file.bin                      # Binary content for compression tests
      local-backend.blobsy.yml             # Config: type: local, path: ./remote
      echo-backend.blobsy.yml              # Config: type: command with echo
```

### Shared Config

```typescript
// tests/golden/tryscript.config.ts
import { defineConfig } from 'tryscript';

export default defineConfig({
  env: {
    NO_COLOR: '1',
    BLOBSY_NO_HOOKS: '1',
  },
  timeout: 10000,
  patterns: {
    HASH: 'sha256:[0-9a-f]{64}',
    SHORT_HASH: '[0-9a-f]{12}',
    TIMESTAMP: '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z?',
    REMOTE_KEY: '\\d{8}T\\d{6}Z-[0-9a-f]+/.+',
    TMPFILE: '/tmp/blobsy-[a-z]+-[0-9a-f]+\\.tmp',
  },
  path: ['$TRYSCRIPT_PACKAGE_BIN'],
});
```

### Fixture Files

The fixture `small-file.txt` contains exactly `hello blobsy\n` (13 bytes).
Because the content is fixed, its SHA-256 hash is deterministic and can be matched
exactly in golden tests when needed.
Most tests match with `[HASH]` for readability, but specific tests that verify hash
computation can use the literal value.

The fixture `local-backend.blobsy.yml`:

```yaml
backends:
  default:
    type: local
    path: ./remote
```

The fixture `echo-backend.blobsy.yml`:

```yaml
backends:
  default:
    type: command
    push_command: >-
      echo "PUSH {local} -> {bucket}/{remote}" &&
      mkdir -p "$(dirname ./.mock-remote/{remote})" &&
      cp {local} ./.mock-remote/{remote}
    pull_command: >-
      echo "PULL {bucket}/{remote} -> {local}" &&
      cp ./.mock-remote/{remote} {local}
    bucket: test-bucket
    prefix: ""
```

### Filesystem Inspection Convention

After operations that create, move, or delete files, golden tests include a filesystem
listing to show the exact state.
The standard command:

```bash
$ find . -not -path './.git/*' -not -name '.git' | sort
```

This shows every file and directory in the sandbox excluding `.git` internals.
The output is deterministic (sorted) and catches unintended side effects: leftover temp
files, missing gitignore entries, unexpected directories, files that should have been
deleted.

Scoped listings for specific areas:

```bash
$ find data/ -type f | sort              # working directory (tracked files + refs)
$ find .blobsy/ -type f | sort           # blobsy internals (stat cache entries)
$ find remote/ -type f | sort            # local backend remote store
$ find .mock-remote/ -type f | sort      # echo backend remote store
```

The remote listing (`find remote/` or `find .mock-remote/`) is particularly valuable
after push/pull operations -- it shows exactly what blobs exist in the “remote,”
catching duplicate uploads, missing blobs, and wrong key paths.

### Per-Command Golden Tests

Each command gets its own tryscript file that exercises all major cases with full output
capture.
No surgical extraction -- show the complete output and let diffs reveal changes.

#### `blobsy track`

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
---

# Filesystem before tracking

```console
$ find . -not -path './.git/*' -not -name '.git' | sort
.
./.blobsy.yml
./another-file.txt
./data
./data/model.bin
./small-file.txt
? 0
```

# Track a single file

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
? 0
```

# Filesystem after tracking -- shows new .yref, .gitignore, and .blobsy/ stat cache

```console
$ find . -not -path './.git/*' -not -name '.git' | sort
.
./.blobsy
./.blobsy/stat-cache
./.blobsy/stat-cache/[..]
./.blobsy.yml
./another-file.txt
./data
./data/.gitignore
./data/model.bin
./data/model.bin.yref
./small-file.txt
? 0
```

# Verify the ref file content

```console
$ cat data/model.bin.yref
# blobsy ref file -- do not edit manually.
# See: blobsy status, blobsy verify, blobsy --help
blobsy-yref/0.1:
  hash: [HASH]
  size: 13
? 0
```

# Verify gitignore was updated

```console
$ cat data/.gitignore
model.bin
? 0
```

# Track same file again (idempotent, unchanged)

```console
$ blobsy track data/model.bin
data/model.bin already tracked (unchanged)
? 0
```

# Modify the file and re-track

```console
$ echo "updated content for model" > data/model.bin
$ blobsy track data/model.bin
Updated data/model.bin.yref (hash changed)
? 0
```

# Verify updated ref

```console
$ cat data/model.bin.yref
# blobsy ref file -- do not edit manually.
# See: blobsy status, blobsy verify, blobsy --help
blobsy-yref/0.1:
  hash: [HASH]
  size: 26
? 0
```

# Track a directory

```console
$ mkdir -p data/research
$ cp small-file.txt data/research/report.bin
$ cp another-file.txt data/research/data.bin
$ blobsy track data/research/
Scanning data/research/...
  data/research/data.bin     (12 B)  -> tracked
  data/research/report.bin   (13 B)  -> tracked
2 files tracked.
? 0
```

# Filesystem after directory tracking -- each file gets its own .yref

```console
$ find data/ | sort
data/
data/.gitignore
data/model.bin
data/model.bin.yref
data/research
data/research/.gitignore
data/research/data.bin
data/research/data.bin.yref
data/research/report.bin
data/research/report.bin.yref
? 0
```

# Verify directory gitignore (per-directory, not global)

```console
$ cat data/research/.gitignore
data.bin
report.bin
? 0
```

# Track directory again (idempotent)

```console
$ blobsy track data/research/
Scanning data/research/...
  data/research/data.bin     (12 B)  -> already tracked (unchanged)
  data/research/report.bin   (13 B)  -> already tracked (unchanged)
0 files tracked, 2 unchanged.
? 0
```
````

#### `blobsy status`

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
---

# Status before tracking anything

```console
$ blobsy status
No tracked files.
? 0
```

# Status after tracking (uncommitted, not synced)

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
$ blobsy status
Tracked files (1):
  ○ data/model.bin (not committed, not synced)

Summary:
  1 needs push and commit (○)

Actions needed:
  Run 'blobsy push' to sync 1 file
  Run 'git add -A && git commit' to commit refs
? 0
```

# Status after commit (committed, not synced)

```console
$ git add -A && git commit -q -m "track model"
$ blobsy status
Tracked files (1):
  ◐ data/model.bin (committed, not synced)

Summary:
  1 needs push (◐)

Actions needed:
  Run 'blobsy push' to sync 1 file (◐)
? 0
```

# Status after push (synced but ref not committed)

```console
$ blobsy push data/model.bin
Pushing 1 file...
  ◑ data/model.bin (13 B) - pushed
Done: 1 pushed.
$ blobsy status
Tracked files (1):
  ◑ data/model.bin (not committed, synced)

Summary:
  1 needs commit (◑)

Actions needed:
  Run 'git add -A && git commit' to commit refs
? 0
```

# Status after committing the push (fully synced)

```console
$ git add -A && git commit -q -m "push model"
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

# Status with modified file

```console
$ echo "modified content" > data/model.bin
$ blobsy status
Tracked files (1):
  ~ data/model.bin (modified locally)

Summary:
  1 modified (~)

Actions needed:
  Run 'blobsy track data/model.bin' to update modified file
? 0
```

# Status with multiple files in various states

```console
$ blobsy track data/dataset.csv
Tracking data/dataset.csv
Created data/dataset.csv.yref
Added data/dataset.csv to .gitignore
$ blobsy status
Tracked files (2):
  ~ data/model.bin (modified locally)
  ○ data/dataset.csv (not committed, not synced)

Summary:
  1 modified (~)
  1 needs push and commit (○)

Actions needed:
  Run 'blobsy track data/model.bin' to update modified file
  Run 'blobsy push' to sync 1 file
  Run 'git add -A && git commit' to commit refs
? 0
```
````

#### `blobsy verify`

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
  cp small-file.txt data/weights.bin
  blobsy track data/model.bin
  blobsy track data/weights.bin
  git add -A && git commit -q -m "track files"
---

# Verify when all files match

```console
$ blobsy verify
Verifying 2 tracked files...
  data/model.bin     ok (sha256 matches)
  data/weights.bin   ok (sha256 matches)
2 ok, 0 mismatch, 0 missing.
? 0
```

# Verify with a modified file

```console
$ echo "corrupted" > data/model.bin
$ blobsy verify
Verifying 2 tracked files...
  data/model.bin     MISMATCH (expected [SHORT_HASH]..., got [SHORT_HASH]...)
  data/weights.bin   ok (sha256 matches)
1 ok, 1 mismatch, 0 missing.
? 1
```

# Verify with a missing file

```console
$ rm data/weights.bin
$ blobsy verify
Verifying 2 tracked files...
  data/model.bin     MISMATCH (expected [SHORT_HASH]..., got [SHORT_HASH]...)
  data/weights.bin   MISSING
0 ok, 1 mismatch, 1 missing.
? 1
```

# Verify a single file

```console
$ echo "hello blobsy" > data/model.bin
$ blobsy verify data/model.bin
Verifying 1 tracked file...
  data/model.bin   ok (sha256 matches)
1 ok, 0 mismatch, 0 missing.
? 0
```
````

#### `blobsy push` and `blobsy pull`

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---

# Remote store before any push

```console
$ find remote/ | sort
remote/
? 0
```

# Push a single file

```console
$ blobsy push data/model.bin
Pushing 1 file...
  ◑ data/model.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

# Remote store after push -- blob appears

```console
$ find remote/ -type f | sort
remote/[REMOTE_KEY]
? 0
```

# Push all tracked files

```console
$ blobsy push
Pushing 2 files...
  ◑ data/model.bin (13 B) - already synced
  ◑ data/dataset.csv (12 B) - pushed
Done: 1 pushed, 1 already synced.
? 0
```

# Remote store now has both blobs

```console
$ find remote/ -type f | sort
remote/[REMOTE_KEY]
remote/[REMOTE_KEY]
? 0
```

# Verify ref was updated with remote_key

```console
$ cat data/model.bin.yref
# blobsy ref file -- do not edit manually.
# See: blobsy status, blobsy verify, blobsy --help
blobsy-yref/0.1:
  hash: [HASH]
  size: 13
  remote_key: [REMOTE_KEY]
? 0
```

# Pull after deleting local file

```console
$ rm data/model.bin
$ find data/ -type f | sort
data/dataset.csv
data/dataset.csv.yref
data/model.bin.yref
? 0
```

```console
$ blobsy pull data/model.bin
Pulling 1 file...
  data/model.bin (13 B) - pulled
Done: 1 pulled.
? 0
```

# Verify pulled content and filesystem state

```console
$ cat data/model.bin
hello blobsy
$ find data/ -type f | sort
data/dataset.csv
data/dataset.csv.yref
data/model.bin
data/model.bin.yref
? 0
```

# Pull when file already matches

```console
$ blobsy pull data/model.bin
Pulling 1 file...
  data/model.bin (13 B) - already up to date
Done: 0 pulled, 1 already up to date.
? 0
```

# Push with uncommitted refs (warning)

```console
$ echo "new content" > data/model.bin
$ blobsy track data/model.bin
Updated data/model.bin.yref (hash changed)
$ blobsy push data/model.bin
Warning: Operating on 1 uncommitted .yref file:
  data/model.bin.yref (modified)

Pushing 1 file...
  ◑ data/model.bin (12 B) - pushed
Done: 1 pushed.

Reminder: Run 'git add -A && git commit' to commit these refs.
? 0
```
````

### Echo Backend Tests

These tests use the echo backend to verify the exact transport commands blobsy
constructs. The echo output appears directly in the golden test, making the transport
layer transparent.

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/echo-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data .mock-remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
---

# Push shows the exact backend command

```console
$ blobsy push data/model.bin
PUSH [TMPFILE] -> test-bucket/[REMOTE_KEY]
Pushed data/model.bin (13 B)
Updated data/model.bin.yref (remote_key set)
? 0
```

# Verify the blob landed in the remote store

```console
$ ls .mock-remote/
[..]
$ cat .mock-remote/[REMOTE_KEY]
hello blobsy
? 0
```

# Pull shows the exact backend command

```console
$ rm data/model.bin
$ blobsy pull data/model.bin
PULL test-bucket/[REMOTE_KEY] -> [TMPFILE]
Pulled data/model.bin (13 B)
? 0
```

# Verify pulled content

```console
$ cat data/model.bin
hello blobsy
? 0
```
````

### End-to-End Workflow Scenarios

These are multi-command sessions that exercise complete user flows against the local
backend.
Each session starts from a bare sandbox and builds up a full git repository with
blobsy tracking. A single workflow scenario replaces dozens of narrow integration tests.

#### Scenario 1: Fresh Setup Through Verify

Full lifecycle: git init, blobsy init, track files, push, simulate a second clone, pull,
verify integrity.

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
---

# Set up a git repository

```console
$ git init -q
$ mkdir -p data remote
? 0
```

# Initialize blobsy with local backend

```console
$ blobsy init --backend local --path ./remote
Created .blobsy.yml
Installed pre-commit hook (.git/hooks/pre-commit)
? 0
```

# Verify the generated config

```console
$ cat .blobsy.yml
backends:
  default:
    type: local
    path: ./remote
? 0
```

# Copy in test data and track

```console
$ cp small-file.txt data/model.bin
$ cp another-file.txt data/dataset.csv
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
$ blobsy track data/dataset.csv
Tracking data/dataset.csv
Created data/dataset.csv.yref
Added data/dataset.csv to .gitignore
? 0
```

# Check status before commit

```console
$ blobsy status
Tracked files (2):
  ○ data/dataset.csv (not committed, not synced)
  ○ data/model.bin (not committed, not synced)

Summary:
  2 need push and commit (○)

Actions needed:
  Run 'blobsy push' to sync 2 files
  Run 'git add -A && git commit' to commit refs
? 0
```

# Commit refs

```console
$ git add -A && git commit -q -m "Track data files with blobsy"
? 0
```

# Push to remote

```console
$ blobsy push
Pushing 2 files...
  ◑ data/dataset.csv (12 B) - pushed
  ◑ data/model.bin (13 B) - pushed
Done: 2 pushed.
? 0
```

# Commit the remote_key updates

```console
$ git add -A && git commit -q -m "Update remote keys after push"
? 0
```

# Verify fully synced status

```console
$ blobsy status
Tracked files (2):
  ✓ data/dataset.csv (committed and synced)
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

# Simulate a second user: clone the repo

```console
$ cd ..
$ mkdir clone && cd clone
$ git clone -q ../[CWD] .
? 0
```

# Second user: blobs are missing, refs are present

```console
$ cat data/model.bin.yref
# blobsy ref file -- do not edit manually.
# See: blobsy status, blobsy verify, blobsy --help
blobsy-yref/0.1:
  hash: [HASH]
  size: 13
  remote_key: [REMOTE_KEY]
$ test -f data/model.bin && echo "exists" || echo "missing"
missing
? 0
```

# Second user: pull all blobs

```console
$ blobsy pull
Pulling 2 files...
  data/dataset.csv (12 B) - pulled
  data/model.bin (13 B) - pulled
Done: 2 pulled.
? 0
```

# Verify integrity on second clone

```console
$ blobsy verify
Verifying 2 tracked files...
  data/dataset.csv   ok (sha256 matches)
  data/model.bin     ok (sha256 matches)
2 ok, 0 mismatch, 0 missing.
? 0
```

# Verify file contents match

```console
$ cat data/model.bin
hello blobsy
$ cat data/dataset.csv
second file
? 0
```
````

#### Scenario 2: Two-User Conflict Detection

Tests the critical race condition: User A modifies a tracked file locally.
Meanwhile, User B pushes a different version and User A does `git pull`, which updates
the `.yref`. Now User A’s local file, the `.yref`, and the stat cache all disagree.

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
  blobsy push
  git add -A && git commit -q -m "push model"
---

# Verify starting state: fully synced

```console
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

# User A modifies the file locally

```console
$ echo "user A version" > data/model.bin
? 0
```

# Simulate User B: push a different version via git
# (Manually update the .yref to simulate a git pull that brought B's changes)

```console
$ echo "user B version" > /tmp/userb.bin
$ HASH_B=$(sha256sum /tmp/userb.bin | cut -d' ' -f1)
$ blobsy track /tmp/userb.bin 2>/dev/null || true
? 0
```

# Now sync detects the conflict: local differs, ref differs, both changed since cache

```console
$ blobsy sync 2>&1
Syncing 1 tracked file...
  ✗ data/model.bin - CONFLICT

Error: Conflict detected for data/model.bin
  Local file has been modified (hash differs from stat cache)
  Ref file has been updated (hash differs from stat cache)
  These are independent changes that cannot be auto-merged.

Resolution options:
  Keep local:  blobsy push --force data/model.bin
  Keep remote: blobsy pull --force data/model.bin
  Compare:     diff <(blobsy cat-remote data/model.bin) data/model.bin

1 conflict. No files synced.
? 2
```

# Force-push to keep local version

```console
$ blobsy push --force data/model.bin
Pushing 1 file (force)...
  ◑ data/model.bin (15 B) - pushed (force)
Done: 1 pushed.
$ blobsy status
Tracked files (1):
  ◑ data/model.bin (not committed, synced)

Summary:
  1 needs commit (◑)

Actions needed:
  Run 'git add -A && git commit' to commit refs
? 0
```
````

#### Scenario 3: Doctor Diagnostics and Fix

Sets up various broken states and verifies doctor detects and repairs each one.

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
  blobsy push
  git add -A && git commit -q -m "push model"
---

# Doctor on healthy repo

```console
$ blobsy doctor

=== CONFIGURATION ===
Backend: local (path: ./remote)

=== REPOSITORY STATE ===
Git repository: [CWD]
Branch: main (clean working tree)

Tracked files: 1 total (13 B)
  ✓ 1 fully synced (13 B)

Stat cache: 1 entry, 0 stale

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✓ No .yref files missing corresponding .gitignore entries

No issues detected.
? 0
```

# Break things: remove gitignore entry manually

```console
$ echo "" > .gitignore
? 0
```

# Doctor detects the missing gitignore entry

```console
$ blobsy doctor

=== CONFIGURATION ===
Backend: local (path: ./remote)

=== REPOSITORY STATE ===
Git repository: [CWD]
Branch: main (dirty working tree)

Tracked files: 1 total (13 B)
  ✓ 1 fully synced (13 B)

Stat cache: 1 entry, 0 stale

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✗ 1 .yref file missing corresponding .gitignore entry:
  data/model.bin.yref -> data/model.bin not in .gitignore

1 issue detected. Run 'blobsy doctor --fix' to repair.
? 1
```

# Fix it

```console
$ blobsy doctor --fix

=== CONFIGURATION ===
Backend: local (path: ./remote)

=== REPOSITORY STATE ===
Git repository: [CWD]
Branch: main (dirty working tree)

Tracked files: 1 total (13 B)
  ✓ 1 fully synced (13 B)

Stat cache: 1 entry, 0 stale

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✗ 1 .yref file missing corresponding .gitignore entry:
  data/model.bin.yref -> data/model.bin not in .gitignore
  FIXED: Added data/model.bin to .gitignore

1 issue fixed.
? 0
```

# Verify the fix

```console
$ cat .gitignore
data/model.bin
$ blobsy doctor

=== CONFIGURATION ===
Backend: local (path: ./remote)

=== REPOSITORY STATE ===
Git repository: [CWD]
Branch: main (dirty working tree)

Tracked files: 1 total (13 B)
  ✓ 1 fully synced (13 B)

Stat cache: 1 entry, 0 stale

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✓ No .yref files missing corresponding .gitignore entries

No issues detected.
? 0
```
````

#### Scenario 4: Modify, Re-track, and Resync

Tests the update cycle: modify a tracked file, re-track to update the hash, push the new
version.

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
  blobsy push
  git add -A && git commit -q -m "push model"
---

# Start: fully synced

```console
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

# Modify the file

```console
$ echo "updated model weights v2" > data/model.bin
$ blobsy status
Tracked files (1):
  ~ data/model.bin (modified locally)

Summary:
  1 modified (~)

Actions needed:
  Run 'blobsy track data/model.bin' to update modified file
? 0
```

# Re-track to update hash

```console
$ blobsy track data/model.bin
Updated data/model.bin.yref (hash changed)
$ cat data/model.bin.yref
# blobsy ref file -- do not edit manually.
# See: blobsy status, blobsy verify, blobsy --help
blobsy-yref/0.1:
  hash: [HASH]
  size: 25
  remote_key: [REMOTE_KEY]
? 0
```

# Push the new version

```console
$ blobsy push data/model.bin
Warning: Operating on 1 uncommitted .yref file:
  data/model.bin.yref (modified)

Pushing 1 file...
  ◑ data/model.bin (25 B) - pushed
Done: 1 pushed.

Reminder: Run 'git add -A && git commit' to commit these refs.
? 0
```

# Commit and verify

```console
$ git add -A && git commit -q -m "update model v2"
$ blobsy verify
Verifying 1 tracked file...
  data/model.bin   ok (sha256 matches)
1 ok, 0 mismatch, 0 missing.
? 0
```

# Status is clean

```console
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```
````

#### Scenario 5: `blobsy rm` and `blobsy mv`

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model-v1.bin
  cp another-file.txt data/old-data.csv
  blobsy track data/model-v1.bin
  blobsy track data/old-data.csv
  git add -A && git commit -q -m "track files"
  blobsy push
  git add -A && git commit -q -m "push files"
---

# Move a tracked file

```console
$ blobsy mv data/model-v1.bin data/model-v2.bin
Moved: data/model-v1.bin -> data/model-v2.bin
Moved: data/model-v1.bin.yref -> data/model-v2.bin.yref
Updated .gitignore (removed old entry, added new entry)

Next: Run 'git add -A && git commit -m "Rename model"'
? 0
```

# Verify the move

```console
$ cat data/model-v2.bin
hello blobsy
$ test -f data/model-v1.bin && echo "exists" || echo "gone"
gone
$ test -f data/model-v2.bin.yref && echo "exists" || echo "gone"
exists
$ test -f data/model-v1.bin.yref && echo "exists" || echo "gone"
gone
? 0
```

# Remove a tracked file

```console
$ blobsy rm data/old-data.csv
⊗ data/old-data.csv (staged for deletion)

Moved data/old-data.csv.yref -> .blobsy/trash/data/old-data.csv.yref
Removed data/old-data.csv from .gitignore
Deleted local file: data/old-data.csv (12 B freed)

Next: Run 'git add -A && git commit -m "Remove old-data.csv"'
? 0
```

# Verify removal

```console
$ test -f data/old-data.csv && echo "exists" || echo "gone"
gone
$ test -f data/old-data.csv.yref && echo "exists" || echo "gone"
gone
$ test -f .blobsy/trash/data/old-data.csv.yref && echo "exists" || echo "gone"
exists
? 0
```

# Status after move and rm

```console
$ blobsy status
Tracked files (1):
  ◑ data/model-v2.bin (not committed, synced)

Summary:
  1 needs commit (◑)

Actions needed:
  Run 'git add -A && git commit' to commit refs
? 0
```
````

### Error Message Golden Tests

Each error scenario captures the full error output -- the complete message including the
failed file, the command that was run, the backend error, and the troubleshooting
suggestions. No `grep` or `jq` extraction.

#### Auth Errors

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
before: |
  git init -q
  cat > .blobsy.yml << 'EOF'
  backends:
    default:
      type: s3
      bucket: my-bucket
      region: us-east-1
  EOF
  git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
---

# Push with missing credentials

```console
$ AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY= AWS_PROFILE= blobsy push data/model.bin 2>&1
Error: Failed to push data/model.bin (13 B)

Command: aws s3 cp [CWD]/data/model.bin s3://my-bucket/[REMOTE_KEY]
Exit code: 255

Output:
Unable to locate credentials. You can configure credentials by running "aws configure".

Troubleshooting:
- Run: aws configure
- Or set: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
- Or use IAM role (if on EC2/ECS)
- See: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
? 1
```
````

#### Conflict Errors

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---

# Pull refuses when local file is modified

```console
$ echo "local changes" > data/model.bin
$ blobsy pull data/model.bin 2>&1
Error: Cannot pull data/model.bin: local file has been modified

Local hash does not match ref hash.
Run 'blobsy track data/model.bin' to update ref to match local file, or
Run 'blobsy pull --force data/model.bin' to overwrite local changes.
? 2
```

# Push refuses when file changed after track

```console
$ echo "sneaky edit after track" > data/model.bin
$ blobsy push data/model.bin 2>&1
Error: Cannot push data/model.bin: local file does not match ref hash

The file has been modified since 'blobsy track' was last run.
Run 'blobsy track data/model.bin' first, then push.
Or run 'blobsy push --force data/model.bin' to re-track and push in one step.
? 1
```
````

#### Validation Errors

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
---

# Malformed .yref file

```console
$ echo "this is not yaml: [[[" > data/model.bin.yref
$ blobsy status 2>&1
Error: Invalid .yref file: data/model.bin.yref

Failed to parse YAML: unexpected token at line 1, column 23
Expected format: blobsy-yref/0.1 with hash and size fields.

To repair: delete data/model.bin.yref and run 'blobsy track data/model.bin'
? 1
```

# Unsupported format version

```console
$ cat > data/model.bin.yref << 'EOF'
# blobsy ref file -- do not edit manually.
blobsy-yref/9.0:
  hash: sha256:0000000000000000000000000000000000000000000000000000000000000000
  size: 13
EOF
$ blobsy status 2>&1
Error: Unsupported .yref format: data/model.bin.yref

Found version blobsy-yref/9.0, but this version of blobsy supports up to blobsy-yref/0.1.
Upgrade blobsy to read this ref file, or re-track the file with the current version.
? 1
```
````

#### Partial Failure

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/good-file.bin
  cp another-file.txt data/bad-file.bin
  blobsy track data/good-file.bin
  blobsy track data/bad-file.bin
  git add -A && git commit -q -m "track"
---

# Simulate partial failure: make remote dir read-only after first push

```console
$ blobsy push data/good-file.bin
Pushing 1 file...
  ◑ data/good-file.bin (13 B) - pushed
Done: 1 pushed.
$ chmod 000 remote
$ blobsy push data/bad-file.bin 2>&1
Pushing 1 file...
  ✗ data/bad-file.bin (12 B) - FAILED

Error: Failed to push data/bad-file.bin (12 B)

Command: cp [CWD]/data/bad-file.bin [CWD]/remote/[REMOTE_KEY]
Exit code: 1

Output:
cp: cannot create regular file '[CWD]/remote/[REMOTE_KEY]': Permission denied

Troubleshooting:
- Check write permissions on the remote directory
- Run: ls -la [CWD]/remote/

1 file failed.
? 1
```

# Restore permissions

```console
$ chmod 755 remote
? 0
```
````

### JSON Output Golden Tests

JSON output is tested separately because it defines the machine-readable API contract.
The full JSON structure is captured so any field addition, removal, or restructuring
shows up in the diff.

````markdown
---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q && git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---

# blobsy status --json

```console
$ blobsy status --json
{
  "schema_version": "1",
  "files": [
    {
      "path": "data/model.bin",
      "state": "synced",
      "committed": true,
      "synced": true,
      "size": 13,
      "hash": "[HASH]",
      "remote_key": "[REMOTE_KEY]"
    }
  ],
  "summary": {
    "total": 1,
    "synced": 1,
    "needs_push": 0,
    "needs_commit": 0,
    "modified": 0,
    "missing": 0
  }
}
? 0
```

# blobsy verify --json

```console
$ echo "corrupted" > data/model.bin
$ blobsy verify --json
{
  "schema_version": "1",
  "files": [
    {
      "path": "data/model.bin",
      "status": "mismatch",
      "expected_hash": "[HASH]",
      "actual_hash": "[HASH]",
      "size": 13
    }
  ],
  "summary": {
    "total": 1,
    "ok": 0,
    "mismatch": 1,
    "missing": 0
  }
}
? 1
```
````

### Error Message Quality Checklist

Every error message must:

- Show the failed file path and size
- Show the exact command that failed (with variables expanded)
- Show the full error output (both stdout and stderr from the transport tool)
- Categorize the error (authentication, network, permission, etc.)
- Suggest concrete next steps for resolution
- Work correctly in both human-readable and `--json` output modes

This checklist is verified by reviewing the golden test output -- if any of these
elements is missing, it is visible in the captured output.

## Unit Tests (vitest)

Unit tests cover isolated logic that doesn’t need full CLI invocation.

### Test File Organization

```
packages/blobsy/
  tests/
    unit/
      ref-parser.test.ts
      config.test.ts
      hash.test.ts
      stat-cache.test.ts
      gitignore.test.ts
      path-resolution.test.ts
```

### Ref File Parsing and Serialization

- Parse valid `.yref` file (all fields present)
- Parse `.yref` with optional fields missing (`remote_key` absent)
- Parse `.yref` with compression fields
- Reject malformed YAML
- Reject unsupported format version (major mismatch)
- Warn on newer minor version
- Round-trip: serialize then parse produces identical object
- Key ordering is stable (deterministic output)

### Configuration

- Parse `.blobsy.yml` with all fields
- Hierarchical config merge (file-level overrides dir-level overrides repo-level)
- Default values applied when config fields absent
- Externalization rules: size threshold, extension matching, glob patterns
- Compression rules: `always`, `never`, `auto` with extension lists
- Invalid config produces clear error

### Hashing

- SHA-256 of known content matches expected hash
- Hash of empty file
- Hash of large file (streaming, not all-in-memory)
- Hash format: `sha256:<64-hex-chars>`

### Stat Cache

See [blobsy-stat-cache-design.md](blobsy-stat-cache-design.md) for design.

- `readCacheEntry` returns null for missing entry
- `writeCacheEntry` creates entry file with correct path hash
- `writeCacheEntry` creates prefix directory if missing
- `deleteCacheEntry` removes entry, no-op if missing
- `listCacheEntries` returns all entries across prefix directories
- `listCacheEntries` returns empty array for missing cache directory
- `listCacheEntries` skips corrupt JSON files
- `getCachedHash` returns hash when size + mtimeNs match
- `getCachedHash` returns null when size differs
- `getCachedHash` returns null when mtimeNs differs
- `getCachedHash` falls back to mtimeMs when mtimeNs is null
- `getMergeBase` returns hash regardless of current stat
- `getCacheEntryPath` produces consistent paths (deterministic hash)
- `getCacheEntryPath` uses 2-char prefix directory
- Atomic writes: concurrent writes to different entries don’t corrupt
- GC removes entries for untracked files, keeps tracked ones

### Gitignore Management

- `blobsy track` adds file to correct `.gitignore` (same directory)
- `blobsy untrack` removes file from `.gitignore`
- Duplicate entries not created on repeated track
- Nested `.gitignore` entries work correctly
- `.gitignore` created if it doesn’t exist

### Path Resolution

- Original file path resolves correctly
- `.yref` path resolves to original file
- Directory path expands to contained tracked files
- Glob patterns expand correctly
- Relative and absolute paths both work

## CI Configuration

- All unit tests (vitest) and golden tests (tryscript) run on every PR.
- Local backend and echo backend only -- no cloud credentials needed in CI.
- Test matrix: Node.js 22 and 24 (minimum supported and current).
- Coverage merged from vitest + tryscript, reported in PR.
- Golden test diffs shown in CI output on failure (tryscript’s default behavior).
- Optional: nightly cloud integration tests against a real S3 bucket.

### CI Script

```bash
pnpm build
pnpm test                          # vitest unit tests
tryscript run tests/golden/        # golden tests (must pass exactly)
```

### Updating Golden Tests

When blobsy’s output intentionally changes:

```bash
tryscript run --update tests/golden/   # regenerate all golden files
git diff tests/golden/                 # review changes carefully
git add tests/golden/ && git commit    # commit updated goldens
```

The review step is critical -- per the guidelines, over-approval without careful review
is an anti-pattern that defeats the purpose of golden testing.
