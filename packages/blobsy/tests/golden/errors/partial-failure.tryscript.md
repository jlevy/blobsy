---
sandbox: true
env:
  BLOBSY_BACKEND_URL: ""
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  rm -rf ../remote && mkdir -p ../remote
  cat > .blobsy.yml << 'YAML'
  backends:
    default:
      url: "local:../remote"
  YAML
  git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/good-file.bin
  cp another-file.txt data/bad-file.bin
  blobsy track data/good-file.bin
  blobsy track data/bad-file.bin
  git add -A && git commit -q -m "track"
---
# Push first file successfully

```console
$ blobsy push data/good-file.bin
...
? 0
```

# Make remote read-only

```console
$ chmod 000 ../remote
? 0
```

# Push second file fails

```console
$ blobsy push data/bad-file.bin 2>&1
...
? 1
```

# Restore permissions

```console
$ chmod 755 ../remote
? 0
```

# Push all succeeds

```console
$ blobsy push
...
? 0
```
