#!/usr/bin/env python3
"""hf_dataset.py — push the private mined dataset to a HuggingFace dataset repo.

The mined corpus (.dataset/) contains real session transcripts and is PRIVATE.
This uploads it to a private HF dataset repo so it is versioned off-machine without
ever entering git.

Usage:
  python3 train/hf_dataset.py push [--repo <owner/name>] [--dataset-dir <path>]

Auth: requires `hf auth login` (or HF_TOKEN env). Repo defaults to
SUPERVISOR_HF_DATASET or 'dzianisv/agent-supervisor-stops', created PRIVATE.
"""
import argparse, os, sys

DEFAULT_REPO = os.environ.get("SUPERVISOR_HF_DATASET", "dzianisv/agent-supervisor-stops")
DATASET_DIR = os.path.join(os.path.dirname(__file__), "..", ".dataset")


def push(repo, dataset_dir):
    try:
        from huggingface_hub import HfApi
    except ImportError:
        print("hf_dataset: huggingface_hub not installed. Run: pip install -U huggingface_hub", file=sys.stderr)
        return 2
    if not os.path.isdir(dataset_dir):
        print(f"hf_dataset: no dataset dir at {dataset_dir} — run build_dataset.py first.", file=sys.stderr)
        return 2
    token = os.environ.get("HF_TOKEN")  # else falls back to cached `hf auth login` token
    api = HfApi(token=token)
    try:
        api.whoami()
    except Exception as e:  # noqa: BLE001
        print(f"hf_dataset: not authenticated ({e}). Run `hf auth login` or set HF_TOKEN.", file=sys.stderr)
        return 3
    api.create_repo(repo_id=repo, repo_type="dataset", private=True, exist_ok=True)
    api.upload_folder(
        folder_path=dataset_dir,
        repo_id=repo,
        repo_type="dataset",
        commit_message="supervisor:train — update mined stop/follow-up dataset",
    )
    print(f"hf_dataset: pushed {dataset_dir} -> https://huggingface.co/datasets/{repo} (private)")
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["push"], help="action")
    p.add_argument("--repo", default=DEFAULT_REPO)
    p.add_argument("--dataset-dir", default=DATASET_DIR)
    args = p.parse_args()
    if args.action == "push":
        sys.exit(push(args.repo, args.dataset_dir))


if __name__ == "__main__":
    main()
