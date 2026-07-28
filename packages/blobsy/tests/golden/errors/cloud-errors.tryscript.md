---
sandbox: true
env:
  BLOBSY_TRUST_COMMAND_BACKEND: "1"
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << 'EOF'
  backends:
    default:
      type: command
      push_command: ./fail.sh {local} {remote}
      pull_command: ./fail.sh {remote} {local}
  EOF
  git add -A && git commit -q -m init
  mkdir -p data
  printf 'cloud error test\n' > data/model.bin
  blobsy track data/model.bin >/dev/null
---
# Authentication error surfaces the backend’s message (TEST-06)

```console
$ printf '#!/bin/sh\necho "AccessDenied: 403 Forbidden - credentials rejected" >&2\nexit 1\n' > fail.sh && chmod +x fail.sh
? 0
```

```console
$ blobsy push data/model.bin
  ✗  data/model.bin - FAILED: Command push failed (exit 1): ./fail.sh [SANDBOX_PATH]/data/model.bin [REMOTE_KEY]
AccessDenied: 403 Forbidden - credentials rejected
Done: 0 pushed, 1 failed.
? 1
```

# Network error

```console
$ printf '#!/bin/sh\necho "connection timed out contacting storage endpoint" >&2\nexit 1\n' > fail.sh
? 0
```

```console
$ blobsy push data/model.bin
  ✗  data/model.bin - FAILED: Command push failed (exit 1): ./fail.sh [SANDBOX_PATH]/data/model.bin [REMOTE_KEY]
connection timed out contacting storage endpoint
Done: 0 pushed, 1 failed.
? 1
```

# Permission error

```console
$ printf '#!/bin/sh\necho "permission denied writing object" >&2\nexit 1\n' > fail.sh
? 0
```

```console
$ blobsy push data/model.bin
  ✗  data/model.bin - FAILED: Command push failed (exit 1): ./fail.sh [SANDBOX_PATH]/data/model.bin [REMOTE_KEY]
permission denied writing object
Done: 0 pushed, 1 failed.
? 1
```
