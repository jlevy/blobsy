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
Installed pre-push hook.
  Using executable: [LOCAL_PATH]
? 0
```

# Verify hook files exist and are executable

```console
$ test -x .git/hooks/pre-commit && echo "executable"
executable
? 0
```

```console
$ test -x .git/hooks/pre-push && echo "executable"
executable
? 0
```

```console
$ head -2 .git/hooks/pre-commit
#!/bin/sh
# Installed by: blobsy hooks install
? 0
```

```console
$ head -2 .git/hooks/pre-push
#!/bin/sh
# Installed by: blobsy hooks install
? 0
```

# Uninstall hooks

```console
$ blobsy hooks uninstall
Uninstalled pre-commit hook.
Uninstalled pre-push hook.
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
No pre-push hook found.
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
No pre-push hook found.
? 0
```

# Hook execution: install hook and verify it runs on commit

```console
$ mkdir -p data
? 0
```

```console
$ blobsy hooks install
Installed pre-commit hook.
Installed pre-push hook.
  Using executable: [LOCAL_PATH]
? 0
```

```console
$ echo "hook test data" > data/hooktest.bin
? 0
```

```console
$ blobsy track data/hooktest.bin
Tracking data/hooktest.bin
Created data/hooktest.bin.bref
Added data/hooktest.bin to .gitignore

Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)
? 0
```

```console
$ BLOBSY_NO_HOOKS=0 git add -A && BLOBSY_NO_HOOKS=0 git commit -q -m "test hook"
? 0
```

```console
$ blobsy hooks uninstall
Uninstalled pre-commit hook.
Uninstalled pre-push hook.
? 0
```
