---
sandbox: true
---
# Prime brief output (same as skill brief)

```console
$ blobsy prime --brief
blobsy: Git-native large file storage CLI.
...
? 0
```

# Prime full output starts with context header

```console
$ blobsy prime | head -3
# blobsy context
...
? 0
```

```console
$ blobsy prime | grep -c 'blobsy'
[..]
? 0
```
