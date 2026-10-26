#!/bin/bash
# push.sh — upload prepared sessions-2026-05 to HuggingFace.
#
# DO NOT RUN without confirming you authorize publication and have
# reviewed README.md + train.jsonl in this directory.
#
# Usage:
#   export HF_TOKEN=hf_xxx              # write-scoped token
#   bash push.sh                        # uploads to mrfennec/agents-supervisor-sessions-2026-05

set -euo pipefail

REPO=${HF_REPO:-mrfennec/agents-supervisor-sessions-2026-05}
DIR=$(dirname "$(readlink -f "$0")")

if [ -z "${HF_TOKEN:-}" ]; then
  echo "ERROR: HF_TOKEN not set. Get one at https://huggingface.co/settings/tokens" >&2
  exit 1
fi

if ! command -v hf >/dev/null 2>&1; then
  echo "ERROR: hf CLI not installed. Run: pip install -U huggingface_hub" >&2
  exit 1
fi

hf auth login --token "$HF_TOKEN" --add-to-git-credential

hf repo create "$REPO" --repo-type dataset --private || true

# Use the larger upload-large-folder pathway for multi-file uploads
hf upload "$REPO" "$DIR/train.jsonl"      train.jsonl      --repo-type dataset --commit-message "sessions snapshot 2026-05"
hf upload "$REPO" "$DIR/README.md"        README.md        --repo-type dataset --commit-message "dataset card"
hf upload "$REPO" "$DIR/manifest.json"    manifest.json    --repo-type dataset --commit-message "snapshot manifest"
hf upload "$REPO" "$DIR/redaction-log.json" redaction-log.json --repo-type dataset --commit-message "redaction audit log"

echo
echo "PUSHED → https://huggingface.co/datasets/$REPO"
echo "  PRIVATE by default."
