/**
 * Translation integration smoke-test for Lulou Dating.
 *
 * Directly imports and exercises `getTranslation` — the same runtime function
 * called by every component's `t()` hook — to verify that switching to each of
 * the 6 new languages returns properly translated text on key pages.
 *
 * Key pages tested:
 *   - Landing   : landing_intentional_dating, landing_hero_1, landing_hero_flourish
 *   - Navigation: discover, connections, likes, profile, settings
 *   - Settings  : app_language, account, preferences, save, cancel, loading
 *   - Chat      : message, write_message, you_prefix, no_connections_yet
 *
 * Rules:
 *   1. Every tested key must return a non-empty string.
 *   2. The returned string must NOT equal the English value (i.e. actually translated).
 *   3. The returned string must NOT contain unresolved JS template literals (${...}).
 *   4. Keys that fall back to English (because the language block lacks them)
 *      are reported; if any LANDING or NAVIGATION key falls back the test FAILS.
 *
 * Run:  npx tsx scripts/test-translations.ts
 * Exit: 0 = all checks pass, 1 = failures found
 */

import { getTranslation, LANGUAGE_NAME_TO_CODE, TRANSLATIONS } from "../client/src/lib/i18n";

// ─── Test matrix ──────────────────────────────────────────────────────────────

const NEW_LANGUAGES = [
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Japanese",
  "Korean",
  "Hindi",
  "Swahili",
] as const;

/** Keys that MUST be translated (hard-fail if they fall back to English). */
const CRITICAL_KEYS = [
  // Landing page
  "landing_intentional_dating",
  "landing_hero_1",
  "landing_hero_flourish",
  // Navigation
  "discover",
  "connections",
  "likes",
  "profile",
  "settings",
] as const;

/** Additional keys to smoke-test (warn if they fall back, but don't hard-fail). */
const SMOKE_KEYS = [
  // Settings page
  "app_language",
  "account",
  "preferences",
  "save",
  "cancel",
  "loading",
  // Chat/Connections page
  "message",
  "write_message",
  "you_prefix",
  "no_connections_yet",
  "start_conversation",
] as const;

const ALL_KEYS = [...CRITICAL_KEYS, ...SMOKE_KEYS] as const;
type TestedKey = (typeof ALL_KEYS)[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function enVal(key: TestedKey): string {
  return (TRANSLATIONS.en as Record<string, string>)[key] ?? key;
}

interface CheckResult {
  key: TestedKey;
  lang: string;
  translated: string;
  en: string;
  isCritical: boolean;
  isEnglishFallback: boolean;
  isEmpty: boolean;
  hasTemplateLiteral: boolean;
  pass: boolean;
  failReason?: string;
}

function check(key: TestedKey, lang: string): CheckResult {
  const translated = getTranslation(key, lang);
  const en = enVal(key);
  const isCritical = (CRITICAL_KEYS as readonly string[]).includes(key);
  const isEmpty = translated.trim() === "";
  const hasTemplateLiteral = translated.includes("${");
  const isEnglishFallback = translated === en;

  let failReason: string | undefined;
  if (isEmpty) {
    failReason = "empty string";
  } else if (hasTemplateLiteral) {
    failReason = `unresolved template literal: "${translated}"`;
  } else if (isEnglishFallback && isCritical) {
    failReason = `falls back to English: "${en}"`;
  }

  return {
    key,
    lang,
    translated,
    en,
    isCritical,
    isEnglishFallback,
    isEmpty,
    hasTemplateLiteral,
    pass: !failReason,
    failReason,
  };
}

// ─── Run tests ────────────────────────────────────────────────────────────────

let totalFails = 0;
let totalWarns = 0;
let totalPass = 0;

console.log(`\n${BOLD}Lulou Translation Integration Smoke-Test${RESET}`);
console.log(`${DIM}Exercises getTranslation() — the same runtime function used by every t() call${RESET}`);
console.log(`${DIM}Critical keys (landing + navigation): fail if English fallback${RESET}\n`);

for (const lang of NEW_LANGUAGES) {
  const code = LANGUAGE_NAME_TO_CODE[lang] ?? "?";
  const results = ALL_KEYS.map((k) => check(k, lang));

  const fails = results.filter((r) => !r.pass);
  const warns = results.filter((r) => r.pass && r.isEnglishFallback && !r.isCritical);
  const passes = results.filter((r) => r.pass && !r.isEnglishFallback);

  totalFails += fails.length;
  totalWarns += warns.length;
  totalPass += passes.length;

  const langStatus = fails.length > 0 ? `${RED}✗ FAIL${RESET}` : `${GREEN}✓ PASS${RESET}`;

  console.log(`${BOLD}${lang}${RESET} (${code}) — ${langStatus}`);

  // Show failures
  for (const r of fails) {
    console.log(
      `  ${RED}✗${RESET} ${r.key.padEnd(34)} → ${RED}${r.failReason}${RESET}`
    );
  }

  // Show warnings (non-critical English fallbacks)
  for (const r of warns) {
    console.log(
      `  ${YELLOW}⚠${RESET} ${r.key.padEnd(34)} ${DIM}(falls back to en: "${r.en}")${RESET}`
    );
  }

  // Show passing critical keys (condensed)
  const passingCritical = results.filter(
    (r) => r.pass && r.isCritical && !r.isEnglishFallback
  );
  if (passingCritical.length > 0) {
    console.log(
      `  ${GREEN}✓${RESET} Critical keys OK: ${passingCritical
        .map((r) => `${r.key}="${r.translated}"`)
        .join(", ")}`
    );
  }

  console.log();
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const totalChecks = NEW_LANGUAGES.length * ALL_KEYS.length;
console.log("─".repeat(70));
console.log(
  `${totalFails > 0 ? RED + "✗" : GREEN + "✓"}${RESET} ` +
    `${totalPass} passed · ${totalWarns > 0 ? YELLOW : ""}${totalWarns} warned${RESET} · ${totalFails > 0 ? RED : ""}${totalFails} failed${RESET}` +
    ` (${totalChecks} checks across ${NEW_LANGUAGES.length} languages)`
);

if (totalFails > 0) {
  console.log(
    `\n${RED}${BOLD}FAIL:${RESET} ${totalFails} critical check(s) failed — see above.\n`
  );
  process.exit(1);
} else if (totalWarns > 0) {
  console.log(
    `\n${YELLOW}All critical checks passed.${RESET} ${totalWarns} non-critical key(s) fall back to English.`
  );
  console.log(
    `${DIM}(These are new keys not yet translated — run 'node scripts/check-translations.cjs' for the full missing-key report.)${RESET}\n`
  );
  process.exit(0);
} else {
  console.log(`\n${GREEN}All checks passed — full translations verified.${RESET}\n`);
  process.exit(0);
}
