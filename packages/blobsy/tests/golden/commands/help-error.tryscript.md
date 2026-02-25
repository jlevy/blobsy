---
sandbox: true
env:
  NO_COLOR: "1"
---
# Unknown command error

```console
$ blobsy badcommand
? 1
error: unknown command 'badcommand'
(use --help for usage, or blobsy docs for full guide)
```

# Missing required argument: track

```console
$ blobsy track
? 1
error: missing required argument 'path'
(use --help for usage, or blobsy docs for full guide)
```

# Missing required argument: init

```console
$ blobsy init
? 1
error: missing required argument 'url'
(use --help for usage, or blobsy docs for full guide)
```
