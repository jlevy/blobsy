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
  mkdir -p remote
  mkdir -p data
  cp small-file.txt data/model.bin
---
# Dry-run track shows what would happen without doing it

```console
$ blobsy --dry-run track data/model.bin
Would track data/model.bin
? 0
```

# File is NOT actually tracked (no .bref created)

```console
$ test -f data/model.bin.bref && echo "exists" || echo "not exists"
not exists
? 0
```

# Now actually track so we can test other dry-run commands

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

# Dry-run untrack shows what would happen

```console
$ blobsy --dry-run untrack data/model.bin
Would untrack data/model.bin
? 0
```

# Dry-run untrack --all previews repo-wide untrack

```console
$ blobsy --dry-run untrack --all
Would untrack data/model.bin
Untracked 1 file across repository
? 0
```

# File is still tracked (.bref still exists)

```console
$ test -f data/model.bin.bref && echo "exists" || echo "not exists"
exists
? 0
```

# Dry-run rm shows what would happen

```console
$ blobsy --dry-run rm data/model.bin
Would remove data/model.bin
? 0
```

# File still exists

```console
$ test -f data/model.bin && echo "exists" || echo "not exists"
exists
? 0
```

# Dry-run with --json output

```console
$ blobsy --dry-run --json track data/model.bin
{
  "schema_version": "0.1",
  "dry_run": true,
  "actions": [
    "update data/model.bin.bref"
  ]
}
? 0
```

# Dry-run push shows what would be pushed

```console
$ blobsy --dry-run push
Would push data/model.bin
Would push 1 file
? 0
```

# Dry-run pull shows what would be pulled

```console
$ blobsy --dry-run pull
Would pull 0 files
? 0
```

# Dry-run sync shows what would happen

```console
$ blobsy --dry-run sync
Would push data/model.bin
? 0
```
