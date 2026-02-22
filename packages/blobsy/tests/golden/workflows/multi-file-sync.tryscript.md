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
  mkdir -p data/models data/datasets
  for i in 1 2 3; do echo "model $i" > data/models/model-$i.bin; done
  for i in 1 2 3; do echo "dataset $i" > data/datasets/data-$i.bin; done
---
# Track multiple files across directories (using .bin extension to match externalize patterns)

```console
$ blobsy track data/models/
Scanning data/models/...
  data/models/model-1.bin (   8 B)  -> tracked
  data/models/model-2.bin (   8 B)  -> tracked
  data/models/model-3.bin (   8 B)  -> tracked
3 files tracked.
? 0
```

```console
$ blobsy track data/datasets/
Scanning data/datasets/...
  data/datasets/data-1.bin (  10 B)  -> tracked
  data/datasets/data-2.bin (  10 B)  -> tracked
  data/datasets/data-3.bin (  10 B)  -> tracked
3 files tracked.
? 0
```

# Commit and push all

```console
$ git add -A && git commit -q -m "track files"
? 0
```

```console
$ blobsy push
  data/datasets/data-1.bin (10 B) - pushed
  data/datasets/data-2.bin (10 B) - pushed
  data/datasets/data-3.bin (10 B) - pushed
  data/models/model-1.bin (8 B) - pushed
  data/models/model-2.bin (8 B) - pushed
  data/models/model-3.bin (8 B) - pushed
Done: 6 pushed.
? 0
```

# All 6 refs have remote_key after push

```console
$ grep -rl remote_key data/ --include='*.yref' | wc -l | tr -d ' '
6
? 0
```

# Commit push updates, then verify all

```console
$ git add -A && git commit -q -m "push updates"
? 0
```

```console
$ blobsy verify
  ✓  data/datasets/data-1.bin  ok
  ✓  data/datasets/data-2.bin  ok
  ✓  data/datasets/data-3.bin  ok
  ✓  data/models/model-1.bin  ok
  ✓  data/models/model-2.bin  ok
  ✓  data/models/model-3.bin  ok

All files verified.
? 0
```

# Delete some files and sync pulls them back

```console
$ rm data/models/model-1.bin data/datasets/data-2.bin
? 0
```

```console
$ blobsy sync
  ✓ data/datasets/data-1.bin - up to date
  ↓ data/datasets/data-2.bin - pulled
  ✓ data/datasets/data-3.bin - up to date
  ↓ data/models/model-1.bin - pulled
  ✓ data/models/model-2.bin - up to date
  ✓ data/models/model-3.bin - up to date
Sync complete: 0 pushed, 2 pulled, 0 errors.
? 0
```

# Verify pulled content

```console
$ cat data/models/model-1.bin
model 1
? 0
```

```console
$ cat data/datasets/data-2.bin
dataset 2
? 0
```
