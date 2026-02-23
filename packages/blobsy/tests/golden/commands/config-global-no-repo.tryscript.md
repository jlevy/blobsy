---
sandbox: true
env:
  BLOBSY_HOME: .test-home
before: |
  # Use temp directory for global config to avoid touching user's home
  rm -rf .test-home
  mkdir -p .test-home
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
