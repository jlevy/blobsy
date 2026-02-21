---
sandbox: true
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << 'EOF'
  backends:
    default:
      url: local:remote
  EOF
  git add -A && git commit -q -m "init"
---
# Install hooks

```console
$ blobsy hooks install
Installed pre-commit hook.
? 0
```

# Verify hook file exists and is executable

```console
$ test -x .git/hooks/pre-commit && echo "executable"
executable
? 0
```

```console
$ head -2 .git/hooks/pre-commit
#!/bin/sh
# Installed by: blobsy hooks install
? 0
```

# Uninstall hooks

```console
$ blobsy hooks uninstall
Uninstalled pre-commit hook.
? 0
```

# Verify hook removed

```console
$ test -f .git/hooks/pre-commit && echo "exists" || echo "gone"
gone
? 0
```

# Uninstall when no hook installed (no-op)

```console
$ blobsy hooks uninstall
No pre-commit hook found.
? 0
```

# Uninstall refuses if hook is not blobsy-owned

```console
$ printf '#!/bin/sh\necho "custom hook"\n' > .git/hooks/pre-commit
? 0
```

```console
$ chmod +x .git/hooks/pre-commit
? 0
```

```console
$ blobsy hooks uninstall
Pre-commit hook not managed by blobsy.
? 0
```
