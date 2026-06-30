---
name: blocked_contacts schema
description: The local blocked_contacts table is for phone contacts, not user-to-user blocks.
---

## Rule
`blocked_contacts` (shared/schema.ts) has columns: `id`, `userId`, `name`, `phoneNumber`, `email`, `createdAt`. There is **no** `blockedUserId` column and no user-to-user block relationship.

## Why
The table stores a user's blocked phone contacts (people they don't want to see). User-to-user blocking (if any) is managed in Supabase, not in the local PostgreSQL instance.

## How to apply
- Never query `blockedContacts.blockedUserId` — that column does not exist and will cause a TypeScript error.
- `isBlockedBy()` in `server/pushService.ts` is a documented stub returning `false` until a Supabase-side user block check is wired up.
- If implementing push notification suppression for blocked users, query Supabase's `blocked_users` table (if it exists) or a new local table with proper schema.
