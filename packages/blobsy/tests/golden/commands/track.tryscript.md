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
  cp small-file.txt data/model.bin
---
# Filesystem before tracking

```console
$ find . -not -path './.git/*' -not -name '.git' | sort
.
./.blobsy.yml
./another-file.txt
./data
./data/model.bin
./small-file.txt
? 0
```

# Track a single file

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore
? 0
```

# Filesystem after tracking -- shows new .bref, .gitignore, and .blobsy/ stat cache

```console
$ find . -not -path './.git/*' -not -name '.git' | sort
.
./.blobsy
./.blobsy.yml
./.blobsy/stat-cache
./.blobsy/stat-cache/cb
./.blobsy/stat-cache/cb/cb917534c6ff03d0bd.json
./another-file.txt
./data
./data/.gitignore
./data/model.bin
./data/model.bin.bref
./small-file.txt
? 0
```

# Verify the ref file content

```console
$ cat data/model.bin.bref
# blobsy -- https://github.com/jlevy/blobsy
# Run: blobsy status | blobsy --help

format: blobsy-bref/0.1
hash: sha256:d02661ea043df3668295984682388a6ac5bae0e7ebe9f27ee8216a4cc224d934
size: 13
? 0
```

# Verify gitignore was updated

```console
$ cat data/.gitignore
# >>> blobsy-managed (do not edit) >>>
model.bin
# <<< blobsy-managed <<<
? 0
```

# Track same file again (idempotent, unchanged)

```console
$ blobsy track data/model.bin
data/model.bin already tracked (unchanged)
? 0
```

# Modify the file and re-track

```console
$ echo "updated content for model" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin
Updated data/model.bin.bref (hash changed)
? 0
```

# Verify ref updated with new hash and size

```console
$ grep -E 'hash|size' data/model.bin.bref
hash: sha256:dbae774e10a267ad13610c357c9d739f7c5729092fff3ec7b9e72a4a79d4f72d
size: 26
? 0
```

# Track via .bref path (equivalent to file path)

```console
$ echo "hello blobsy" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin.bref
Updated data/model.bin.bref (hash changed)
? 0
```

# Track a directory

```console
$ mkdir -p data/research
? 0
```

```console
$ cp small-file.txt data/research/report.bin
? 0
```

```console
$ cp another-file.txt data/research/data.bin
? 0
```

```console
$ blobsy track data/research/
Scanning data/research/...
  data/research/data.bin (  12 B)  -> tracked
  data/research/report.bin (  13 B)  -> tracked
2 files tracked.
? 0
```

# Filesystem after directory tracking -- each file gets its own .bref

```console
$ find data/ | sort
data/
data/.gitignore
data/model.bin
data/model.bin.bref
data/research
data/research/.gitignore
data/research/data.bin
data/research/data.bin.bref
data/research/report.bin
data/research/report.bin.bref
? 0
```

# Verify directory gitignore (per-directory, manages files in that directory)

```console
$ cat data/research/.gitignore
# >>> blobsy-managed (do not edit) >>>
data.bin
report.bin
# <<< blobsy-managed <<<
? 0
```

# Track directory again (idempotent)

```console
$ blobsy track data/research/
Scanning data/research/...
  data/research/data.bin (  12 B)  -> already tracked (unchanged)
  data/research/report.bin (  13 B)  -> already tracked (unchanged)
0 files tracked, 2 unchanged.
? 0
```
