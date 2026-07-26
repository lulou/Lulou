/**
 * Removes the first (older) occurrence of any key that appears more than once
 * within the same language block in i18n.ts.
 * Only removes duplicates within the same block; leaves cross-block entries alone.
 */
import { readFileSync, writeFileSync } from "fs";

const FILE = "client/src/lib/i18n.ts";
const src = readFileSync(FILE, "utf8");
const lines = src.split("\n");

// ── Identify language block boundaries ────────────────────────────────────────
// A block starts on a line like `  en: {` or `  "zh-CN": {` and ends on the
// first subsequent `  },` or `},` or `} as const;` line.
const KEY_RE = /^\s{4}([\w-]+)\s*:/;  // 4-space indent key

// Find all block start lines
const BLOCK_START_RE = /^\s{2}(?:"[\w-]+"|\w+)\s*:\s*\{/;
const blockStarts = [];
for (let i = 0; i < lines.length; i++) {
  if (BLOCK_START_RE.test(lines[i])) blockStarts.push(i);
}

// For each block, collect (lineIndex, key) pairs and mark first occurrences of duplicates for removal
const linesToRemove = new Set();

for (let bi = 0; bi < blockStarts.length; bi++) {
  const start = blockStarts[bi];
  const end = bi + 1 < blockStarts.length ? blockStarts[bi + 1] : lines.length;

  // Map: key → [list of line indices inside this block]
  const keyLines = new Map();
  for (let i = start + 1; i < end; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    if (!keyLines.has(key)) keyLines.set(key, []);
    keyLines.get(key).push(i);
  }

  // For any key with >1 occurrence, remove all but the LAST one
  for (const [key, idxArr] of keyLines) {
    if (idxArr.length > 1) {
      console.log(`Duplicate in block starting L${start+1}: key="${key}" at lines ${idxArr.map(x=>x+1).join(', ')} — removing all but last`);
      for (let k = 0; k < idxArr.length - 1; k++) {
        linesToRemove.add(idxArr[k]);
      }
    }
  }
}

if (linesToRemove.size === 0) {
  console.log("No duplicates found.");
  process.exit(0);
}

const cleaned = lines.filter((_, i) => !linesToRemove.has(i));
writeFileSync(FILE, cleaned.join("\n"), "utf8");
console.log(`Removed ${linesToRemove.size} duplicate line(s). New file: ${cleaned.length} lines.`);
