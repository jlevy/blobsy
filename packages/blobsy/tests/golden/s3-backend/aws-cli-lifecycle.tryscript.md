---
sandbox: true
timeout: 30000
env:
  BLOBSY_NO_HOOKS: "1"
  # Dummy credentials for the sandbox-local `rclone serve s3` endpoint below;
  # they never touch a real cloud service.
  AWS_ACCESS_KEY_ID: blobsy-test-key
  AWS_SECRET_ACCESS_KEY: blobsy-test-secret # skipcq: SCT-A000
  AWS_DEFAULT_REGION: us-east-1
  AWS_EC2_METADATA_DISABLED: "true"
  AWS_REQUEST_CHECKSUM_CALCULATION: when_required
  AWS_RESPONSE_CHECKSUM_VALIDATION: when_required
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
before: |
  if ! command -v aws >/dev/null 2>&1; then
    echo "SKIP: aws CLI not installed" >&2
    exit 1
  fi
  if ! command -v rclone >/dev/null 2>&1; then
    echo "SKIP: rclone not installed (needed to serve a local S3 endpoint)" >&2
    exit 1
  fi
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  mkdir -p s3-store/blobsy-test-bucket
  rclone serve s3 --addr 127.0.0.1:20787 \
    --auth-key blobsy-test-key,blobsy-test-secret \
    s3-store < /dev/null > rclone-serve.log 2>&1 &
  echo $! > rclone-serve.pid
  i=0
  while [ "$i" -lt 100 ]; do
    if curl -s -o /dev/null "http://127.0.0.1:20787/"; then break; fi
    i=$((i+1))
    sleep 0.1
  done
  if ! kill -0 "$(cat rclone-serve.pid)" 2>/dev/null; then
    echo "ERROR: rclone serve s3 failed to start (port 20787 in use?)" >&2
    cat rclone-serve.log >&2
    exit 1
  fi
  cat > .blobsy.yml << YAML
  backends:
    default:
      url: s3://blobsy-test-bucket/blobs/
      endpoint: http://127.0.0.1:20787
  compress:
    algorithm: none
  YAML
  echo ".blobsy/" >> .gitignore
  git add -A && git commit -q -m "init"
  mkdir -p data
after: |
  if [ -f rclone-serve.pid ]; then
    kill "$(cat rclone-serve.pid)" 2>/dev/null || true
  fi
---
# Full S3 backend lifecycle with the real aws CLI: track -> push -> pull -> sync -> verify -> doctor

This test exercises the AwsCliBackend (`aws s3 cp` / `aws s3api`) end to end against a
hermetic local S3 endpoint (`rclone serve s3` backed by a sandbox directory), so it runs
the real aws binary without needing cloud credentials.

## Track two files

```console
$ cp small-file.txt data/model.bin && cp another-file.txt data/dataset.csv
? 0
```

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ blobsy track data/dataset.csv
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

## Push both files via the aws CLI

```console
$ blobsy push
  ↑  data/dataset.csv (12 B)
  ↑  data/model.bin (13 B)
Done: 2 pushed.
? 0
```

## Verify blobs landed in the S3 store directory

```console
$ find s3-store -type f | wc -l | awk '{print $1}'
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
$ blobsy status
  ✓  data/dataset.csv  synced (12 B)
  ✓  data/model.bin  synced (13 B)

2 tracked files: 2 synced
? 0
```

## Delete local files and pull them back via the aws CLI

```console
$ rm data/model.bin data/dataset.csv
? 0
```

```console
$ blobsy pull
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
$ blobsy verify
  ✓  data/dataset.csv  ok
  ✓  data/model.bin  ok

All files verified.
? 0
```

## Push again (already synced -- no-op)

```console
$ blobsy push
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
$ blobsy sync --skip-health-check
  ✓ data/dataset.csv - up to date
  ↑ data/model.bin - pushed (modified)
Sync complete: 1 pushed, 0 pulled, 0 errors.
? 0
```

## Verify 3 blobs now in the store (2 original + 1 updated)

```console
$ find s3-store -type f | wc -l | awk '{print $1}'
3
? 0
```

## Doctor shows healthy S3 backend

```console
$ blobsy doctor
  ✓  data/dataset.csv  synced (12 B)
  ✓  data/model.bin  synced (16 B)

2 tracked files: 2 synced

=== GIT HOOKS ===
  ⚠  pre-commit hook not installed
  ⚠  pre-push hook not installed

2 issues found. Run with --fix to attempt repairs.
? 0
```
