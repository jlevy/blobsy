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
  mkdir -p data/models data/datasets ../remote
---
# Track multiple files across directories

```console
$ for i in 1 2 3; do echo "model $i" > data/models/model-$i.bin; done
$ for i in 1 2 3; do echo "dataset $i" > data/datasets/data-$i.csv; done
$ blobsy track data/models/
Scanning data/models/...
  data/models/model-1.bin   (8 B)  -> tracked
  data/models/model-2.bin   (8 B)  -> tracked
  data/models/model-3.bin   (8 B)  -> tracked
3 files tracked.
$ blobsy track data/datasets/
Scanning data/datasets/...
  data/datasets/data-1.csv   (10 B)  -> tracked
  data/datasets/data-2.csv   (10 B)  -> tracked
  data/datasets/data-3.csv   (10 B)  -> tracked
3 files tracked.
? 0
```

# Status shows all 6 files

```console
$ blobsy status
Tracked files (6):
  ○ data/datasets/data-1.csv (not committed, not synced)
  ○ data/datasets/data-2.csv (not committed, not synced)
  ○ data/datasets/data-3.csv (not committed, not synced)
  ○ data/models/model-1.bin (not committed, not synced)
  ○ data/models/model-2.bin (not committed, not synced)
  ○ data/models/model-3.bin (not committed, not synced)

Summary:
  6 need push and commit (○)

Actions needed:
  Run 'blobsy push' to sync 6 files
  Run 'git add -A && git commit' to commit refs
? 0
```

# Commit and push all

```console
$ git add -A && git commit -q -m "track all"
$ blobsy push
Pushing 6 files...
  ◑ data/datasets/data-1.csv (10 B) - pushed
  ◑ data/datasets/data-2.csv (10 B) - pushed
  ◑ data/datasets/data-3.csv (10 B) - pushed
  ◑ data/models/model-1.bin (8 B) - pushed
  ◑ data/models/model-2.bin (8 B) - pushed
  ◑ data/models/model-3.bin (8 B) - pushed
Done: 6 pushed.
? 0
```

# Remote has 6 blobs

```console
$ find ../remote/ -type f | wc -l
6
? 0
```

# Commit, then verify all

```console
$ git add -A && git commit -q -m "push all"
$ blobsy verify
Verifying 6 tracked files...
  data/datasets/data-1.csv   ok (sha256 matches)
  data/datasets/data-2.csv   ok (sha256 matches)
  data/datasets/data-3.csv   ok (sha256 matches)
  data/models/model-1.bin    ok (sha256 matches)
  data/models/model-2.bin    ok (sha256 matches)
  data/models/model-3.bin    ok (sha256 matches)
6 ok, 0 mismatch, 0 missing.
? 0
```

# Delete some files and sync pulls them back

```console
$ rm data/models/model-1.bin data/datasets/data-2.csv
$ blobsy sync
Syncing 6 tracked files...
  ✓ data/datasets/data-1.csv (up to date)
  data/datasets/data-2.csv (10 B) - pulled
  ✓ data/datasets/data-3.csv (up to date)
  data/models/model-1.bin (8 B) - pulled
  ✓ data/models/model-2.bin (up to date)
  ✓ data/models/model-3.bin (up to date)
Done: 0 pushed, 2 pulled.
? 0
```

# Everything is back

```console
$ cat data/models/model-1.bin
model 1
$ cat data/datasets/data-2.csv
dataset 2
? 0
```
