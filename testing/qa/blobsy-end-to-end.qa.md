---
title: Blobsy End-to-End QA Playbook
description: Comprehensive manual testing from clean install to full validation
author: Joshua Levy (github.com/jlevy) with LLM assistance
---
# QA Playbook: Blobsy End-to-End Validation

Manual QA playbook for validating Blobsy functionality from clean installation through
comprehensive workflows with real backing stores.

**Purpose**: Validate that Blobsy v1.0 works correctly for all major workflows including
tracking, compression, push/pull/sync, error handling, and Git integration with both
local and cloud backends.

**Estimated Time**: ~60-90 minutes (depending on network speeds for cloud testing)

> This is a “manual test” playbook designed to:
> 
> - Systematically validate functionality that requires real backends, network
>   operations, and interactive scenarios
> - Provide detailed steps with expected outputs for agent execution
> - Document edge cases and error scenarios that are hard to automate
> - Ensure end-to-end workflows function correctly in realistic environments

* * *

## Current Status (last update YYYY-MM-DD)

| Phase | Status | Notes |
| --- | --- | --- |
| Phase 1: Installation & Local Setup | ⏳ Pending | Clean install + local backend |
| Phase 2: Basic Workflow (Happy Path) | ⏳ Pending | track → push → pull → verify |
| Phase 3: Compression & Config | ⏳ Pending | All algorithms, externalize rules |
| Phase 4: Error Scenarios | ⏳ Pending | Auth, missing files, conflicts |
| Phase 5: Advanced Operations | ⏳ Pending | mv/rm, sync, Git hooks |
| Phase 6: Cloud Backend (S3/R2) | ⏳ Pending | Real remote storage |
| Phase 7: Cleanup & Doctor | ⏳ Pending | Health check, repair, untrack |

**Status Legend**: ✅ Passed | ❌ Failed | ⏳ Pending | ⏸️ Blocked

**Test Results (last update YYYY-MM-DD):**

- `blobsy init local:../remote` → [✅/❌] [result]
- `blobsy track test-file.bin` → [✅/❌] [result]
- `blobsy push` → [✅/❌] [result]
- `blobsy pull` → [✅/❌] [result]
- `blobsy sync` → [✅/❌] [result]
- `blobsy health` → [✅/❌] [result]
- `blobsy doctor --fix` → [✅/❌] [result]

**Next Steps**:

1. Complete Phase 1 setup
2. Validate basic workflow
3. Test error paths thoroughly
4. Validate with cloud backend

* * *

## Prerequisites

**Required**:

- Node.js >= 24 (check: `node --version`)
- pnpm installed (check: `pnpm --version`)
- Git repository for testing (create fresh test repo)
- ~100MB free disk space

**Optional (for cloud backend testing)**:

- AWS credentials with S3 access (`~/.aws/credentials` or env vars)
- OR Cloudflare R2 credentials
- OR any S3-compatible storage with credentials

**Test Data**:

- Will be generated during testing (no pre-existing data needed)

* * *

## Related Documentation — Read for Context

- [blobsy-design.md](../../docs/project/design/current/blobsy-design.md) - Overall
  architecture and design
- [blobsy-backend-and-transport-design.md](../../docs/project/design/current/blobsy-backend-and-transport-design.md)
  \- Backend layer details
- [blobsy-stat-cache-design.md](../../docs/project/design/current/blobsy-stat-cache-design.md)
  \- Change detection and conflict resolution
- [blobsy-testing-design.md](../../docs/project/design/current/blobsy-testing-design.md)
  \- Testing strategy
- [README.md](../../packages/blobsy/README.md) - User-facing documentation

* * *

## Phase 1: Installation & Local Backend Setup

### 1.1 Build and Install Blobsy

```bash
# From blobsy repo root
pnpm install
pnpm build
pnpm link --global
```

**Expected output**:

```
✓ Built packages/blobsy
✓ Linked blobsy@x.x.x → global
```

**Verify**:

- [ ] `blobsy --version` shows correct version number
- [ ] `blobsy --help` displays help text with all commands
- [ ] No error messages during build

**Troubleshooting**:

- **Issue**: `command not found: blobsy` **Fix**: Check `pnpm bin -g` is in PATH, or use
  `pnpm exec blobsy`
- **Issue**: Build errors **Fix**: Run `pnpm install` again, check Node version >= 24

### 1.2 Create Fresh Test Repository

```bash
# Create isolated test environment
cd /tmp
rm -rf blobsy-qa-test
mkdir -p blobsy-qa-test/test-repo
cd blobsy-qa-test/test-repo
git init
git config user.name "QA Test"
git config user.email "qa@test.local"
echo "# Blobsy QA Test" > README.md
git add README.md
git commit -m "Initial commit"
```

**Expected output**:

```
Initialized empty Git repository in /tmp/blobsy-qa-test/test-repo/.git/
[main (root-commit) abc1234] Initial commit
 1 file changed, 1 insertion(+)
```

**Verify**:

- [ ] `.git/` directory exists
- [ ] `git log` shows initial commit
- [ ] Working directory is clean (`git status`)

### 1.3 Initialize Blobsy with Local Backend

```bash
# Initialize with local backend (outside repo for safety)
blobsy init local:../blobsy-remote
```

**Expected output**:

```
✓ Created .blobsy.yml
✓ Backend configured: local:../blobsy-remote
✓ Local path: /tmp/blobsy-qa-test/blobsy-remote
Run: blobsy track <file> to start tracking large files
```

**Verify**:

- [ ] `.blobsy.yml` created in repo root
- [ ] Backend directory `../blobsy-remote/` created
- [ ] `blobsy config backend` shows `local:../blobsy-remote`

**Check `.blobsy.yml` contents**:

```bash
cat .blobsy.yml
```

**Expected**:

```yaml
backend: default
backends:
  default:
    url: local:../blobsy-remote

# (optional sections may also be present)
```

**Troubleshooting**:

- **Issue**: “Path must be outside repository root” **Fix**: Use `../blobsy-remote`
  (relative to repo root), not `./remote`
- **Issue**: Permission denied creating backend directory **Fix**: Check write
  permissions on parent directory

### 1.4 Test Backend Connectivity

```bash
blobsy health
```

**Expected output**:

```
✓ Backend health check passed
✓ Can write to local:../blobsy-remote
✓ Can read from local:../blobsy-remote
```

**Verify**:

- [ ] Exit code 0 (check with `echo $?`)
- [ ] No error messages
- [ ] Test file created and deleted in backend directory

**Troubleshooting**:

- **Issue**: Health check failed **Fix**: Run `blobsy health --verbose` for detailed
  diagnostics

* * *

## Phase 2: Basic Workflow (Happy Path)

### 2.1 Create Test Files

```bash
# Create files of various sizes
dd if=/dev/urandom of=small-file.bin bs=1024 count=50        # 50KB
dd if=/dev/urandom of=medium-file.bin bs=1024 count=500      # 500KB
dd if=/dev/urandom of=large-file.bin bs=1024 count=5000      # 5MB
echo "This is a text file" > notes.txt
```

**Verify**:

- [ ] 4 files created
- [ ] `ls -lh` shows correct sizes (~50K, ~500K, ~5M, ~20 bytes)

### 2.2 Track Files

```bash
blobsy track small-file.bin medium-file.bin large-file.bin
```

**Expected output**:

```
✓ Tracked small-file.bin (50.0 KB, sha256:abc...)
✓ Tracked medium-file.bin (500.0 KB, sha256:def...)
✓ Tracked large-file.bin (5.0 MB, sha256:ghi...)
```

**Verify**:

- [ ] `.yref` files created for each tracked file
- [ ] Original `.bin` files still exist
- [ ] `.gitignore` created with entries for tracked files

**Check `.yref` file structure**:

```bash
cat small-file.bin.yref
```

**Expected format**:

```yaml
# blobsy -- https://github.com/jlevy/blobsy
# Run: blobsy status | blobsy --help

format: blobsy-yref/0.1
hash: sha256:abc123...
size: 51200
```

**Verify .yref fields**:

- [ ] `format: blobsy-yref/0.1` present
- [ ] `hash: sha256:...` (64 hex chars after colon)
- [ ] `size:` matches file size in bytes
- [ ] NO `remote_key:` yet (unpushed)
- [ ] Fields in order: format, hash, size

**Check .gitignore**:

```bash
cat .gitignore
```

**Expected**:

```
small-file.bin
medium-file.bin
large-file.bin
```

**Verify**:

- [ ] Each tracked file listed (one per line)
- [ ] `.yref` files NOT in .gitignore (they should be committed)

**Troubleshooting**:

- **Issue**: “File too small to externalize” **Fix**: Expected for files < 1MB (default
  `min_size`), adjust config or use larger files
- **Issue**: Malformed .yref file **Fix**: Check YAML syntax, run `blobsy verify`

### 2.3 Check Status Before Push

```bash
blobsy status
```

**Expected output**:

```
small-file.bin.yref
  Local:  ✓ (sha256:abc...)
  Remote: ✗ Not pushed

medium-file.bin.yref
  Local:  ✓ (sha256:def...)
  Remote: ✗ Not pushed

large-file.bin.yref
  Local:  ✓ (sha256:ghi...)
  Remote: ✗ Not pushed
```

**Verify**:

- [ ] All files show “Local: ✓”
- [ ] All files show “Remote: ✗ Not pushed”
- [ ] No errors or warnings

**Check status with JSON output**:

```bash
blobsy status --json
```

**Verify JSON structure**:

- [ ] Valid JSON (pipe to `jq` or `python -m json.tool`)
- [ ] Each file has `local_state` and `remote_state` fields
- [ ] `remote_state: "not_pushed"` for all files

### 2.4 Push to Backend

```bash
blobsy push --verbose
```

**Expected output**:

```
Pushing small-file.bin...
  ✓ Uploaded to 20260221T120000Z-abc123.../small-file.bin (50.0 KB)
Pushing medium-file.bin...
  ✓ Uploaded to 20260221T120000Z-def456.../medium-file.bin (500.0 KB)
Pushing large-file.bin...
  ✓ Uploaded to 20260221T120000Z-ghi789.../large-file.bin (5.0 MB)
✓ Pushed 3 files
```

**Verify**:

- [ ] All files pushed successfully
- [ ] Remote keys shown (ISO timestamp + hash prefix format)
- [ ] Exit code 0

**Check .yref files updated**:

```bash
cat large-file.bin.yref
```

**Expected additions**:

```yaml
format: blobsy-yref/0.1
hash: sha256:ghi789...
size: 5242880
remote_key: 20260221T120000Z-ghi789.../large-file.bin
```

**Verify**:

- [ ] `remote_key:` field now present
- [ ] Remote key follows template pattern (ISO date, hash prefix, path)

**Check backend directory**:

```bash
ls -lhR ../blobsy-remote/
```

**Verify**:

- [ ] Files exist in backend with remote_key paths
- [ ] File sizes match (or smaller if compressed)
- [ ] Can read files with `cat`, `file` commands

**Troubleshooting**:

- **Issue**: Push failed with “backend not writable” **Fix**: Check `blobsy health`,
  verify backend directory permissions
- **Issue**: Remote key not written to .yref **Fix**: Check for errors in `--verbose`
  output, verify atomic write succeeded

### 2.5 Verify Status After Push

```bash
blobsy status
```

**Expected output**:

```
small-file.bin.yref
  Local:  ✓ (sha256:abc...)
  Remote: ✓ (sha256:abc...)

medium-file.bin.yref
  Local:  ✓ (sha256:def...)
  Remote: ✓ (sha256:def...)

large-file.bin.yref
  Local:  ✓ (sha256:ghi...)
  Remote: ✓ (sha256:ghi...)
```

**Verify**:

- [ ] All files show “Local: ✓” and “Remote: ✓”
- [ ] Hashes match between local and remote
- [ ] No “Not pushed” warnings

### 2.6 Simulate Pull (Delete Local, Restore from Remote)

```bash
# Delete local files (keep .yref)
rm small-file.bin medium-file.bin large-file.bin
blobsy status
```

**Expected status output**:

```
small-file.bin.yref
  Local:  ✗ Missing
  Remote: ✓ (sha256:abc...)

medium-file.bin.yref
  Local:  ✗ Missing
  Remote: ✓ (sha256:def...)

large-file.bin.yref
  Local:  ✗ Missing
  Remote: ✓ (sha256:ghi...)
```

**Verify**:

- [ ] Status detects missing local files
- [ ] Remote status still valid

**Pull files from backend**:

```bash
blobsy pull --verbose
```

**Expected output**:

```
Pulling small-file.bin...
  ✓ Downloaded from 20260221T120000Z-abc123.../small-file.bin
  ✓ Verified hash: sha256:abc...
Pulling medium-file.bin...
  ✓ Downloaded from 20260221T120000Z-def456.../medium-file.bin
  ✓ Verified hash: sha256:def...
Pulling large-file.bin...
  ✓ Downloaded from 20260221T120000Z-ghi789.../large-file.bin
  ✓ Verified hash: sha256:ghi...
✓ Pulled 3 files
```

**Verify**:

- [ ] All files restored
- [ ] Hashes verified during pull
- [ ] Files readable and correct size

**Verify integrity**:

```bash
blobsy verify
```

**Expected output**:

```
✓ small-file.bin (sha256:abc... matches .yref)
✓ medium-file.bin (sha256:def... matches .yref)
✓ large-file.bin (sha256:ghi... matches .yref)
All files verified successfully.
```

**Verify**:

- [ ] All files pass verification
- [ ] No hash mismatches
- [ ] Exit code 0

**Troubleshooting**:

- **Issue**: Hash mismatch during pull **Fix**: Backend corruption or network issue,
  delete local file and re-pull with `--force`
- **Issue**: Pull failed “file not found in backend” **Fix**: Check `.yref` remote_key
  is valid, inspect backend directory

### 2.7 Test Idempotency

```bash
# Re-run operations that should be no-ops
blobsy track small-file.bin       # Already tracked
blobsy push                        # Already pushed
blobsy pull                        # Already up-to-date
blobsy verify                      # Already verified
```

**Expected behavior**:

- `track`: “Already tracked, skipping” or similar
- `push`: “All files up-to-date” (no uploads)
- `pull`: “All files up-to-date” (no downloads)
- `verify`: Success with no re-hashing (uses stat cache)

**Verify**:

- [ ] No errors or warnings
- [ ] No network activity for push/pull (check `--verbose`)
- [ ] Exit code 0 for all commands

* * *

## Phase 3: Compression & Configuration

### 3.1 Test Compression (zstd)

**Update config to always compress**:

```bash
cat >> .blobsy.yml << 'EOF'

compress:
  algorithm: zstd
  min_size: 10kb
  always:
    - "*.bin"
EOF
```

**Create new file and track**:

```bash
dd if=/dev/urandom of=compressible.bin bs=1024 count=1000  # 1MB
blobsy track compressible.bin
blobsy push --verbose
```

**Expected output**:

```
Pushing compressible.bin...
  → Compressing with zstd...
  ✓ Compressed 1.0 MB → 1.0 MB (ratio: 1.0x)
  ✓ Uploaded to 20260221T120100Z-xyz789.../compressible.bin.zst
✓ Pushed 1 file
```

**Check .yref for compression metadata**:

```bash
cat compressible.bin.yref
```

**Expected fields**:

```yaml
format: blobsy-yref/0.1
hash: sha256:xyz789...
size: 1024000
remote_key: 20260221T120100Z-xyz789.../compressible.bin.zst
compressed: zstd
compressed_size: 1024000  # (may be smaller depending on data entropy)
```

**Verify**:

- [ ] `compressed: zstd` field present
- [ ] `compressed_size:` <= original `size:`
- [ ] Remote key has `.zst` suffix

**Test decompression on pull**:

```bash
rm compressible.bin
blobsy pull compressible.bin --verbose
```

**Expected output**:

```
Pulling compressible.bin...
  ✓ Downloaded 1.0 MB
  → Decompressing with zstd...
  ✓ Decompressed to 1.0 MB
  ✓ Verified hash: sha256:xyz...
✓ Pulled 1 file
```

**Verify**:

- [ ] File restored correctly
- [ ] Hash verification passed
- [ ] File size matches original

### 3.2 Test Other Compression Algorithms

**Test gzip**:

```bash
# Update config
sed -i.bak 's/algorithm: zstd/algorithm: gzip/' .blobsy.yml
dd if=/dev/urandom of=gzip-test.bin bs=1024 count=500
blobsy track gzip-test.bin
blobsy push --verbose
```

**Verify**:

- [ ] Remote key has `.gz` suffix
- [ ] `.yref` shows `compressed: gzip`

**Test brotli**:

```bash
sed -i.bak 's/algorithm: gzip/algorithm: brotli/' .blobsy.yml
dd if=/dev/urandom of=brotli-test.bin bs=1024 count=500
blobsy track brotli-test.bin
blobsy push --verbose
```

**Verify**:

- [ ] Remote key has `.br` suffix
- [ ] `.yref` shows `compressed: brotli`

**Round-trip all algorithms**:

```bash
rm compressible.bin gzip-test.bin brotli-test.bin
blobsy pull --verbose
blobsy verify
```

**Verify**:

- [ ] All files pulled and decompressed correctly
- [ ] All files pass hash verification
- [ ] No errors

### 3.3 Test Externalization Rules

**Update config with size and pattern rules**:

```bash
cat > .blobsy.yml << 'EOF'
backend: default
backends:
  default:
    url: local:../blobsy-remote

externalize:
  min_size: 100kb
  always:
    - "*.onnx"
    - "*.model"
  never:
    - "*.txt"
    - "*.md"

compress:
  algorithm: none
EOF
```

**Create test files**:

```bash
dd if=/dev/urandom of=small.bin bs=1024 count=50       # 50KB (below min_size)
dd if=/dev/urandom of=large.bin bs=1024 count=200      # 200KB (above min_size)
dd if=/dev/urandom of=model.onnx bs=1024 count=10      # 10KB (always rule)
echo "Small text file" > notes.txt                      # (never rule)
```

**Track all files**:

```bash
blobsy track small.bin large.bin model.onnx notes.txt
```

**Expected behavior**:

- `small.bin`: ✗ Not tracked (too small)
- `large.bin`: ✓ Tracked (above min_size)
- `model.onnx`: ✓ Tracked (always rule)
- `notes.txt`: ✗ Not tracked (never rule)

**Verify**:

- [ ] Only `large.bin.yref` and `model.onnx.yref` created
- [ ] No `.yref` for `small.bin` or `notes.txt`

**Troubleshooting**:

- **Issue**: Files not externalized according to rules **Fix**: Check config syntax, run
  `blobsy config externalize` to view merged config

* * *

## Phase 4: Error Scenarios

### 4.1 Test Missing Backend (No Authentication)

**Temporarily break backend config**:

```bash
# Rename backend directory to simulate missing backend
mv ../blobsy-remote ../blobsy-remote.backup
```

**Try to push**:

```bash
blobsy push 2>&1
```

**Expected error**:

```
✗ Error: Backend directory not found: /tmp/blobsy-qa-test/blobsy-remote
  Suggestion: Check backend configuration in .blobsy.yml
```

**Verify**:

- [ ] Clear error message (not stack trace)
- [ ] Exit code 1 (check with `echo $?`)
- [ ] Helpful suggestion provided

**Try to pull**:

```bash
rm large.bin
blobsy pull large.bin 2>&1
```

**Expected error**:

```
✗ Error: Backend directory not found: /tmp/blobsy-qa-test/blobsy-remote
  Cannot read from backend
```

**Restore backend**:

```bash
mv ../blobsy-remote.backup ../blobsy-remote
```

### 4.2 Test Invalid .yref File

**Corrupt .yref file**:

```bash
# Save original
cp large.bin.yref large.bin.yref.backup

# Break hash field
sed -i.bak 's/sha256:/sha999:/' large.bin.yref
blobsy verify large.bin 2>&1
```

**Expected error**:

```
✗ Error: Invalid hash algorithm in large.bin.yref: sha999
  Supported: sha256
```

**Verify**:

- [ ] Validation error caught
- [ ] Clear error message
- [ ] Exit code 1

**Break YAML syntax**:

```bash
echo "invalid: yaml: syntax:" > large.bin.yref
blobsy status large.bin 2>&1
```

**Expected error**:

```
✗ Error: Failed to parse large.bin.yref
  YAML parse error: ...
```

**Restore .yref**:

```bash
mv large.bin.yref.backup large.bin.yref
```

### 4.3 Test Missing Local File (Untracked Push)

```bash
# Try to push file that isn't tracked
echo "test" > untracked.bin
blobsy push untracked.bin 2>&1
```

**Expected error**:

```
✗ Error: untracked.bin is not tracked
  Run: blobsy track untracked.bin
```

**Verify**:

- [ ] Clear error with actionable suggestion
- [ ] Exit code 1

### 4.4 Test Missing Remote Blob

**Delete remote blob, try to pull**:

```bash
# Find remote key from .yref
REMOTE_KEY=$(grep 'remote_key:' large.bin.yref | awk '{print $2}')
rm "../blobsy-remote/$REMOTE_KEY"
rm large.bin
blobsy pull large.bin 2>&1
```

**Expected error**:

```
✗ Error: Blob not found in backend: 20260221T...
  File: large.bin.yref
  Backend may be incomplete or corrupted
```

**Verify**:

- [ ] Error clearly identifies missing blob
- [ ] Suggests backend issue

**Fix by re-pushing**:

```bash
# Restore local file from another source or recreate
dd if=/dev/urandom of=large.bin bs=1024 count=5000
blobsy track large.bin --force
blobsy push large.bin --force
```

### 4.5 Test Sync Conflicts

**Create conflict scenario**:

```bash
# Modify file locally
echo "modified" >> medium-file.bin
blobsy track medium-file.bin --force  # Re-track with new hash

# Simulate remote change (edit .yref directly to fake different remote hash)
FAKE_HASH="sha256:0000000000000000000000000000000000000000000000000000000000000000"
sed -i.bak "s/hash: sha256:.*/hash: $FAKE_HASH/" medium-file.bin.yref

# Try to sync
blobsy sync medium-file.bin 2>&1
```

**Expected conflict error**:

```
✗ Conflict detected: medium-file.bin
  Local hash:  sha256:abc...
  Remote hash: sha256:000...
  Base hash:   sha256:def... (from stat cache)

  Resolution options:
  - Use local version:  blobsy sync medium-file.bin --force
  - Discard local:      blobsy pull medium-file.bin --force
  - Manual resolution:  inspect file and .yref
```

**Verify**:

- [ ] Three-way conflict detected
- [ ] All three hashes shown (local, remote, base)
- [ ] Clear resolution options provided
- [ ] Exit code 2 (conflict error)

**Resolve with --force**:

```bash
blobsy sync medium-file.bin --force
```

**Verify**:

- [ ] Local version wins
- [ ] No error
- [ ] File pushed successfully

* * *

## Phase 5: Advanced Operations

### 5.1 Test mv (Rename/Move)

**Create and track file**:

```bash
dd if=/dev/urandom of=original-name.bin bs=1024 count=100
blobsy track original-name.bin
blobsy push
```

**Rename file**:

```bash
blobsy mv original-name.bin new-name.bin
```

**Expected output**:

```
✓ Moved original-name.bin → new-name.bin
✓ Updated .yref reference
✓ Updated .gitignore
```

**Verify**:

- [ ] `new-name.bin` and `new-name.bin.yref` exist
- [ ] `original-name.bin` and `original-name.bin.yref` deleted
- [ ] `.gitignore` updated (old name removed, new name added)
- [ ] `.yref` remote_key still valid (unchanged)

**Test status after rename**:

```bash
blobsy status new-name.bin
```

**Expected**:

```
new-name.bin.yref
  Local:  ✓ (sha256:...)
  Remote: ✓ (sha256:...)
```

**Verify**:

- [ ] Status recognizes renamed file
- [ ] Remote association preserved

### 5.2 Test rm (Delete Tracked File)

**Delete local and remote**:

```bash
blobsy rm new-name.bin
```

**Expected output**:

```
✓ Deleted new-name.bin (local)
✓ Deleted new-name.bin from backend
✓ Removed new-name.bin.yref
✓ Updated .gitignore
```

**Verify**:

- [ ] Local file deleted
- [ ] .yref file deleted
- [ ] .gitignore entry removed
- [ ] Backend blob deleted

**Test rm --local (keep remote)**:

```bash
dd if=/dev/urandom of=keep-remote.bin bs=1024 count=100
blobsy track keep-remote.bin
blobsy push
blobsy rm keep-remote.bin --local
```

**Expected**:

```
✓ Deleted keep-remote.bin (local)
✓ Removed keep-remote.bin.yref
✓ Remote blob kept in backend
```

**Verify**:

- [ ] Local file and .yref deleted
- [ ] Backend blob still exists (check `ls ../blobsy-remote/`)

### 5.3 Test Sync Workflow

**Create file, track, push**:

```bash
dd if=/dev/urandom of=sync-test.bin bs=1024 count=200
blobsy track sync-test.bin
blobsy push
```

**Simulate changes and sync**:

```bash
# Case 1: Local change only
echo "local change" >> sync-test.bin
blobsy sync sync-test.bin
```

**Expected**:

```
Syncing sync-test.bin...
  → Local changed, pushing...
  ✓ Pushed sync-test.bin
✓ Synced 1 file
```

**Verify**:

- [ ] Local change detected
- [ ] File pushed automatically
- [ ] Status shows in-sync

**Test sync is idempotent**:

```bash
blobsy sync sync-test.bin
```

**Expected**:

```
✓ sync-test.bin up-to-date
```

**Verify**:

- [ ] No push or pull activity
- [ ] Exit code 0

### 5.4 Test Git Hooks

**Install pre-commit hook**:

```bash
blobsy hooks install
```

**Expected output**:

```
✓ Installed pre-commit hook to .git/hooks/pre-commit
```

**Verify**:

- [ ] `.git/hooks/pre-commit` exists and is executable
- [ ] Hook script contains blobsy check

**Test hook prevents committing large tracked files**:

```bash
git add large.bin large.bin.yref
git commit -m "Test commit" 2>&1
```

**Expected hook behavior**:

```
✗ Pre-commit check failed:
  large.bin is tracked by blobsy but not in .gitignore
  Add to .gitignore or commit only the .yref file

  To bypass: git commit --no-verify
```

**Verify**:

- [ ] Commit blocked
- [ ] Clear error message
- [ ] Bypass option mentioned

**Test hook allows .yref files**:

```bash
git reset
git add large.bin.yref
git commit -m "Add large file reference"
```

**Expected**:

```
✓ Pre-commit check passed
[main abc1234] Add large file reference
 1 file changed, 5 insertions(+)
```

**Verify**:

- [ ] Commit succeeds
- [ ] Only .yref committed (check `git show --stat`)

**Uninstall hook**:

```bash
blobsy hooks uninstall
```

**Verify**:

- [ ] `.git/hooks/pre-commit` removed (or blobsy section removed)

* * *

## Phase 6: Cloud Backend (S3/R2) - Optional but Recommended

**Prerequisites**:

- AWS credentials configured (`~/.aws/credentials` or env vars) OR Cloudflare R2
  credentials
- Test bucket created with write permissions

### 6.1 Initialize S3 Backend

**For AWS S3**:

```bash
blobsy init s3://your-test-bucket/blobsy-qa/ --region us-east-1
```

**For Cloudflare R2**:

```bash
blobsy init s3://your-r2-bucket/blobsy-qa/ \
  --endpoint https://your-account-id.r2.cloudflarestorage.com \
  --region auto
```

**Expected output**:

```
✓ Updated .blobsy.yml
✓ Backend configured: s3://your-test-bucket/blobsy-qa/
Run: blobsy health to test connectivity
```

**Verify**:

- [ ] `.blobsy.yml` updated with S3 URL
- [ ] `region` and `endpoint` (if R2) saved

### 6.2 Test Cloud Connectivity

```bash
blobsy health
```

**Expected output (success)**:

```
✓ Backend health check passed
✓ Can write to s3://your-test-bucket/blobsy-qa/
✓ Can read from s3://your-test-bucket/blobsy-qa/
✓ Can delete from s3://your-test-bucket/blobsy-qa/
```

**Verify**:

- [ ] All operations succeed
- [ ] Exit code 0

**Common errors and checks**:

**Error: “Access Denied”**

```bash
# Check credentials
aws sts get-caller-identity  # (if using AWS CLI)
```

**Verify**:

- [ ] AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY set
- [ ] Credentials valid and not expired
- [ ] IAM permissions include `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`

**Error: “Bucket does not exist”**

```bash
# List buckets
aws s3 ls  # (if using AWS CLI)
```

**Verify**:

- [ ] Bucket name is correct
- [ ] Bucket exists in the specified region

**Error: “Invalid endpoint”**

**Verify**:

- [ ] Endpoint URL is correct (for R2/S3-compatible)
- [ ] URL includes `https://` scheme

### 6.3 Push to S3 Backend

```bash
# Create test file
dd if=/dev/urandom of=s3-test.bin bs=1024 count=500
blobsy track s3-test.bin
blobsy push s3-test.bin --verbose
```

**Expected output**:

```
Pushing s3-test.bin...
  → Uploading to s3://your-test-bucket/blobsy-qa/20260221T...
  ✓ Uploaded 500.0 KB
✓ Pushed 1 file
```

**Verify using AWS CLI (if available)**:

```bash
aws s3 ls s3://your-test-bucket/blobsy-qa/ --recursive
```

**Expected**:

```
2026-02-21 12:00:00  512000  20260221T120000Z-abc123.../s3-test.bin
```

**Verify**:

- [ ] File visible in S3 bucket
- [ ] Size matches
- [ ] Path follows template (ISO date + hash + filename)

### 6.4 Pull from S3 Backend

```bash
rm s3-test.bin
blobsy pull s3-test.bin --verbose
```

**Expected output**:

```
Pulling s3-test.bin...
  ✓ Downloaded from s3://your-test-bucket/blobsy-qa/20260221T...
  ✓ Verified hash: sha256:abc...
✓ Pulled 1 file
```

**Verify**:

- [ ] File restored
- [ ] Hash verified
- [ ] File size matches original

### 6.5 Test Network Error Handling

**Simulate network timeout** (requires firewall rule or invalid endpoint):

```bash
# Temporarily break endpoint (for R2 example)
sed -i.bak 's/endpoint: https:/endpoint: https:\/\/invalid-/' .blobsy.yml
blobsy push s3-test.bin 2>&1
```

**Expected error**:

```
✗ Error: Network error connecting to S3
  Error: getaddrinfo ENOTFOUND invalid-your-account-id.r2.cloudflarestorage.com
  Check your network connection and endpoint configuration
```

**Verify**:

- [ ] Error type identified (network)
- [ ] Helpful suggestion provided
- [ ] Exit code 1

**Restore config**:

```bash
mv .blobsy.yml.bak .blobsy.yml
```

### 6.6 Test S3-Specific Errors

**Test invalid bucket name**:

```bash
blobsy init s3://Invalid_Bucket_Name/ --region us-east-1 2>&1
```

**Expected validation error**:

```
✗ Error: Invalid S3 bucket name: Invalid_Bucket_Name
  Bucket names must be 3-63 characters, lowercase alphanumeric and hyphens only
  See: https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
```

**Verify**:

- [ ] Client-side validation (fast failure)
- [ ] Clear rules provided

**Test missing region**:

```bash
blobsy init s3://test-bucket/prefix/ 2>&1
```

**Expected error or prompt**:

```
✗ Error: AWS region required for S3 backend
  Specify with: blobsy init s3://... --region <region>
  Or set environment variable: AWS_DEFAULT_REGION
```

**Verify**:

- [ ] Clear guidance provided
- [ ] Multiple solutions offered

* * *

## Phase 7: Cleanup & Doctor Validation

### 7.1 Test Doctor Command (Diagnostic)

**Run diagnostic scan**:

```bash
blobsy doctor --verbose
```

**Expected output (healthy repo)**:

```
Checking repository health...
✓ Backend connectivity OK
✓ All .yref files valid (10 checked)
✓ All tracked files present locally (10/10)
✓ All remote blobs accessible (10/10)
✓ Stat cache consistent (10 entries)
✓ No orphaned files
Repository is healthy.
```

**Verify**:

- [ ] All checks passed
- [ ] Exit code 0

**Simulate issues and test doctor**:

```bash
# Create orphaned .yref (missing local file)
dd if=/dev/urandom of=orphan.bin bs=1024 count=50
blobsy track orphan.bin
blobsy push orphan.bin
rm orphan.bin

# Run doctor
blobsy doctor
```

**Expected output**:

```
Checking repository health...
✓ Backend connectivity OK
✓ All .yref files valid
⚠ Missing local files: 1
  - orphan.bin (has .yref but file missing)
✓ All remote blobs accessible
✓ Stat cache mostly consistent (1 stale entry)

Issues found: 1 warning
Run with --fix to attempt automatic repair
```

**Verify**:

- [ ] Missing file detected
- [ ] Categorized as warning (not error)
- [ ] `--fix` option suggested

### 7.2 Test Doctor --fix (Automatic Repair)

```bash
blobsy doctor --fix --verbose
```

**Expected output**:

```
Checking repository health...
✓ Backend connectivity OK
✓ All .yref files valid
⚠ Missing local files: 1
  → Pulling orphan.bin from backend...
  ✓ Restored orphan.bin
✓ All remote blobs accessible
✓ Stat cache updated (1 entry refreshed)

Repairs completed: 1 file restored
Repository is now healthy.
```

**Verify**:

- [ ] Missing file automatically pulled
- [ ] Stat cache updated
- [ ] No errors

**Verify file restored**:

```bash
blobsy verify orphan.bin
```

**Expected**:

```
✓ orphan.bin (sha256:... matches .yref)
```

### 7.3 Test Untrack (Cleanup)

**Untrack single file**:

```bash
blobsy untrack orphan.bin
```

**Expected output**:

```
✓ Untracked orphan.bin
✓ Removed orphan.bin.yref
✓ Updated .gitignore
Local file kept: orphan.bin
```

**Verify**:

- [ ] `.yref` file deleted
- [ ] `.gitignore` entry removed
- [ ] Local file still exists

**Untrack directory recursively**:

```bash
mkdir subdir
dd if=/dev/urandom of=subdir/file1.bin bs=1024 count=100
dd if=/dev/urandom of=subdir/file2.bin bs=1024 count=100
blobsy track subdir/*.bin
blobsy push

# Untrack all
blobsy untrack subdir/ --recursive
```

**Expected output**:

```
✓ Untracked subdir/file1.bin
✓ Untracked subdir/file2.bin
✓ Removed 2 .yref files
✓ Updated .gitignore
```

**Verify**:

- [ ] All `.yref` files in subdirectory removed
- [ ] Local files kept
- [ ] `.gitignore` cleaned up

### 7.4 Final Repository Validation

**Run comprehensive final checks**:

```bash
blobsy status --verbose
blobsy verify
blobsy health
blobsy doctor
git status
```

**Verify all clean**:

- [ ] `blobsy status`: All files in sync or properly managed
- [ ] `blobsy verify`: All files pass hash check
- [ ] `blobsy health`: Backend connectivity OK
- [ ] `blobsy doctor`: No issues
- [ ] `git status`: Clean working tree (only .yref files committed)

**Check JSON outputs for all commands**:

```bash
blobsy status --json | jq .
blobsy verify --json | jq .
blobsy health --json | jq .
```

**Verify JSON validity**:

- [ ] All produce valid JSON
- [ ] Consistent structure (status, files, errors)
- [ ] No parser errors from `jq`

* * *

## Troubleshooting

### Command Fails with “Backend not configured”

```bash
blobsy config backend
```

**Solution**: Initialize backend with `blobsy init <url>`

### Status Shows “Hash mismatch”

```bash
blobsy verify --verbose
```

**Likely causes**:

- File modified after tracking (re-track with `blobsy track --force`)
- Corrupted .yref file (restore from git or regenerate)

**Fix**: Re-track file or restore from remote with `blobsy pull --force`

### Push Fails with “Permission denied” (S3)

```bash
aws sts get-caller-identity  # Check credentials
```

**Solution**: Verify IAM permissions include `s3:PutObject` on bucket/prefix

### Pull Fails with “Blob not found”

```bash
blobsy status <file> --verbose  # Check remote_key
```

**Solution**: Check backend for blob, or re-push with `blobsy push --force`

### Sync Reports Conflict

```bash
blobsy status <file> --verbose  # See all three hashes
```

**Resolution options**:

- Use local: `blobsy sync <file> --force`
- Use remote: `blobsy pull <file> --force`
- Manual: inspect file and `.yref`, resolve manually

### Pre-commit Hook Blocks Commit

```bash
git status  # Check what's staged
```

**Solution**: Only commit `.yref` files, not the original large files (they should be in
.gitignore)

### Doctor Reports Issues

```bash
blobsy doctor --verbose  # Detailed diagnostics
blobsy doctor --fix      # Attempt automatic repair
```

**Manual fixes**:

- Missing files: `blobsy pull`
- Orphaned `.yref`: `blobsy untrack` or delete manually
- Stale stat cache: Delete `.blobsy/stat-cache/` and run `blobsy verify`

* * *

## Success Criteria

Before marking this test as **PASSED**, verify:

- [ ] **Installation**: `blobsy --version` and `blobsy --help` work
- [ ] **Basic workflow**: track → push → pull → verify completes without errors
- [ ] **Compression**: All algorithms (zstd, gzip, brotli) round-trip successfully
- [ ] **Configuration**: Externalization rules and config merging work correctly
- [ ] **Error handling**: All error scenarios produce clear, actionable messages (not
  stack traces)
- [ ] **Git integration**: Pre-commit hooks work, .gitignore managed correctly
- [ ] **Cloud backend**: S3/R2 connectivity works (if credentials available)
- [ ] **Advanced ops**: mv, rm, sync, conflict resolution work as documented
- [ ] **Idempotency**: Re-running operations is safe and produces expected no-ops
- [ ] **Doctor**: Diagnostic and repair functions detect and fix common issues
- [ ] **JSON output**: All commands with `--json` produce valid, parseable output
- [ ] **Exit codes**: Success (0), validation errors (1), conflicts (2) consistently
  used
- [ ] **Documentation**: All error messages reference help docs or suggest next steps

**Performance checks** (optional):

- [ ] Tracking 100+ files completes in reasonable time (< 30 seconds)
- [ ] Push/pull of 10MB files completes without timeout
- [ ] Stat cache reduces re-hashing on unchanged files (verify with `--verbose`)

* * *

**Final Notes**:

- This playbook covers the critical paths for v1.0 validation
- Run this playbook on a clean environment before each release
- Update “Current Status” table and “Test Results” as you progress
- Document any discrepancies or unexpected behaviors for investigation
- For production use, also test with real multi-user scenarios and large-scale repos
  (1000+ files)

* * *

**QA Completed by**: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

**Date**: \_\_\_\_\_\_\_\_\_\_\_\_

**Version Tested**: blobsy v\_\_\_\_\_\_\_\_\_\_

**Overall Result**: ⏳ Pending / ✅ PASSED / ❌ FAILED

**Notes**:
\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_
