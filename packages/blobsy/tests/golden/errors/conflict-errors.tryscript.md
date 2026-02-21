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
  blobsy push
  git add -A && git commit -q -m "push"
---
# Pull refuses when local file is modified

```console
$ echo "local changes" > data/model.bin
$ blobsy pull data/model.bin 2>&1
Error: Cannot pull data/model.bin: local file has been modified

Local hash does not match ref hash.
Run 'blobsy track data/model.bin' to update ref to match local file, or
Run 'blobsy pull --force data/model.bin' to overwrite local changes.
? 2
```

# Pull --force overwrites local changes

```console
$ blobsy pull --force data/model.bin
Pulling 1 file (force)...
  data/model.bin (13 B) - pulled (overwriting local changes)
Done: 1 pulled.
? 0
```

# Verify the overwrite

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Push refuses when file changed after track

```console
$ echo "sneaky edit after track" > data/model.bin
$ blobsy push data/model.bin 2>&1
Error: Cannot push data/model.bin: local file does not match ref hash

The file has been modified since 'blobsy track' was last run.
Run 'blobsy track data/model.bin' first, then push.
Or run 'blobsy push --force data/model.bin' to re-track and push in one step.
? 1
```

# Push --force re-tracks and pushes

```console
$ blobsy push --force data/model.bin
Pushing 1 file (force)...
  ◑ data/model.bin (24 B) - pushed (force)
Done: 1 pushed.
? 0
```

# Sync conflict: local and ref both changed

```console
$ git add -A && git commit -q -m "force push"
$ echo "local edit" > data/model.bin
$ cat > data/model.bin.yref << 'EOF'
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:0000000000000000000000000000000000000000000000000000000000000000
size: 99
remote_key: fake-key/model.bin
EOF
$ blobsy sync 2>&1
Syncing 1 tracked file...
  ✗ data/model.bin - CONFLICT

Error: Conflict detected for data/model.bin
  Local file has been modified (hash differs from stat cache)
  Ref file has been updated (hash differs from stat cache)
  These are independent changes that cannot be auto-merged.

Resolution options:
  Keep local:  blobsy push --force data/model.bin
  Keep remote: blobsy pull --force data/model.bin

1 conflict. No files synced.
? 2
```
