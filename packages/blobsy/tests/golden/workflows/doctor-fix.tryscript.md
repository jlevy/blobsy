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
# Doctor on healthy repo -- no issues

```console
$ blobsy doctor
[..]
No issues detected.
? 0
```

# Break: remove the gitignore entry

```console
$ echo "" > data/.gitignore
? 0
```

# Doctor detects the missing gitignore entry

```console
$ blobsy doctor
[..]
✗ 1 .yref file missing corresponding .gitignore entry:
  data/model.bin.yref -> data/model.bin not in .gitignore

1 issue detected. Run 'blobsy doctor --fix' to repair.
? 1
```

# Fix it

```console
$ blobsy doctor --fix
[..]
✗ 1 .yref file missing corresponding .gitignore entry:
  data/model.bin.yref -> data/model.bin not in .gitignore
  FIXED: Added data/model.bin to .gitignore

1 issue fixed.
? 0
```

# Verify the fix

```console
$ cat data/.gitignore
# >>> blobsy-managed (do not edit) >>>
model.bin
# <<< blobsy-managed <<<
$ blobsy doctor
[..]
No issues detected.
? 0
```

# Break: add an orphaned gitignore entry (file not tracked)

```console
$ echo "orphaned-file.bin" >> data/.gitignore
? 0
```

# Doctor detects orphaned entry

```console
$ blobsy doctor
[..]
✗ 1 orphaned .gitignore entry (no matching .yref):
  data/.gitignore: orphaned-file.bin

1 issue detected. Run 'blobsy doctor --fix' to repair.
? 1
```

# Fix orphaned entry

```console
$ blobsy doctor --fix
[..]
✗ 1 orphaned .gitignore entry (no matching .yref):
  data/.gitignore: orphaned-file.bin
  FIXED: Removed orphaned entry

1 issue fixed.
? 0
```

# Break: corrupt the .yref file

```console
$ echo "this is not yaml: [[[" > data/model.bin.yref
? 0
```

# Doctor detects malformed ref

```console
$ blobsy doctor
[..]
✗ 1 invalid .yref file:
  data/model.bin.yref: Failed to parse YAML

1 issue detected.
? 1
```
