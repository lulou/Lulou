#!/usr/bin/env node
/**
 * Lulou Dating — cross-platform git hook installer (Node.js)
 *
 * Replaces install-hooks.sh so that `npm install` / `npm run prepare` works
 * on Windows (cmd.exe / PowerShell) as well as macOS and Linux.
 *
 * Usage:
 *   node scripts/install-hooks.js
 *
 * What it does:
 *   Copies scripts/hooks/pre-commit → .git/hooks/pre-commit  (sets executable bit on Unix)
 *   The pre-commit hook runs the translation smoke-test before every commit.
 *   WARN-only issues (missing keys) allow the commit through.
 *   Critical issues (template bugs, empty values, untranslated blocks) block it.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── Resolve repo root ────────────────────────────────────────────────────────
let repoRoot;
try {
  repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
} catch {
  repoRoot = path.resolve(__dirname, "..");
}

const hooksSrc = path.join(repoRoot, "scripts", "hooks");
const hooksDst = path.join(repoRoot, ".git", "hooks");

// ─── Guard: not a git checkout ────────────────────────────────────────────────
if (!fs.existsSync(hooksDst)) {
  console.log(
    "  ⚠  .git/hooks directory not found — skipping hook installation (not a git checkout or CI environment)."
  );
  process.exit(0);
}

// ─── Install a single hook ────────────────────────────────────────────────────
function installHook(hookName) {
  const src = path.join(hooksSrc, hookName);
  const dst = path.join(hooksDst, hookName);

  if (!fs.existsSync(src)) {
    console.log(`  ⚠  Source hook not found: ${src} — skipping.`);
    return;
  }

  if (fs.existsSync(dst)) {
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(dst, "utf8");
    } catch {}
    if (!existingContent.includes("Lulou Dating")) {
      console.log(
        `  ⚠  ${dst} already exists and was not installed by this script.`
      );
      console.log(`     Backing it up to ${dst}.bak and replacing it.`);
      fs.copyFileSync(dst, dst + ".bak");
    }
  }

  fs.copyFileSync(src, dst);

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dst, 0o755);
    } catch {}
  }

  console.log(`  ✓  Installed ${hookName} → ${dst}`);
}

// ─── Run ──────────────────────────────────────────────────────────────────────
console.log("Installing Lulou Dating git hooks…");
installHook("pre-commit");
console.log("");
console.log("Done. The translation smoke-test will run before every commit.");
console.log("To uninstall, delete .git/hooks/pre-commit");
