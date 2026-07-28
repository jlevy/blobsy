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
$ BLOBSY_NO_HOOKS= blobsy hooks install
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
Pre-commit hook not managed by blobsy; leaving it in place.
No pre-push hook found.
? 0
```

# Hook execution: install hook and verify it runs on commit

The custom hook from the previous section is user-owned, so install would refuse to
touch it (HK-03); remove it first to test a clean install.

```console
$ rm .git/hooks/pre-commit && mkdir -p data
? 0
```

```console
$ BLOBSY_NO_HOOKS= blobsy hooks install
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

# Dry-run mirrors the real run: both hooks planned in a clean repo

```console
$ BLOBSY_NO_HOOKS= blobsy hooks install --dry-run
Would install pre-commit hook
Would install pre-push hook
? 0
```

# Dry-run honors BLOBSY_NO_HOOKS (set for this suite): nothing planned

```console
$ blobsy hooks install --dry-run
? 0
```

# Dry-run skips hooks blobsy doesn’t own, like the real run

```console
$ printf '#!/bin/sh\necho "custom hook"\n' > .git/hooks/pre-commit
? 0
```

```console
$ BLOBSY_NO_HOOKS= blobsy hooks install --dry-run
Would install pre-push hook
? 0
```

# Uninstall dry-run plans only blobsy-managed hooks that exist

```console
$ blobsy hooks uninstall --dry-run
? 0
```

```console
$ rm .git/hooks/pre-commit && BLOBSY_NO_HOOKS= blobsy hooks install >/dev/null && blobsy hooks uninstall --dry-run
Would uninstall pre-commit hook
Would uninstall pre-push hook
? 0
```
