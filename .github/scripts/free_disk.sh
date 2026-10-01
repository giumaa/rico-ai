#!/usr/bin/env bash
# Reclaim ~30 GB on a GitHub-hosted ubuntu runner (default ~14 GB free -> ~45 GB).
set -u
echo "before:"; df -h / | tail -1
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /usr/share/swift \
  /usr/local/share/boost /opt/hostedtoolcache/CodeQL /usr/lib/jvm /usr/local/julia* /opt/az /usr/share/miniconda 2>/dev/null || true
sudo docker image prune --all --force >/dev/null 2>&1 || true
sudo apt-get clean >/dev/null 2>&1 || true
echo "after:"; df -h / | tail -1
