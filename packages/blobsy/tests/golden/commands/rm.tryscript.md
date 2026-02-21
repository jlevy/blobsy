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
  mkdir -p data/old ../remote
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  cp small-file.txt data/old/file1.bin
  cp another-file.txt data/old/file2.bin
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  blobsy track data/old/
  git add -A && git commit -q -m "track files"
  blobsy push
  git add -A && git commit -q -m "push files"
---
# Default rm: delete local file + move ref to trash

```console
$ blobsy rm data/dataset.csv
Removed data/dataset.csv
Moved data/dataset.csv.yref to trash
Deleted local file
? 0
```

# Verify: local file gone, ref in trash

```console
$ test -f data/dataset.csv && echo "exists" || echo "gone" test -f data/dataset.csv.yref && echo "exists" || echo "gone" test -f .blobsy/trash/data/dataset.csv.yref && echo "in trash" || echo "not in trash"
gone test -f data/dataset.csv.yref
exists
in trash
? 0
```

# rm --local: delete local file only, keep .yref and remote

```console
$ blobsy rm --local data/model.bin
Deleted local file: data/model.bin
? 0
```

# Verify --local: ref still exists, can pull to restore

```console
$ test -f data/model.bin && echo "exists" || echo "gone" test -f data/model.bin.yref && echo "ref exists" || echo "ref gone" blobsy pull data/model.bin cat data/model.bin
gone test -f data/model.bin.yref
ref exists
? 0
```

# rm --recursive for directory

```console
$ blobsy rm --recursive data/old/
Removed data/old/file1.bin
Moved data/old/file1.bin.yref to trash
Deleted local file
Removed data/old/file2.bin
Moved data/old/file2.bin.yref to trash
Deleted local file
? 0
```

# Verify directory removal

```console
$ find data/old/ -type f 2>/dev/null | sort
data/old/.gitignore
? 0
```

# rm directory without --recursive fails

```console
$ blobsy track data/model.bin mkdir -p data/keep cp small-file.txt data/keep/important.bin blobsy track data/keep/ blobsy rm data/keep/ 2>&1
error: unknown option '-p'
? 1
```

# rm via .yref path (equivalent)

```console
$ blobsy rm data/keep/important.bin.yref
Error: Not tracked: data/keep/important.bin (no .yref file found)
? 1
```

# rm a file that isn’t tracked

```console
$ blobsy rm data/nonexistent.bin 2>&1
Error: Not tracked: data/nonexistent.bin (no .yref file found)
? 1
```
