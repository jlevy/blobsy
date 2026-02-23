---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
---
# Track nonexistent file fails

```console
$ blobsy track nonexistent.bin 2>&1
Error: File not found: nonexistent.bin

  Check the file path and try again.
? 1
```

# Untrack nonexistent file fails

```console
$ blobsy untrack nonexistent.bin 2>&1
Error: Not tracked: nonexistent.bin (no .bref file found)
? 1
```

# rm nonexistent file fails

```console
$ blobsy rm nonexistent.bin 2>&1
Error: Not tracked: nonexistent.bin (no .bref file found)
? 1
```

# init without args fails

```console
$ blobsy init 2>&1
error: missing required argument 'url'
(use --help for usage, or blobsy docs for full guide)
? 1
```

# init with unrecognized scheme fails

```console
$ blobsy init r2://bucket/prefix/ 2>&1
Error: Unrecognized backend URL scheme: r2:

  Supported schemes:
    s3://my-bucket/prefix/
    gs://my-bucket/prefix/
    azure://my-container/prefix/
    local:../blobsy-remote
? 1
```

# Push with malformed .bref fails

```console
$ echo "not valid yaml %%%" > data/model.bin.bref
? 0
```

```console
$ blobsy push data/model.bin 2>&1
Error: Invalid .bref file (not an object): [LOCAL_PATH]/data/model.bin.bref
? 1
```

# Status with malformed .bref

```console
$ blobsy status 2>&1
Error: Invalid .bref file (not an object): [LOCAL_PATH]/data/model.bin.bref
? 1
```

# Restore valid .bref

```console
$ rm data/model.bin.bref
? 0
```

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore
? 0
```
