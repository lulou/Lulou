# Bloom - Intentional Dating App

## Overview
Bloom is a calm, premium dating app focused on helping people move from matching to conversation to real-life meeting. It reduces endless texting, ghosting, and casual dating culture.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Express.js with session-based auth (Replit Auth)
- **Database**: PostgreSQL with Drizzle ORM
- **Auth**: Replit Auth (OpenID Connect)

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
- Matches page with expandable inline chatrooms per match card
- Limited messaging (15 messages per person, 500 chars max)
- Multi-call progression after message limit:
  1. First voice call (10 minutes) - prompted after 15 messages
  2. Second voice call (15 minutes) - prompted after first call
  3. Optional face/video call (10 minutes) - both users must accept; either can skip
- Call stages tracked via `callStage` (0=pre-call, 1=first done, 2=second done, 3=face done/skipped)
- Face call requires mutual acceptance (`faceCallUser1Accepted`, `faceCallUser2Accepted`)
- After all calls: "Ready to Meet" button shows date/time picker (next 7 days, 4 time slots each)
- Meet availability tracked per user (`meetAvailability1`, `meetAvailability2` as JSON)
- Phone number exchange only unlocked after both users confirm matching date/time availability
- Message content filtered server-side to block phone numbers, emails, and social media handles in regular messages
- Exchange number auto-sends phone as message via dedicated route (bypasses content filter)
- Profile page shows age, height, location, adjustable search radius
- Profile sections: Bloom Extras (subscriptions), Safety, Bloom Me (photo verification badge), Help Centre, What Works (dating tips)
- Location radius (5-100 miles) configurable in onboarding and profile
- Photo verification (Bloom Me) gives profiles a verified badge

## Design Language
- Color scheme: Warm rose-blush primary (HSL 350 45% 52%), sage green accents (HSL 155 25%), warm cream backgrounds
- Fonts: Playfair Display (serif headings), Plus Jakarta Sans (body)
- Calm, spacious, minimal - "luxury boutique hotel" feel
- No gamification, no casino mechanics

## Project Structure
- `client/src/pages/` - Landing, Onboarding, Discover, Intent, Likes, Matches, Messaging, Profile
- `client/src/components/` - AppLayout (bottom nav), UI components
- `server/routes.ts` - API endpoints
- `server/storage.ts` - Database operations
- `server/seed.ts` - Seed data with 5 demo profiles
- `shared/schema.ts` - Drizzle schema definitions
- `server/replit_integrations/auth/` - Replit Auth integration

## Database Tables
- `users` + `sessions` - Auth (managed by Replit Auth)
- `profiles` - Dating profiles with signals, flags, photos
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
- `POST /api/matches/:id/meet-availability` - Set date/time availability slots (after all calls done)
