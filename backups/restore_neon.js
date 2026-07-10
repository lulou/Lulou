'use strict';
/**
 * Neon restore script — executes pre.sql / data.sql (COPY blocks) / post.sql
 * statement-by-statement via pg, avoiding psql -f sandbox restrictions.
 * Run: node backups/restore_neon.js
 * Reads NEON_DATABASE_URL from environment (never printed).
 */
const { Pool } = require('pg');
const fs = require('fs');

// ── Build direct (non-pooler) URL from secret ─────────────────────────────
const rawUrl = process.env.NEON_DATABASE_URL;
if (!rawUrl) { console.error('FATAL: NEON_DATABASE_URL not set'); process.exit(1); }
const directUrl = rawUrl
  .replace(/-pooler\./, '.')
  .replace(/[?&]channel_binding=require/g, '')
  .replace(/\?&/, '?')
  .replace(/[?&]$/, '');

const pool = new Pool({ connectionString: directUrl, max: 1 });

// ── Helpers ───────────────────────────────────────────────────────────────
function splitStatements(sql) {
  // Split on semicolons at end-of-line (standard pg_dump output format).
  // Filters blank lines and comments.
  return sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--') && !/^\s*$/.test(s));
}

// Unescape PostgreSQL COPY text-format escape sequences.
function unescapeCopy(v) {
  if (v === '\\N') return null;
  return v
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

async function execStatements(stmts, label) {
  let ok = 0, skipped = 0, errors = [];
  for (const stmt of stmts) {
    if (!stmt) continue;
    try {
      await pool.query(stmt);
      ok++;
    } catch (e) {
      const m = e.message;
      // Expected during --clean restore: objects that don't exist yet being dropped.
      if (m.includes('does not exist') || m.includes('already exists') || m.includes('duplicate key')) {
        skipped++;
      } else {
        errors.push(m.slice(0, 220));
      }
    }
  }
  console.log(`[${label}] statements=${stmts.length} ok=${ok} skipped=${skipped} errors=${errors.length}`);
  errors.forEach(e => console.log(`  ERR: ${e}`));
  return errors.length;
}

// Parse COPY blocks and insert rows via parameterised queries.
async function execCopyData(sql) {
  // Match: COPY schema.table (col, col, ...) FROM stdin;\n<rows>\n\.
  const blockRe = /COPY ([^\s(]+)\s*\(([^)]+)\)\s*FROM stdin;\n([\s\S]*?)\\\./gm;
  let tables = 0, rows = 0, errors = [];
  let match;

  while ((match = blockRe.exec(sql)) !== null) {
    const table = match[1];
    const cols  = match[2].split(',').map(c => c.trim());
    const lines = match[3].split('\n').filter(l => l.length > 0);
    tables++;

    for (const line of lines) {
      const raw    = line.split('\t');
      const values = raw.map(unescapeCopy);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const q = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        await pool.query(q, values);
        rows++;
      } catch (e) {
        errors.push(`${table}: ${e.message.slice(0, 220)}`);
      }
    }
    process.stdout.write('.');
  }
  console.log('');
  console.log(`[DATA] tables=${tables} rows_inserted=${rows} errors=${errors.length}`);
  errors.slice(0, 20).forEach(e => console.log(`  ERR: ${e}`));
  return errors.length;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  // 1. Verify connection
  try {
    await pool.query('SELECT 1');
    console.log('[CONNECT] OK — Neon reachable');
  } catch (e) {
    console.error('[CONNECT] FAILED:', e.message);
    process.exit(1);
  }

  let totalErrors = 0;

  // 2. Pre-data (schemas, tables — no constraints yet)
  const preSql   = fs.readFileSync('/tmp/pre.sql', 'utf8');
  const preStmts = splitStatements(preSql);
  console.log(`\n[PRE] ${preStmts.length} statements`);
  totalErrors += await execStatements(preStmts, 'PRE');

  // 3. Data (COPY blocks → parameterised INSERTs)
  const dataSql = fs.readFileSync('/tmp/data.sql', 'utf8');
  console.log('\n[DATA] inserting rows...');
  totalErrors += await execCopyData(dataSql);

  // 4. Post-data (indexes, constraints, sequences)
  const postSql   = fs.readFileSync('/tmp/post.sql', 'utf8');
  const postStmts = splitStatements(postSql);
  console.log(`\n[POST] ${postStmts.length} statements`);
  totalErrors += await execStatements(postStmts, 'POST');

  // 5. Verification
  console.log('\n[VERIFY] row counts:');
  const tables = ['profiles','matches','messages','interactions','push_subscriptions','user_benefits'];
  for (const t of tables) {
    try {
      const r = await pool.query(`SELECT count(*) FROM public.${t}`);
      console.log(`  ${t}: ${r.rows[0].count}`);
    } catch (e) {
      console.log(`  ${t}: ERROR — ${e.message}`);
    }
  }

  const schemas = await pool.query(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','pg_catalog','pg_toast') ORDER BY schema_name`
  );
  console.log('\n[VERIFY] schemas:', schemas.rows.map(r => r.schema_name).join(', '));

  const tblCount = await pool.query(
    `SELECT table_schema, count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('information_schema','pg_catalog','pg_toast') GROUP BY table_schema ORDER BY table_schema`
  );
  tblCount.rows.forEach(r => console.log(`[VERIFY] tables in ${r.table_schema}: ${r.count}`));

  const idxCount = await pool.query(
    `SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname NOT LIKE '%_pkey'`
  );
  console.log(`[VERIFY] non-PK indexes: ${idxCount.rows[0].count}`);

  const seqCount = await pool.query(
    `SELECT count(*) FROM information_schema.sequences WHERE sequence_schema NOT IN ('information_schema','pg_catalog')`
  );
  console.log(`[VERIFY] sequences: ${seqCount.rows[0].count}`);

  const conCount = await pool.query(
    `SELECT count(*) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public'`
  );
  console.log(`[VERIFY] FK constraints: ${conCount.rows[0].count}`);

  console.log(`\n[DONE] total non-skipped errors: ${totalErrors}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
