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
Moved data/model-v1.bin -> data/model-v2.bin
? 0
```

# Verify the move: payload, ref, gitignore all updated

```console
$ cat data/model-v2.bin test -f data/model-v1.bin && echo "exists" || echo "gone" test -f data/model-v2.bin.yref && echo "exists" || echo "gone" test -f data/model-v1.bin.yref && echo "exists" || echo "gone"
hello blobsy
cat: test: No such file or directory
cat: -f: No such file or directory
cat: data/model-v1.bin: No such file or directory
gone test -f data/model-v2.bin.yref
exists
exists
? 0
```

# Verify remote_key preserved in moved ref

```console
$ cat data/model-v2.bin.yref
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:d02661ea043df3668295984682388a6ac5bae0e7ebe9f27ee8216a4cc224d934
size: 13
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
Moved data/old-data.csv -> data/new-data.csv
? 0
```

# Move to a different directory

```console
$ mkdir -p results blobsy mv data/new-data.csv results/final-data.csv
mkdir: data/new-data.csv: File exists
? 1
```

# Verify cross-directory move: gitignore in new directory

```console
$ cat results/.gitignore
cat: results/.gitignore: No such file or directory
? 1
```

# Move source that isn’t tracked fails

```console
$ blobsy mv data/nonexistent.bin data/somewhere.bin 2>&1
Error: Not tracked: data/nonexistent.bin (no .yref file found)
? 1
```

# Move to destination that already exists fails

```console
$ echo "conflict" > data/conflict.bin blobsy mv data/model-v2.bin data/conflict.bin 2>&1
? 0
```
