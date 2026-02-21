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
⊗ data/dataset.csv (staged for deletion)

Moved data/dataset.csv.yref -> .blobsy/trash/data/dataset.csv.yref
Removed data/dataset.csv from .gitignore
Deleted local file: data/dataset.csv (12 B freed)

Next: Run 'git add -A && git commit -m "Remove dataset.csv"'
? 0
```

# Verify: local file gone, ref in trash

```console
$ test -f data/dataset.csv && echo "exists" || echo "gone"
gone
$ test -f data/dataset.csv.yref && echo "exists" || echo "gone"
gone
$ test -f .blobsy/trash/data/dataset.csv.yref && echo "in trash" || echo "not in trash"
in trash
? 0
```

# rm --local: delete local file only, keep .yref and remote

```console
$ blobsy rm --local data/model.bin
? data/model.bin (file missing)

Deleted local file: data/model.bin (13 B freed)
Kept .yref and remote blob (run 'blobsy pull' to restore)
? 0
```

# Verify --local: ref still exists, can pull to restore

```console
$ test -f data/model.bin && echo "exists" || echo "gone"
gone
$ test -f data/model.bin.yref && echo "ref exists" || echo "ref gone"
ref exists
$ blobsy pull data/model.bin
Pulling 1 file...
  data/model.bin (13 B) - pulled
Done: 1 pulled.
$ cat data/model.bin
hello blobsy
? 0
```

# rm --recursive for directory

```console
$ blobsy rm --recursive data/old/
Staged for removal (2 files):
  ⊗ data/old/file1.bin
  ⊗ data/old/file2.bin

Moved 2 .yref files to .blobsy/trash/
Removed 2 entries from .gitignore
Deleted 2 local files (25 B freed)
? 0
```

# Verify directory removal

```console
$ find data/old/ -type f 2>/dev/null | sort
? 0
```

# rm directory without --recursive fails

```console
$ blobsy track data/model.bin
[..]
$ mkdir -p data/keep
$ cp small-file.txt data/keep/important.bin
$ blobsy track data/keep/
[..]
$ blobsy rm data/keep/ 2>&1
Error: Cannot remove directory without --recursive flag.
Run: blobsy rm --recursive data/keep/
? 1
```

# rm via .yref path (equivalent)

```console
$ blobsy rm data/keep/important.bin.yref
⊗ data/keep/important.bin (staged for deletion)

Moved data/keep/important.bin.yref -> .blobsy/trash/data/keep/important.bin.yref
Removed data/keep/important.bin from .gitignore
Deleted local file: data/keep/important.bin (13 B freed)

Next: Run 'git add -A && git commit -m "Remove important.bin"'
? 0
```

# rm a file that isn’t tracked

```console
$ blobsy rm data/nonexistent.bin 2>&1
Error: data/nonexistent.bin is not tracked (no .yref file found)
? 1
```
