---
sandbox: true
---
# Skill brief output

```console
$ blobsy skill --brief
blobsy: Git-native large file storage CLI.
...
? 0
```

# Skill full output starts with markdown header

```console
$ blobsy skill | head -3
# blobsy
...
? 0
```

```console
$ blobsy skill | grep -c '##'
[..]
? 0
```
