---
sandbox: true
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
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/notes.csv
  blobsy add data/model.bin
  blobsy add data/notes.csv
  git commit -q -m "track files"
---
# Verify initial state

```console
$ git show --name-only HEAD | grep bref | sort
data/model.bin.bref
data/notes.csv.bref
? 0
```

# Remove a tracked file and verify staging

After `blobsy rm`, the .gitignore should be staged and the .bref should be removed from
the git index.

```console
$ blobsy rm data/model.bin
Removed data/model.bin
Moved data/model.bin.bref to trash
Deleted local file
? 0
```

# Verify .bref was removed from git index (staged deletion)

```console
$ git diff --cached --diff-filter=D --name-only
data/model.bin.bref
? 0
```

# Verify .gitignore modification is staged

```console
$ git diff --cached --diff-filter=M --name-only
data/.gitignore
? 0
```

# Verify local file is deleted

```console
$ test -f data/model.bin && echo "exists" || echo "deleted"
deleted
? 0
```
