'use strict';
/**
 * Neon restore — individual statements (reliable), batched data INSERTs (fast).
 * Run: node backups/restore_neon.cjs
 * Env: NEON_DATABASE_URL
 */
const { Pool } = require('pg');
const fs = require('fs');

const rawUrl = process.env.NEON_DATABASE_URL;
if (!rawUrl) { console.error('FATAL: NEON_DATABASE_URL not set'); process.exit(1); }
const directUrl = rawUrl
  .replace(/-pooler\./, '.')
  .replace(/[?&]channel_binding=require/g, '')
  .replace(/\?&/, '?')
  .replace(/[?&]$/, '');

const pool = new Pool({ connectionString: directUrl, max: 1 });

// ── Proper SQL splitter (handles dollar-quoting, single quotes, comments) ─
function splitSql(sql) {
  const stmts = [];
  let cur = '', i = 0;
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i+1] === '-') {
      // DISCARD comment lines — do NOT accumulate them into cur,
      // otherwise the next real statement gets filtered as "starts with --"
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql[i] === '/' && sql[i+1] === '*') {
      // Discard block comments too
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (sql[i] === '$') {
      let tagEnd = i + 1;
      while (tagEnd < sql.length && sql[tagEnd] !== '$') tagEnd++;
      const tag = sql.slice(i, tagEnd + 1);
      const closePos = sql.indexOf(tag, tagEnd + 1);
      if (closePos === -1) { cur += sql.slice(i); i = sql.length; }
      else { cur += sql.slice(i, closePos + tag.length); i = closePos + tag.length; }
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j+1] === "'") j += 2;
        else if (sql[j] === "'") { j++; break; }
        else j++;
      }
      cur += sql.slice(i, j); i = j;
    } else if (sql[i] === ';') {
      const s = cur.trim();
      if (s && !s.startsWith('--') && !/^\s*$/.test(s)) stmts.push(s);
      cur = ''; i++;
    } else { cur += sql[i]; i++; }
  }
  const last = cur.trim();
  if (last && !last.startsWith('--') && !/^\s*$/.test(last)) stmts.push(last);
  return stmts;
}

// ── Execute DDL statements individually ───────────────────────────────────
async function execDDL(stmts, label) {
  let ok = 0, skipped = 0, errors = [];
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    try {
      await pool.query(stmt);
      ok++;
    } catch (e) {
      const m = e.message;
      if (m.includes('does not exist') || m.includes('already exists') || m.includes('duplicate key')) {
        skipped++;
      } else {
        errors.push(`stmt[${i}]: ${m.slice(0, 180)}`);
        process.stderr.write(`  [${label}] ERR stmt${i}: ${m.slice(0,100)}\n`);
      }
    }
  }
  console.log(`[${label}] total=${stmts.length} ok=${ok} skipped=${skipped} errors=${errors.length}`);
  return errors.length;
}

// ── Unescape PostgreSQL COPY text format ─────────────────────────────────
function unesc(v) {
  if (v === '\\N') return null;
  return v.replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\r/g,'\r').replace(/\\\\/g,'\\');
}

// ── Insert one COPY block with batched INSERTs ────────────────────────────
async function insertBlock(table, cols, lines, batchSize) {
  let rows = 0, errors = [];
  for (let s = 0; s < lines.length; s += batchSize) {
    const chunk = lines.slice(s, s + batchSize);
    const params = []; const vparts = []; let pidx = 1;
    for (const ln of chunk) {
      const vals = ln.split('\t').map(unesc);
      vparts.push(`(${vals.map(() => `$${pidx++}`).join(', ')})`);
      params.push(...vals);
    }
    const q = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${vparts.join(', ')} ON CONFLICT DO NOTHING`;
    try {
      const r = await pool.query(q, params);
      rows += (r.rowCount || 0);
    } catch (e) {
      process.stderr.write(`  DATA batch ERR ${table}: ${e.message.slice(0,140)}\n`);
      // row-by-row fallback
      for (const ln of chunk) {
        const vals = ln.split('\t').map(unesc);
        const ph = vals.map((_,i) => `$${i+1}`).join(', ');
        try {
          const r2 = await pool.query(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
            vals
          );
          rows += (r2.rowCount || 0);
        } catch (e2) {
          errors.push(`${table}: ${e2.message.slice(0,160)}`);
        }
      }
    }
  }
  return { rows, errors };
}

// ── Parse all COPY blocks from data.sql ───────────────────────────────────
function parseCopyBlocks(sql) {
  const blockRe = /COPY ([^\s(]+)\s*\(([^)]+)\)\s*FROM stdin;\n([\s\S]*?)\\\./gm;
  const blocks = []; let m;
  while ((m = blockRe.exec(sql)) !== null) {
    const table = m[1], cols = m[2].split(',').map(c => c.trim());
    const lines = m[3].split('\n').filter(l => l.length > 0);
    blocks.push({ table, cols, lines });
  }
  return blocks;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now()-t0)/1000).toFixed(1)}s`;

  try { await pool.query('SELECT 1'); console.log('[CONNECT] OK'); }
  catch (e) { console.error('[CONNECT] FAILED:', e.message); process.exit(1); }

  let totalErrors = 0;

  // ── PRE-DATA ────────────────────────────────────────────────────────────
  const preStmts = splitSql(fs.readFileSync('/tmp/pre.sql', 'utf8'));
  console.log(`\n[PRE] ${preStmts.length} statements`);
  totalErrors += await execDDL(preStmts, 'PRE');
  console.log(`  elapsed: ${elapsed()}`);

  // Quick sanity check
  const chk = await pool.query(`SELECT count(*) c FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
  console.log(`  public tables after PRE: ${chk.rows[0].c}`);

  // ── DATA ─────────────────────────────────────────────────────────────────
  const dataSql = fs.readFileSync('/tmp/data.sql', 'utf8');
  const blocks = parseCopyBlocks(dataSql);
  console.log(`\n[DATA] ${blocks.length} tables with data`);

  let dataErrors = [];
  for (const { table, cols, lines } of blocks) {
    if (lines.length === 0) continue;
    const batchSize = table === 'public.profiles' ? 5 : 50;
    const { rows, errors: errs } = await insertBlock(table, cols, lines, batchSize);
    dataErrors.push(...errs);
    console.log(`  ${table}: ${lines.length} rows → ${rows} inserted`);
  }
  console.log(`[DATA] total_errors=${dataErrors.length}`);
  dataErrors.slice(0,20).forEach(e => console.log(`  ERR: ${e}`));
  totalErrors += dataErrors.length;
  console.log(`  elapsed: ${elapsed()}`);

  // ── POST-DATA ────────────────────────────────────────────────────────────
  const postStmts = splitSql(fs.readFileSync('/tmp/post.sql', 'utf8'));
  console.log(`\n[POST] ${postStmts.length} statements`);
  totalErrors += await execDDL(postStmts, 'POST');
  console.log(`  elapsed: ${elapsed()}`);

  // ── VERIFY ───────────────────────────────────────────────────────────────
  console.log('\n[VERIFY]');
  const vq = `
    SELECT 'profiles'        t, count(*) n FROM public.profiles
    UNION ALL SELECT 'matches',       count(*) FROM public.matches
    UNION ALL SELECT 'messages',      count(*) FROM public.messages
    UNION ALL SELECT 'interactions',  count(*) FROM public.interactions
    UNION ALL SELECT 'push_subs',     count(*) FROM public.push_subscriptions
    UNION ALL SELECT 'user_benefits', count(*) FROM public.user_benefits
  `;
  try {
    const r = await pool.query(vq);
    r.rows.forEach(row => console.log(`  ${row.t}: ${row.n}`));
  } catch (e) { console.log('  verify query error:', e.message); }

  const meta = await pool.query(`
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema='public') tables,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname NOT LIKE '%_pkey') idx,
      (SELECT count(*) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public') fk,
      (SELECT count(*) FROM information_schema.sequences WHERE sequence_schema='public') seq
  `);
  const mv = meta.rows[0];
  console.log(`  tables=${mv.tables} non-pk-idx=${mv.idx} fk=${mv.fk} seq=${mv.seq}`);

  console.log(`\n[DONE] total_errors=${totalErrors} elapsed=${elapsed()}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
