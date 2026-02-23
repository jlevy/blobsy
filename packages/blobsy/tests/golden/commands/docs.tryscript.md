---
sandbox: true
---
# List available sections

```console
$ blobsy docs --list
Available documentation sections:

  conceptual-model             Conceptual Model
  configuration                Configuration
  built-in-defaults            Built-in Defaults
  externalization-rules        Externalization Rules
  compression                  Compression
  ignore-patterns              Ignore Patterns
  backend-configuration        Backend Configuration
  ci-integration               CI Integration
  common-workflows             Common Workflows

Use: blobsy docs <topic>
? 0
```

# Brief version starts with quick reference header

```console
$ blobsy docs --brief | head -3
# blobsy — Quick Reference
...
? 0
```

# Brief version ends with pointer to full docs

```console
$ blobsy docs --brief | grep "For full documentation"
For full documentation: `blobsy docs`
? 0
```

# Extract specific section by slug

```console
$ blobsy docs compression | head -3
## Compression
...
? 0
```

# Partial title match for backends

```console
$ blobsy docs backend | head -3
## Backend Configuration
...
? 0
```

# Error on nonexistent section

```console
$ blobsy docs nonexistent-section 2>&1
Section "nonexistent-section" not found. Use --list to see available sections.
? 1
```

# Full docs start with user guide header

```console
$ blobsy docs | head -3
# blobsy User Guide
...
? 0
```
