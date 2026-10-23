#!/usr/bin/env bash
set -euo pipefail

# Hermetic golden-test runner (review finding DX-01/TEST-01).
#
# Golden tryscripts invoke `blobsy` by name, so this script controls exactly
# which binary that name resolves to: a temp shim that execs the CLI built
# from THIS checkout. It prints the tested binary path and version so every
# run records what was actually exercised. Never rely on a globally linked
# blobsy — it can be a stale build and produce a false green.
#
# Note for local runs as root: the permission-revocation goldens
# (commands/health, commands/sync, errors/partial-failure) cannot fail for
# root and will report failures. CI runs as a non-root user.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR"

CLI="$PKG_DIR/dist/cli.mjs"
if [ ! -f "$CLI" ]; then
  echo "Built CLI not found at $CLI. Run 'pnpm build' first." >&2
  exit 1
fi

BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$BIN_DIR"' EXIT
cat > "$BIN_DIR/blobsy" <<EOF
#!/bin/sh
exec "$(command -v node)" "$CLI" "\$@"
EOF
chmod +x "$BIN_DIR/blobsy"
export PATH="$BIN_DIR:$PATH"

echo "Testing binary: $CLI ($(blobsy --version))"

shopt -s globstar nullglob
exec ./node_modules/.bin/tryscript run "$@" tests/golden/**/*.tryscript.md
