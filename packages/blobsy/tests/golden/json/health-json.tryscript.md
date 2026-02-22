---
sandbox: true
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
# health --json success

```console
$ blobsy health --json
{
  "schema_version": "0.1",
  "status": "ok",
  "message": "Backend is reachable and writable."
}
? 0
```

# health --json failure

```console
$ rm -rf ../remote
? 0
```

```console
$ blobsy health --json 2>&1
{
  "schema_version": "0.1",
  "error": "Local backend directory not found: [LOCAL_PATH]",
  "type": "not_found",
  "suggestions": [
    "Create the directory or check the path in .blobsy.yml."
  ]
}
? 1
```
