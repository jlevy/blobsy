---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
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
  git add -A && git commit -q -m "track"
  blobsy push
  git add -A && git commit -q -m "push"
---
# Pull when local matches ref: already up to date (no refuse)

```console
$ blobsy pull data/model.bin
  data/model.bin  already up to date
Done: 0 pulled.
? 0
```

# Modify locally

```console
$ echo "local changes" > data/model.bin
? 0
```

# Pull overwrites (does NOT refuse)

```console
$ blobsy pull data/model.bin
  ↓  data/model.bin (13 B)
Done: 1 pulled.
? 0
```

# Verify pull restored remote content

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Modify again

```console
$ echo "local changes" > data/model.bin
? 0
```

# Pull --force overwrites

```console
$ blobsy pull --force data/model.bin
  ↓  data/model.bin (13 B)
Done: 1 pulled.
? 0
```

# Verify --force overwrote

```console
$ cat data/model.bin
hello blobsy
? 0
```
