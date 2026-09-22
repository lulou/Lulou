---
name: Supabase connectivity from Replit
description: Direct PostgreSQL TCP is blocked, while the Management API and PostgREST are available
---

## Blocked

- **Direct TCP** `db.{ref}.supabase.co:5432`: ENOTFOUND (DNS blocked, even with DoH)
- **Supabase Pooler** `aws-0-*.pooler.supabase.com:5432/6543`: all regions fail
- **Supabase CLI `db query --db-url`**: same DNS failure with DoH

## Works

- Supabase Management API database queries using the current workspace access token ✓
- HTTP to `https://{ref}.supabase.co/rest/v1/` (PostgREST) ✓
- The app's configured Supabase clients work because they normalize the configured URL and provide the required runtime transport.

## Implication

DDL can be applied programmatically through the Management API when authorized.

**Why:** The previously stored access token returned 401, but the currently configured token successfully applied an additive production migration on 2026-09-07.

**How to apply:** Prefer the Management API for migrations. For direct REST audits or any new `createClient` call, derive `new URL(VITE_SUPABASE_URL).origin` first; the stored URL may already include `/rest/v1/`, and appending another API path produces `Invalid path specified`. Avoid standalone Node 20 `createClient` audit scripts unless they provide the runtime's WebSocket transport; direct authenticated REST is more reliable for aggregate audits.
