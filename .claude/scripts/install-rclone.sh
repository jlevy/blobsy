#!/bin/bash
# -------------------------------------------------------------------
# rclone Install Script (standalone)
# -------------------------------------------------------------------
# Finds rclone on PATH or installs it to ~/.local/bin/ on Linux.
# On macOS, prints a message and exits if rclone is not found.
#
# Usage:
#   bash .claude/scripts/install-rclone.sh          # install if needed
#   source .claude/scripts/install-rclone.sh         # install + update PATH in caller
#
# After sourcing, rclone will be on PATH. After running as a script,
# you may need to add ~/.local/bin to PATH yourself.
# -------------------------------------------------------------------

RCLONE_INSTALL_DIR="${RCLONE_INSTALL_DIR:-${HOME}/.local/bin}"

export PATH="${RCLONE_INSTALL_DIR}:$PATH"

if command -v rclone &> /dev/null; then
    RCLONE_VERSION=$(rclone --version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
    echo "[rclone] Found at $(which rclone) (${RCLONE_VERSION})"
elif [ "$(uname -s)" = "Linux" ]; then
    echo "[rclone] Installing to ${RCLONE_INSTALL_DIR}..."

    mkdir -p "$RCLONE_INSTALL_DIR"
    ARCH="amd64"
    [ "$(uname -m)" = "aarch64" ] && ARCH="arm64"

    TMPDIR_RCLONE=$(mktemp -d)
    curl -sSL "https://downloads.rclone.org/rclone-current-linux-${ARCH}.zip" \
        -o "${TMPDIR_RCLONE}/rclone.zip"
    unzip -q "${TMPDIR_RCLONE}/rclone.zip" -d "${TMPDIR_RCLONE}"
    cp "${TMPDIR_RCLONE}"/rclone-*-linux-*/rclone "${RCLONE_INSTALL_DIR}/rclone"
    chmod 755 "${RCLONE_INSTALL_DIR}/rclone"
    rm -rf "$TMPDIR_RCLONE"

    if ! command -v rclone &> /dev/null; then
        echo "[rclone] ERROR: Installation failed"
        return 1 2>/dev/null || exit 1
    fi

    echo "[rclone] Installed $(rclone --version 2>/dev/null | head -1)"
else
    echo "[rclone] NOTE: rclone not found. Install with: brew install rclone"
    return 1 2>/dev/null || exit 1
fi
