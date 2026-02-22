# blobsy Implementation Notes

Code snippets and error message templates to incorporate during implementation.
These are reference sketches, not final code.

## Pre-Commit Hook Architecture

### Design: Thin Shim + TypeScript Command

The pre-commit hook uses a two-layer architecture, following the same pattern as
Lefthook, Husky, Git LFS, and lint-staged:

1. **Shim script** -- a minimal POSIX shell script installed at `.git/hooks/pre-commit`
   that delegates to blobsy.
2. **`blobsy hook pre-commit`** -- a TypeScript command that does all the real work.

**Why not a bash script?**

The original design used a self-contained bash script with `sed`, `xargs`, `wc -l`, etc.
This has several problems:

- **Windows incompatibility.** These utilities aren’t available on all platforms.
  While Git for Windows bundles MSYS2 which includes `/bin/sh`, extended bash utilities
  are unreliable.
- **Duplicated logic.** File discovery, path stripping, and error handling are
  reimplemented outside the blobsy codebase, creating two sources of truth.
- **Fragile parsing.** Filenames with spaces or special characters break `echo | xargs`
  pipelines.
- **Untestable.** Bash logic can’t be unit tested with vitest.

Every major hook tool uses the thin-shim-delegates-to-real-tool pattern:

| Tool | Shim | Real logic |
| --- | --- | --- |
| Lefthook | Shell script calls `lefthook` Go binary | Go binary reads `lefthook.yml` |
| Husky v9 | Plain shell script in `.husky/` | User commands (e.g. `npx lint-staged`) |
| Git LFS | Shell script calls `git lfs pre-push` | Go binary |
| lint-staged | Called via `npx lint-staged` from hook | Node.js |

### Installation Model

Blobsy is a system tool, not a project dependency.
The primary installation is global, like Git LFS:

```bash
npm install -g blobsy    # npm
```

This makes `blobsy` available on PATH for any repo, regardless of project language
(Python, Rust, Go, data science, etc.). No `node_modules` required.

Node.js projects may optionally add blobsy as a devDependency for version pinning, but
this is not required and not the default setup path.

**Setup flow:**

| Step | Who | When |
| --- | --- | --- |
| `npm install -g blobsy` | Each developer (once per machine) | Before first use |
| `blobsy init` | Every developer (once per clone) | After `git clone` or on first setup |

`blobsy init` is idempotent.
The first developer to run it creates the config (`.blobsy.yml`) and installs hooks.
Subsequent developers run the same command — it detects the existing config, skips
setup, and just installs hooks.
This means there is one command for everyone to remember, whether they are the first
developer or the tenth.

Projects can automate `blobsy init` via their existing setup mechanism (Makefile,
`prepare` script, setup.sh, etc.)
but blobsy does not require or assume any particular project type.

### The Shim Script

Installed by `blobsy hooks install` (and by `blobsy init`) at `.git/hooks/pre-commit`.

```sh
#!/bin/sh
# .git/hooks/pre-commit
# Installed by: blobsy hooks install
# To bypass: git commit --no-verify

exec blobsy hook pre-commit
```

The shim delegates entirely to the `blobsy` CLI on PATH. If blobsy is not installed, the
shell reports “command not found” and blocks the commit -- a clear signal to install
blobsy.

**Cross-platform notes:**

- Uses `#!/bin/sh` (POSIX), not `#!/bin/bash`. Git executes hooks via its bundled shell
  on all platforms, including Windows (Git for Windows bundles MSYS2 with `/bin/sh`).
- `exec` replaces the shell process so the exit code propagates correctly.
- No `npx`, no `node_modules/.bin/` lookup, no auto-bootstrapping.
  The hook assumes blobsy is installed as a system tool, the same way `git lfs` hooks
  assume `git-lfs` is installed.

### The `blobsy hook pre-commit` Command

An internal command (not prominently documented in `--help` but available) that performs
the actual pre-commit logic in TypeScript.

```typescript
async function hookPreCommit(): Promise<void> {
  // 1. Find staged .bref files
  const stagedFiles = await git("diff", "--cached", "--name-only", "--diff-filter=ACM");
  const brefFiles = stagedFiles.filter((f) => f.endsWith(".bref"));

  if (brefFiles.length === 0) {
    return; // Nothing to do -- exit 0
  }

  console.log(`blobsy: ${brefFiles.length} .bref file(s) staged`);

  // 2. Derive payload paths and push each blob
  const payloadPaths = brefFiles.map((f) => f.replace(/\.bref$/, ""));

  for (const payloadPath of payloadPaths) {
    await push(payloadPath, { quiet: true }); // calls push() directly, no subprocess
  }

  // 3. Re-stage .bref files that push may have updated (remote_key written back)
  await git("add", ...brefFiles);

  console.log("blobsy: all blobs uploaded, proceeding with commit");
}
```

**Key implementation details:**

- **Direct function call, not subprocess.** The hook command calls `push()` directly --
  no spawning `blobsy push` as a child process.
  This avoids process overhead and shares configuration, caching, and connection state.
- **Error handling.** If any push fails, the process exits with code 1 (blocking the
  commit). Error messages come from the standard push error handling, keeping output
  consistent with manual `blobsy push`.
- **Re-staging.** After push writes `remote_key` back to `.bref` files, the hook
  re-stages them via `git add` so the commit includes the updated refs.
- **Concurrency.** For multiple `.bref` files, pushes run through the standard
  concurrency pool (same as `blobsy push` with multiple paths).

### Coexistence with Hook Managers

Projects may already use a hook manager (Lefthook, Husky, simple-git-hooks, Python’s
pre-commit framework, etc.). Blobsy must not conflict with existing hook infrastructure.

**Projects with a hook manager:** Add `blobsy hook pre-commit` as a command in the
existing hook configuration.
Since blobsy is on PATH, this works the same way regardless of project type or hook
manager. Examples:

```yaml
# lefthook.yml
pre-commit:
  commands:
    blobsy:
      glob: "*.bref"
      run: blobsy hook pre-commit
```

```sh
# .husky/pre-commit
blobsy hook pre-commit
```

```yaml
# .pre-commit-config.yaml (Python pre-commit framework)
repos:
  - repo: local
    hooks:
      - id: blobsy
        name: blobsy push
        entry: blobsy hook pre-commit
        language: system
        pass_filenames: false
```

`blobsy hooks install` detects existing hook managers and prints the appropriate
integration instructions instead of installing a standalone shim.

**Projects without a hook manager:** `blobsy hooks install` writes the standalone shim
to `.git/hooks/pre-commit`. If an existing hook is present, blobsy warns and offers to
append rather than overwrite.

**Detection logic for `blobsy hooks install`:**

1. Check for `lefthook.yml` in repo root -- if found, print Lefthook integration
   instructions instead of installing a shim.
2. Check for `.husky/` directory -- if found, print Husky integration instructions.
3. Check for `.pre-commit-config.yaml` -- if found, print pre-commit framework
   integration instructions.
4. Check for existing `.git/hooks/pre-commit` -- if found and not blobsy-owned (no
   `Installed by: blobsy` marker), warn and offer to append.
5. Otherwise, install the standalone shim.

### `blobsy hooks install` and `blobsy hooks uninstall`

These commands manage the shim lifecycle.
Consistent with the design doc’s `blobsy hooks` section.

**`blobsy hooks install`:**

- Writes the shim to `.git/hooks/pre-commit`.
- Makes it executable (`chmod +x`; no-op on Windows since Git handles this).
- Detects hook manager presence and adjusts behavior (see above).
- Idempotent: re-running overwrites with the latest shim version.

**`blobsy hooks uninstall`:**

- Removes `.git/hooks/pre-commit` only if it contains the `Installed by: blobsy` marker.
- If the hook was modified or isn’t blobsy-owned, warns and exits without deleting.

**`blobsy init`** calls `blobsy hooks install` as its final step.
Since `blobsy init` is idempotent and subsumes hook installation, most developers only
need to know `blobsy init`. `blobsy hooks install` remains available as a standalone
command for cases where only hook management is needed (e.g., after switching hook
managers).

## Push Verification Logic (Pseudocode)

`blobsy push` verifies consistency before uploading:

```typescript
async function push(filePath: string, options: PushOptions = {}): Promise<void> {
  const brefPath = filePath + '.bref';
  if (!await exists(brefPath)) {
    throw new Error(`No .bref file found for ${filePath}. Run 'blobsy track' first.`);
  }

  const ref = await readBref(brefPath);

  if (!await exists(filePath)) {
    throw new Error(
      `File not found: ${filePath}\n` +
      `\n` +
      `The .bref file exists but the actual file is missing.\n` +
      `Run 'blobsy pull ${filePath}' to download it.`
    );
  }

  const actualHash = await computeHash(filePath);

  // Verify hash matches .bref (catches file modified after track)
  if (actualHash !== ref.hash && !options.force) {
    throw new Error(
      `Hash mismatch in ${filePath}:\n` +
      `\n` +
      `  Expected (in .bref): ${ref.hash}\n` +
      `  Actual (file):       ${actualHash}\n` +
      `\n` +
      `This means the file was modified after the .bref was created.\n` +
      `\n` +
      `To fix:\n` +
      `  1. Update the .bref to match current file: blobsy track ${filePath}\n` +
      `  2. Restore file to match .bref: blobsy pull --force ${filePath}\n` +
      `  3. Force push current file (DANGER): blobsy push --force ${filePath}\n`
    );
  }

  if (actualHash !== ref.hash && options.force) {
    // Update ref to match actual file
    ref.hash = actualHash;
    ref.size = await getFileSize(filePath);
    await writeBref(brefPath, ref);
  }

  const remoteKey = await uploadBlob(filePath, ref);

  ref.remote_key = remoteKey;
  await writeBref(brefPath, ref);

  await updateCacheEntry(cacheDir, filePath, ref.hash);
}
```

## Attribution Error Messages

### Pull fails due to missing remote blob

```
$ blobsy pull

x data/model.bin: Cannot pull (no remote blob)

This .bref file references a blob that doesn't exist in remote storage:
  Expected remote key: 20260220T140322Z-abc123/data/model.bin
  Remote backend: s3://my-bucket/project/

This usually means someone committed the .bref file without pushing the blob.

Last commit of this .bref:
  commit: a1b2c3d4
  author: Alice <alice@example.com>
  date:   2026-02-20 14:03:22
  message: Update model

To fix:
  1. Ask Alice to run: blobsy push data/model.bin
  2. Or if you have the correct file, run: blobsy push --force data/model.bin
  3. Or run: blobsy doctor --check-unpushed (to find all such files)
```

### check-unpushed output

```
$ blobsy check-unpushed

Scanning git history for committed .bref files...

Found 2 .bref files in HEAD with missing remote blobs:

  data/model.bin.bref
    Committed: 2026-02-20 14:03:22
    Author: Alice <alice@example.com>
    Commit: a1b2c3d4
    Issue: remote_key not set (never pushed)

  results/output.json.bref
    Committed: 2026-02-19 09:15:44
    Author: Bob <bob@example.com>
    Commit: e5f6g7h8
    Issue: remote blob not found at key (might have been deleted)

To fix:
  Run 'blobsy push' to upload missing blobs.
  Then commit the updated .bref files: git add *.bref && git commit -m "Add remote keys"
```
