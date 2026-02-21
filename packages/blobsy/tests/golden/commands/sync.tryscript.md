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
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Sync when nothing is pushed (pushes all)

```console
$ blobsy sync
Syncing 2 tracked files...
  ◑ data/dataset.csv (12 B) - pushed
  ◑ data/model.bin (13 B) - pushed
Done: 2 pushed, 0 pulled.

Reminder: 2 .yref files have uncommitted changes. Run 'git add -A && git commit' to commit.
? 0
```

# Commit and sync again (up to date)

```console
$ git add -A && git commit -q -m "push files"
$ blobsy sync
Syncing 2 tracked files...
  ✓ data/dataset.csv (up to date)
  ✓ data/model.bin (up to date)
Done: 0 pushed, 0 pulled. All up to date.
? 0
```

# Modify a file, re-track, then sync (pushes the change)

```console
$ echo "updated model" > data/model.bin
$ blobsy track data/model.bin
Updated data/model.bin.yref (hash changed)
$ blobsy sync
Syncing 2 tracked files...
  ✓ data/dataset.csv (up to date)
  ◑ data/model.bin (14 B) - pushed
Done: 1 pushed, 0 pulled.

Reminder: 1 .yref file has uncommitted changes. Run 'git add -A && git commit' to commit.
? 0
```

# Delete a local file, sync pulls it back

```console
$ git add -A && git commit -q -m "update model"
$ rm data/dataset.csv
$ blobsy sync
Syncing 2 tracked files...
  data/dataset.csv (12 B) - pulled
  ✓ data/model.bin (up to date)
Done: 0 pushed, 1 pulled.
? 0
```

# Sync specific path only

```console
$ blobsy sync data/model.bin
Syncing 1 tracked file...
  ✓ data/model.bin (up to date)
Done: 0 pushed, 0 pulled. All up to date.
? 0
```
