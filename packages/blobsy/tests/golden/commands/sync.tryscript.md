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
? 0
```

# Sync again (up to date)

```console
$ blobsy sync
...
? 0
```

# Modify a file, re-track, then sync

```console
$ echo "updated model" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin
[..]
? 0
```

```console
$ blobsy sync
...
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
? 0
```

# Verify pulled file

```console
$ cat data/dataset.csv
second file
? 0
```
