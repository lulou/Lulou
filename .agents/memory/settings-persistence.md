---
name: Settings persistence architecture
description: How language, units, audio transcripts, and push account preference are persisted across refresh/logout/devices
---

## Architecture

`user_settings` table in local Neon PostgreSQL (NOT Supabase). One row per user_id (UUID PK).
Columns: `preferred_language`, `preferred_units`, `audio_transcripts`, `push_account_enabled`, `created_at`, `updated_at`.

**Routes:** `GET /api/settings` + `PATCH /api/settings` (both require isAuthenticated).
- GET returns `{ hasRecord: bool, preferredLanguage, preferredUnits, audioTranscripts, pushAccountEnabled }`.
- `hasRecord: false` means no DB row yet (first time) — client should persist its localStorage values to server instead of overriding them.

## Contexts (language + units)

`language-context.tsx` and `units-context.tsx` no longer use Supabase `auth.updateUser`.
- State initializes from localStorage (fast, avoids flicker).
- `setLanguage(lang)` / `setUnits(u)` update state + localStorage + PATCH `/api/settings` (fire-and-forget, silently ignores 401 when unauthenticated).

**Why:** Supabase `user_metadata` is per-device/session and lost on token refresh; also blocked by the `auth.updateUser` network call being unreliable.

## Settings page sync (settings.tsx)

`useQuery(["/api/settings"], staleTime=30s)` + `useMutation(PATCH /api/settings)`.

**First-time flow** (`hasRecord: false`): persist current localStorage (language, units, audioTranscripts) to server. Server adopts the user's prior choices.

**Returning flow** (`hasRecord: true`): server values win — call `setLanguage`/`setUnits`/`setAudioTranscripts` with server values if they differ. This covers the multi-device case (changed on device B, now opening on device A).

`audioTranscripts`: was localStorage-only (`useToggle`). Now persisted via PATCH when it changes. Skips write if value matches what was just synced from server (prevents echo-write).

## Push account preference (use-push-notifications.ts)

New state: `accountPreference: boolean | null` (null = never set).
New computed: `needsReconnect = accountPreference === true && !isSubscribed`.

On mount: fetches `/api/settings` to get `pushAccountEnabled` → sets `accountPreference`. This prevents the push toggle from flashing OFF on refresh (account preference is known before the browser's PushManager check).

On subscribe: PATCH `{ pushAccountEnabled: true }` + `setAccountPreference(true)`.
On unsubscribe: PATCH `{ pushAccountEnabled: false }` + `setAccountPreference(false)`.

## Push toggle UI (settings.tsx)

Toggle `checked = pushAccountPreference === true || (pushAccountPreference === null && pushSubscribed)`.
When `needsReconnect && !pushLoading`: amber reconnect banner with "Reconnect" button.

**Why:** Old toggle showed `checked={pushSubscribed}` which flashed OFF on refresh until PushManager resolved. New approach shows the account-level intent immediately.

## Startup guard

`user_settings` CREATE TABLE added to the `server/index.ts` startup block (line ~427). Safe to re-run (`IF NOT EXISTS`). Also manually migrated in prod Neon DB (2026-08-02).

## Dev logging

- `[SETTINGS_PERSISTENCE]` — server fetch/patch logs; client sync and change logs.
- `[PUSH_SUBSCRIPTION]` — replaces `[PUSH]` prefix in push hook for subscription events.
