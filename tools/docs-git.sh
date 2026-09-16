#!/usr/bin/env bash
# git for the private docs repository.
#
#   bash tools/docs-git.sh status
#   bash tools/docs-git.sh add session_logs/2026-09-16_work_log.md
#   bash tools/docs-git.sh commit -m "..."
#   bash tools/docs-git.sh push
#
# docs/ holds session logs, codex_rescue run records and design notes. They carry server
# names and local paths, so they are kept out of this public repo (.gitignore) and versioned
# in a private one instead. Its git directory is .git-docs at the repo root and its work tree
# is docs/ — deliberately NOT docs/.git: a .git inside docs/ would stop this repo from
# tracking the two public guides that live there (docs/codex-rescue-guide.md / .ko.md).
#
# Paths given to add/rm are relative to docs/, because that is the work tree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec git --git-dir="$ROOT/.git-docs" --work-tree="$ROOT/docs" "$@"
