---
sandbox: true
env:
  BLOBSY_NO_HOOKS: "1"
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  rm -rf ../remote && mkdir -p ../remote
---
# Initialize blobsy with local backend

```console
$ blobsy init local:../remote
Initialized blobsy in .
Created .blobsy.yml
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

# Idempotent: re-running init skips config creation

```console
$ blobsy init local:../remote
Config already exists at .blobsy.yml. Skipping config creation.
? 0
```

# Init with missing required arg fails

```console
$ blobsy init 2>&1
error: missing required argument 'url'
? 1
```

# Unrecognized URL scheme fails

```console
$ blobsy init r2://my-bucket/prefix/ 2>&1
Error: Unrecognized backend URL scheme: r2:

  Supported schemes:
    s3://my-bucket/prefix/
    gs://my-bucket/prefix/
    azure://my-container/prefix/
    local:../blobsy-remote
? 1
```

# Invalid S3 bucket name fails

```console
$ blobsy init s3://AB/prefix/ 2>&1
Error: Bucket name must be 3-63 characters: "AB" in s3://AB/prefix/
? 1
```

# Init with GCS URL

```console
$ rm .blobsy.yml
? 0
```

```console
$ blobsy init gs://my-bucket/prefix/
Initialized blobsy in .
Created .blobsy.yml
? 0
```

```console
$ cat .blobsy.yml
backends:
  default:
    url: gs://my-bucket/prefix/
? 0
```

# Init with Azure URL

```console
$ rm .blobsy.yml
? 0
```

```console
$ blobsy init azure://my-container/prefix/
Initialized blobsy in .
Created .blobsy.yml
? 0
```

```console
$ cat .blobsy.yml
backends:
  default:
    url: azure://my-container/prefix/
? 0
```
