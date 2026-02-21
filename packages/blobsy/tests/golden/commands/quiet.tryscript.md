---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - source: ../fixtures/local-backend.blobsy.yml
    dest: .blobsy.yml
env:
  BLOBSY_NO_HOOKS: "1"
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  git add -A && git commit -q -m "init"
  mkdir -p data
  cp small-file.txt data/model.bin
---
# --quiet suppresses normal output

```console
$ blobsy --quiet track data/model.bin
? 0
```

# --quiet + --verbose is an error

```console
$ blobsy --quiet --verbose status 2>&1
Error: --quiet and --verbose cannot be used together.
? 1
```

# --quiet with --json still produces JSON (json takes precedence)

```console
$ blobsy --quiet --json status
{
  "schema_version": "0.1",
  "files": [
    {
      "path": "data/model.bin",
      "state": "new",
      "details": "not pushed"
    }
  ],
  "summary": {
    "total": 1
  }
}
? 0
```
