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
  git add -A && git commit -q -m "track model"
  blobsy push
  git add -A && git commit -q -m "push model"
---
# Verify starting state: fully synced

```console
$ blobsy status
Tracked files (1):
  ✓ data/model.bin (committed and synced)

All files synced.
? 0
```

# User A modifies the file locally

```console
$ echo "user A version" > data/model.bin
? 0
```

# Simulate User B: update the .yref to simulate a git pull that brought B’s changes

# (In a real scenario, User B would have pushed a different version and User A did git pull)

```console
$ echo "user B version" > /tmp/userb-model.bin
$ USER_B_HASH=$(sha256sum /tmp/userb-model.bin | cut -d' ' -f1)
$ cat > data/model.bin.yref << EOF
# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:${USER_B_HASH}
size: 15
remote_key: [REMOTE_KEY]
EOF
? 0
```

# Now sync detects the conflict: local differs from ref, and both changed since stat cache

```console
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

# Force-push to keep local version

```console
$ blobsy push --force data/model.bin
Pushing 1 file (force)...
  ◑ data/model.bin (15 B) - pushed (force)
Done: 1 pushed.
? 0
```

# Status shows synced but needs commit

```console
$ blobsy status
Tracked files (1):
  ◑ data/model.bin (not committed, synced)

Summary:
  1 needs commit (◑)

Actions needed:
  Run 'git add -A && git commit' to commit refs
? 0
```
