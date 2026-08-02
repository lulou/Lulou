---
name: Settings persistence architecture
description: How language, units, audio transcripts, and push account preference are persisted across refresh/logout/devices
---

## Architecture

`user_settings` table in local Neon PostgreSQL (NOT Supabase). One row per user_id (UUID PK).
Columns: `preferred_language`, `preferred_units`, `audio_transcripts`, `push_account_enabled` (NOT NULL DEFAULT false), `created_at`, `updated_at`.

**Routes:** `GET /api/settings` + `PATCH /api/settings` (both require isAuthenticated).
- GET upserts the row on first call (INSERT … ON CONFLICT DO NOTHING) so new users always get a row.
- PATCH rejects unknown keys and validates types. `pushAccountEnabled` must be boolean (not null).
- Query key: `["/api/settings", userId]` — scoped per user so Account A and B never share a cache entry.

## Hydration — SettingsHydrationProvider (added 2026-08-02)

`client/src/contexts/settings-hydration-context.tsx` wraps the full app (inside AuthProvider in App.tsx).
Fires `GET /api/settings` the moment `user` is set — before the Settings page is ever opened.
React Query deduplicates this with any `useQuery(["/api/settings", userId])` call in settings.tsx.

- Calls `setLanguage` / `setUnits` when the server row arrives, keyed on `serverSettings.userId`.
- Resets both to defaults ("English" / "miles") when `user` becomes null (logout).
- Exposes `settingsHydrated: boolean` via `useSettingsHydration()` — false until server row arrives.

**Why needed:** Before this, the hydration effect only ran inside settings.tsx (visited rarely), so French/km users saw English/miles on every other page until they opened Settings.

## Contexts (language + units)

`language-context.tsx` and `units-context.tsx`:
- No localStorage read on init (would leak Account A's preference to Account B on the same device).
- `setLanguage(lang)` / `setUnits(u)` update in-memory state only.
- PATCH /api/settings is the caller's responsibility (so optimistic rollback works).
- `queryClient.clear()` at logout clears the cache; SettingsHydrationProvider resets contexts.

## Settings page (settings.tsx)

`useQuery(["/api/settings", user?.id], staleTime=30s)` — same cache entry as SettingsHydrationProvider.
`useMutation(PATCH /api/settings)` with full optimistic update + rollback + error toast for:
  language, units, audioTranscripts.

Profile-stored toggles (show_last_active, comment_filter, conversation_starter_ai):
- **No longer use useToggle / localStorage** (removed 2026-08-02 — leaked across accounts).
- Derived directly from the profile query: `profile?.showLastActive ?? true`, etc.
- `updateProfileSetting` mutation: `POST /api/profile`, optimistic cache update, rollback on error, destructive toast.

## Push account preference (use-push-notifications.ts)

State: `accountPreference: boolean | undefined`
- `undefined` = not yet loaded (before GET /api/settings completes)
- `false` = loaded, disabled
- `true` = loaded, enabled

`needsReconnect = accountPreference === true && !isSubscribed`

The stale-subscription cleanup gates on `accountPreference !== false`, which skips `undefined` correctly
so it does not fire prematurely on mount before the server row has been read.

On subscribe: PATCH `{ pushAccountEnabled: true }` + `setAccountPreference(true)`.
On unsubscribe: PATCH `{ pushAccountEnabled: false }` + `setAccountPreference(false)`.

## Push toggle UI (settings.tsx)

`checked={pushAccountPreference === true}` — false while loading (undefined), correct once loaded.
Amber reconnect banner when `needsReconnect && !pushLoading`.

## Schema / migration files

- `supabase/migrations/add_user_settings_table.sql` — original table creation
- `supabase/migrations/amend_push_not_null.sql` — back-fills NULL→false, adds NOT NULL DEFAULT false
- `server/index.ts` startup DDL updated to match (NOT NULL DEFAULT false)
- `shared/schema.ts`: `pushAccountEnabled: boolean("push_account_enabled").notNull().default(false)`
