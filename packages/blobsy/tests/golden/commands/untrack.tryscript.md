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
Moved data/model.bin.yref -> .blobsy/trash/data/model.bin.yref
Removed data/model.bin from .gitignore
(Local file preserved)
? 0
```

# Verify: local file preserved, .yref moved to trash, gitignore updated

```console
$ cat data/model.bin
hello blobsy
$ test -f data/model.bin.yref && echo "exists" || echo "gone"
gone
$ test -f .blobsy/trash/data/model.bin.yref && echo "in trash" || echo "not in trash"
in trash
? 0
```

# Untrack via .yref path (equivalent)

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
$ blobsy untrack data/model.bin.yref
Untracked data/model.bin
Moved data/model.bin.yref -> .blobsy/trash/data/model.bin.yref
Removed data/model.bin from .gitignore
(Local file preserved)
? 0
```

# Untrack directory without --recursive fails

```console
$ blobsy untrack data/research/ 2>&1
Error: Cannot untrack directory without --recursive flag.
Run: blobsy untrack --recursive data/research/
? 1
```

# Untrack directory with --recursive

```console
$ blobsy untrack --recursive data/research/
Untracked 2 files in data/research/
Moved data/research/data.bin.yref -> .blobsy/trash/data/research/data.bin.yref
Moved data/research/report.bin.yref -> .blobsy/trash/data/research/report.bin.yref
Removed 2 entries from .gitignore
(Local files preserved)
? 0
```

# Verify directory untrack

```console
$ test -f data/research/data.bin && echo "file preserved" || echo "file gone"
file preserved
$ test -f data/research/data.bin.yref && echo "ref exists" || echo "ref gone"
ref gone
$ find .blobsy/trash/ -type f | sort
.blobsy/trash/data/model.bin.yref
.blobsy/trash/data/research/data.bin.yref
.blobsy/trash/data/research/report.bin.yref
? 0
```

# Untrack a file that isn’t tracked

```console
$ blobsy untrack data/nonexistent.bin 2>&1
Error: data/nonexistent.bin is not tracked (no .yref file found)
? 1
```
