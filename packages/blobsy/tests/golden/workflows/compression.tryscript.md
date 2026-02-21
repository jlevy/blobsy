---
sandbox: true
fixtures:
  - fixtures/small-file.txt
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << 'EOF'
  backends:
    default:
      url: local:../remote
  compress:
    min_size: 0
    algorithm: zstd
    always:
      - "*.txt"
  EOF
  git add -A && git commit -q -m "init"
  mkdir -p data ../remote
---
# Track a compressible file

```console
$ cp small-file.txt data/readme.txt
$ blobsy track data/readme.txt
Tracking data/readme.txt
Created data/readme.txt.yref
Added data/readme.txt to .gitignore
? 0
```

# Push with compression enabled

```console
$ git add -A && git commit -q -m "track readme"
$ blobsy push data/readme.txt
Pushing 1 file...
  ◑ data/readme.txt (13 B) - pushed (compressed: zstd)
Done: 1 pushed.
? 0
```

# Verify ref has compression fields

```console
$ cat data/readme.txt.yref
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: [HASH]
size: 13
remote_key: [REMOTE_KEY]
compressed: zstd
compressed_size: [..]
? 0
```

# Remote has compressed blob (with .zst suffix in key)

```console
$ find ../remote/ -type f | sort
../remote/[REMOTE_KEY]
? 0
```

# Delete local file, pull decompresses

```console
$ rm data/readme.txt
$ blobsy pull data/readme.txt
Pulling 1 file...
  data/readme.txt (13 B) - pulled (decompressed: zstd)
Done: 1 pulled.
? 0
```

# Verify content matches after decompress round-trip

```console
$ cat data/readme.txt
hello blobsy
$ blobsy verify data/readme.txt
Verifying 1 tracked file...
  data/readme.txt   ok (sha256 matches)
1 ok, 0 mismatch, 0 missing.
? 0
```
