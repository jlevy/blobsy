---
sandbox: true
---
# Top-level help

```console
$ blobsy --help
Usage: blobsy [options] [command]

Store large files anywhere. Track them in Git.

Options:
  --version              Show version number
  --json                 Structured JSON output
  --quiet                Suppress all output except errors
  --verbose              Detailed progress output
  --dry-run              Show what would happen without doing it
  -h, --help             Display help for command

Commands:
  init <url>             Initialize blobsy in a git repo with a backend URL
  track <path...>        Start tracking files or directories with .yref pointers
  untrack <path...>      Stop tracking files (keeps local files, moves .yref to trash)
  rm <path...>           Remove tracked files: delete local + move .yref to trash
  mv <source> <dest>     Rename or move a tracked file (updates .yref + .gitignore)
  push [path...]         Upload local blobs to the configured backend
  pull [path...]         Download blobs from the configured backend
  sync [path...]         Bidirectional sync: push unpushed + pull missing
  status [path...]       Show sync state of tracked files
  verify [path...]       Verify local files match their .yref hashes
  config [key] [value]   Show, get, or set .blobsy.yml values
  health                 Test backend connectivity and permissions
  doctor                 Run diagnostics and optionally auto-fix issues
  hooks <action>         Install or uninstall the blobsy pre-commit hook
  check-unpushed         List committed .yref files whose blobs are not yet pushed
  pre-push-check         CI guard: fail if any .yref is missing its remote blob
  trust                  Trust this repo to run command backends from .blobsy.yml
  skill                  Output blobsy skill documentation (for AI agents)
  prime                  Output context primer for AI agents working in this repo
  help [command]         Display help for command

Get started:
  blobsy init s3://bucket/prefix/
  blobsy track <file>
  blobsy push

Docs: https://github.com/jlevy/blobsy

? 0
```

# Per-command help: track

```console
$ blobsy track --help
Usage: blobsy track [options] <path...>

Start tracking files or directories with .yref pointers

Arguments:
  path                   Files or directories to track

Options:
  --force                Skip confirmation for destructive operations
  -h, --help             Display help for command
? 0
```

# Per-command help: push

```console
$ blobsy push --help
Usage: blobsy push [options] [path...]

Upload local blobs to the configured backend

Arguments:
  path                   Files or directories (default: all tracked)

Options:
  --force                Re-push even if remote exists
  -h, --help             Display help for command
? 0
```

# Per-command help: pull

```console
$ blobsy pull --help
Usage: blobsy pull [options] [path...]

Download blobs from the configured backend

Arguments:
  path                   Files or directories (default: all tracked)

Options:
  --force                Overwrite local modifications
  -h, --help             Display help for command
? 0
```

# Per-command help: status

```console
$ blobsy status --help
Usage: blobsy status [options] [path...]

Show sync state of tracked files

Arguments:
  path                   Files or directories (default: all tracked)

Options:
  --json                 Structured JSON output
  -h, --help             Display help for command
? 0
```

# Per-command help: sync

```console
$ blobsy sync --help
Usage: blobsy sync [options] [path...]

Bidirectional sync: push unpushed + pull missing

Arguments:
  path                   Files or directories (default: all tracked)

Options:
  --skip-health-check    Skip backend health check
  --force                Force sync (overwrite conflicts)
  -h, --help             Display help for command
? 0
```

# Per-command help: verify

```console
$ blobsy verify --help
Usage: blobsy verify [options] [path...]

Verify local files match their .yref hashes

Arguments:
  path                   Files or directories (default: all tracked)

Options:
  --json                 Structured JSON output
  -h, --help             Display help for command
? 0
```

# Per-command help: rm

```console
$ blobsy rm --help
Usage: blobsy rm [options] <path...>

Remove tracked files: delete local + move .yref to trash

Arguments:
  path                   Files or directories to remove

Options:
  --local                Delete local file only, keep .yref and remote
  --recursive            Required for directory removal
  -h, --help             Display help for command
? 0
```

# Per-command help: doctor

```console
$ blobsy doctor --help
Usage: blobsy doctor [options]

Run diagnostics and optionally auto-fix issues

Options:
  --fix                  Attempt to automatically fix detected issues
  --json                 Structured JSON output
  --verbose              Show detailed diagnostic logs
  -h, --help             Display help for command
? 0
```
