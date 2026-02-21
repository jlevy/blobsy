---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data ../remote
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

# Status after push (synced but ref not committed with remote_key)

```console
$ blobsy push data/model.bin
[..]
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

# Status with missing file

```console
$ rm data/model.bin
$ blobsy status
Tracked files (1):
  ? data/model.bin (file missing)

Summary:
  1 missing (?)

Actions needed:
  Run 'blobsy pull data/model.bin' or 'blobsy rm data/model.bin'
? 0
```

# Status with multiple files in various states

```console
$ echo "hello blobsy" > data/model.bin
$ blobsy track data/dataset.csv
Tracking data/dataset.csv
Created data/dataset.csv.yref
Added data/dataset.csv to .gitignore
$ blobsy status
Tracked files (2):
  ✓ data/model.bin (committed and synced)
  ○ data/dataset.csv (not committed, not synced)

Summary:
  1 fully synced (✓)
  1 needs push and commit (○)

Actions needed:
  Run 'blobsy push' to sync 1 file
  Run 'git add -A && git commit' to commit refs
? 0
```

# Status for a specific path

```console
$ blobsy status data/model.bin
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```
