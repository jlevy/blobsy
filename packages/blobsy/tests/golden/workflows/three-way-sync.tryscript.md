---
sandbox: true
before: |
  mkdir -p shared-remote
  for r in repoA repoB; do
    mkdir -p $r/data
    (cd $r \
      && git init -q -b main \
      && git config user.name "Blobsy Test" \
      && git config user.email "blobsy-test@example.com" \
      && printf 'backends:\n  default:\n    url: local:../shared-remote\n' > .blobsy.yml \
      && git add -A && git commit -q -m init)
  done
  printf 'version one\n' > repoA/data/doc.txt
  (cd repoA && blobsy track data/doc.txt >/dev/null && blobsy push data/doc.txt >/dev/null)
  cp repoA/data/doc.txt.bref repoB/data/doc.txt.bref
  cp repoA/data/.gitignore repoB/data/.gitignore
---
# User B clones (bref arrives via git) and pulls; sync base established

```console
$ cd repoB && blobsy pull data/doc.txt
  ↓  data/doc.txt (12 B)
Done: 1 pulled.
? 0
```

# User A updates the file and pushes; B receives the new .bref via git pull

```console
$ cd repoA && printf 'version two\n' > data/doc.txt && blobsy track data/doc.txt >/dev/null && blobsy push data/doc.txt >/dev/null && cp data/doc.txt.bref ../repoB/data/doc.txt.bref
? 0
```

# DS-01: sync on B pulls the teammate’s update instead of reverting it

```console
$ cd repoB && blobsy sync --skip-health-check
  ↓ data/doc.txt - pulled (updated)
Sync complete: 0 pushed, 1 pulled, 0 errors.
? 0
```

```console
$ cat repoB/data/doc.txt
version two
? 0
```

# DS-01: both sides changed -> conflict, exit 2, nothing destroyed

```console
$ cd repoB && printf 'B local edit\n' > data/doc.txt
? 0
```

```console
$ cd repoA && printf 'A newer version\n' > data/doc.txt && blobsy track data/doc.txt >/dev/null && blobsy push data/doc.txt >/dev/null && cp data/doc.txt.bref ../repoB/data/doc.txt.bref
? 0
```

```console
$ cd repoB && blobsy sync --skip-health-check
  ✗ data/doc.txt - conflict: local and .bref both changed since last sync (local sha256:b21d59ea3149…, ref sha256:d2e2fb715109…); resolve with an explicit choice: `blobsy push --force` (keep local) or `blobsy pull --force` (take remote)
Sync complete: 0 pushed, 0 pulled, 0 errors, 1 conflicts.
? 2
```

```console
$ cat repoB/data/doc.txt
B local edit
? 0
```

# DS-02: pull refuses to overwrite the modified local file without --force

```console
$ cd repoB && blobsy pull data/doc.txt
  ✗ data/doc.txt - local file modified; use `blobsy pull --force` to overwrite (or `blobsy push` to keep local)
Done: 0 pulled, 1 refused (locally modified).
? 2
```

# DS-02: pull --force resolves the conflict by taking remote

```console
$ cd repoB && blobsy pull --force data/doc.txt
  ↓  data/doc.txt (16 B)
Done: 1 pulled.
? 0
```

```console
$ cat repoB/data/doc.txt
A newer version
? 0
```

# Pushed file modified afterwards: push says so instead of “already pushed”

```console
$ cd repoB && printf 'B edits again\n' > data/doc.txt && blobsy push data/doc.txt
  ⚠ data/doc.txt  modified since last push (run `blobsy sync` or `blobsy push --force`)
Done: 0 pushed.
? 0
```

# DS-03: push refuses content modified after track (stale hash, no remote_key)

```console
$ cd repoB && printf 'fresh content\n' > data/fresh.bin && blobsy track data/fresh.bin >/dev/null && printf 'edited after track\n' > data/fresh.bin && blobsy push data/fresh.bin
  ✗  data/fresh.bin - FAILED: local file changed since it was tracked (hash mismatch); run `blobsy track` to re-track, `blobsy pull --force` to restore, or `blobsy push --force` to push the current content
Done: 0 pushed, 1 failed.
? 1
```

# Ambiguity: local differs from ref with no merge base -> explicit error

```console
$ cd repoB && rm -rf .blobsy/stat-cache && blobsy sync --skip-health-check data/doc.txt
  ✗ data/doc.txt - no merge base to tell a local edit from a git pull; run `blobsy push` or `blobsy pull` explicitly
Sync complete: 0 pushed, 0 pulled, 0 errors, 1 conflicts.
? 2
```
