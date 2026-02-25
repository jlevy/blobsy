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
  mkdir -p data
  cp small-file.txt data/model-v1.bin
  cp another-file.txt data/old-data.csv
  blobsy track data/model-v1.bin
  blobsy track data/old-data.csv
  git add -A && git commit -q -m "track files"
---
# Move a tracked file

```console
$ blobsy mv data/model-v1.bin data/model-v2.bin
Moved data/model-v1.bin -> data/model-v2.bin
? 0
```

# Verify payload moved

```console
$ cat data/model-v2.bin
hello blobsy
? 0
```

# Verify old file gone

```console
$ test -f data/model-v1.bin && echo "exists" || echo "gone"
gone
? 0
```

# Verify new ref exists, old ref gone

```console
$ test -f data/model-v2.bin.bref && echo "ref exists"
ref exists
? 0
```

```console
$ test -f data/model-v1.bin.bref && echo "exists" || echo "gone"
gone
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

# Move via .bref path (equivalent)

```console
$ blobsy mv data/old-data.csv.bref data/new-data.csv
Moved data/old-data.csv -> data/new-data.csv
? 0
```

# Move to a different directory

```console
$ mkdir -p results
? 0
```

```console
$ blobsy mv data/new-data.csv results/final-data.csv
Moved data/new-data.csv -> results/final-data.csv
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
Error: Not tracked: data/nonexistent.bin (no .bref file found)
? 1
```

# Set up for directory move test

```console
$ mkdir -p data/research
? 0
```

```console
$ echo "research model" > data/research/model.bin
? 0
```

```console
$ echo "research data" > data/research/data.bin
? 0
```

```console
$ blobsy config externalize.min_size 5
Set externalize.min_size = 5
? 0
```

```console
$ blobsy track data/research/
Scanning data/research/...
  data/research/data.bin (  14 B)  -> tracked
  data/research/model.bin (  15 B)  -> tracked
2 files tracked.
? 0
```

# Move a directory of tracked files

```console
$ blobsy mv data/research archive/research
Moved data/research/data.bin -> archive/research/data.bin
Moved data/research/model.bin -> archive/research/model.bin
? 0
```

# Verify files moved to new location

```console
$ cat archive/research/model.bin
research model
? 0
```

```console
$ cat archive/research/data.bin
research data
? 0
```

# Verify refs moved

```console
$ test -f archive/research/model.bin.bref && echo "ref exists"
ref exists
? 0
```

```console
$ test -f archive/research/data.bin.bref && echo "ref exists"
ref exists
? 0
```

# Verify old directory has no tracked files

```console
$ test -f data/research/model.bin.bref && echo "exists" || echo "gone"
gone
? 0
```

# Verify gitignore in new directory

```console
$ cat archive/research/.gitignore
# >>> blobsy-managed (do not edit) >>>
data.bin
model.bin
# <<< blobsy-managed <<<
? 0
```
