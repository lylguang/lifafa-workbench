#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lock_file="$repo_root/lwb/UPSTREAM.lock.json"
upstream="$(sed -n 's/  "repository": "\(.*\)",/\1/p' "$lock_file")"

git ls-remote "$upstream" HEAD refs/heads/master 'refs/tags/dsh-v*'
