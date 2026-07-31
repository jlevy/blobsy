# Joining a Repo That Uses blobsy

What to do when you clone a repository that already tracks files with blobsy — and how
to recover from the situations you’ll eventually hit.

## First-time setup

```bash
git clone <repo-url> && cd <repo>
npm install -g blobsy

# Config (.blobsy.yml) is already in the repo. This installs git hooks and
# agent integration; it does not overwrite existing config:
blobsy setup --auto

# Fetch the actual file contents for every .bref pointer:
blobsy pull

# Confirm everything is in sync:
blobsy status
```

You’ll need credentials for the repo’s backend (e.g. AWS credentials for an `s3://`
backend). `blobsy health` tests connectivity; read-only credentials are enough to pull.

Opt-outs: set `BLOBSY_NO_HOOKS=1` to disable blobsy git hooks entirely — it both
skips hook installation and makes already-installed blobsy hooks no-ops at runtime.
If the repo uses a `command` backend, blobsy refuses to run repo-controlled commands
until you grant trust explicitly (`BLOBSY_TRUST_COMMAND_BACKEND=1` or a
`trust_command_backends` entry in `~/.blobsy.yml`) — review the commands in
`.blobsy.yml` first.

## Day-to-day

```bash
blobsy pull            # after git pull, fetch any new/updated blobs
blobsy add <file>      # track a new large file (creates .bref, stages it)
git commit && git push # pre-push hook uploads unpushed blobs first
blobsy sync            # bidirectional catch-up (push unpushed + pull missing)
```

## Recovery drills

Each of these is safe to practice in a scratch clone.

### 1. Fresh clone / missing local files

`blobsy status` shows `?` (missing local).
Run `blobsy pull`. Hashes are verified on download; a partial or corrupted transfer
never replaces your local file (downloads go to a temp file and are renamed only after
verification).

### 2. You modified a tracked file and want to keep your version

`blobsy push` refuses with a warning (it never uploads content whose hash doesn’t match
the `.bref`). Re-track to record the new content, then push:

```bash
blobsy track path/file.bin     # re-hashes, updates the .bref
blobsy push path/file.bin --force
git add path/file.bin.bref && git commit
```

### 3. You modified a tracked file and want to discard your version

```bash
blobsy pull path/file.bin --force   # re-downloads the authoritative content
```

Without `--force`, pull refuses to overwrite local modifications.

### 4. Sync conflict (both local and remote changed)

`blobsy sync` reports a conflict and exits with code 2. Decide per file: keep yours
(drill 2) or take the remote version (drill 3).

### 5. Credential or connectivity failure

`blobsy push`/`pull` fail with a categorized error (authentication, network, permission)
and suggestions. Run `blobsy health` to test the backend directly; `blobsy doctor` for a
broader diagnosis. Nothing is left half-written: failed transfers clean up their temp
files, and your `.bref` files are untouched.

### 6. Interrupted transfer (Ctrl-C, network drop)

Just re-run the command.
Uploads and downloads are atomic (temp file + rename), so an interrupted transfer leaves
no partial blob under the final name, and `push`/`pull`/`sync` are idempotent.

### 7. Rolling back to an older commit

```bash
git checkout <old-commit>   # or git switch/revert
blobsy pull                 # fetches the blobs those older .brefs reference
```

This works because remote blobs are immutable: the key recorded in an old `.bref` still
holds exactly the bytes that were pushed.
(Exception: if someone ran `blobsy rm --remote --force`, that blob is gone — which is
why that flag is labeled history-breaking.)

### 8. Suspected remote corruption

`blobsy pull` fails with a hash mismatch ("The remote blob may be corrupted"). The local
file is not overwritten.
Re-push from a machine that has the correct content (`blobsy push --force`), or restore
the object from backend versioning if enabled.

## CI

See [ci-github-actions.md](ci-github-actions.md) for a copy-paste GitHub Actions
workflow.
