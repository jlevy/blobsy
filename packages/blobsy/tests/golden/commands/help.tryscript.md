---
sandbox: true
env:
  NO_COLOR: "1"
---
# Top-level help

```console
$ blobsy --help
Usage: blobsy [options] [command]

Store large files anywhere. Track them in Git.

Options:
  --version                       Show version number
  --json                          Structured JSON output
  --quiet                         Suppress all output except errors
  --verbose                       Detailed progress output
  --dry-run                       Show what would happen without doing it
  --color <when>                  Color output: always, never, auto (choices:
                                  "always", "never", "auto", default: "auto")
  -h, --help                      Display help for command

Commands:
  setup [options] <url>           Set up blobsy in a git repo (wraps init +
                                  agent integration)
  init [options] <url>            Initialize blobsy config (low-level; prefer
                                  setup --auto)
  add [options] <path...>         Track files and stage changes to git
                                  (recommended)
  track [options] <path...>       Start tracking files or directories with .bref
                                  pointers
  untrack [options] [path...]     Stop tracking files (keeps local files, moves
                                  .bref to trash)
  rm [options] <path...>          Remove tracked files: delete local + move
                                  .bref to trash
  mv <source> <dest>              Rename or move tracked files or directories
                                  (updates .bref + .gitignore)
  push [options] [path...]        Upload local blobs to the configured backend
  pull [options] [path...]        Download blobs from the configured backend
  sync [options] [path...]        Bidirectional sync: push unpushed + pull
                                  missing
  status [options] [path...]      Show sync state of tracked files
  verify [options] [path...]      Verify local files match their .bref hashes
  config [options] [key] [value]  Show, get, or set .blobsy.yml values
  health                          Test backend connectivity and permissions
  doctor [options]                Run diagnostics and optionally auto-fix issues
  hooks <action>                  Install or uninstall blobsy git hooks
                                  (pre-commit, pre-push)
  check-unpushed                  List committed .bref files whose blobs are not
                                  yet pushed
  pre-push-check                  CI guard: fail if any .bref is missing its
                                  remote blob
  readme                          Display the blobsy README
  docs [options] [topic]          Display blobsy user documentation
  skill                           Output blobsy skill documentation (for AI
                                  agents)
  help [command]                  display help for command

Get started:
  blobsy setup --auto s3://bucket/prefix/
  blobsy add <file-or-dir>
  blobsy push

Learn more:
  blobsy readme              Overview and quick start
  blobsy docs                Full user guide
  blobsy docs <topic>        Specific topic (try "backends", "compression")
  blobsy docs --list          List all topics
  blobsy skill               Quick reference for AI agents

https://github.com/jlevy/blobsy
? 0
```

# Per-command help: track

```console
$ blobsy track --help
Usage: blobsy track [options] <path...>

Start tracking files or directories with .bref pointers

Arguments:
  path               Files or directories to track

Options:
  --min-size <size>  Override minimum file size for directory tracking (e.g.
                     "100kb", "5mb")
  -h, --help         Display help for command

Global Options:
  --version          Show version number
  --json             Structured JSON output
  --quiet            Suppress all output except errors
  --verbose          Detailed progress output
  --dry-run          Show what would happen without doing it
  --color <when>     Color output: always, never, auto (choices: "always",
                     "never", "auto", default: "auto")
? 0
```

# Per-command help: push

```console
$ blobsy push --help
Usage: blobsy push [options] [path...]

Upload local blobs to the configured backend

Arguments:
  path            Files or directories (default: all tracked)

Options:
  --force         Re-push even if remote exists
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: pull

```console
$ blobsy pull --help
Usage: blobsy pull [options] [path...]

Download blobs from the configured backend

Arguments:
  path            Files or directories (default: all tracked)

Options:
  --force         Overwrite local modifications
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: status

```console
$ blobsy status --help
Usage: blobsy status [options] [path...]

Show sync state of tracked files

Arguments:
  path            Files or directories (default: all tracked)

Options:
  --json          Structured JSON output
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: sync

```console
$ blobsy sync --help
Usage: blobsy sync [options] [path...]

Bidirectional sync: push unpushed + pull missing

Arguments:
  path                 Files or directories (default: all tracked)

Options:
  --skip-health-check  Skip backend health check
  -h, --help           Display help for command

Global Options:
  --version            Show version number
  --json               Structured JSON output
  --quiet              Suppress all output except errors
  --verbose            Detailed progress output
  --dry-run            Show what would happen without doing it
  --color <when>       Color output: always, never, auto (choices: "always",
                       "never", "auto", default: "auto")
? 0
```

# Per-command help: verify

```console
$ blobsy verify --help
Usage: blobsy verify [options] [path...]

Verify local files match their .bref hashes

Arguments:
  path            Files or directories (default: all tracked)

Options:
  --json          Structured JSON output
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: rm

```console
$ blobsy rm --help
Usage: blobsy rm [options] <path...>

Remove tracked files: delete local + move .bref to trash

Arguments:
  path            Files or directories to remove

Options:
  --local         Delete local file only, keep .bref and remote
  --remote        Also delete blob from backend (requires confirmation)
  --force         Skip confirmation prompts
  --recursive     Required for directory removal
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: doctor

```console
$ blobsy doctor --help
Usage: blobsy doctor [options]

Run diagnostics and optionally auto-fix issues

Options:
  --fix           Attempt to automatically fix detected issues
  --json          Structured JSON output
  --verbose       Show detailed diagnostic logs
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: init

```console
$ blobsy init --help
Usage: blobsy init [options] <url>

Initialize blobsy config (low-level; prefer setup --auto)

Arguments:
  url                    Backend URL (e.g. s3://bucket/prefix/, local:../path)

Options:
  --region <region>      AWS region (for S3 backends)
  --endpoint <endpoint>  Custom S3-compatible endpoint URL
  --no-hooks             Skip git hook installation
  -h, --help             Display help for command

Global Options:
  --version              Show version number
  --json                 Structured JSON output
  --quiet                Suppress all output except errors
  --verbose              Detailed progress output
  --dry-run              Show what would happen without doing it
  --color <when>         Color output: always, never, auto (choices: "always",
                         "never", "auto", default: "auto")
? 0
```

# Per-command help: untrack

```console
$ blobsy untrack --help
Usage: blobsy untrack [options] [path...]

Stop tracking files (keeps local files, moves .bref to trash)

Arguments:
  path            Files or directories to untrack

Options:
  --all           Untrack all tracked files in the repository
  --recursive     Required for directory removal
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: mv

```console
$ blobsy mv --help
Usage: blobsy mv [options] <source> <dest>

Rename or move tracked files or directories (updates .bref + .gitignore)

Arguments:
  source          Source tracked file or directory
  dest            Destination path

Options:
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: config

```console
$ blobsy config --help
Usage: blobsy config [options] [key] [value]

Show, get, or set .blobsy.yml values

Arguments:
  key             Config key (dot-separated, e.g. compress.algorithm)
  value           Value to set

Options:
  --global        Use global config (~/.blobsy.yml)
  --show-origin   Show which config file each value comes from
  --unset         Remove the specified config key
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: hooks

```console
$ blobsy hooks --help
Usage: blobsy hooks [options] <action>

Install or uninstall blobsy git hooks (pre-commit, pre-push)

Arguments:
  action          install or uninstall

Options:
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: health

```console
$ blobsy health --help
Usage: blobsy health [options]

Test backend connectivity and permissions

Options:
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: check-unpushed

```console
$ blobsy check-unpushed --help
Usage: blobsy check-unpushed [options]

List committed .bref files whose blobs are not yet pushed

Options:
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: pre-push-check

```console
$ blobsy pre-push-check --help
Usage: blobsy pre-push-check [options]

CI guard: fail if any .bref is missing its remote blob

Options:
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: readme

```console
$ blobsy readme --help
Usage: blobsy readme [options]

Display the blobsy README

Options:
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: docs

```console
$ blobsy docs --help
Usage: blobsy docs [options] [topic]

Display blobsy user documentation

Arguments:
  topic           Section to display (e.g. "compression", "backends")

Options:
  --list          List available sections
  --brief         Condensed version
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```

# Per-command help: skill

```console
$ blobsy skill --help
Usage: blobsy skill [options]

Output blobsy skill documentation (for AI agents)

Options:
  -h, --help      Display help for command

Global Options:
  --version       Show version number
  --json          Structured JSON output
  --quiet         Suppress all output except errors
  --verbose       Detailed progress output
  --dry-run       Show what would happen without doing it
  --color <when>  Color output: always, never, auto (choices: "always", "never",
                  "auto", default: "auto")
? 0
```
