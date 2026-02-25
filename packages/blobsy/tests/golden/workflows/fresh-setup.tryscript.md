---
sandbox: true
env:
  BLOBSY_NO_HOOKS: "1"
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
---
# Full lifecycle: init -> track -> push -> pull -> verify

## Set up a git repository

```console
$ git init -q -b main && git config user.name "Blobsy Test" && git config user.email "blobsy-test@example.com"
? 0
```

```console
$ rm -rf ../remote && mkdir -p data ../remote
? 0
```

## Initialize blobsy with local backend

```console
$ blobsy init local:../remote
Initialized blobsy in .
Created .blobsy.yml
? 0
```

## Copy in test data and track

```console
$ cp small-file.txt data/model.bin && cp another-file.txt data/dataset.csv
? 0
```

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
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

## Commit refs

```console
$ git add -A && git commit -q -m "Track data files with blobsy"
? 0
```

## Push to remote

```console
$ blobsy push
  ↑  data/dataset.csv (32 B)
  ↑  data/model.bin (13 B)
Done: 2 pushed.
? 0
```

## Remote store has 2 blobs

```console
$ find ../remote -type f | sort
../remote/[REMOTE_KEY]
../remote/[REMOTE_KEY]
? 0
```

## Commit the remote_key updates

```console
$ git add -A && git commit -q -m "Update remote keys after push"
? 0
```

## Status shows synced

```console
$ blobsy status
  ✓  data/dataset.csv  synced (12 B)
  ✓  data/model.bin  synced (13 B)

2 tracked files: 2 synced
? 0
```

## Delete local files and pull them back

```console
$ rm data/model.bin data/dataset.csv
? 0
```

```console
$ blobsy pull
  ↓  data/dataset.csv (12 B)
  ↓  data/model.bin (13 B)
Done: 2 pulled.
? 0
```

## Verify pulled content

```console
$ cat data/model.bin
hello blobsy
? 0
```

```console
$ cat data/dataset.csv
second file
? 0
```

## Verify integrity

```console
$ blobsy verify
  ✓  data/dataset.csv  ok
  ✓  data/model.bin  ok

All files verified.
? 0
```
