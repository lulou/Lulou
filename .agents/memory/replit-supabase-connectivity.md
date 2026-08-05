---
name: Replit blocked from Supabase PostgreSQL
description: All TCP paths to Supabase PostgreSQL are blocked from Replit; only HTTP to the REST API works
---

## Blocked

- **Management API** `https://api.supabase.com/v1/projects/{ref}/database/query`: 401 (sbp_ PAT unauthorized)
- **Direct TCP** `db.{ref}.supabase.co:5432`: ENOTFOUND (DNS blocked, even with DoH)
- **Supabase Pooler** `aws-0-*.pooler.supabase.com:5432/6543`: all regions fail
- **Supabase CLI `db query --db-url`**: same DNS failure with DoH
- **Supabase CLI `link --project-ref`**: 401 same Management API issue

## Works

- HTTP to `https://{ref}.supabase.co/rest/v1/` (PostgREST) via JS client ✓

## Implication

DDL migrations cannot be applied programmatically. User must apply via Supabase SQL editor:
https://supabase.com/dashboard/project/{ref}/sql/new

After DDL: `SELECT pg_notify('pgrst', 'reload schema');`
