---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data ../remote
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  git add -A && git commit -q -m "track"
---
# Malformed .yref file

```console
$ echo "this is not yaml: [[[" > data/model.bin.yref
$ blobsy status 2>&1
Error: Invalid .yref file: data/model.bin.yref

Failed to parse YAML: [..]
Expected format: blobsy-yref/0.1 with hash and size fields.

To repair: delete data/model.bin.yref and run 'blobsy track data/model.bin'
? 1
```

# Unsupported format version (major mismatch)

```console
$ cat > data/model.bin.yref << 'EOF'
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/9.0
hash: sha256:0000000000000000000000000000000000000000000000000000000000000000
size: 13
EOF
$ blobsy status 2>&1
Error: Unsupported .yref format: data/model.bin.yref

Found version blobsy-yref/9.0, but this version of blobsy supports up to blobsy-yref/0.1.
Upgrade blobsy to read this ref file, or re-track the file with the current version.
? 1
```

# Missing required fields in .yref

```console
$ cat > data/model.bin.yref << 'EOF'
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:0000000000000000000000000000000000000000000000000000000000000000
EOF
$ blobsy status 2>&1
Error: Invalid .yref file: data/model.bin.yref

Missing required field: size
Expected format: blobsy-yref/0.1 with hash and size fields.

To repair: delete data/model.bin.yref and run 'blobsy track data/model.bin'
? 1
```

# Invalid hash format

```console
$ cat > data/model.bin.yref << 'EOF'
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: md5:abcdef1234567890
size: 13
EOF
$ blobsy status 2>&1
Error: Invalid .yref file: data/model.bin.yref

Invalid hash format: md5:abcdef1234567890
Expected format: sha256:<64-hex-chars>

To repair: delete data/model.bin.yref and run 'blobsy track data/model.bin'
? 1
```

# Track on nonexistent file

```console
$ blobsy track data/nonexistent.bin 2>&1
Error: File not found: data/nonexistent.bin
? 1
```

# Push on file with no .yref

```console
$ echo "not tracked" > data/untracked.bin
$ blobsy push data/untracked.bin 2>&1
Error: data/untracked.bin is not tracked (no .yref file found)
Run 'blobsy track data/untracked.bin' first.
? 1
```
