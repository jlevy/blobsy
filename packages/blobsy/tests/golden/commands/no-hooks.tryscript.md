---
sandbox: true
before: |
  mkdir -p init-repo setup-repo nested-repo
  for r in init-repo setup-repo nested-repo; do
    (cd $r \
      && git init -q -b main \
      && git config user.name "Blobsy Test" \
      && git config user.email "blobsy-test@example.com")
  done
---
Ambient `BLOBSY_NO_HOOKS` is explicitly cleared (`BLOBSY_NO_HOOKS=`) so these checks
exercise the `--no-hooks` FLAG (review finding CLI-01), not the env var.

# init --no-hooks installs no hook files (CLI-01)

```console
$ cd init-repo && BLOBSY_NO_HOOKS= blobsy init --no-hooks local:../init-backend >/dev/null && ls .git/hooks/pre-commit .git/hooks/pre-push 2>&1
ls: cannot access '.git/hooks/pre-commit': No such file or directory
ls: cannot access '.git/hooks/pre-push': No such file or directory
? 2
```

# setup --auto --no-hooks installs no hook files (CLI-01)

```console
$ cd setup-repo && BLOBSY_NO_HOOKS= blobsy setup --auto --no-hooks local:../setup-backend >/dev/null && ls .git/hooks/pre-commit .git/hooks/pre-push 2>&1
ls: cannot access '.git/hooks/pre-commit': No such file or directory
ls: cannot access '.git/hooks/pre-push': No such file or directory
? 2
```

# Without --no-hooks, init installs both hooks (control)

```console
$ cd nested-repo && BLOBSY_NO_HOOKS= blobsy init local:../nested-backend >/dev/null && ls .git/hooks/pre-commit .git/hooks/pre-push >/dev/null && echo "hooks installed"
hooks installed
? 0
```

# LIB-01: add inside an ignored dir rewrites the rule so nested .bref files are visible

```console
$ cd nested-repo && mkdir -p data/a/b && echo "data/" > .gitignore && git add .gitignore && git commit -qm ignore && printf 'nested payload\n' > data/a/b/model.bin && blobsy add data/a/b/model.bin >/dev/null && git check-ignore data/a/b/model.bin.bref; echo "check-ignore exit: $?"
check-ignore exit: 1
? 0
```

```console
$ cd nested-repo && git status --porcelain -- data
A  data/a/b/.gitignore
A  data/a/b/model.bin.bref
? 0
```
