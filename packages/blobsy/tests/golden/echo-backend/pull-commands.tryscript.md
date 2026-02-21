---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/echo-backend.ts
  - source: ../fixtures/echo-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data .mock-remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track model"
  blobsy push data/model.bin
  git add -A && git commit -q -m "push model"
---
# Delete local file

```console
$ rm data/model.bin
$ test -f data/model.bin && echo "exists" || echo "missing"
missing
? 0
```

# Pull shows the exact backend command via echo-backend.ts

```console
$ blobsy pull data/model.bin
PULL test-bucket/[REMOTE_KEY] -> [CWD]/[..]
Pulled data/model.bin (13 B)
? 0
```

# Verify pulled content

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Pull again (already up to date, no echo)

```console
$ blobsy pull data/model.bin
Pulling 1 file...
  data/model.bin (13 B) - already up to date
Done: 0 pulled, 1 already up to date.
? 0
```
