#!/bin/bash
# -------------------------------------------------------------------
# GCP Service Account Credentials Bootstrap for Claude Code Sessions
# -------------------------------------------------------------------
# This script runs on SessionStart. If GCP_CREDENTIALS_BASE64 is not set,
# it exits immediately (no installs, no network calls, no startup delay).
#
# When the env var IS set, it decodes the credentials and configures
# gcloud CLI (if installed) for GCP access (GCS, Cloud Run, etc.).
#
# On Linux (CI, Claude Code Cloud): auto-installs gcloud if missing.
# On macOS: expects gcloud already installed (brew install google-cloud-sdk).
# Client libraries work via GOOGLE_APPLICATION_CREDENTIALS regardless.
#
# The script supports two configuration methods:
#   1. True environment variable (Claude Code Cloud, CI)
#   2. .env file in repo root (local development)
#
# It expects a GCP_CREDENTIALS_BASE64 environment variable containing
# a base64-encoded GCP service account JSON key file.
#
# HOW TO SET UP GCP_CREDENTIALS_BASE64:
#
#   1. In GCP Console, go to IAM & Admin > Service Accounts
#   2. Create a service account (or use an existing one)
#   3. Grant only the specific roles the service account needs (least-privilege).
#      For example: Storage Object Viewer, Cloud Run Invoker, etc.
#   4. Click the service account > Keys tab > Add Key > Create new key > JSON
#   5. A .json file downloads — that's your credential file
#   6. Base64-encode it for use in the environment:
#      - macOS:   echo "GCP_CREDENTIALS_BASE64=$(base64 -i my-proj-e5cbb58de146.json)" | pbcopy
#      - Linux:   echo "GCP_CREDENTIALS_BASE64=$(base64 -w0 my-proj-e5cbb58de146.json)"
#   7. Add the variable to your environment:
#      - Claude Code Cloud: Set in Claude Code project settings
#      - Local development: Add to .env file in repo root
#      - CI: Add to CI secrets
#
# -------------------------------------------------------------------

set -e

GCLOUD_INSTALL_DIR="${HOME}/.local/lib/google-cloud-sdk"
KEY_FILE="/tmp/gcp/sa-key.json"

# ----- Check for credentials (exit early if not needed) -----

# Try to load from .env if the variable isn't already set.
# Uses grep+cut instead of 'source .env' to avoid executing arbitrary shell commands.
if [ -z "$(printenv GCP_CREDENTIALS_BASE64)" ]; then
    if [ -f ".env" ]; then
        value=$(grep -E '^GCP_CREDENTIALS_BASE64=' .env | head -1 | cut -d'=' -f2-) || true
        if [ -n "$value" ]; then
            echo "[gcp] Loading credentials from .env file..."
            export GCP_CREDENTIALS_BASE64="$value"
        fi
    fi
fi

# Exit early if still not set
if [ -z "$(printenv GCP_CREDENTIALS_BASE64)" ]; then
    echo "[gcp] GCP_CREDENTIALS_BASE64 not set, skipping GCP setup"
    exit 0
fi

# ----- Find or install gcloud CLI -----

# Also check our own install dir (from previous Linux auto-install)
export PATH="${GCLOUD_INSTALL_DIR}/bin:$PATH"

if command -v gcloud &> /dev/null; then
    GCLOUD_VERSION=$(gcloud version --format='value(Google Cloud SDK)' 2>/dev/null || gcloud --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
    echo "[gcp] gcloud CLI found at $(which gcloud) (v${GCLOUD_VERSION})"
elif [ "$(uname -s)" = "Linux" ]; then
    # Auto-install on Linux (CI, Claude Code Cloud, containers)
    echo "[gcp] Installing gcloud CLI to ${GCLOUD_INSTALL_DIR}..."

    mkdir -p "$(dirname "$GCLOUD_INSTALL_DIR")"
    ARCH="x86_64"
    [ "$(uname -m)" = "aarch64" ] && ARCH="arm"
    curl -sSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-${ARCH}.tar.gz" \
        | tar xz -C "$(dirname "$GCLOUD_INSTALL_DIR")"

    "${GCLOUD_INSTALL_DIR}/install.sh" --quiet --usage-reporting=false --path-update=false > /dev/null 2>&1

    export PATH="${GCLOUD_INSTALL_DIR}/bin:$PATH"

    if ! command -v gcloud &> /dev/null; then
        echo "[gcp] ERROR: gcloud CLI installation failed"
        exit 1
    fi

    echo "[gcp] gcloud CLI installed ($(gcloud --version 2>/dev/null | head -1))"
else
    # macOS (or other): developer is expected to install gcloud themselves
    echo "[gcp] NOTE: gcloud CLI not found. Install it with: brew install google-cloud-sdk"
    echo "[gcp] Client libraries will work via GOOGLE_APPLICATION_CREDENTIALS,"
    echo "[gcp] but gcloud CLI commands will not be available."
    GCLOUD_MISSING=1
fi

# ----- Decode credentials and write key file -----

mkdir -p "$(dirname "$KEY_FILE")"
printenv GCP_CREDENTIALS_BASE64 | base64 -d > "$KEY_FILE"
chmod 600 "$KEY_FILE"

# Extract project ID and service account email from the key file
PROJECT_ID=$(python3 -c "import json; print(json.load(open('${KEY_FILE}')).get('project_id',''))" 2>/dev/null || true)
CLIENT_EMAIL=$(python3 -c "import json; print(json.load(open('${KEY_FILE}')).get('client_email',''))" 2>/dev/null || true)

if [ -z "$PROJECT_ID" ] || [ -z "$CLIENT_EMAIL" ]; then
    echo "[gcp] ERROR: Failed to parse credentials JSON"
    rm -f "$KEY_FILE"
    exit 1
fi

echo "[gcp] Service account: ${CLIENT_EMAIL}"
echo "[gcp] Project: ${PROJECT_ID}"

# Set GOOGLE_APPLICATION_CREDENTIALS for Python/Go/Node client libraries
export GOOGLE_APPLICATION_CREDENTIALS="$KEY_FILE"

if [ "${GCLOUD_MISSING:-}" = "1" ]; then
    echo "[gcp] Setup complete (credentials only, no gcloud CLI)"
    exit 0
fi

# ----- Activate service account -----

gcloud auth activate-service-account --key-file="$KEY_FILE" --quiet 2>/dev/null
gcloud config set project "$PROJECT_ID" --quiet 2>/dev/null

# ----- Verify access -----

if gcloud storage buckets list --project="$PROJECT_ID" --quiet > /dev/null 2>&1; then
    echo "[gcp] Verified: GCS access OK"
else
    echo "[gcp] WARNING: GCS access check failed (API may not be enabled)"
fi

echo "[gcp] Setup complete"
exit 0
