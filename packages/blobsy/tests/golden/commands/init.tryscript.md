---
sandbox: true
---
# Initialize blobsy in a new git repo with local backend

```console
$ git init -q -b main git config user.name "Blobsy Test" git config user.email "blobsy-test@example.com" blobsy init local:../remote
usage: git init [-q | --quiet] [--bare] [--template=<template-directory>]
         [--separate-git-dir <git-dir>] [--object-format=<format>]
         [--ref-format=<format>]
         [-b <branch-name> | --initial-branch=<branch-name>]
         [--shared[=<permissions>]] [<directory>]
? 129
```

# Verify the generated config

```console
$ cat .blobsy.yml
cat: .blobsy.yml: No such file or directory
? 1
```

# Verify the hook was installed

```console
$ test -f .git/hooks/pre-commit && echo "hook installed" || echo "no hook"
no hook
? 0
```

# Idempotent: re-running init skips config setup

```console
$ blobsy init
error: missing required argument 'url'
? 1
```

# Verify config was not changed

```console
$ cat .blobsy.yml
cat: .blobsy.yml: No such file or directory
? 1
```

# Init in a non-git directory fails

```console
$ cd /tmp && mkdir blobsy-test-no-git && cd blobsy-test-no-git blobsy init local:../remote 2>&1
? 0
```

# Unrecognized URL scheme fails with helpful error

```console
$ cd - blobsy init r2://my-bucket/prefix/ 2>&1
/bin/sh: line 0: cd: OLDPWD not set
? 1
```

# Invalid S3 bucket name fails

```console
$ blobsy init s3://AB/prefix/ 2>&1
Error: Not inside a git repository. Run this command from within a git repo.
? 1
```

# Query parameters rejected

```console
$ blobsy init "s3://bucket/prefix/?region=us-east-1" 2>&1
Error: Not inside a git repository. Run this command from within a git repo.
? 1
```

# Incompatible flag rejected

```console
$ blobsy init local:../remote --region us-east-1 2>&1
Error: Not inside a git repository. Run this command from within a git repo.
? 1
```

# Error: local backend path inside repo

```console
$ blobsy init local:./inside-repo 2>&1
Error: Not inside a git repository. Run this command from within a git repo.
? 1
```
