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
# Remote store before any push

```console
$ find "$BLOBSY_TEST_REMOTE" | sort
...
? 0
```

# Push a single file

```console
$ blobsy push data/model.bin
...
? 0
```

# Remote store after push -- blob appears

```console
$ test -n "$(find "$BLOBSY_TEST_REMOTE" -type f -name '*.bin*')"
? 0
```

# Push all tracked files

```console
$ blobsy push
...
? 0
```

# Verify ref was updated with remote_key

```console
$ grep -c remote_key data/model.bin.yref
1
? 0
```

# Pull after deleting local file

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy pull data/model.bin
...
? 0
```

# Verify pulled content

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Pull when file already matches

```console
$ blobsy pull data/model.bin
...
? 0
```

# Push with --force re-hashes and pushes

```console
$ echo "new content" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin
...
? 0
```

```console
$ blobsy push data/model.bin
...
? 0
```
