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
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Remote store before any push

```console
$ find ../remote/ | sort
../remote/
? 0
```

# Push a single file

```console
$ blobsy push data/model.bin
Pushing 1 file...
  ◑ data/model.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

# Remote store after push -- blob appears

```console
$ find ../remote/ -type f | sort
../remote/[REMOTE_KEY]
? 0
```

# Push all tracked files

```console
$ blobsy push
Pushing 2 files...
  ◑ data/dataset.csv (12 B) - pushed
  ◑ data/model.bin (13 B) - already synced
Done: 1 pushed, 1 already synced.
? 0
```

# Remote store now has both blobs

```console
$ find ../remote/ -type f | sort
../remote/[REMOTE_KEY]
../remote/[REMOTE_KEY]
? 0
```

# Verify ref was updated with remote_key

```console
$ cat data/model.bin.yref
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: [HASH]
size: 13
remote_key: [REMOTE_KEY]
? 0
```

# Pull after deleting local file

```console
$ rm data/model.bin
$ find data/ -type f | sort
data/.gitignore
data/dataset.csv
data/dataset.csv.yref
data/model.bin.yref
? 0
```

```console
$ blobsy pull data/model.bin
Pulling 1 file...
  data/model.bin (13 B) - pulled
Done: 1 pulled.
? 0
```

# Verify pulled content and filesystem state

```console
$ cat data/model.bin
hello blobsy
$ find data/ -type f | sort
data/.gitignore
data/dataset.csv
data/dataset.csv.yref
data/model.bin
data/model.bin.yref
? 0
```

# Pull when file already matches

```console
$ blobsy pull data/model.bin
Pulling 1 file...
  data/model.bin (13 B) - already up to date
Done: 0 pulled, 1 already up to date.
? 0
```

# Push with uncommitted refs (warning)

```console
$ echo "new content" > data/model.bin
$ blobsy track data/model.bin
Updated data/model.bin.yref (hash changed)
$ blobsy push data/model.bin
Warning: Operating on 1 uncommitted .yref file:
  data/model.bin.yref (modified)

Pushing 1 file...
  ◑ data/model.bin (12 B) - pushed
Done: 1 pushed.

Reminder: Run 'git add -A && git commit' to commit these refs.
? 0
```

# Push via .yref path (equivalent)

```console
$ blobsy push data/dataset.csv.yref
Pushing 1 file...
  ◑ data/dataset.csv (12 B) - already synced
Done: 0 pushed, 1 already synced.
? 0
```
