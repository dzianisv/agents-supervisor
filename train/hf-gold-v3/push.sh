#!/bin/bash
# push.sh — upload prepared gold-v3 to HuggingFace.
#
# DO NOT RUN this without confirming:
#   1. You authorize publishing this data.
#   2. You have a HuggingFace account (https://huggingface.co/join).
#   3. You have HF_TOKEN with write scope (https://huggingface.co/settings/tokens).
#   4. You've reviewed README.md + train.jsonl in this directory.
#
# Usage:
#   export HF_TOKEN=hf_xxx              # write-scoped token
#   bash push.sh                        # uploads to dzianisv/agents-supervisor-gold-v3
#
# Requires:
#   pip install huggingface_hub
# OR:
#   curl -L https://github.com/huggingface/huggingface_hub/releases/download/v0.20.0/huggingface-cli-linux -o ~/.local/bin/huggingface-cli && chmod +x ~/.local/bin/huggingface-cli

set -euo pipefail

REPO=${HF_REPO:-mrfennec/agents-supervisor-gold-v3}
DIR=$(dirname "$(readlink -f "$0")")

if [ -z "${HF_TOKEN:-}" ]; then
  echo "ERROR: HF_TOKEN not set. Get one at https://huggingface.co/settings/tokens" >&2
  exit 1
fi

if ! command -v hf >/dev/null 2>&1; then
  echo "ERROR: hf CLI not installed. Run: pip install -U huggingface_hub" >&2
  exit 1
fi

# Login (token-only, no browser)
hf auth login --token "$HF_TOKEN" --add-to-git-credential

# Create the dataset repo if it doesn't exist (private by default — flip via web UI later)
hf repo create "$REPO" --repo-type dataset --private || true

# Upload
hf upload "$REPO" "$DIR/train.jsonl" train.jsonl --repo-type dataset --commit-message "gold v3 (57 records, 4 categories)"
hf upload "$REPO" "$DIR/README.md"   README.md   --repo-type dataset --commit-message "dataset card"
hf upload "$REPO" "$DIR/redaction-log.json" redaction-log.json --repo-type dataset --commit-message "redaction audit log"

echo
echo "PUSHED → https://huggingface.co/datasets/$REPO"
echo "  PRIVATE by default. Flip to public via the HF web UI when ready."
