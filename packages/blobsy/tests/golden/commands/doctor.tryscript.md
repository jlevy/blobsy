---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
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
# Doctor on healthy repo

```console
$ blobsy doctor

=== CONFIGURATION ===
Backend: local:../remote

=== REPOSITORY STATE ===
Git repository: [CWD]
Branch: [..]

Tracked files: 1 total (13 B)
  ✓ 1 fully synced (13 B)

Stat cache: 1 entry, 0 stale

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✓ No .yref files missing corresponding .gitignore entries

No issues detected.
? 0
```

# Break things: clear the gitignore

```console
$ echo "" > data/.gitignore
? 0
```

# Doctor detects missing gitignore entry

```console
$ blobsy doctor

=== CONFIGURATION ===
Backend: local:../remote

=== REPOSITORY STATE ===
Git repository: [CWD]
Branch: [..]

Tracked files: 1 total (13 B)
  ✓ 1 fully synced (13 B)

Stat cache: 1 entry, 0 stale

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✗ 1 .yref file missing corresponding .gitignore entry:
  data/model.bin.yref -> data/model.bin not in .gitignore

1 issue detected. Run 'blobsy doctor --fix' to repair.
? 1
```

# Doctor --fix repairs the issue

```console
$ blobsy doctor --fix
[..]
✗ 1 .yref file missing corresponding .gitignore entry:
  data/model.bin.yref -> data/model.bin not in .gitignore
  FIXED: Added data/model.bin to .gitignore

1 issue fixed.
? 0
```

# Verify the fix, then re-run doctor

```console
$ blobsy doctor

=== CONFIGURATION ===
Backend: local:../remote

=== REPOSITORY STATE ===
Git repository: [CWD]
Branch: [..]

Tracked files: 1 total (13 B)
  ✓ 1 fully synced (13 B)

Stat cache: 1 entry, 0 stale

=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✓ No .yref files missing corresponding .gitignore entries

No issues detected.
? 0
```

# Doctor detects modified file

```console
$ echo "modified" > data/model.bin
$ blobsy doctor
[..]
=== INTEGRITY CHECKS ===
✓ All .yref files valid YAML
✓ All .yref format versions supported (blobsy-yref/0.1)
✓ No orphaned .gitignore entries
✓ No .yref files missing corresponding .gitignore entries
⚠ 1 file modified locally (hash mismatch with .yref)
  → Run 'blobsy track data/model.bin' to update ref

1 warning.
? 1
```
