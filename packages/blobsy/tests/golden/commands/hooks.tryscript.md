---
sandbox: true
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  cat > .blobsy.yml << 'EOF'
  backends:
    default:
      url: local:../remote
  EOF
  git add -A && git commit -q -m "init"
---
# Install hooks

```console
$ blobsy hooks install
✓ Installed pre-commit hook (.git/hooks/pre-commit)
? 0
```

# Verify hook file exists and is executable

```console
$ test -x .git/hooks/pre-commit && echo "executable" || echo "not executable"
executable
$ head -2 .git/hooks/pre-commit
#!/bin/sh
# Installed by: blobsy hooks install
? 0
```

# Re-install is idempotent

```console
$ blobsy hooks install
✓ Installed pre-commit hook (.git/hooks/pre-commit)
? 0
```

# Uninstall hooks

```console
$ blobsy hooks uninstall
✓ Removed pre-commit hook
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
No blobsy pre-commit hook found.
? 0
```

# Uninstall refuses if hook is not blobsy-owned

```console
$ echo '#!/bin/sh' > .git/hooks/pre-commit
$ echo 'echo "custom hook"' >> .git/hooks/pre-commit
$ chmod +x .git/hooks/pre-commit
$ blobsy hooks uninstall 2>&1
Warning: .git/hooks/pre-commit exists but was not installed by blobsy.
Not removing. Edit or remove it manually if needed.
? 1
```
