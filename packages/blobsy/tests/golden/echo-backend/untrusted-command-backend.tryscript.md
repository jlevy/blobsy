---
sandbox: true
env:
  BLOBSY_TRUST_COMMAND_BACKEND: ""
fixtures:
  - ../fixtures/small-file.txt
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << 'EOF'
  backends:
    default:
      push_command: echo pushed {local} {remote}
      pull_command: echo pulled {remote} {local}
  EOF
  mkdir -p data
  cp small-file.txt data/model.bin
  git add -A && git commit -q -m "init"
  blobsy track data/model.bin >/dev/null
---
A committed `.blobsy.yml` chooses the executable a command backend runs, so executing it
from a fresh clone is repository-controlled code execution (review finding SEC-03).
Without an out-of-repo grant (user-global config or `BLOBSY_TRUST_COMMAND_BACKEND`),
blobsy must refuse.

# push refuses an untrusted command backend

```console
$ blobsy push data/model.bin
Error: This repository configures a command backend, which executes repository-controlled commands. Refusing without an out-of-repo trust grant.

  Trust this repo: add to [..]
  Trust all repos: trust_command_backends: true
  Or set BLOBSY_TRUST_COMMAND_BACKEND=1 in the environment (e.g. CI).
? 1
```

# With the environment grant, the same push runs

```console
$ BLOBSY_TRUST_COMMAND_BACKEND=1 blobsy push data/model.bin
  ↑  data/model.bin (13 B)
Done: 1 pushed.
? 0
```
