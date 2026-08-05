---
name: WAL refetch race causes badge snap-back
description: Message insert triggers WAL event that races the Supabase counter update, snapping the badge back to 15
---

## Race sequence

1. Server inserts message → Supabase postgres_changes WAL fires (~100–200 ms)
2. `useUnreadCounts` (matches.tsx L5493) handles WAL and calls:
   `invalidateQueries({ queryKey: ["/api/matches", matchId], exact: true })`
3. React Query fires GET /api/matches/:id refetch
4. If counter UPDATE hasn't committed yet → Supabase returns counter=0
5. Client patches cache to 0 → badge snaps to 15
6. onSuccess patches to correct count → brief 14
7. Late refetch response arrives → overwrites → persistent 15

**Why matches.tsx is always mounted:** /messages/:matchId is inside PersistentTabs (App.tsx L277).

## Fix

**Increment counter BEFORE inserting message** (server/routes.ts).
Counter is committed in Supabase before WAL fires → refetch reads correct value.

## PostgREST schema reload

After creating/replacing a Supabase function:
`SELECT pg_notify('pgrst', 'reload schema');`
Without this, new functions are invisible for up to ~60 seconds.
