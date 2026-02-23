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
---
# config --json show all

```console
$ blobsy config --json
{
  "schema_version": "0.1",
  "config": {
    "externalize": {
      "min_size": "1mb",
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
