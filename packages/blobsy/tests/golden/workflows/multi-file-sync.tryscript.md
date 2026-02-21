---
sandbox: true
fixtures:
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data/models data/datasets
  for i in 1 2 3; do echo "model $i" > data/models/model-$i.bin; done
  for i in 1 2 3; do echo "dataset $i" > data/datasets/data-$i.bin; done
---
# Track multiple files across directories (using .bin extension to match externalize patterns)

```console
$ blobsy track data/models/
...
? 0
```

```console
$ blobsy track data/datasets/
...
? 0
```

# Commit and push all

```console
$ git add -A && git commit -q -m "track files"
? 0
```

```console
$ blobsy push
...
? 0
```

# Remote has blobs

```console
$ test -n "$(find "$BLOBSY_TEST_REMOTE" -type f)"
? 0
```

# Commit push updates, then verify all

```console
$ git add -A && git commit -q -m "push updates"
? 0
```

```console
$ blobsy verify
...
All files verified.
? 0
```

# Delete some files and sync pulls them back

```console
$ rm data/models/model-1.bin data/datasets/data-2.bin
? 0
```

```console
$ blobsy sync
...
? 0
```

# Everything is back

```console
$ cat data/models/model-1.bin
model 1
? 0
```

```console
$ cat data/datasets/data-2.bin
dataset 2
? 0
```
