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
# Verify initial state: both .bref files committed

```console
$ git show --name-only HEAD | grep bref | sort
data/model.bin.bref
data/notes.csv.bref
? 0
```

# Untrack a file and verify staging

After `blobsy untrack`, the .gitignore should be staged and the old .bref should be
removed from the git index.

```console
$ blobsy untrack data/model.bin
Untracked data/model.bin
Moved data/model.bin.bref to trash
? 0
```

# Verify .bref was removed from git index

```console
$ git diff --cached --name-only | sort
data/.gitignore
data/model.bin.bref
? 0
```

# Verify git status shows the .bref as deleted (staged)

```console
$ git diff --cached --diff-filter=D --name-only
data/model.bin.bref
? 0
```

# Verify .gitignore was modified (staged)

```console
$ git diff --cached --diff-filter=M --name-only
data/.gitignore
? 0
```

# Reset to tracked baseline, then verify untrack --all stages all .bref deletions

```console
$ git reset --hard -q HEAD
? 0
```

```console
$ (cd data && blobsy untrack --all)
Untracked data/model.bin
Moved data/model.bin.bref to trash
Untracked data/notes.csv
Moved data/notes.csv.bref to trash
Untracked 2 files across repository
? 0
```

```console
$ git diff --cached --name-only | sort
data/.gitignore
data/model.bin.bref
data/notes.csv.bref
? 0
```

```console
$ git diff --cached --diff-filter=D --name-only | sort
data/model.bin.bref
data/notes.csv.bref
? 0
```
