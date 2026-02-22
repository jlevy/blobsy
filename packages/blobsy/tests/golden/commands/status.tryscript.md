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
Created data/model.bin.yref
Added data/model.bin to .gitignore
? 0
```

```console
$ blobsy status
  ○  data/model.bin  not pushed

1 tracked file
? 0
```

# Status with modified file

```console
$ echo "modified content" > data/model.bin
? 0
```

```console
$ blobsy status
  ~  data/model.bin  modified

1 tracked file
? 0
```

# Status with missing file

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy status
  ?  data/model.bin  file missing

1 tracked file
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
Created data/dataset.csv.yref
Added data/dataset.csv to .gitignore
? 0
```

```console
$ blobsy status
  ○  data/dataset.csv  not pushed
  ○  data/model.bin  not pushed

2 tracked files
? 0
```

# Status after push shows synced

```console
$ blobsy push
  data/dataset.csv (21 B) - pushed
  data/model.bin (13 B) - pushed
Done: 2 pushed.
? 0
```

```console
$ git add -A && git commit -q -m "push"
? 0
```

```console
$ blobsy status
  ✓  data/dataset.csv  synced
  ✓  data/model.bin  synced

2 tracked files
? 0
```

# Status for a specific path

```console
$ blobsy status data/dataset.csv
  ✓  data/dataset.csv  synced

1 tracked file
? 0
```
