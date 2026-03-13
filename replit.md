# Lulou Dating - Intentional Dating App

## Overview
Lulou Dating is a calm, premium dating app focused on helping people move from matching to conversation to real-life meeting. It reduces endless texting, ghosting, and casual dating culture.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Express.js with Supabase token verification middleware
- **Database**: Supabase (PostgreSQL) via @supabase/supabase-js client
- **Auth**: Supabase Auth (email + password via `signUp` / `signInWithPassword`)

## Key Features
- Profile creation with personality signals, green flags, dating intent, connection style, optional height
- Discovery page showing one profile at a time with bubble-style photo layout
  - Single scrollable card: photos at top, about section below, name/age/location/height at bottom
  - No tabs - all info visible in one scroll
  - Photo bubbles with dynamic focus (centered photo grows, side photos shrink)
  - Open button (heart + "Open" label) overlaid on focused photo
  - Close button (moon) fixed at bottom-right of screen
- Intention Wheel (Intent tab) - horizontal spinning wheel of top 10 most popular profiles
  - Spin button triggers animated wheel spin with eased deceleration
  - Lands on a random profile, shows their details (photo, name, age, location, signals, starters)
  - Popularity ranked by number of "opens" received
  - Manual drag scrolling with momentum physics
- Mutual matching system
- Matches page with expandable inline chatrooms (only one chat open at a time)
- Unread message counts per conversation via Supabase Realtime (badge on match card)
- Unread counts clear automatically when opening a thread
- Real-time messaging via Supabase Realtime subscriptions (with 10s polling fallback)
- Typing indicators via Supabase Realtime broadcast (no DB writes) — "{Name} is typing..." shown in active thread with animated dots; disappears on send or after 3.5s timeout; throttled to one broadcast per 2s
- Optimistic message updates (sender sees message instantly)
- Limited messaging (15 messages per person, 500 chars max)
- Structured connection progression (5 steps: Match → Chat → 1st Call → 2nd Call → Meet)
  - Spark progress bar in chat header shows current step
  - Stage hint banners appear in input area as limits approach
- Call scheduling: both calls require mutual agreement on a time before starting
  - States: not scheduled → proposed → accepted → ready to start
  - Quick times: Available now / In 30 min / In 1 hr / In 2 hrs / Pick specific time
  - Receiver can accept, decline, or suggest a different time
  - Seed users auto-accept proposals (1.5-3s delay)
  - Scheduling state derived from `__SCHEDULE__:` system messages in messages table (no new columns)
  - `__SCHEDULE__:` messages are hidden from the chat display
  - Start Call button only appears when schedule is accepted + time is within 5 min
- Multi-call progression after message limit:
  1. First voice call (10 minutes) - prompted after 15 messages (stage 0)
  2. Post-call messaging (6 messages per user) - after first call (stage 1)
  3. Second voice call (15 minutes) - unlocked when both users hit 6 post-call messages (stage 1→2)
  4. Optional face/video call (10 minutes) - both users must accept; either can skip (stage 2→3)
- Call stages tracked via `callStage` (0=pre-call, 1=first done, 2=second done, 3=face done/skipped)
- `message_count_1/2` reset to 0 when first call completes — reused as post-call message counters (0-6)
- Call sessions tracked via `callSessionId` derived from `call_started_at` (no DB column)
- **Call system active** — re-enabled with stale checks, cancelled-session guards, and inline chat state preservation; no WebRTC audio/video yet (use-webrtc.ts exists but is not imported)
- Call signaling via Supabase Realtime broadcast (5 signal types: ring, answered, declined, cancelled, ended)
- Server broadcasts ring on start, cancelled on cancel, ended on complete
- Client broadcasts declined (on decline), cancelled (on caller cancel), ended (on hang up)
- Incoming call overlay: full-screen phone-call-style screen with caller photo, drag-up-to-answer (green knob) + tap-to-decline (red button)
- Active call overlay: full-screen UI with call timer and end-call button (no audio/video controls)
- CallDetectors in App.tsx polls matches every 10s and shows incoming or active call overlays
- Staleness protection: ringing calls >120s and answered calls >30min are ignored (prevents stale re-entry)
- Cancelled call session tracking via `client/src/lib/cancelled-calls.ts` — prevents stale call data from re-showing call UI after decline/cancel
- After decline/cancel, optimistic cache clear sticks (no immediate refetch); 10s poll refreshes naturally
- End signals (declined/cancelled/ended) in use-call-signaling.ts mark sessions as cancelled and do NOT invalidate queries (prevents stale data flip-flop)
- Both CallDetectors (App.tsx) and inline call UI (matches.tsx) check `isCallSessionCancelled` before showing call overlays/ringing state
- Call routes use `getCallStorage(req)` — uses admin client if service role key exists, falls back to user JWT client
- `cancelCall` in storage.ts never throws on DB update failure — returns pre-read data with cleared fields
- Duplicate call prevention via `.is("call_started_at", null)` guard in DB update
- Caller gets "declined" notification when receiver declines their call
- Face call requires mutual acceptance (`faceCallUser1Accepted`, `faceCallUser2Accepted`)
- After all calls: "Ready to Meet" button shows date/time picker (next 7 days, 4 time slots each)
- Meet availability tracked per user (`meetAvailability1`, `meetAvailability2` as JSON)
- Phone number exchange only unlocked after both users confirm matching date/time availability
- Message reactions: double-tap a received message to toggle ❤️ reaction (stored in DB, visible to both users)
- Message content filtered server-side to block phone numbers, emails, and social media handles in regular messages
- Exchange number auto-sends phone as message via dedicated route (bypasses content filter)
- Profile page shows age, height, location, adjustable search radius
- Profile sections: Lulou Extras (subscriptions), Safety, Lulou Me (photo verification badge), Help Centre, What Works (dating tips)
- Location radius (5-100 miles) configurable in onboarding and profile
- Photo verification (Lulou Me) gives profiles a verified badge

## Design Language
- Color scheme: Warm rose-blush primary (HSL 350 45% 52%), sage green accents (HSL 155 25%), warm cream backgrounds
- Fonts: Playfair Display (serif headings), Plus Jakarta Sans (body)
- Calm, spacious, minimal - "luxury boutique hotel" feel
- No gamification, no casino mechanics

## Project Structure
- `client/src/pages/` - Landing, Onboarding, Discover, Intent, Likes, Matches, Messaging, Profile
- `client/src/components/` - AppLayout (bottom nav), IncomingCallOverlay, UI components
- `server/routes.ts` - API endpoints
- `server/storage.ts` - Database operations
- `server/seed.ts` - Seed data with 5 demo profiles
- `shared/schema.ts` - Drizzle schema definitions
- `client/src/lib/supabase.ts` - Frontend Supabase client
- `client/src/lib/profile-upsert.ts` - Frontend profile upsert helper (writes directly to Supabase with user_id = user.id, onConflict: "user_id")
- `client/src/hooks/use-auth.ts` - Supabase Auth hook (session, login, logout)
- `client/src/hooks/use-realtime-messages.ts` - Supabase Realtime subscription for instant message delivery
- `client/src/hooks/use-unread-counts.ts` - Per-match unread message tracking via Supabase Realtime
- `client/src/hooks/use-typing-indicator.ts` - Typing indicator via Supabase Realtime broadcast (ephemeral, no DB writes)
- `client/src/lib/cancelled-calls.ts` - Cancelled call session tracking (prevents stale call UI reappearance)
- `client/src/hooks/use-webrtc.ts` - WebRTC peer connection hook with Supabase Realtime signaling
- `client/src/components/active-call.tsx` - Active call overlay (voice/video) with WebRTC streams
- `server/supabase.ts` - Server Supabase client

## Database Tables
- `profiles` - Dating profiles with signals, flags, photos (user_id = Supabase auth user.id, id auto-generated)
- `interactions` - Open/Close actions between users
- `matches` - Mutual connections
- `messages` - Conversation messages
- `spin_standouts` - Tracks which profiles a user has already seen via Intention Wheel spin (prevents repeats)
- `spin_usage` - Tracks spins per user per date for daily/weekly limits

## Spin Economy
- Free spin earned by sending 10+ likes ("opens") on 3 consecutive days
- Otherwise 1 free spin per week (Monday-Sunday)
- Spins do NOT accumulate - user must use their spin before earning another
- Purchase options: 1 spin/$1.49, 2 spins/$2.49 (coming soon)
- Wheel always shows 10 profiles, shuffled fresh each time
- Profiles reset after every spin (new random set of 10)
- Server-side eligibility enforcement on POST /api/spin

## API Routes
- `GET /api/profile` - Get current user's profile
- `POST /api/profile` - Create/update profile
- `GET /api/discover` - Get discoverable profiles
- `POST /api/interactions` - Create open/close interaction
- `GET /api/matches` - Get user's matches
- `GET /api/matches/:id` - Get match details with messages
- `POST /api/matches/:id/messages` - Send message
- `GET /api/popular` - Get top 10 most popular profiles (by opens received)
- `GET /api/spin-status` - Get spin eligibility (spins today/week, daily likes, canSpin)
- `POST /api/spin` - Record a spin and standout (server-side eligibility enforced)
- `POST /api/matches/:id/call/start` - Start a call (voice or face)
- `POST /api/matches/:id/call/answer` - Answer an incoming call
- `POST /api/matches/:id/call/cancel` - Cancel a ringing call
- `POST /api/matches/:id/call/complete` - Complete call and advance callStage
- `POST /api/matches/:id/face-call/accept` - Accept optional face call (after 2nd voice call)
- `POST /api/matches/:id/face-call/decline` - Decline/skip face call (advances to stage 3)
- `POST /api/messages/:messageId/reaction` - Toggle ❤️ reaction on a message (server validates ownership + received-only)
- `POST /api/matches/:id/schedule-call` - Propose/accept/decline/reschedule a call time (action + proposedTime)
- `POST /api/matches/:id/meet-availability` - Set date/time availability slots (after all calls done)
