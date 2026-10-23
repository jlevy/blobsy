#!/bin/bash
# -------------------------------------------------------------------
# rclone Bootstrap for Claude Code Sessions
# -------------------------------------------------------------------
# This script runs on SessionStart (after setup-gcp-credentials.sh).
# It auto-detects existing cloud credentials and exports RCLONE_CONFIG_*
# env vars so rclone discovers remotes automatically — no config file needed.
#
# Auto-detected credentials (env vars, ~/.aws/, or .env in repo root):
#   - GCP_CREDENTIALS_BASE64 (or /tmp/gcp/sa-key.json) → "gcs" remote
#   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY         → "s3" remote
#   - ~/.aws/credentials                                → "s3" remote
#
# If no credentials are found, exits immediately (no installs, no delay).
#
# On Linux (CI, Claude Code Cloud): auto-installs rclone to ~/.local/bin/
# On macOS: expects rclone already installed (brew install rclone)
# -------------------------------------------------------------------

set -e

RCLONE_INSTALL_DIR="${HOME}/.local/bin"
GCP_KEY_FILE="/tmp/gcp/sa-key.json"

# ----- Detect available credentials -----

HAS_GCP=0
HAS_AWS=0

# GCP: key file from setup-gcp-credentials.sh
if [ -f "$GCP_KEY_FILE" ]; then
    HAS_GCP=1
fi

# AWS: env vars, .env file, or ~/.aws/credentials
if [ -z "$(printenv AWS_ACCESS_KEY_ID 2>/dev/null)" ] && [ -f ".env" ]; then
    aws_key=$(grep -E '^AWS_ACCESS_KEY_ID=' .env | head -1 | cut -d'=' -f2-) || true
    aws_secret=$(grep -E '^AWS_SECRET_ACCESS_KEY=' .env | head -1 | cut -d'=' -f2-) || true
    aws_region=$(grep -E '^AWS_DEFAULT_REGION=' .env | head -1 | cut -d'=' -f2-) || true
    if [ -n "$aws_key" ] && [ -n "$aws_secret" ]; then
        echo "[rclone] Loading AWS credentials from .env file..."
        export AWS_ACCESS_KEY_ID="$aws_key"
        export AWS_SECRET_ACCESS_KEY="$aws_secret"
        [ -n "$aws_region" ] && export AWS_DEFAULT_REGION="$aws_region"
    fi
fi

if [ -n "$(printenv AWS_ACCESS_KEY_ID 2>/dev/null)" ]; then
    HAS_AWS=1
elif [ -f "${AWS_SHARED_CREDENTIALS_FILE:-$HOME/.aws/credentials}" ]; then
    HAS_AWS=1
fi

# Exit early if nothing to configure
if [ "$HAS_GCP" = "0" ] && [ "$HAS_AWS" = "0" ]; then
    echo "[rclone] No cloud credentials detected, skipping"
    exit 0
fi

# ----- Find or install rclone -----

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RCLONE_INSTALL_DIR
source "${SCRIPT_DIR}/install-rclone.sh" || exit 0

# ----- Configure remotes via env vars -----

# Workaround: Go 1.24+ changed RSA CRT parameter validation, breaking some
# GCP service account keys. GODEBUG=x509rsacrt=0 restores old behavior.
# Safe to remove once rclone ships a fix (track: rclone/rclone#7921).
export GODEBUG="${GODEBUG:+${GODEBUG},}x509rsacrt=0"

REMOTES=""

if [ "$HAS_GCP" = "1" ]; then
    PROJECT_ID=$(python3 -c "import json; print(json.load(open('${GCP_KEY_FILE}')).get('project_id',''))" 2>/dev/null || true)

    export RCLONE_CONFIG_GCS_TYPE="google cloud storage"
    export RCLONE_CONFIG_GCS_SERVICE_ACCOUNT_FILE="$GCP_KEY_FILE"
    export RCLONE_CONFIG_GCS_PROJECT_NUMBER="$PROJECT_ID"

    REMOTES="${REMOTES} gcs(${PROJECT_ID})"
fi

if [ "$HAS_AWS" = "1" ]; then
    AWS_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
    if [ -f "${AWS_CONFIG_FILE:-$HOME/.aws/config}" ]; then
        CONFIGURED_REGION=$(grep -E '^\s*region\s*=' "${AWS_CONFIG_FILE:-$HOME/.aws/config}" | head -1 | cut -d'=' -f2- | tr -d ' ') || true
        [ -n "$CONFIGURED_REGION" ] && AWS_REGION="$CONFIGURED_REGION"
    fi

    export RCLONE_CONFIG_S3_TYPE="s3"
    export RCLONE_CONFIG_S3_PROVIDER="AWS"
    export RCLONE_CONFIG_S3_ENV_AUTH="true"
    export RCLONE_CONFIG_S3_REGION="$AWS_REGION"

    REMOTES="${REMOTES} s3(${AWS_REGION})"
fi

echo "[rclone] Remotes:${REMOTES}"

# ----- Verify access -----

if [ "$HAS_GCP" = "1" ]; then
    if timeout 10 rclone lsd gcs: 2>/dev/null | head -1 > /dev/null; then
        echo "[rclone] Verified: GCS access OK"
    else
        echo "[rclone] WARNING: GCS access check failed"
    fi
fi

if [ "$HAS_AWS" = "1" ]; then
    if timeout 10 rclone lsd s3: 2>/dev/null | head -1 > /dev/null; then
        echo "[rclone] Verified: S3 access OK"
    else
        echo "[rclone] WARNING: S3 access check failed (credentials may need 'aws sso login')"
    fi
fi

echo "[rclone] Setup complete"
exit 0
