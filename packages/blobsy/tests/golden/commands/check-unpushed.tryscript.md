---
sandbox: true
fixtures:
  - fixtures/small-file.txt
  - fixtures/another-file.txt
  - source: fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data ../remote
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
  blobsy track data/model.bin
  blobsy track data/dataset.csv
  git add -A && git commit -q -m "track files"
---
# Check-unpushed when refs are committed but blobs never pushed

```console
$ blobsy check-unpushed

⚠ Found 2 .yref files in HEAD with missing remote blobs:

  data/dataset.csv.yref
    Committed: [TIMESTAMP]
    Author: [..]
    Issue: remote_key not set (never pushed)

  data/model.bin.yref
    Committed: [TIMESTAMP]
    Author: [..]
    Issue: remote_key not set (never pushed)

To fix: Run 'blobsy push' to upload missing blobs.
? 1
```

# Push one file, then check again

```console
$ blobsy push data/model.bin
[..]
$ git add -A && git commit -q -m "push model"
$ blobsy check-unpushed

⚠ Found 1 .yref file in HEAD with missing remote blob:

  data/dataset.csv.yref
    Committed: [TIMESTAMP]
    Author: [..]
    Issue: remote_key not set (never pushed)

To fix: Run 'blobsy push' to upload missing blobs.
? 1
```

# Push all, then check (all clear)

```console
$ blobsy push
[..]
$ git add -A && git commit -q -m "push all"
$ blobsy check-unpushed

✓ All committed .yref files have remote blobs
  Checked 2 .yref files in HEAD
? 0
```
