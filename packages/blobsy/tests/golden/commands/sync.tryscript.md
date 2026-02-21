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
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Sync when nothing is pushed (pushes all)

```console
$ blobsy sync
...
Sync complete: 2 pushed, 0 pulled, 0 errors.
? 0
```

# Both refs have remote_key after sync

```console
$ grep -l remote_key data/*.yref | wc -l | tr -d ' '
2
? 0
```

# Sync again (up to date)

```console
$ blobsy sync
...
Sync complete: 0 pushed, 0 pulled, 0 errors.
? 0
```

# Modify a file, re-track, then sync

```console
$ echo "updated model" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin
Updated data/model.bin.yref (hash changed)
? 0
```

```console
$ blobsy sync
...
Sync complete: 1 pushed, 0 pulled, 0 errors.
? 0
```

# Verify updated ref has remote_key

```console
$ grep remote_key data/model.bin.yref
remote_key: [REMOTE_KEY]
? 0
```

# Delete a local file, sync pulls it back

```console
$ rm data/dataset.csv
? 0
```

```console
$ blobsy sync
...
Sync complete: 0 pushed, 1 pulled, 0 errors.
? 0
```

# Verify pulled file content

```console
$ cat data/dataset.csv
second file
? 0
```

# Both files present after full sync

```console
$ test -f data/model.bin && test -f data/dataset.csv && echo "both present"
both present
? 0
```
