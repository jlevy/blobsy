---
sandbox: true
fixtures:
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
env:
  BLOBSY_HOME: .test-home
before: |
  # Use temp directory for global config to avoid touching user's home
  rm -rf .test-home
  mkdir -p .test-home
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p remote
---
# config --json show all

```console
$ blobsy config --json
{
  "schema_version": "0.1",
  "config": {
    "externalize": {
      "min_size": "200kb",
      "always": [],
      "never": []
    },
    "compress": {
      "algorithm": "zstd",
      "min_size": "100kb",
      "always": [
        "*.json",
        "*.csv",
        "*.tsv",
        "*.txt",
        "*.jsonl",
        "*.xml",
        "*.sql"
      ],
      "never": [
        "*.gz",
        "*.zst",
        "*.zip",
        "*.tar.*",
        "*.parquet",
        "*.png",
        "*.jpg",
        "*.jpeg",
        "*.mp4",
        "*.webp",
        "*.avif"
      ]
    },
    "remote": {
      "key_template": "{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}"
    },
    "sync": {
      "tools": [
        "aws-cli",
        "rclone"
      ],
      "parallel": 8
    },
    "checksum": {
      "algorithm": "sha256"
    },
    "ignore": [
      "node_modules/**",
      ".git/**",
      ".blobsy/**",
      "*.tmp",
      "dist/**",
      "build/**",
      "__pycache__/**",
      "*.pyc",
      ".DS_Store"
    ],
    "backends": {
      "default": {
        "url": "local:remote"
      }
    }
  }
}
? 0
```

# config --json get specific key

```console
$ blobsy config --json compress.algorithm
{
  "schema_version": "0.1",
  "key": "compress.algorithm",
  "value": "zstd"
}
? 0
```

# config --json --global set value

```console
$ blobsy config --json --global compress.algorithm gzip
{
  "schema_version": "0.1",
  "message": "Set compress.algorithm = gzip",
  "level": "info"
}
? 0
```

# config --json --global get value

```console
$ blobsy config --json --global compress.algorithm
{
  "schema_version": "0.1",
  "key": "compress.algorithm",
  "value": "gzip"
}
? 0
```

# config --json --unset (non-existent key)

```console
$ blobsy config --json --unset nonexistent.key
{
  "schema_version": "0.1",
  "message": "Key nonexistent.key was not set",
  "level": "info"
}
? 0
```

# config --json --show-origin for specific key

```console
$ blobsy config --json --show-origin compress.algorithm
{
  "schema_version": "0.1",
  "key": "compress.algorithm",
  "value": "gzip",
  "origin": "global",
  "file": "~/.blobsy.yml"
}
? 0
```
