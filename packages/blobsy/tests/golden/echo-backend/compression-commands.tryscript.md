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
    algorithm: zstd
    min_size: "0"
    always:
      - "*.txt"
  YAML
  git add -A && git commit -q -m "init"
  mkdir -p data
---
# Track and push a compressible file

```console
$ cp small-file.txt data/readme.txt
? 0
```

```console
$ blobsy track data/readme.txt
Tracking data/readme.txt
Created data/readme.txt.yref
Added data/readme.txt to .gitignore
? 0
```

```console
$ git add -A && git commit -q -m "track"
? 0
```

```console
$ blobsy push data/readme.txt
  data/readme.txt (22 B) - pushed
Done: 1 pushed.
? 0
```

# Verify ref has compression fields

```console
$ grep compressed data/readme.txt.yref
compressed: zstd
compressed_size: 22
? 0
```

# The mock remote has the compressed blob

```console
$ find .mock-remote -type f | sort
.mock-remote/[REMOTE_KEY]
? 0
```

# Delete local, pull decompresses

```console
$ rm data/readme.txt
? 0
```

```console
$ blobsy pull data/readme.txt
  data/readme.txt (13 B) - pulled
Done: 1 pulled.
? 0
```

# Verify content after decompress round-trip

```console
$ cat data/readme.txt
hello blobsy
? 0
```
