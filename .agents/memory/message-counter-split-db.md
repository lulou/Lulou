---
name: Message counter split-DB fix
description: Root cause and fix for message badge snapping back to 15 — counter wrote to wrong DB.
---

# Message Counter Split-DB Fix

## Root cause
`db.update(matches)` (Drizzle → `DATABASE_URL` = Railway/Neon PostgreSQL) incremented `message_count_1/2`.
Every read — `getMatchMeta`, `getMatch`, `getMatchesForUser` — uses `supabaseAdmin` (Supabase PostgREST).
Two physically separate Postgres instances: write went to Railway, reads came from Supabase → Supabase always returned 0 → badge snapped back to 15 after every send.

Secondary consequence: `myPreCount` was always 0, so the 15-message limit check never fired.

## Fix
- `supabase/migrations/increment_message_count_fn.sql`: atomic `UPDATE ... RETURNING` inside Supabase Postgres, `GRANT EXECUTE TO service_role`.
- `server/routes.ts`: `supabaseAdmin.rpc('increment_message_count', …)` replaces `db.update`. No fallback — RPC failure returns HTTP 503.
- Extended to `callStage === 1` too (not just stage 0), so post-call countdown also has canonical counts.
- `FC_THRESHOLD` milestone guarded to `callStage === 0` only.

## Client
- `messaging.tsx` onSuccess: patches `["/api/matches", matchId]` with authoritative counts from `progression`, resets `localSentCount` to 0, then calls `refetchQueries({ exact: true })` in background to verify.
- System messages (`__VOICE__:` etc.) never change `localSentCount`.

## Retry button
- `matches.tsx` retry: calls `supabase.auth.refreshSession()` before refetching queries.
- `use-auth.ts` logout: Railway DELETE has a 2s `AbortController` timeout so Sign Out completes even when Railway is offline.

**Why:** The Drizzle `db` pool connects to `DATABASE_URL` (Railway). All storage reads use `supabaseAdmin` (Supabase). Any write to a `matches` column via `db.*` is invisible to reads. Only `supabaseAdmin.from()` or `supabaseAdmin.rpc()` writes are visible.

**How to apply:** Run `supabase/migrations/increment_message_count_fn.sql` in the Supabase SQL editor for each environment before deploying the server.
