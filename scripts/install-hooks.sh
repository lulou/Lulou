#!/bin/sh
# Lulou Dating — install git hooks (shell wrapper)
#
# DEPRECATED — kept for contributors who prefer a shell entry-point.
# All installation logic now lives in scripts/install-hooks.cjs so that
# `npm run prepare` works on Windows, macOS, and Linux.
#
# This script is a thin wrapper; it just calls the Node.js installer so
# the two can never silently diverge.
#
# Preferred usage:
#   node scripts/install-hooks.cjs
#
# Shell wrapper (Unix/macOS only):
#   sh scripts/install-hooks.sh

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗  node is not in PATH. Please run: node scripts/install-hooks.cjs"
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
exec node "$REPO_ROOT/scripts/install-hooks.cjs" "$@"
