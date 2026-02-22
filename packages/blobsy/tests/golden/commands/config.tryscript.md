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
---
# Show all config

```console
$ blobsy config
backends:
  default:
    url: local:remote
? 0
```

# Show specific key

```console
$ blobsy config backend
(not set)
? 0
```

# Show externalization defaults

```console
$ blobsy config externalize
min_size: 1mb
always:
  - "*.parquet"
  - "*.bin"
  - "*.weights"
  - "*.onnx"
  - "*.safetensors"
  - "*.pkl"
  - "*.pt"
  - "*.h5"
  - "*.arrow"
  - "*.sqlite"
  - "*.db"
never: []
? 0
```

# Show compression defaults

```console
$ blobsy config compress
algorithm: zstd
min_size: 100kb
always:
  - "*.json"
  - "*.csv"
  - "*.tsv"
  - "*.txt"
  - "*.jsonl"
  - "*.xml"
  - "*.sql"
never:
  - "*.gz"
  - "*.zst"
  - "*.zip"
  - "*.tar.*"
  - "*.parquet"
  - "*.png"
  - "*.jpg"
  - "*.jpeg"
  - "*.mp4"
  - "*.webp"
  - "*.avif"
? 0
```

# Show remote key template

```console
$ blobsy config remote
key_template: "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"
? 0
```

# Set a config value

```console
$ blobsy config compress.algorithm zstd
Set compress.algorithm = zstd
? 0
```

```console
$ blobsy config compress.algorithm
zstd
? 0
```
