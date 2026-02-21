---
sandbox: true
env:
  BLOBSY_BACKEND_URL: ""
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  rm -rf ../remote && mkdir -p ../remote
  cat > .blobsy.yml << 'YAML'
  backends:
    default:
      url: "local:../remote"
  YAML
  git add -A && git commit -q -m "init"
---
# Health check passes for local backend

```console
$ blobsy health
Backend is reachable and writable.
? 0
```

# Health check fails when remote directory doesn’t exist

```console
$ rm -rf ../remote
? 0
```

```console
$ blobsy health 2>&1
[..]
? 1
```

# Health check fails when remote directory isn’t writable

```console
$ mkdir -p ../remote
? 0
```

```console
$ chmod 000 ../remote
? 0
```

```console
$ blobsy health 2>&1
[..]
? 1
```

```console
$ chmod 755 ../remote
? 0
```
