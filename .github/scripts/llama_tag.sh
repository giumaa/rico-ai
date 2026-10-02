#!/usr/bin/env bash
# usage: llama_tag.sh [override] [fallback]
# Prints the llama.cpp release tag to use. Priority: explicit override > repo-root LLAMA_CPP_TAG file > fallback.
# (one place defines the pin: the app's fetch-llama-server.mjs, the CI workflows and ml/llama_tools.py all read LLAMA_CPP_TAG)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
override="${1:-}"
fallback="${2:-b11321}"
if [ -n "$override" ]; then echo "$override"; exit 0; fi
if [ -f "$root/LLAMA_CPP_TAG" ]; then
  tag="$(grep -v '^[[:space:]]*#' "$root/LLAMA_CPP_TAG" | tr -d '[:space:]')"
  if [[ "$tag" =~ ^b[0-9]+$ ]]; then echo "$tag"; exit 0; fi
  echo "::warning::LLAMA_CPP_TAG file has an unexpected value ('$tag'); using $fallback" >&2
fi
echo "$fallback"
