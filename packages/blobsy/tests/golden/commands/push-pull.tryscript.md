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
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Verify no remote_key in ref before push

```console
$ grep remote_key data/model.bin.bref || echo "no remote_key"
no remote_key
? 0
```

# Push a single file

```console
$ blobsy push data/model.bin
  ↑  data/model.bin (13 B)
Done: 1 pushed.
? 0
```

# Verify ref updated with remote_key after push

```console
$ grep remote_key data/model.bin.bref
remote_key: [REMOTE_KEY]
? 0
```

# Remote store after push -- blob exists

```console
$ test -n "$(find remote -type f -name '*.bin*')" && echo "blob exists"
blob exists
? 0
```

# Push all tracked files

```console
$ blobsy push
  data/model.bin  already pushed
  ↑  data/dataset.csv (32 B)
Done: 1 pushed.
? 0
```

# Verify both refs have remote_key

```console
$ grep -c remote_key data/dataset.csv.bref
1
? 0
```

# Both refs have remote_key (proving both pushed)

```console
$ grep -l remote_key data/*.bref | wc -l | tr -d ' '
2
? 0
```

# Pull after deleting local file

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy pull data/model.bin
  ↓  data/model.bin (13 B)
Done: 1 pulled.
? 0
```

# Verify pulled content matches original

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Pull when file already matches (no-op)

```console
$ blobsy pull data/model.bin
  data/model.bin  already up to date
Done: 0 pulled.
? 0
```

# Push with --force re-hashes and pushes

```console
$ echo "new content" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin
Updated data/model.bin.bref (hash changed)

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ blobsy push data/model.bin
  ↑  data/model.bin (12 B)
Done: 1 pushed.
? 0
```

# Verify new push updated remote_key

```console
$ grep remote_key data/model.bin.bref
remote_key: [REMOTE_KEY]
? 0
```

# Push via .bref path

```console
$ echo "bref path test" > data/model.bin
? 0
```

```console
$ blobsy track data/model.bin
Updated data/model.bin.bref (hash changed)

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ blobsy push data/model.bin.bref
  ↑  data/model.bin (15 B)
Done: 1 pushed.
? 0
```

# Pull via .bref path

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy pull data/model.bin.bref
  ↓  data/model.bin (15 B)
Done: 1 pulled.
? 0
```

```console
$ cat data/model.bin
bref path test
? 0
```
