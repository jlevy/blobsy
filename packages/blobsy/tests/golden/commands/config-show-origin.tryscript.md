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
---
# Show all config values with origins

## Set some custom values at different levels

```console
$ blobsy config --global compress.algorithm gzip
Set compress.algorithm = gzip
? 0
```

```console
$ blobsy config externalize.min_size 5mb
Set externalize.min_size = 5mb
? 0
```

## List all config values with origins (sample output)

```console
$ blobsy config --show-origin | grep -E "(compress\.algorithm|externalize\.min_size)"
global	~/.blobsy.yml	compress.algorithm=gzip
repo	.blobsy.yml	externalize.min_size=5mb
? 0
```

## Show origin for specific keys

```console
$ blobsy config --show-origin compress.algorithm
global	~/.blobsy.yml	gzip
? 0
```

```console
$ blobsy config --show-origin externalize.min_size
repo	.blobsy.yml	5mb
? 0
```

```console
$ blobsy config --show-origin compress.min_size
builtin		100kb
? 0
```
