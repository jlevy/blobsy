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
  git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
  blobsy track data/model.bin
  blobsy push data/model.bin
  git add -A && git commit -q -m "track and push"
---
# Start on main: fully synced

```console
$ blobsy status
...
1 tracked file
? 0
```

# Create feature branch

```console
$ git checkout -b feature/new-data 2>&1
[..]
? 0
```

# Add a new file on feature branch

```console
$ cp another-file.txt data/results.csv
? 0
```

```console
$ blobsy track data/results.csv
Tracking data/results.csv
Created data/results.csv.yref
Added data/results.csv to .gitignore
? 0
```

```console
$ blobsy push data/results.csv
  data/results.csv ([SIZE] B) - pushed
Done: 1 pushed.
? 0
```

# Verify results.csv has remote_key after push

```console
$ grep remote_key data/results.csv.yref
remote_key: [REMOTE_KEY]
? 0
```

```console
$ git add -A && git commit -q -m "add results"
? 0
```

# Feature branch status

```console
$ blobsy status
...
2 tracked files
? 0
```

# Merge back to main

```console
$ git checkout main 2>&1
[..]
? 0
```

```console
$ git merge feature/new-data -q
? 0
```

# On main after merge: both files present

```console
$ blobsy status
...
2 tracked files
? 0
```

# Sync is no-op since blobs already exist from feature branch

```console
$ blobsy sync
...
Sync complete: 0 pushed, 0 pulled, 0 errors.
? 0
```

# Verify all files

```console
$ blobsy verify
...
All files verified.
? 0
```
