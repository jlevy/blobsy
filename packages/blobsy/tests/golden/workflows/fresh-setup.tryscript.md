---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
---
# Full lifecycle: init -> track -> push -> clone -> pull -> verify

## Set up a git repository

```console
$ git init -q -b main
$ git config user.name "Blobsy Test"
$ git config user.email "blobsy-test@example.com"
$ mkdir -p data ../remote
? 0
```

## Initialize blobsy with local backend

```console
$ blobsy init local:../remote
Created .blobsy.yml
Installed pre-commit hook (.git/hooks/pre-commit)
? 0
```

## Verify the generated config

```console
$ cat .blobsy.yml
backends:
  default:
    url: local:../remote
? 0
```

## Copy in test data and track

```console
$ cp small-file.txt data/model.bin
$ cp another-file.txt data/dataset.csv
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.yref
Added data/model.bin to .gitignore
$ blobsy track data/dataset.csv
Tracking data/dataset.csv
Created data/dataset.csv.yref
Added data/dataset.csv to .gitignore
? 0
```

## Check status before commit

```console
$ blobsy status
Tracked files (2):
  ○ data/dataset.csv (not committed, not synced)
  ○ data/model.bin (not committed, not synced)

Summary:
  2 need push and commit (○)

Actions needed:
  Run 'blobsy push' to sync 2 files
  Run 'git add -A && git commit' to commit refs
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
Pushing 2 files...
  ◑ data/dataset.csv (12 B) - pushed
  ◑ data/model.bin (13 B) - pushed
Done: 2 pushed.
? 0
```

## Commit the remote_key updates

```console
$ git add -A && git commit -q -m "Update remote keys after push"
? 0
```

## Verify fully synced status

```console
$ blobsy status
Tracked files (2):
  ✓ data/dataset.csv (committed and synced)
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

## Inspect remote store

```console
$ find ../remote/ -type f | sort
../remote/[REMOTE_KEY]
../remote/[REMOTE_KEY]
? 0
```

## Simulate a second user: clone the repo

```console
$ cd ..
$ git clone -q [CWD] clone
$ cd clone
? 0
```

## Second user: blobs are missing, refs are present

```console
$ cat data/model.bin.yref
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: [HASH]
size: 13
remote_key: [REMOTE_KEY]
$ test -f data/model.bin && echo "exists" || echo "missing"
missing
? 0
```

## Second user: pull all blobs

```console
$ blobsy pull
Pulling 2 files...
  data/dataset.csv (12 B) - pulled
  data/model.bin (13 B) - pulled
Done: 2 pulled.
? 0
```

## Verify integrity on second clone

```console
$ blobsy verify
Verifying 2 tracked files...
  data/dataset.csv   ok (sha256 matches)
  data/model.bin     ok (sha256 matches)
2 ok, 0 mismatch, 0 missing.
? 0
```

## Verify file contents match

```console
$ cat data/model.bin
hello blobsy
$ cat data/dataset.csv
second file
? 0
```

## Full filesystem of second clone

```console
$ find . -not -path './.git/*' -not -name '.git' | sort
.
./.blobsy
./.blobsy/stat-cache
./.blobsy/stat-cache/[..]
./.blobsy/stat-cache/[..]
./.blobsy.yml
./data
./data/.gitignore
./data/dataset.csv
./data/dataset.csv.yref
./data/model.bin
./data/model.bin.yref
? 0
```
