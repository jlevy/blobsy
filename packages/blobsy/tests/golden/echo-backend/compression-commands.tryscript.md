---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/echo-backend.ts
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << 'EOF'
  backends:
    default:
      type: command
      push_command: npx tsx echo-backend.ts push {local} {bucket}/{remote}
      pull_command: npx tsx echo-backend.ts pull {bucket}/{remote} {local}
      exists_command: npx tsx echo-backend.ts exists {bucket}/{remote}
      bucket: test-bucket
      prefix: ""
  compress:
    min_size: 0
    algorithm: zstd
    always:
      - "*.txt"
  EOF
  git add -A && git commit -q -m "init"
  mkdir -p data .mock-remote
---
# Track and push a compressible file -- echo shows compressed temp file

```console
$ cp small-file.txt data/readme.txt
$ blobsy track data/readme.txt
Tracking data/readme.txt
Created data/readme.txt.yref
Added data/readme.txt to .gitignore
$ git add -A && git commit -q -m "track readme"
$ blobsy push data/readme.txt
PUSH [CWD]/[..] -> test-bucket/[REMOTE_KEY]
Pushed data/readme.txt (13 B, compressed: zstd)
Updated data/readme.txt.yref (remote_key set)
? 0
```

# The mock remote has the compressed blob

```console
$ find .mock-remote/ -type f | sort
.mock-remote/[REMOTE_KEY]
? 0
```

# Pull decompresses -- echo shows the pull command

```console
$ rm data/readme.txt
$ git add -A && git commit -q -m "push readme"
$ blobsy pull data/readme.txt
PULL test-bucket/[REMOTE_KEY] -> [CWD]/[..]
Pulled data/readme.txt (13 B, decompressed: zstd)
? 0
```

# Verify content after decompress round-trip

```console
$ cat data/readme.txt
hello blobsy
? 0
```
