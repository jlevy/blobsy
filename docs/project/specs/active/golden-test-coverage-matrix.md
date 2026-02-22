# Golden Test Coverage Matrix

**Generated:** 2026-02-21

CLI commands from `blobsy --help` (help.tryscript.md).
Test files from `packages/blobsy/tests/golden/`.

## Command Coverage

| Command | Command Test | JSON Test | Error Test | Workflow Test | Flags Tested |
| --- | --- | --- | --- | --- | --- |
| init | commands/init | - | errors/validation-errors | workflows/fresh-setup | --region, --endpoint |
| track | commands/track | json/track-json | errors/validation-errors, errors/not-found-errors | workflows/*, echo-backend/* | --json, --force, --verbose |
| untrack | commands/untrack | json/untrack-rm-json | errors/validation-errors, errors/not-found-errors | - | --json, --recursive |
| rm | commands/rm | json/untrack-rm-json | errors/validation-errors, errors/not-found-errors | - | --json, --local, --recursive |
| mv | commands/mv | - | errors/validation-errors | - | - |
| push | commands/push-pull | json/push-pull-json | errors/validation-errors, errors/not-found-errors, errors/partial-failure | workflows/*, echo-backend/* | --json, --force, --verbose |
| pull | commands/push-pull | json/push-pull-json | errors/conflict-errors, errors/not-found-errors | workflows/*, echo-backend/* | --json, --force |
| sync | commands/sync | json/sync-json | - | workflows/*, echo-backend/* | --json, --skip-health-check, --force |
| status | commands/status | json/status-json | errors/validation-errors | workflows/* | --json, --verbose |
| verify | commands/verify | json/verify-json | errors/errors-json | workflows/* | --json |
| config | commands/config | json/config-json | - | commands/externalization | - |
| health | commands/health | json/health-json | errors/validation-errors | - | --json |
| doctor | commands/doctor | json/doctor-json | - | workflows/doctor-fix | --json, --fix, --verbose |
| hooks | commands/hooks | - | - | - | install, uninstall |
| check-unpushed | commands/check-unpushed | json/check-unpushed-json | - | - | --json |
| pre-push-check | commands/pre-push-check | - | - | - | - |
| skill | commands/skill | - | - | - | --brief |
| prime | commands/prime | - | - | - | --brief |
| help | commands/help | - | - | - | per-command --help |

### Cross-cutting Flags Tests

| Test File | Purpose |
| --- | --- |
| commands/dry-run | --dry-run on track, untrack, rm, --json |
| commands/quiet | --quiet, --quiet + --verbose error, --quiet + --json |
| commands/verbose | --verbose on track, push, status |
| commands/externalization | config externalize.min_size, externalize.never, track with rules |

## Coverage Gaps

- **mv**: No dedicated JSON test.
- **hooks**: No JSON test (hooks has no --json).
- **pre-push-check**: No JSON test (pre-push-check has no --json).
- **skill** / **prime**: No JSON tests (these commands have no --json).
- **help**: No JSON or error tests (help is documentation only).

## Test File Index

### commands/ (23 files)

| File | Description |
| --- | --- |
| check-unpushed.tryscript.md | List committed .bref whose blobs are not pushed; push flow |
| config.tryscript.md | Show, get, set .blobsy.yml values (backend, externalize, compress, remote) |
| doctor.tryscript.md | Diagnostics, --fix, orphan detection |
| dry-run.tryscript.md | --dry-run on track, untrack, rm with JSON |
| externalization.tryscript.md | externalize.min_size, externalize.never, track with rules |
| health.tryscript.md | Backend connectivity, success and failure |
| help.tryscript.md | Top-level --help and per-command --help |
| hooks.tryscript.md | Install/uninstall pre-commit hook |
| init.tryscript.md | Initialize with local/s3/gs/azure, validation errors |
| mv.tryscript.md | Rename/move tracked files and directories |
| pre-push-check.tryscript.md | CI guard for missing remote blobs |
| prime.tryscript.md | AI context primer output |
| push-pull.tryscript.md | push, pull, path handling, .bref paths |
| quiet.tryscript.md | --quiet, --quiet + --verbose error |
| rm.tryscript.md | rm, --local, --recursive |
| skill.tryscript.md | Skill documentation for AI agents |
| status.tryscript.md | Sync state of tracked files |
| sync.tryscript.md | Bidirectional sync, --skip-health-check |
| track.tryscript.md | Track files, directories, edge cases |
| untrack.tryscript.md | Untrack files, --recursive |
| verbose.tryscript.md | --verbose on track, push, status |
| verify.tryscript.md | Verify local files match .bref hashes |

### echo-backend/ (4 files)

| File | Description |
| --- | --- |
| compression-commands.tryscript.md | track, push, pull with compression |
| pull-commands.tryscript.md | pull with echo backend transport |
| push-commands.tryscript.md | push with echo backend transport |
| sync-commands.tryscript.md | sync with echo backend transport |

### errors/ (4 files)

| File | Description |
| --- | --- |
| conflict-errors.tryscript.md | pull conflicts, --force |
| not-found-errors.tryscript.md | Nonexistent paths, untracked push targets |
| partial-failure.tryscript.md | push with some failing blobs |
| validation-errors.tryscript.md | init/track/untrack/rm/push/status validation |

### json/ (12 files)

| File | Description |
| --- | --- |
| check-unpushed-json.tryscript.md | check-unpushed --json |
| config-json.tryscript.md | config --json, config key --json |
| doctor-json.tryscript.md | doctor --json |
| errors-json.tryscript.md | track, push, verify, status --json error paths |
| health-json.tryscript.md | health --json |
| push-pull-json.tryscript.md | push --json, pull --json |
| status-json.tryscript.md | status --json |
| sync-json.tryscript.md | sync --json |
| track-json.tryscript.md | track --json single file and directory |
| untrack-rm-json.tryscript.md | untrack --json, rm --json |
| verify-json.tryscript.md | verify --json |

### workflows/ (8 files)

| File | Description |
| --- | --- |
| branch-workflow.tryscript.md | Track, push, branch, sync, verify |
| compression.tryscript.md | Track, push, pull, verify with compression |
| compression-algorithms.tryscript.md | Compression algorithm variants (zstd, gzip, none) |
| doctor-fix.tryscript.md | Doctor --fix workflow |
| fresh-setup.tryscript.md | init, track, push, status, pull, verify |
| modify-and-resync.tryscript.md | Modify file, track, push, verify |
| multi-file-sync.tryscript.md | Multi-directory track, push, verify, sync |
| two-user-conflict.tryscript.md | Conflicting pushes, --force resolution |

**Total:** 49 golden test files.
