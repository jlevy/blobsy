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
  mkdir -p data/research ../remote
  cp small-file.txt data/model.bin
  cp another-file.txt data/research/data.bin
  cp small-file.txt data/research/report.bin
  blobsy track data/model.bin
  blobsy track data/research/
  git add -A && git commit -q -m "track files"
---
# Untrack a single file

```console
$ blobsy untrack data/model.bin
Untracked data/model.bin
Moved data/model.bin.yref to trash
? 0
```

# Verify: local file preserved, .yref moved to trash, gitignore updated

```console
$ cat data/model.bin test -f data/model.bin.yref && echo "exists" || echo "gone" test -f .blobsy/trash/data/model.bin.yref && echo "in trash" || echo "not in trash"
hello blobsy
cat: test: No such file or directory
cat: -f: No such file or directory
cat: data/model.bin.yref: No such file or directory
gone test -f .blobsy/trash/data/model.bin.yref
in trash
? 0
```

# Untrack via .yref path (equivalent)

```console
$ blobsy track data/model.bin blobsy untrack data/model.bin.yref
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
Error: File not found: blobsy
? 1
```

# Untrack directory without --recursive fails

```console
$ blobsy untrack data/research/ 2>&1
Error: data/research is a directory. Use --recursive to untrack all files in it.
? 1
```

# Untrack directory with --recursive

```console
$ blobsy untrack --recursive data/research/
Untracked data/research/data.bin
Moved data/research/data.bin.yref to trash
Untracked data/research/report.bin
Moved data/research/report.bin.yref to trash
? 0
```

# Verify directory untrack

```console
$ test -f data/research/data.bin && echo "file preserved" || echo "file gone" test -f data/research/data.bin.yref && echo "ref exists" || echo "ref gone" find .blobsy/trash/ -type f | sort
file preserved
ref exists
? 0
```

# Untrack a file that isn’t tracked

```console
$ blobsy untrack data/nonexistent.bin 2>&1
Error: Not tracked: data/nonexistent.bin (no .yref file found)
? 1
```
