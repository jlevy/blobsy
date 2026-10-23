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
  blobsy add data/model.bin
  git commit -q -m "track model"
---
# Verify initial state: model.bin.bref is committed

```console
$ test -f data/model.bin.bref && echo "ref exists"
ref exists
? 0
```

# Move a tracked file and verify staging

After `blobsy mv`, the new .bref should be staged and the old .bref should be removed
from the index.

```console
$ blobsy mv data/model.bin data/model-v2.bin
Moved data/model.bin -> data/model-v2.bin
? 0
```

# Verify new .bref exists and old is gone

```console
$ test -f data/model-v2.bin.bref && echo "new ref exists"
new ref exists
? 0
```

```console
$ test -f data/model.bin.bref && echo "old ref exists" || echo "old ref gone"
old ref gone
? 0
```

# Verify git sees staged changes

git detects the add+rm as a rename, so diff shows the destination and modified gitignore
(the old .bref removal is folded into the rename).

```console
$ git diff --cached --name-only | sort
data/.gitignore
data/model-v2.bin.bref
? 0
```

# Move across directories

```console
$ git commit -q -m "move model"
? 0
```

```console
$ mkdir -p archive
? 0
```

```console
$ blobsy mv data/model-v2.bin archive/model-v2.bin
Moved data/model-v2.bin -> archive/model-v2.bin
? 0
```

# Verify cross-directory staging

```console
$ git diff --cached --name-only | sort
archive/.gitignore
archive/model-v2.bin.bref
data/.gitignore
? 0
```
