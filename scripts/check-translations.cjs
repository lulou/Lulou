#!/usr/bin/env node
/**
 * Translation smoke-test for Lulou Dating.
 *
 * Checks the 6 recently-added languages (zh-CN, zh-TW, ja, ko, hi, sw) and
 * all existing non-English languages against the English master dictionary.
 *
 * Run:  node scripts/check-translations.js
 * Exit: 0 = all languages fully covered, 1 = issues found
 */

const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────
const I18N_PATH = path.resolve(__dirname, "../client/src/lib/i18n.ts");
const NEW_LANGUAGES = ["zh-CN", "zh-TW", "ja", "ko", "hi", "sw"];
const ALL_NON_EN = [
  "es", "fr", "de", "pt", "it", "nl", "pl", "ru", "ar",
  "zh-CN", "zh-TW", "ja", "ko", "hi", "sw",
];

// ─── Parse i18n.ts ────────────────────────────────────────────────────────────
const raw = fs.readFileSync(I18N_PATH, "utf8");
const lines = raw.split("\n");

/**
 * Extract { key -> value } for a given language block.
 * Returns { keys: string[], vals: Record<string,string>, startLine, endLine }.
 */
function getLangBlock(lang) {
  const marker = lang.includes("-") ? `"${lang}"` : lang;
  const startIdx = lines.findIndex(
    (l) => l.trim().startsWith(marker + ":") && l.includes("{")
  );
  if (startIdx < 0) return null;

  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (i > startIdx && depth === 0) {
      endIdx = i;
      break;
    }
  }

  const block = lines.slice(startIdx, endIdx + 1);
  const keys = [];
  const vals = {};
  block.forEach((l) => {
    const m = l.match(/^\s+(\w+):\s+"(.*)",?\s*$/);
    if (m) {
      keys.push(m[1]);
      vals[m[1]] = m[2];
    }
  });
  return { keys, vals, startLine: startIdx + 1, endLine: endIdx + 1 };
}

// ─── English master ───────────────────────────────────────────────────────────
const en = getLangBlock("en");
if (!en) {
  console.error("ERROR: Could not find English (en) block in i18n.ts");
  process.exit(1);
}

// ─── Checks ───────────────────────────────────────────────────────────────────

let overallPass = true;
const report = [];

function checkLang(lang, isNew) {
  const block = getLangBlock(lang);
  const label = isNew ? `[NEW] ${lang}` : `      ${lang}`;

  if (!block) {
    report.push({ lang, status: "MISSING_BLOCK", details: [] });
    overallPass = false;
    return;
  }

  const details = [];

  // 1. Missing keys (in English but not this language)
  const missingKeys = en.keys.filter((k) => !block.keys.includes(k));
  if (missingKeys.length > 0) {
    details.push({
      type: "MISSING_KEYS",
      count: missingKeys.length,
      items: missingKeys,
    });
  }

  // 2. Unresolved JS template literals  (${...} inside a translated string)
  const templateLiteralIssues = [];
  const blockStart = block.startLine - 1;
  lines.slice(block.startLine - 1, block.endLine).forEach((l, i) => {
    if (l.includes("${")) {
      templateLiteralIssues.push({ lineNo: blockStart + i + 1, text: l.trim() });
    }
  });
  if (templateLiteralIssues.length > 0) {
    details.push({
      type: "TEMPLATE_LITERAL_BUG",
      count: templateLiteralIssues.length,
      items: templateLiteralIssues.map((x) => `L${x.lineNo}: ${x.text}`),
    });
    overallPass = false;
  }

  // 3. Empty string values
  const emptyKeys = block.keys.filter((k) => block.vals[k] === "");
  if (emptyKeys.length > 0) {
    details.push({ type: "EMPTY_VALUES", count: emptyKeys.length, items: emptyKeys });
    overallPass = false;
  }

  // 4. Keys present in this language but not in English (orphaned)
  const orphanKeys = block.keys.filter((k) => !en.keys.includes(k));
  if (orphanKeys.length > 0) {
    details.push({ type: "ORPHAN_KEYS", count: orphanKeys.length, items: orphanKeys });
  }

  // 5. Spot-check: a meaningful set of core UI strings must differ from English.
  //    Some words are international loanwords or coincidentally identical (e.g.
  //    "Error" in Spanish, "Likes" in Dutch) — we only flag when 3+ spot-check
  //    keys are identical to English, which strongly suggests an untranslated block.
  const SPOT_CHECK_KEYS = [
    "discover", "settings", "profile", "connections",
    "save", "cancel", "loading",
  ];
  const stillEnglish = SPOT_CHECK_KEYS.filter(
    (k) => block.vals[k] && block.vals[k] === en.vals[k]
  );
  if (stillEnglish.length >= 3) {
    details.push({
      type: "SPOT_CHECK_UNTRANSLATED",
      count: stillEnglish.length,
      items: stillEnglish.map((k) => `${k}: "${block.vals[k]}"`),
    });
    overallPass = false;
  }

  const hasCritical = details.some((d) =>
    ["TEMPLATE_LITERAL_BUG", "EMPTY_VALUES", "SPOT_CHECK_UNTRANSLATED"].includes(d.type)
  );
  if (hasCritical) overallPass = false;

  const coveragePct = (
    ((en.keys.length - missingKeys.length) / en.keys.length) *
    100
  ).toFixed(1);

  report.push({
    lang,
    label,
    isNew,
    status: hasCritical ? "FAIL" : missingKeys.length > 0 ? "WARN" : "PASS",
    keyCount: block.keys.length,
    enKeyCount: en.keys.length,
    coveragePct,
    details,
  });
}

// Run checks for all non-English languages
ALL_NON_EN.forEach((lang) => checkLang(lang, NEW_LANGUAGES.includes(lang)));

// ─── Render report ────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const statusColor = (s) =>
  s === "PASS" ? GREEN : s === "WARN" ? YELLOW : RED;

console.log(`\n${BOLD}Lulou Translation Smoke-Test${RESET}`);
console.log(`${DIM}Source: ${I18N_PATH}${RESET}`);
console.log(`${DIM}English master: ${en.keys.length} keys (lines ${en.startLine}–${en.endLine})${RESET}\n`);

console.log(
  `${"Language".padEnd(16)} ${"Status".padEnd(8)} ${"Coverage".padEnd(10)} Details`
);
console.log("─".repeat(80));

report.forEach(({ lang, label, status, keyCount, enKeyCount, coveragePct, details }) => {
  const color = statusColor(status);
  const mark = status === "PASS" ? "✓" : status === "WARN" ? "⚠" : "✗";
  const coverage =
    keyCount != null ? `${coveragePct}% (${keyCount}/${enKeyCount})` : "–";
  const detailSummary =
    details
      ?.map((d) => {
        if (d.type === "MISSING_KEYS") return `${d.count} missing keys`;
        if (d.type === "TEMPLATE_LITERAL_BUG") return `${BOLD}${RED}${d.count} template bugs${RESET}`;
        if (d.type === "EMPTY_VALUES") return `${BOLD}${RED}${d.count} empty values${RESET}`;
        if (d.type === "ORPHAN_KEYS") return `${DIM}${d.count} orphan keys${RESET}`;
        if (d.type === "SPOT_CHECK_UNTRANSLATED") return `${RED}${d.count} untranslated spot-check keys${RESET}`;
        return "";
      })
      .filter(Boolean)
      .join(", ") || "";

  const langDisplay = NEW_LANGUAGES.includes(lang)
    ? `${BOLD}${lang}${RESET}`
    : lang;

  console.log(
    `${color}${mark}${RESET} ${langDisplay.padEnd(14)} ${color}${status.padEnd(8)}${RESET} ${coverage.padEnd(20)} ${detailSummary}`
  );
});

console.log("─".repeat(80));

// Print details for languages with missing keys (top 10 per language)
const withMissing = report.filter((r) =>
  r.details?.some((d) => d.type === "MISSING_KEYS")
);

if (withMissing.length > 0) {
  console.log(`\n${BOLD}Missing keys (all languages share the same ${withMissing[0].details.find(d=>d.type==="MISSING_KEYS").count} missing keys):${RESET}`);
  const missingKeys = withMissing[0].details.find((d) => d.type === "MISSING_KEYS").items;
  console.log(`${DIM}These keys fall back to English in the UI — add them to each language to fully localise.${RESET}`);
  missingKeys.forEach((k) => {
    const enVal = en.vals[k] ?? "(no English value found)";
    console.log(`  ${YELLOW}${k}${RESET}: "${DIM}${enVal}${RESET}"`);
  });
}

// Print any critical issues (bugs, not just missing keys)
const withCritical = report.filter((r) =>
  r.details?.some((d) =>
    ["TEMPLATE_LITERAL_BUG", "EMPTY_VALUES", "SPOT_CHECK_UNTRANSLATED"].includes(d.type)
  )
);
if (withCritical.length > 0) {
  console.log(`\n${BOLD}${RED}Critical Issues:${RESET}`);
  withCritical.forEach((r) => {
    r.details
      .filter((d) =>
        ["TEMPLATE_LITERAL_BUG", "EMPTY_VALUES", "SPOT_CHECK_UNTRANSLATED"].includes(
          d.type
        )
      )
      .forEach((d) => {
        console.log(`\n  ${r.lang} — ${d.type} (${d.count}):`);
        d.items.slice(0, 20).forEach((item) => console.log(`    ${RED}${item}${RESET}`));
      });
  });
}

console.log(
  `\n${overallPass ? GREEN + "✓ All checks passed" : RED + "✗ Issues found — see above"}${RESET}\n`
);

process.exit(overallPass ? 0 : 1);
