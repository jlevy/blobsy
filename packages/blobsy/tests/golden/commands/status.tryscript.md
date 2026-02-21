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
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
---
# Status before tracking anything

```console
$ blobsy status
No tracked files found.
? 0
```

# Status after tracking (uncommitted, not synced)

```console
$ blobsy track data/model.bin blobsy status
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
Error: File not found: blobsy
? 1
```

# Status after commit (committed, not synced)

```console
$ git add -A && git commit -q -m "track model" blobsy status
error: pathspec 'blobsy' did not match any file(s) known to git
error: pathspec 'status' did not match any file(s) known to git
? 1
```

# Status after push (synced but ref not committed with remote_key)

```console
$ blobsy push data/model.bin blobsy status
Error: Push not yet implemented (Stage 2).
? 1
```

# Status after committing the push (fully synced)

```console
$ git add -A && git commit -q -m "push model" blobsy status
error: pathspec 'blobsy' did not match any file(s) known to git
error: pathspec 'status' did not match any file(s) known to git
? 1
```

# Status with modified file

```console
$ echo "modified content" > data/model.bin blobsy status
? 0
```

# Status with missing file

```console
$ rm data/model.bin blobsy status
rm: blobsy: No such file or directory
rm: status: No such file or directory
? 1
```

# Status with multiple files in various states

```console
$ echo "hello blobsy" > data/model.bin blobsy track data/dataset.csv blobsy status
? 0
```

# Status for a specific path

```console
$ blobsy status data/model.bin
  ~  data/model.bin  modified

1 tracked file
? 0
```
