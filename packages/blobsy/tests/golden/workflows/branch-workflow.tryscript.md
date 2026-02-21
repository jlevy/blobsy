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
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
  blobsy push
  git add -A && git commit -q -m "push model"
---
# Start on main: fully synced

```console
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

# Create feature branch

```console
$ git checkout -q -b feature/new-data
? 0
```

# Add a new file on feature branch

```console
$ cp another-file.txt data/results.csv
$ blobsy track data/results.csv
Tracking data/results.csv
Created data/results.csv.yref
Added data/results.csv to .gitignore
$ git add -A && git commit -q -m "track results"
$ blobsy push
[..]
$ git add -A && git commit -q -m "push results"
? 0
```

# Feature branch status: both files synced

```console
$ blobsy status
Tracked files (2):
  ✓ data/model.bin (committed and synced)
  ✓ data/results.csv (committed and synced)

All files synced.
? 0
```

# Merge back to main

```console
$ git checkout -q main
$ git merge -q feature/new-data
? 0
```

# On main after merge: results.csv .yref merged cleanly

```console
$ blobsy status
Tracked files (2):
  ✓ data/model.bin (committed and synced)
  ✓ data/results.csv (committed and synced)

All files synced.
? 0
```

# No post-merge gap: blobs already exist from feature branch push

```console
$ blobsy sync
Syncing 2 tracked files...
  ✓ data/model.bin (up to date)
  ✓ data/results.csv (up to date)
Done: 0 pushed, 0 pulled. All up to date.
? 0
```

# Verify all files

```console
$ blobsy verify
Verifying 2 tracked files...
  data/model.bin     ok (sha256 matches)
  data/results.csv   ok (sha256 matches)
2 ok, 0 mismatch, 0 missing.
? 0
```
