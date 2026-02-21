---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << 'YAML'
  backends:
    default:
      url: local:remote
  compress:
    min_size: "0"
    algorithm: zstd
    always:
      - "*.txt"
  YAML
  git add -A && git commit -q -m "init"
  mkdir -p data
---
# Track a compressible file

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

# Push with compression enabled

```console
$ git add -A && git commit -q -m "track readme"
? 0
```

```console
$ blobsy push data/readme.txt
  data/readme.txt ([SIZE] B) - pushed
Done: 1 pushed.
? 0
```

# Verify ref has compression fields

```console
$ grep compressed data/readme.txt.yref
compressed: zstd
compressed_size: [SIZE]
? 0
```

# Remote has a compressed blob (.zst)

```console
$ test -n "$(find "$BLOBSY_TEST_REMOTE" -type f -name '*.zst')" && echo "compressed blob exists"
compressed blob exists
? 0
```

# Delete local file, pull decompresses

```console
$ rm data/readme.txt
? 0
```

```console
$ blobsy pull data/readme.txt
  data/readme.txt ([SIZE] B) - pulled
Done: 1 pulled.
? 0
```

# Verify content matches after decompress round-trip

```console
$ cat data/readme.txt
hello blobsy
? 0
```

```console
$ blobsy verify data/readme.txt
  ✓  data/readme.txt  ok

All files verified.
? 0
```
