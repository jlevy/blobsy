---
sandbox: true
fixtures:
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p ../remote
---
# Health check passes for local backend

```console
$ blobsy health
✓ Backend reachable (local: ../remote)
✓ Directory exists and is writable
? 0
```

# Health check fails when remote directory doesn’t exist

```console
$ rm -rf ../remote
$ blobsy health 2>&1
✗ Backend unreachable (local: ../remote)

Error: Remote directory does not exist: ../remote
Create it with: mkdir -p ../remote
? 1
```

# Health check fails when remote directory isn’t writable

```console
$ mkdir -p ../remote
$ chmod 000 ../remote
$ blobsy health 2>&1
✗ Backend unreachable (local: ../remote)

Error: Remote directory is not writable: ../remote
Check permissions: ls -la ../remote
? 1
```

```console
$ chmod 755 ../remote
? 0
```
