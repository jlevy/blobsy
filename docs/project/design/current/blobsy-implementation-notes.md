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

### The Shim Script

Installed by `blobsy hooks install` (and by `blobsy init`) at `.git/hooks/pre-commit`.

```sh
#!/bin/sh
# .git/hooks/pre-commit
# Installed by: blobsy hooks install
# To bypass: git commit --no-verify

# Prefer local install (fast) over npx (adds ~5s cold start overhead).
if [ -x node_modules/.bin/blobsy ]; then
  exec node_modules/.bin/blobsy hook pre-commit
else
  exec npx --yes blobsy hook pre-commit
fi
```

**Cross-platform notes:**

- Uses `#!/bin/sh` (POSIX), not `#!/bin/bash`. Git executes hooks via its bundled shell
  on all platforms, including Windows (Git for Windows bundles MSYS2 with `/bin/sh`).
- `node_modules/.bin/blobsy` exists as a POSIX shell script on all platforms.
  npm and pnpm both generate POSIX shell scripts alongside `.cmd` and `.ps1` variants.
  The POSIX variant runs correctly in Git’s MSYS2 environment on Windows.
- The `npx` fallback handles cases where blobsy is installed globally or via `npx`
  one-off usage. The `--yes` flag suppresses the install prompt.
- `exec` replaces the shell process to avoid an extra process layer and ensure the exit
  code propagates correctly.

**Performance:** Direct `node_modules/.bin/` invocation avoids the `npx` cold start
penalty, which is well-documented at ~5 seconds even for cached packages.
Since blobsy hooks may trigger blob uploads (already slow), the `npx` fallback overhead
is acceptable but not ideal for the common case.

### The `blobsy hook pre-commit` Command

An internal command (not prominently documented in `--help` but available) that performs
the actual pre-commit logic in TypeScript.

```typescript
async function hookPreCommit(): Promise<void> {
  // 1. Find staged .yref files
  const stagedFiles = await git("diff", "--cached", "--name-only", "--diff-filter=ACM");
  const yrefFiles = stagedFiles.filter((f) => f.endsWith(".yref"));

  if (yrefFiles.length === 0) {
    return; // Nothing to do -- exit 0
  }

  console.log(`blobsy: ${yrefFiles.length} .yref file(s) staged`);

  // 2. Derive payload paths and push each blob
  const payloadPaths = yrefFiles.map((f) => f.replace(/\.yref$/, ""));

  for (const payloadPath of payloadPaths) {
    await push(payloadPath, { quiet: true }); // calls push() directly, no subprocess
  }

  // 3. Re-stage .yref files that push may have updated (remote_key written back)
  await git("add", ...yrefFiles);

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
- **Re-staging.** After push writes `remote_key` back to `.yref` files, the hook
  re-stages them via `git add` so the commit includes the updated refs.
- **Concurrency.** For multiple `.yref` files, pushes run through the standard
  concurrency pool (same as `blobsy push` with multiple paths).

### Coexistence with Hook Managers

Many Node.js projects already use Lefthook, Husky, or simple-git-hooks.
Blobsy must not conflict with existing hook infrastructure.

**Projects using Lefthook:** Add blobsy as a command in `lefthook.yml` instead of
installing a standalone shim.
`blobsy hooks install` should detect Lefthook’s presence and print instructions:

```yaml
# lefthook.yml
pre-commit:
  commands:
    blobsy:
      glob: "*.yref"
      run: npx blobsy hook pre-commit
      # Or: node_modules/.bin/blobsy hook pre-commit
```

**Projects using Husky v9:** Add the command to `.husky/pre-commit`. Husky v9 does not
add `node_modules/.bin/` to PATH (older versions did), so use `npx` or a direct path:

```sh
# .husky/pre-commit
npx blobsy hook pre-commit
```

**Projects without a hook manager:** `blobsy hooks install` writes the standalone shim
to `.git/hooks/pre-commit`. If an existing hook is present, blobsy warns and offers to
append rather than overwrite.

**Detection logic for `blobsy hooks install`:**

1. Check for `lefthook.yml` in repo root -- if found, print Lefthook integration
   instructions instead of installing a shim.
2. Check for `.husky/` directory -- if found, print Husky integration instructions.
3. Check for existing `.git/hooks/pre-commit` -- if found and not blobsy-owned (no
   `Installed by: blobsy` marker), warn and offer to append.
4. Otherwise, install the standalone shim.

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

**`blobsy init`** calls `blobsy hooks install` automatically as its final step.

## Push Verification Logic (Pseudocode)

`blobsy push` verifies consistency before uploading:

```typescript
async function push(filePath: string, options: PushOptions = {}): Promise<void> {
  const yrefPath = filePath + '.yref';
  if (!await exists(yrefPath)) {
    throw new Error(`No .yref file found for ${filePath}. Run 'blobsy track' first.`);
  }

  const ref = await readYRef(yrefPath);

  if (!await exists(filePath)) {
    throw new Error(
      `File not found: ${filePath}\n` +
      `\n` +
      `The .yref file exists but the actual file is missing.\n` +
      `Run 'blobsy pull ${filePath}' to download it.`
    );
  }

  const actualHash = await computeHash(filePath);

  // Verify hash matches .yref (catches file modified after track)
  if (actualHash !== ref.hash && !options.force) {
    throw new Error(
      `Hash mismatch in ${filePath}:\n` +
      `\n` +
      `  Expected (in .yref): ${ref.hash}\n` +
      `  Actual (file):       ${actualHash}\n` +
      `\n` +
      `This means the file was modified after the .yref was created.\n` +
      `\n` +
      `To fix:\n` +
      `  1. Update the .yref to match current file: blobsy track ${filePath}\n` +
      `  2. Restore file to match .yref: blobsy pull --force ${filePath}\n` +
      `  3. Force push current file (DANGER): blobsy push --force ${filePath}\n`
    );
  }

  if (actualHash !== ref.hash && options.force) {
    // Update ref to match actual file
    ref.hash = actualHash;
    ref.size = await getFileSize(filePath);
    await writeYRef(yrefPath, ref);
  }

  const remoteKey = await uploadBlob(filePath, ref);

  ref.remote_key = remoteKey;
  await writeYRef(yrefPath, ref);

  await updateCacheEntry(cacheDir, filePath, ref.hash);
}
```

## Attribution Error Messages

### Pull fails due to missing remote blob

```
$ blobsy pull

x data/model.bin: Cannot pull (no remote blob)

This .yref file references a blob that doesn't exist in remote storage:
  Expected remote key: 20260220T140322Z-abc123/data/model.bin
  Remote backend: s3://my-bucket/project/

This usually means someone committed the .yref file without pushing the blob.

Last commit of this .yref:
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

Scanning git history for committed .yref files...

Found 2 .yref files in HEAD with missing remote blobs:

  data/model.bin.yref
    Committed: 2026-02-20 14:03:22
    Author: Alice <alice@example.com>
    Commit: a1b2c3d4
    Issue: remote_key not set (never pushed)

  results/output.json.yref
    Committed: 2026-02-19 09:15:44
    Author: Bob <bob@example.com>
    Commit: e5f6g7h8
    Issue: remote blob not found at key (might have been deleted)

To fix:
  Run 'blobsy push' to upload missing blobs.
  Then commit the updated .yref files: git add *.yref && git commit -m "Add remote keys"
```
