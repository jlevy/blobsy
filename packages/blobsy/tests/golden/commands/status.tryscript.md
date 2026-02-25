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
  cp another-file.txt data/dataset.csv
---
# Status before tracking anything

```console
$ blobsy status
No tracked files found.
? 0
```

# Track a file then check status

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ blobsy status
  ○  data/model.bin  not pushed (13 B)

1 tracked file: 1 new
? 0
```

# Status with modified file

```console
$ echo "modified content" > data/model.bin
? 0
```

```console
$ blobsy status
  ~  data/model.bin  modified (13 B)

1 tracked file: 1 modified
? 0
```

# Status with missing file

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy status
  ?  data/model.bin  file missing (13 B)

1 tracked file: 1 missing_file
? 0
```

# Track another file and check status with multiple files

```console
$ echo "hello blobsy" > data/model.bin
? 0
```

```console
$ blobsy track data/dataset.csv
Tracking data/dataset.csv
Created data/dataset.csv.bref
Added data/dataset.csv to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ blobsy status
  ○  data/dataset.csv  not pushed (12 B)
  ○  data/model.bin  not pushed (13 B)

2 tracked files: 2 new
? 0
```

# Status after push shows synced

```console
$ blobsy push
  ↑  data/dataset.csv (32 B)
  ↑  data/model.bin (13 B)
Done: 2 pushed.
? 0
```

```console
$ git add -A && git commit -q -m "push"
? 0
```

```console
$ blobsy status
  ✓  data/dataset.csv  synced (12 B)
  ✓  data/model.bin  synced (13 B)

2 tracked files: 2 synced
? 0
```

# Status for a specific path

```console
$ blobsy status data/dataset.csv
  ✓  data/dataset.csv  synced (12 B)

1 tracked file: 1 synced
? 0
```
