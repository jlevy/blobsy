---
sandbox: true
env:
  BLOBSY_BACKEND_URL: ""
fixtures:
  - ../fixtures/small-file.txt
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
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
---
# Push via command backend

```console
$ blobsy push data/model.bin
...
? 0
```

# Verify the blob landed in the mock remote

```console
$ find .mock-remote -type f | wc -l | tr -d ' '
1
? 0
```

# Verify the content in the remote

```console
$ find .mock-remote -type f -exec cat {} \;
hello blobsy
? 0
```

# Push again (already synced)

```console
$ blobsy push data/model.bin
...
? 0
```

# Verify ref was updated with remote_key

```console
$ grep -c remote_key data/model.bin.yref
1
? 0
```
