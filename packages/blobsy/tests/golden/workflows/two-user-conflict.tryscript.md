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
  mkdir -p remote
  mkdir -p data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
---
# Verify starting state: fully synced

```console
$ blobsy status
  ✓  data/model.bin  synced

1 tracked file
? 0
```

# User A modifies the file locally

```console
$ echo "user A changes" > data/model.bin
? 0
```

# Re-track and force push to overwrite remote

```console
$ blobsy track data/model.bin
Updated data/model.bin.bref (hash changed)
? 0
```

```console
$ blobsy push --force data/model.bin
  ↑  data/model.bin (15 B)
Done: 1 pushed.
? 0
```

# Verify push stored blob in remote

```console
$ find remote -type f | sort
remote/[REMOTE_KEY]
remote/[REMOTE_KEY]
? 0
```

# Verify force push updated the ref

```console
$ grep remote_key data/model.bin.bref
remote_key: [REMOTE_KEY]
? 0
```

# Now simulate pulling back (user B’s perspective): delete local, pull

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy pull data/model.bin
  ↓  data/model.bin (15 B)
Done: 1 pulled.
? 0
```

# Verify content is user A’s version

```console
$ cat data/model.bin
user A changes
? 0
```

# Verify integrity

```console
$ blobsy verify data/model.bin
  ✓  data/model.bin  ok

All files verified.
? 0
```
