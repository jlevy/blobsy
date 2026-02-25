---
sandbox: true
env:
  NO_COLOR: "1"
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git config commit.gpgsign false
  git add -A && git commit -q -m "init"
  mkdir -p data remote
  cp small-file.txt data/model.bin
  blobsy add data/model.bin
  git commit -q -m "track"
---
# Clean track output with NO_COLOR=1

Semantic colors (c.muted for already-tracked, c.hint for guidance) produce plain text
when NO_COLOR is set.

```console
$ blobsy track data/model.bin
data/model.bin already tracked (unchanged)

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

# Clean status output

```console
$ blobsy status
  ○  data/model.bin  not pushed (13 B)

1 tracked file: 1 new
? 0
```

# Verify track output contains no escape character

cat -v converts escape to ^[ — verify none present.

```console
$ blobsy track data/model.bin 2>&1 | cat -v | grep -c '\^\[' || true
0
? 0
```

# --color never flag works

```console
$ blobsy --color never track data/model.bin
data/model.bin already tracked (unchanged)

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

# --color always produces colored output

When --color always is used, cat -v shows ^[ escape sequences (one per colored line).

```console
$ blobsy --color always track data/model.bin 2>&1 | cat -v | grep -c '\^\['
2
? 0
```
