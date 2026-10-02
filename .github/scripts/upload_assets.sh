#!/usr/bin/env bash
# usage: upload_assets.sh <release-tag> <file>...
# Uploads release assets and NEVER overwrites a name that already exists with different bytes: shipped apps bundle the
# sha256 of every asset they download, so re-using a name for new content would break them forever.
# Same name + same sha256 -> skipped (idempotent re-run). Same name + different content -> hard error.
set -euo pipefail
tag="$1"; shift
repo="${GH_REPO:-${GITHUB_REPOSITORY}}"
existing="$(gh api "repos/${repo}/releases/tags/${tag}" --jq '.assets[] | [.name, (.size|tostring), (.digest // "")] | @tsv' 2>/dev/null || true)"
for f in "$@"; do
  name="$(basename "$f")"
  size="$(stat -c %s "$f")"
  row="$(printf '%s\n' "$existing" | awk -F'\t' -v n="$name" '$1==n {print}')"
  if [ -n "$row" ]; then
    osize="$(printf '%s' "$row" | cut -f2)"; odigest="$(printf '%s' "$row" | cut -f3)"
    new="sha256:$(sha256sum "$f" | cut -d' ' -f1)"
    if [ "$osize" = "$size" ] && { [ -z "$odigest" ] || [ "$odigest" = "$new" ]; }; then
      echo "skip $name (already uploaded, identical)"; continue
    fi
    echo "::error::$name already exists in release $tag with different content ($osize B / $odigest vs $size B / $new). Refusing to overwrite an asset that shipped apps may reference - bump the revision (new name) or use a new release tag."
    exit 1
  fi
  echo "upload $name ($size bytes)"
  gh release upload "$tag" "$f"
done
