---
sandbox: true
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
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
---
# Delete local file, verify missing

```console
$ rm data/model.bin && test ! -f data/model.bin && echo "missing"
missing
? 0
```

# Pull via command backend

```console
$ blobsy pull data/model.bin
  ↓  data/model.bin (13 B)
Done: 1 pulled.
? 0
```

# Verify pulled content

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Pull again (already up to date)

```console
$ blobsy pull data/model.bin
  data/model.bin  already up to date
Done: 0 pulled.
? 0
```
