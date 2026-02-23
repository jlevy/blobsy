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
# Multi-level config precedence

## Set value at global level

```console
$ blobsy config --global compress.algorithm gzip
Set compress.algorithm = gzip
? 0
```

```console
$ blobsy config compress.algorithm
gzip
? 0
```

## Set value at repo level (overrides global)

```console
$ blobsy config compress.algorithm lz4
Set compress.algorithm = lz4
? 0
```

```console
$ blobsy config compress.algorithm
lz4
? 0
```

```console
$ blobsy config --global compress.algorithm
gzip
? 0
```

## Unset repo-level value (fallback to global)

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

## Unset global value (fallback to builtin)

```console
$ blobsy config --global --unset compress.algorithm
Unset compress.algorithm
? 0
```

```console
$ blobsy config compress.algorithm
zstd
? 0
```
