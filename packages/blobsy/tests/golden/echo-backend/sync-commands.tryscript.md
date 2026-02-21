---
sandbox: true
env:
  BLOBSY_BACKEND_URL: ""
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
  - ../fixtures/echo-backend.ts
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  FIXTURE="$(pwd)/echo-backend.ts"
  cat > .blobsy.yml << YAML
  backends:
    default:
      type: command
      bucket: test-bucket
      push_command: "npx tsx $FIXTURE push {local} {remote}"
      pull_command: "npx tsx $FIXTURE pull {remote} {local}"
      exists_command: "npx tsx $FIXTURE exists {remote}"
  compress:
    algorithm: none
  YAML
  git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track"
---
# Sync pushes both files

```console
$ blobsy sync --skip-health-check
  ↑ data/dataset.csv - pushed
  ↑ data/model.bin - pushed
Sync complete: 2 pushed, 0 pulled, 0 errors.
? 0
```

# Verify both blobs in mock remote

```console
$ find .mock-remote -type f | wc -l | tr -d ' '
2
? 0
```

# Delete one file, sync pulls it back

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy sync --skip-health-check
  ✓ data/dataset.csv - up to date
  ↓ data/model.bin - pulled
Sync complete: 0 pushed, 1 pulled, 0 errors.
? 0
```

# Verify pulled file

```console
$ cat data/model.bin
hello blobsy
? 0
```
