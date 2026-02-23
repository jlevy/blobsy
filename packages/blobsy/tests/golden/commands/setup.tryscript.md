---
sandbox: true
env:
  BLOBSY_NO_HOOKS: "1"
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  rm -rf ../remote && mkdir -p ../remote
  mkdir -p .claude
  echo "# Existing Agents" > AGENTS.md
---
# Setup with --auto wraps init, installs agent files, and shows next steps

```console
$ blobsy setup --auto local:../remote
Initialized blobsy in .
Created .blobsy.yml
Installed .claude/skills/blobsy/SKILL.md
Added blobsy section to AGENTS.md

Setup complete! Next steps:
  blobsy track <file>    Track files with .bref pointers
  blobsy push            Upload to backend
  blobsy status          Check sync state
  blobsy skill           Quick reference for AI agents
? 0
```

# Verify config was created by setup

```console
$ cat .blobsy.yml
backends:
  default:
    url: local:../remote
? 0
```

# Verify skill file was installed

```console
$ head -3 .claude/skills/blobsy/SKILL.md
# blobsy

Git-native large file storage. Track large files with `.bref` pointers in Git,
? 0
```

# Verify AGENTS.md was updated

```console
$ grep "BEGIN BLOBSY" AGENTS.md
<!-- BEGIN BLOBSY INTEGRATION -->
? 0
```

# Idempotent: re-running setup updates agent files

```console
$ blobsy setup --auto local:../remote
Config already exists at .blobsy.yml. Skipping config creation.
Installed .claude/skills/blobsy/SKILL.md
Updated blobsy section in AGENTS.md

Setup complete! Next steps:
  blobsy track <file>    Track files with .bref pointers
  blobsy push            Upload to backend
  blobsy status          Check sync state
  blobsy skill           Quick reference for AI agents
? 0
```

# Setup requires --auto flag

```console
$ rm .blobsy.yml
? 0
```

```console
$ blobsy setup local:../remote 2>&1
Error: --auto flag is required (interactive setup is not yet supported)
? 1
```

# Setup requires URL argument

```console
$ blobsy setup --auto 2>&1
error: missing required argument 'url'
(use --help for usage, or blobsy docs for full guide)
? 1
```

# Setup validates backend URL

```console
$ blobsy setup --auto r2://my-bucket/prefix/ 2>&1
Error: Unrecognized backend URL scheme: r2:

  Supported schemes:
    s3://my-bucket/prefix/
    gs://my-bucket/prefix/
    azure://my-container/prefix/
    local:../blobsy-remote
? 1
```

# Setup with --dry-run shows planned actions without creating files

```console
$ rm -f .blobsy.yml
? 0
```

```console
$ blobsy setup --auto --dry-run local:../remote
Would create .blobsy.yml
Would install pre-commit hook
? 0
```

```console
$ test -f .blobsy.yml && echo "exists" || echo "not created"
not created
? 0
```

# Setup with --quiet suppresses output

```console
$ blobsy setup --auto --quiet local:../remote
? 0
```

```console
$ cat .blobsy.yml
backends:
  default:
    url: local:../remote
? 0
```

# Setup with S3 URL creates correct config

```console
$ rm .blobsy.yml
? 0
```

```console
$ blobsy setup --auto s3://my-bucket/prefix/
Initialized blobsy in .
Created .blobsy.yml
Installed .claude/skills/blobsy/SKILL.md
Updated blobsy section in AGENTS.md

Setup complete! Next steps:
  blobsy track <file>    Track files with .bref pointers
  blobsy push            Upload to backend
  blobsy status          Check sync state
  blobsy skill           Quick reference for AI agents
? 0
```

```console
$ cat .blobsy.yml
backends:
  default:
    url: s3://my-bucket/prefix/
? 0
```

# Setup help shows usage

```console
$ blobsy setup --help
Usage: blobsy setup [options] <url>

Set up blobsy in a git repo (wraps init + agent integration)

Arguments:
  url                    Backend URL (e.g. s3://bucket/prefix/, local:../path)

Options:
  --auto                 Non-interactive setup (recommended)
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
? 0
```
