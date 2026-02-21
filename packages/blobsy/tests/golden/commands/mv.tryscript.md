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
  cp small-file.txt data/model-v1.bin
  cp another-file.txt data/old-data.csv
  blobsy track data/model-v1.bin
  blobsy track data/old-data.csv
  git add -A && git commit -q -m "track files"
  blobsy push
  git add -A && git commit -q -m "push files"
---
# Move a tracked file

```console
$ blobsy mv data/model-v1.bin data/model-v2.bin
Moved: data/model-v1.bin -> data/model-v2.bin
Moved: data/model-v1.bin.yref -> data/model-v2.bin.yref
Updated .gitignore (removed old entry, added new entry)

Next: Run 'git add -A && git commit -m "Rename model"'
? 0
```

# Verify the move: payload, ref, gitignore all updated

```console
$ cat data/model-v2.bin
hello blobsy
$ test -f data/model-v1.bin && echo "exists" || echo "gone"
gone
$ test -f data/model-v2.bin.yref && echo "exists" || echo "gone"
exists
$ test -f data/model-v1.bin.yref && echo "exists" || echo "gone"
gone
? 0
```

# Verify remote_key preserved in moved ref

```console
$ cat data/model-v2.bin.yref
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: [HASH]
size: 13
remote_key: [REMOTE_KEY]
? 0
```

# Verify gitignore updated

```console
$ cat data/.gitignore
# >>> blobsy-managed (do not edit) >>>
model-v2.bin
old-data.csv
# <<< blobsy-managed <<<
? 0
```

# Move via .yref path (equivalent)

```console
$ blobsy mv data/old-data.csv.yref data/new-data.csv
Moved: data/old-data.csv -> data/new-data.csv
Moved: data/old-data.csv.yref -> data/new-data.csv.yref
Updated .gitignore (removed old entry, added new entry)

Next: Run 'git add -A && git commit -m "Rename old-data.csv"'
? 0
```

# Move to a different directory

```console
$ mkdir -p results
$ blobsy mv data/new-data.csv results/final-data.csv
Moved: data/new-data.csv -> results/final-data.csv
Moved: data/new-data.csv.yref -> results/final-data.csv.yref
Updated .gitignore (removed old entry, added new entry)

Next: Run 'git add -A && git commit -m "Move new-data.csv"'
? 0
```

# Verify cross-directory move: gitignore in new directory

```console
$ cat results/.gitignore
# >>> blobsy-managed (do not edit) >>>
final-data.csv
# <<< blobsy-managed <<<
? 0
```

# Move source that isn’t tracked fails

```console
$ blobsy mv data/nonexistent.bin data/somewhere.bin 2>&1
Error: data/nonexistent.bin is not tracked (no .yref file found)
? 1
```

# Move to destination that already exists fails

```console
$ echo "conflict" > data/conflict.bin
$ blobsy mv data/model-v2.bin data/conflict.bin 2>&1
Error: Destination data/conflict.bin already exists.
Remove it first or choose a different name.
? 1
```
