#!/usr/bin/env bash
set -euo pipefail

# Check golden test coverage for all CLI commands
# Run from packages/blobsy/

EXIT_CODE=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
TESTS_DIR="tests/golden"

# Check for ... elisions (anti-pattern)
echo "Checking for unnamed wildcard elisions..."
ELISIONS=$(grep -rn '^\.\.\.$' "$TESTS_DIR" 2>/dev/null || true)
if [ -n "$ELISIONS" ]; then
  echo "ERROR: Found ... elisions (output suppression anti-pattern):"
  echo "$ELISIONS"
  EXIT_CODE=1
else
  echo "OK: No ... elisions found"
fi

# Count test files
FILE_COUNT=$(find "$TESTS_DIR" -name "*.tryscript.md" | wc -l | tr -d ' ')
echo ""
echo "Total golden test files: $FILE_COUNT"

# List commands and check coverage (matches blobsy --help Commands section)
echo ""
echo "Command coverage check:"
COMMANDS="init track untrack rm mv push pull sync status verify config health doctor hooks check-unpushed pre-push-check skill"
for cmd in $COMMANDS; do
  FILES=$(grep -rl "blobsy $cmd" "$TESTS_DIR" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$FILES" -eq 0 ]; then
    echo "  MISSING: $cmd - no golden tests found"
    EXIT_CODE=1
  else
    echo "  OK: $cmd ($FILES files)"
  fi
done

exit $EXIT_CODE
