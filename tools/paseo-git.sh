#!/usr/bin/env bash
# git for the private Paseo plugin repository.
#
#   bash tools/paseo-git.sh status
#   bash tools/paseo-git.sh add claude-state-bar/server/index.ts
#   bash tools/paseo-git.sh commit -m "..."
#   bash tools/paseo-git.sh push
#
# paseo-plugins/ holds the Paseo plugins (claude-state-bar, peer-mail, work-ledger, the relay, team
# launch, work supervisor). They name servers and local paths and are not published, so they are
# kept out of this public repo (.gitignore) and versioned in a private one instead
# (comonetso/blueming-paseo-plugins, since 2026-11-03 — before that they sat on the plugins-next
# branch). Its git directory is .git-paseo at the repo root and its work tree is paseo-plugins/,
# so the PC's Paseo keeps loading the plugins from where they always were.
#
# Paths given to add/rm are relative to paseo-plugins/, because that is the work tree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec git --git-dir="$ROOT/.git-paseo" --work-tree="$ROOT/paseo-plugins" "$@"
