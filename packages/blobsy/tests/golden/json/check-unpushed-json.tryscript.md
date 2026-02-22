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
---
# check-unpushed --json with unpushed files

```console
$ blobsy check-unpushed --json
{
  "schema_version": "0.1",
  "unpushed": [
    "data/model.bin"
  ],
  "count": 1
}
? 1
```

# Push and check again

```console
$ blobsy push
  data/model.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

```console
$ git add -A && git commit -q -m "push"
? 0
```

```console
$ blobsy check-unpushed --json
{
  "schema_version": "0.1",
  "unpushed": [],
  "count": 0
}
? 0
```
