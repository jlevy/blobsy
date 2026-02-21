# blobsy Implementation Notes

Code snippets and error message templates to incorporate during implementation.
These are reference sketches, not final code.

## Pre-Commit Hook Script

Installed by `blobsy init` at `.git/hooks/pre-commit`. Auto-pushes blobs when committing
`.yref` files.

```bash
#!/bin/bash
# .git/hooks/pre-commit
# Installed by: blobsy init

YREF_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.yref$')

if [ -z "$YREF_FILES" ]; then
  exit 0
fi

echo "blobsy pre-commit hook"
echo ""
echo "Detected $(echo "$YREF_FILES" | wc -l) .yref file(s) in this commit:"
echo "$YREF_FILES" | sed 's/^/  /'
echo ""
echo "Running 'blobsy push' to ensure blobs are uploaded before commit..."
echo ""

FILE_PATHS=$(echo "$YREF_FILES" | sed 's/\.yref$//')

if echo "$FILE_PATHS" | xargs blobsy push --quiet; then
  echo ""
  echo "All blobs uploaded successfully"

  # Re-stage .yref files updated by blobsy push (remote_key written back)
  echo "$YREF_FILES" | xargs git add

  echo "  Proceeding with commit..."
  exit 0
else
  EXIT_CODE=$?
  echo ""
  echo "Failed to upload one or more blobs (exit code: $EXIT_CODE)"
  echo ""
  echo "Your commit has been BLOCKED to prevent committing .yref files"
  echo "without their corresponding remote blobs."
  echo ""
  echo "Options:"
  echo "  1. Fix the upload issue (check network, credentials, backend config)"
  echo "     Then retry: git commit"
  echo ""
  echo "  2. Skip this check (NOT RECOMMENDED):"
  echo "     git commit --no-verify"
  echo ""
  echo "  3. Unstage the .yref files and commit other changes:"
  echo "     git reset HEAD *.yref"
  echo "     git commit"
  echo ""
  exit 1
fi
```

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
