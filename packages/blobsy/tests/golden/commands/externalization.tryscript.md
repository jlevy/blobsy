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
  mkdir -p remote
  mkdir -p data
  echo "tiny" > data/small.txt
  printf '%100s' '' > data/large.bin
  echo "keep me" > data/notes.md
---
# Configure externalization rules

```console
$ blobsy config externalize.min_size 50
Set externalize.min_size = 50
? 0
```

```console
$ blobsy config externalize.never "*.md"
Set externalize.never = *.md
? 0
```

# Track directory: small files and .md files should be skipped

```console
$ blobsy track data/
Scanning data/...
  data/large.bin        ( 100 B)  -> tracked
1 file tracked.

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

# Verify only large.bin was externalized (small.txt and notes.md skipped)

```console
$ find data/ -name '*.bref' | sort
data/large.bin.bref
? 0
```

```console
$ test ! -f data/small.txt.bref && test ! -f data/notes.md.bref && echo "correctly skipped"
correctly skipped
? 0
```
