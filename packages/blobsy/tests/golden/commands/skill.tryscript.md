---
sandbox: true
---
# Skill output starts with markdown header

```console
$ blobsy skill | head -5
# blobsy

Git-native large file storage. Track large files with `.bref` pointers in Git,
store blobs in S3/local/custom backends.

? 0
```

# Skill output includes installation instructions

```console
$ blobsy skill | grep -c "npm install"
1
? 0
```

# Skill output includes setup command

```console
$ blobsy skill | grep -c "blobsy setup"
1
? 0
```

# Skill output includes quick reference commands

```console
$ blobsy skill | grep "blobsy track"
blobsy track <path...>     # Track files (creates .bref)
? 0
```

# Skill output points to status and doctor for dynamic state

```console
$ blobsy skill | grep "status --json"
blobsy status --json       # Current state (JSON)
- `blobsy status --json` - Tracked files, sync state
? 0
```
