#!/bin/sh
# Lulou Dating — install git hooks
#
# Run this once after cloning the repo:
#   sh scripts/install-hooks.sh
#
# What it does:
#   Copies scripts/hooks/pre-commit → .git/hooks/pre-commit  (makes it executable)
#   The pre-commit hook runs the translation smoke-test before every commit.
#   WARN-only issues (missing keys) allow the commit through.
#   Critical issues (template bugs, empty values, untranslated blocks) block it.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
HOOKS_SRC="$REPO_ROOT/scripts/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DST" ]; then
  echo "✗ .git/hooks directory not found — are you inside a git repository?"
  exit 1
fi

install_hook() {
  HOOK_NAME="$1"
  SRC="$HOOKS_SRC/$HOOK_NAME"
  DST="$HOOKS_DST/$HOOK_NAME"

  if [ ! -f "$SRC" ]; then
    echo "  ⚠  Source hook not found: $SRC — skipping."
    return
  fi

  if [ -f "$DST" ] && ! grep -q "Lulou Dating" "$DST" 2>/dev/null; then
    echo "  ⚠  $DST already exists and was not installed by this script."
    echo "     Backing it up to $DST.bak and replacing it."
    cp "$DST" "$DST.bak"
  fi

  cp "$SRC" "$DST"
  chmod +x "$DST"
  echo "  ✓  Installed $HOOK_NAME → $DST"
}

echo "Installing Lulou Dating git hooks…"
install_hook "pre-commit"
echo ""
echo "Done. The translation smoke-test will run before every commit."
echo "To uninstall, delete .git/hooks/pre-commit"
