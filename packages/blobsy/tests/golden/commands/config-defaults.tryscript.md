---
sandbox: true
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  printf 'backends:\n  default:\n    url: local:remote\n' > .blobsy.yml
---
Pins the shipped defaults so code/docs drift is caught by CI — the README documented 1
MB while the code shipped 200 KB for months (review finding DOCS-02). If a default
changes intentionally, update this file AND README.md.

# Externalize threshold default

```console
$ blobsy config externalize.min_size
200kb
? 0
```

# Compression defaults

```console
$ blobsy config compress.algorithm
zstd
? 0
```

```console
$ blobsy config compress.min_size
100kb
? 0
```
