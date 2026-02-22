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
  mkdir -p data/old
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  cp small-file.txt data/old/file1.bin
  cp another-file.txt data/old/file2.bin
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  blobsy track data/old/
---
# Default rm: delete local file + move ref to trash

```console
$ blobsy rm data/dataset.csv
Removed data/dataset.csv
Moved data/dataset.csv.bref to trash
Deleted local file
? 0
```

# Verify local file gone

```console
$ test -f data/dataset.csv && echo "exists" || echo "gone"
gone
? 0
```

# Verify ref gone

```console
$ test -f data/dataset.csv.bref && echo "exists" || echo "gone"
gone
? 0
```

# Verify gitignore updated after rm

```console
$ cat data/.gitignore
# >>> blobsy-managed (do not edit) >>>
model.bin
# <<< blobsy-managed <<<
? 0
```

# rm --local: delete local file only, keep .bref

```console
$ blobsy rm --local data/model.bin
Deleted local file: data/model.bin
? 0
```

# Verify --local: local file gone but ref exists

```console
$ test -f data/model.bin && echo "exists" || echo "gone"
gone
? 0
```

```console
$ test -f data/model.bin.bref && echo "ref exists"
ref exists
? 0
```

# rm --recursive for directory

```console
$ blobsy rm --recursive data/old/
Removed data/old/file1.bin
Moved data/old/file1.bin.bref to trash
Deleted local file
Removed data/old/file2.bin
Moved data/old/file2.bin.bref to trash
Deleted local file
? 0
```

# Verify directory cleanup after recursive rm

```console
$ find data/old/ -type f 2>/dev/null | sort
data/old/.gitignore
? 0
```

# rm directory without --recursive fails

```console
$ blobsy rm data/ 2>&1
Error: data is a directory. Use --recursive to remove all files in it.
? 1
```

# rm a file that isn’t tracked

```console
$ blobsy rm data/nonexistent.bin 2>&1
Error: Not tracked: data/nonexistent.bin (no .bref file found)
? 1
```
