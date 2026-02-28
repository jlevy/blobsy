---
sandbox: true
env:
  BLOBSY_NO_HOOKS: "1"
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
before: |
  if ! command -v rclone >/dev/null 2>&1; then
    echo "SKIP: rclone not installed" >&2
    exit 1
  fi
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  mkdir -p rclone-remote
  cat > rclone.conf << CONF
  [test-local]
  type = local
  nounc = true
  CONF
  export RCLONE_CONFIG="$(pwd)/rclone.conf"
  cat > .blobsy.yml << YAML
  backends:
    default:
      type: gcs
      rclone_remote: test-local
      bucket: rclone-remote
      prefix: ""
  compress:
    algorithm: none
  YAML
  echo ".blobsy/" >> .gitignore
  git add -A && git commit -q -m "init"
  mkdir -p data
---
# Full rclone backend lifecycle: track -> push -> pull -> sync -> verify -> doctor

This test exercises the rclone backend using a local remote type, which goes through the
real rclone binary without needing cloud credentials.

## Track two files

```console
$ cp small-file.txt data/model.bin && cp another-file.txt data/dataset.csv
? 0
```

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy track data/dataset.csv
Tracking data/dataset.csv
Created data/dataset.csv.bref
Added data/dataset.csv to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ git add -A && git commit -q -m "Track data files"
? 0
```

## Push both files via rclone

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy push
  ↑  data/dataset.csv (12 B)
  ↑  data/model.bin (13 B)
Done: 2 pushed.
? 0
```

## Verify blobs landed in the rclone-remote directory

```console
$ find rclone-remote -type f | wc -l | awk '{print $1}'
2
? 0
```

## Commit remote_key updates

```console
$ git add -A && git commit -q -m "Update remote keys after push"
? 0
```

## Status shows synced

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy status
  ✓  data/dataset.csv  synced (12 B)
  ✓  data/model.bin  synced (13 B)

2 tracked files: 2 synced
? 0
```

## Delete local files and pull them back via rclone

```console
$ rm data/model.bin data/dataset.csv
? 0
```

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy pull
  ↓  data/dataset.csv (12 B)
  ↓  data/model.bin (13 B)
Done: 2 pulled.
? 0
```

## Verify pulled content matches original

```console
$ cat data/model.bin
hello blobsy
? 0
```

```console
$ cat data/dataset.csv
second file
? 0
```

## Verify hash integrity after round-trip

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy verify
  ✓  data/dataset.csv  ok
  ✓  data/model.bin  ok

All files verified.
? 0
```

## Push again (already synced -- no-op)

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy push
  data/dataset.csv  already pushed
  data/model.bin  already pushed
Done: 0 pushed.
? 0
```

## Sync cycle: modify a file, sync pushes the change

```console
$ echo "updated content" > data/model.bin
? 0
```

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy sync --skip-health-check
  ✓ data/dataset.csv - up to date
  ↑ data/model.bin - pushed (modified)
Sync complete: 1 pushed, 0 pulled, 0 errors.
? 0
```

## Verify 3 blobs now in remote (2 original + 1 updated)

```console
$ find rclone-remote -type f | wc -l | awk '{print $1}'
3
? 0
```

## Doctor shows healthy rclone backend

```console
$ RCLONE_CONFIG="$(pwd)/rclone.conf" blobsy doctor
  ✓  data/dataset.csv  synced (12 B)
  ✓  data/model.bin  synced (16 B)

2 tracked files: 2 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

2 issues found. Run with --fix to attempt repairs.
? 0
```
