---
sandbox: true
---
# Skill output starts with markdown header

```console
$ blobsy skill | head -5
---
name: blobsy
description: Track large files in Git with .bref pointers; store blobs in S3, local directories, or custom backends. Use when a repo has large binary files, when files must sync across machines without committing bytes to Git, or when the user mentions blobsy, .bref, externalize, or a Git LFS alternative.
---
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
blobsy track <path...>     # Track files (creates .bref pointers)
? 0
```

# Skill output points to status and doctor for dynamic state

```console
$ blobsy skill | grep "status --json"
blobsy status --json       # Current state (JSON)
- `blobsy status --json` - Tracked files, sync state
? 0
```
