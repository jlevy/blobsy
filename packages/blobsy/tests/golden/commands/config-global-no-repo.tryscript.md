---
sandbox: true
before: |
  # Clean up any existing global config from previous test runs
  rm -f ~/.blobsy.yml
---
# Global config outside git repository

## Set global config value (should work)

```console
$ blobsy config --global compress.algorithm gzip
Set compress.algorithm = gzip
? 0
```

## Get global config value (should work)

```console
$ blobsy config --global compress.algorithm
gzip
? 0
```

## Unset global config value (should work)

```console
$ blobsy config --global --unset compress.algorithm
Unset compress.algorithm
? 0
```

## Try to get repo config without --global (should fail)

```console
$ blobsy config compress.algorithm
Error: Not inside a git repository.

  Run this command from within a git repo.
? 1
```

## Try to set repo config without --global (should fail)

```console
$ blobsy config compress.algorithm lz4
Error: Not inside a git repository.

  Run this command from within a git repo.
? 1
```
