---
sandbox: true
---
# Initialize blobsy in a new git repo with local backend

```console
$ git init -q -b main
$ git config user.name "Blobsy Test"
$ git config user.email "blobsy-test@example.com"
$ blobsy init local:../remote
Created .blobsy.yml
Installed pre-commit hook (.git/hooks/pre-commit)
? 0
```

# Verify the generated config

```console
$ cat .blobsy.yml
backends:
  default:
    url: local:../remote
? 0
```

# Verify the hook was installed

```console
$ test -f .git/hooks/pre-commit && echo "hook installed" || echo "no hook"
hook installed
? 0
```

# Idempotent: re-running init skips config setup

```console
$ blobsy init
Found existing .blobsy.yml -- skipping config setup
Installed pre-commit hook
? 0
```

# Verify config was not changed

```console
$ cat .blobsy.yml
backends:
  default:
    url: local:../remote
? 0
```

# Init in a non-git directory fails

```console
$ cd /tmp && mkdir blobsy-test-no-git && cd blobsy-test-no-git
$ blobsy init local:../remote 2>&1
Error: Not a git repository (or any parent up to mount point)
Run 'git init' first.
? 1
```

# Unrecognized URL scheme fails with helpful error

```console
$ cd -
$ blobsy init r2://my-bucket/prefix/ 2>&1
Error: Unrecognized backend URL: "r2://my-bucket/prefix/"

Supported URL schemes:
  s3://bucket/prefix/       Amazon S3 and S3-compatible (R2, MinIO, B2, etc.)
  gs://bucket/prefix/       Google Cloud Storage
  azure://container/prefix/ Azure Blob Storage
  /path or ./path           Local directory

For S3-compatible stores like R2, use s3:// with --endpoint:
  blobsy init s3://my-bucket/ --endpoint https://ACCT_ID.r2.cloudflarestorage.com
? 1
```

# Invalid S3 bucket name fails

```console
$ blobsy init s3://AB/prefix/ 2>&1
Error: Invalid S3 URL: bucket name "AB" is too short (minimum 3 characters).
? 1
```

# Query parameters rejected

```console
$ blobsy init "s3://bucket/prefix/?region=us-east-1" 2>&1
Error: Unexpected query string in URL: "s3://bucket/prefix/?region=us-east-1"

Region should be specified as a flag:
  blobsy init s3://bucket/prefix/ --region us-east-1
? 1
```

# Incompatible flag rejected

```console
$ blobsy init local:../remote --region us-east-1 2>&1
Error: --region is not applicable to local backends.
? 1
```

# Error: local backend path inside repo

```console
$ blobsy init local:./inside-repo 2>&1
Error: Local backend path is inside the git repository

  The local backend directory must be outside the git repo to avoid
  git tracking blob files. Use a path outside the repo:
    blobsy init local:../blobsy-remote
    blobsy init local:/tmp/blobsy-remote
? 1
```
