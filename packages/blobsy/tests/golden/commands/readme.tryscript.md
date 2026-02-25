---
sandbox: true
---
# Readme output starts with project header

```console
$ blobsy readme | head -5
# blobsy
...
? 0
```

# Readme contains multiple section headers

```console
$ blobsy readme | grep -c "##"
[..]
? 0
```

# Readme includes Quick Start section

```console
$ blobsy readme | grep "Quick Start"
[..]
? 0
```
