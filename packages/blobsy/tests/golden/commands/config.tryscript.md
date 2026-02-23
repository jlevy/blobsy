---
sandbox: true
fixtures:
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
before: |
  # Clean up any existing global config from previous test runs
  rm -f ~/.blobsy.yml
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
always: []
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

# Set a global config value

```console
$ blobsy config --global compress.algorithm gzip
Set compress.algorithm = gzip
? 0
```

```console
$ blobsy config --global compress.algorithm
gzip
? 0
```

# Unset a config value

```console
$ blobsy config compress.algorithm lz4
Set compress.algorithm = lz4
? 0
```

```console
$ blobsy config --unset compress.algorithm
Unset compress.algorithm
Effective value (from other scope): gzip
? 0
```

```console
$ blobsy config compress.algorithm
gzip
? 0
```

# Unset non-existent key

```console
$ blobsy config --unset nonexistent.key
Key nonexistent.key was not set
? 0
```

# Show origin for specific key

```console
$ blobsy config --show-origin compress.algorithm
global	~/.blobsy.yml	gzip
? 0
```
