---
sandbox: true
env:
  BLOBSY_NO_HOOKS: "1"
  BLOBSY_BACKEND_URL: ""
  HOME: "$TRYSCRIPT_SANDBOX"
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << YAML
  backends:
    default:
      url: "local:../remote"
  YAML
  mkdir -p ../remote
  git add -A && git commit -q -m "init"
---
# Trust list when no repos are trusted

```console
$ blobsy trust --list
No repos currently trusted.
? 0
```

# Trust the current repo

```console
$ blobsy trust
...
? 0
```

# Trust list now shows the repo (one entry)

```console
$ blobsy trust --list | wc -l | tr -d ' '
1
? 0
```

# Revoke trust

```console
$ blobsy trust --revoke
...
? 0
```

# Trust list is empty again

```console
$ blobsy trust --list
No repos currently trusted.
? 0
```

# Revoke when not trusted is a no-op

```console
$ blobsy trust --revoke
This repo is not currently trusted.
? 0
```
