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
  echo "data/" > .gitignore
  git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/notes.csv
---
# Verify data directory is gitignored

```console
$ git check-ignore data/model.bin
data/model.bin
? 0
```

# Add a file inside a gitignored directory

blobsy add should detect the gitignore conflict, rewrite the rule, and stage files.

```console
$ blobsy add data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore
Fixing .gitignore rule: data/ (in .gitignore)
Staged 3 files (1 .bref, 2 .gitignore).
Changes have been staged to git: run `git status` to review and `git commit` to commit.
? 0
```

# Verify root .gitignore was rewritten

The directory pattern is rewritten from `data/` to glob form with negation rules.

```console
$ cat .gitignore
# Directory ignore rewritten by blobsy to allow .bref tracking
data/**
!data/*/
!**/*.bref
!**/.gitignore
? 0
```

# Verify files are staged in git

```console
$ git diff --cached --name-only | sort
.gitignore
data/.gitignore
data/model.bin.bref
? 0
```

# Verify .bref file was created

```console
$ test -f data/model.bin.bref && echo "ref exists"
ref exists
? 0
```

# Add a second file in the same gitignored directory

Should work without needing to rewrite .gitignore again.

```console
$ blobsy add data/notes.csv
Tracking data/notes.csv
Created data/notes.csv.bref
Added data/notes.csv to .gitignore
Staged 2 files (1 .bref, 1 .gitignore).
Changes have been staged to git: run `git status` to review and `git commit` to commit.
? 0
```

# Verify both .bref files staged

```console
$ git diff --cached --name-only | sort
.gitignore
data/.gitignore
data/model.bin.bref
data/notes.csv.bref
? 0
```
