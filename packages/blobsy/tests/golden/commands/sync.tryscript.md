---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p remote
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Sync when nothing is pushed (pushes all)

```console
$ blobsy sync
  ↑ data/dataset.csv - pushed
  ↑ data/model.bin - pushed
Sync complete: 2 pushed, 0 pulled, 0 errors.
? 0
```

# Both refs have remote_key after sync

```console
$ grep -l remote_key data/*.bref | wc -l | tr -d ' '
2
? 0
```

# Sync again (up to date)

```console
$ blobsy sync
  ✓ data/dataset.csv - up to date
  ✓ data/model.bin - up to date
Sync complete: 0 pushed, 0 pulled, 0 errors.
? 0
```

# Modify a file, re-track, then sync

```console
$ echo "updated model" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin
Updated data/model.bin.bref (hash changed)

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ blobsy sync
  ✓ data/dataset.csv - up to date
  ↑ data/model.bin - pushed
Sync complete: 1 pushed, 0 pulled, 0 errors.
? 0
```

# Verify updated ref has remote_key

```console
$ grep remote_key data/model.bin.bref
remote_key: [REMOTE_KEY]
? 0
```

# Delete a local file, sync pulls it back

```console
$ rm data/dataset.csv
? 0
```

```console
$ blobsy sync
  ↓ data/dataset.csv - pulled
  ✓ data/model.bin - up to date
Sync complete: 0 pushed, 1 pulled, 0 errors.
? 0
```

# Verify pulled file content

```console
$ cat data/dataset.csv
second file
? 0
```

# Both files present after full sync

```console
$ test -f data/model.bin && test -f data/dataset.csv && echo "both present"
both present
? 0
```

# Sync fails when backend health check fails

```console
$ chmod 000 remote
? 0
```

```console
$ blobsy sync 2>&1
Health check failed: Local backend directory is not writable: [LOCAL_PATH]
? 1
```

```console
$ chmod 755 remote
? 0
```

# Sync with --skip-health-check bypasses health check

```console
$ blobsy sync --skip-health-check
  ✓ data/dataset.csv - up to date
  ✓ data/model.bin - up to date
Sync complete: 0 pushed, 0 pulled, 0 errors.
? 0
```

# Sync refuses modified-since-track content, like push (DS-03)

```console
$ echo "edited after track" > data/new-file.bin && blobsy track data/new-file.bin >/dev/null 2>&1 && echo "changed again" > data/new-file.bin
? 0
```

```console
$ blobsy sync data/new-file.bin 2>&1
  ✗ data/new-file.bin - push refused: changed since track; re-track with `blobsy track <path>` then `blobsy push --force`
Sync complete: 0 pushed, 0 pulled, 1 errors.
? 1
```

```console
$ blobsy --dry-run sync data/new-file.bin
Would refuse data/new-file.bin (changed since track; re-track with `blobsy track <path>` then `blobsy push --force`)
? 1
```
