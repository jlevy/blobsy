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
  init <url>             Initialize blobsy in a git repo
  track <path...>        Start tracking files or directories
  untrack <path...>      Stop tracking (keep local files)
  rm <path...>           Remove from tracking and delete local file
  mv <source> <dest>     Rename or move a tracked file
  push [path...]         Upload local blobs to remote
  pull [path...]         Download remote blobs to local
  sync [path...]         Bidirectional sync (push + pull)
  status [path...]       Show state of tracked files
  verify [path...]       Verify local files match ref hashes
  config [key] [value]   Get or set configuration
  health                 Check backend connectivity
  doctor                 Diagnostics and health check
  hooks <action>         Manage pre-commit hook
  check-unpushed         Find committed refs with missing blobs
  pre-push-check         Verify all refs have remote blobs (CI)
  trust                  Trust current repo for command backend execution
  help [command]         Display help for command
? 0
```

# Per-command help: track

```console
$ blobsy track --help
Usage: blobsy track [options] <path...>

Start tracking files or directories

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

Upload local blobs to remote

Arguments:
  path                   Files or directories to push (default: all tracked)

Options:
  --force                Override hash mismatch (updates .yref to match file)
  -h, --help             Display help for command
? 0
```

# Per-command help: pull

```console
$ blobsy pull --help
Usage: blobsy pull [options] [path...]

Download remote blobs to local

Arguments:
  path                   Files or directories to pull (default: all tracked)

Options:
  --force                Overwrite local modifications
  -h, --help             Display help for command
? 0
```

# Per-command help: status

```console
$ blobsy status --help
Usage: blobsy status [options] [path...]

Show state of tracked files

Arguments:
  path                   Files or directories to check (default: all tracked)

Options:
  --json                 Structured JSON output
  -h, --help             Display help for command
? 0
```

# Per-command help: sync

```console
$ blobsy sync --help
Usage: blobsy sync [options] [path...]

Bidirectional sync (push + pull)

Arguments:
  path                   Files or directories to sync (default: all tracked)

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

Verify local files match ref hashes

Arguments:
  path                   Files or directories to verify (default: all tracked)

Options:
  --json                 Structured JSON output
  -h, --help             Display help for command
? 0
```

# Per-command help: rm

```console
$ blobsy rm --help
Usage: blobsy rm [options] <path...>

Remove from tracking and delete local file

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

Diagnostics and health check

Options:
  --fix                  Attempt to automatically fix detected issues
  --json                 Structured JSON output
  --verbose              Show detailed diagnostic logs
  -h, --help             Display help for command
? 0
```
