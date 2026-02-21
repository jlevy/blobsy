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
  mkdir -p data/research
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

# Verify local file preserved

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Verify .yref moved

```console
$ test -f data/model.bin.yref && echo "exists" || echo "gone"
gone
? 0
```

# Verify gitignore updated after untrack

```console
$ cat data/.gitignore
# >>> blobsy-managed (do not edit) >>>
# <<< blobsy-managed <<<
? 0
```

# Verify trash has the ref

```console
$ find .blobsy/trash/ -type f | sort
.blobsy/trash/model.bin.yref.[UNIX_TS]
? 0
```

# Untrack via .yref path (re-track first)

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
? 0
```

```console
$ blobsy untrack data/model.bin.yref
Untracked data/model.bin
Moved data/model.bin.yref to trash
? 0
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

# Verify directory files preserved after untrack

```console
$ test -f data/research/data.bin && echo "file preserved"
file preserved
? 0
```

```console
$ test -f data/research/data.bin.yref && echo "ref exists" || echo "ref gone"
ref gone
? 0
```

# Verify research gitignore cleaned up

```console
$ cat data/research/.gitignore
# >>> blobsy-managed (do not edit) >>>
# <<< blobsy-managed <<<
? 0
```

# Untrack a file that isn’t tracked

```console
$ blobsy untrack data/nonexistent.bin 2>&1
Error: Not tracked: data/nonexistent.bin (no .yref file found)
? 1
```
