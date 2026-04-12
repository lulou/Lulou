# Lulou Dating - Intentional Dating App

## Overview
Lulou Dating is a premium dating app designed to foster intentional connections, moving users from initial matches to real-life meetings. It aims to reduce common dating app frustrations like endless texting, ghosting, and the pervasive casual dating culture, promoting meaningful interactions instead. The platform focuses on a structured progression through conversation and calls to facilitate genuine connections.

## User Preferences
No explicit user preferences were provided in the original `replit.md` file.

## System Architecture
Lulou Dating employs a modern web architecture:
-   **Frontend**: Built with React, Vite, Tailwind CSS, and shadcn/ui for a responsive and aesthetically pleasing user interface.
-   **Backend**: Powered by Express.js, featuring Supabase token verification middleware for secure API access.
-   **Database**: Utilizes PostgreSQL via Supabase, with `@supabase/supabase-js` for client-side interactions.
-   **Authentication**: Managed by Supabase Auth, supporting email and password-based sign-up and sign-in.

**Key Features**:
-   **Profile Creation**: Comprehensive profiles include personality signals, green flags, dating intent, connection style, and optional height.
-   **Discovery**: Displays one profile at a time in a bubble-style photo layout, with all information visible in a single scrollable card. Features dynamic photo focus and clear interaction buttons.
-   **Intention Wheel**: A horizontal spinning wheel showcasing the top 10 most popular profiles, allowing users to discover new matches. Popularity is based on "opens received."
-   **Matching System**: A mutual matching mechanism.
-   **Matches & Chat**: A dedicated matches page with expandable inline chatrooms.
    -   **Real-time Messaging**: Implemented with Supabase Realtime subscriptions and a 10s polling fallback. Includes unread message counts and typing indicators.
    -   **Optimistic Updates**: Messages appear instantly for the sender.
    -   **Limited Messaging**: Conversations are structured with a limit of 15 messages per person (500 characters max) in the initial stage.
-   **Structured Connection Progression**: A 5-step process (Match → Chat → 1st Call → 2nd Call → Meet) guided by a "Spark progress bar" and system messages in chat.
    -   **Call Scheduling**: Both first and second calls require mutual agreement on a time, with proposed, accepted, and ready states. Uses system messages for tracking without additional DB columns.
    -   **Multi-Call Progression**:
        1.  First voice call (10 minutes) after 15 messages.
        2.  Post-call messaging (6 messages per user).
        3.  Second voice call (15 minutes) after post-call messages are exchanged.
        4.  Optional face/video call (10 minutes) with mutual acceptance.
    -   **Call System**: Active call signaling via Supabase Realtime broadcast for ring, answered, declined, cancelled, and ended states. Features incoming and active call overlays, staleness protection, and cancelled session tracking.
-   **Post-Call Actions**: "Ready to Meet" button unlocks after all calls, allowing users to propose meet-up availability. Phone number exchange is unlocked only after mutual meet-up confirmation.
-   **Message Reactions**: Double-tap to toggle a heart reaction on received messages.
-   **Content Filtering**: Server-side filtering to block sensitive information (phone numbers, emails, social media handles) in regular messages.
-   **Benefit System**: Account-wide benefits (e.g., message extensions, extra calls) stored in `user_benefits` table, activated per chat.
-   **Lulou Extras / Membership Stripe flow**: `POST /api/stripe/extras-checkout` creates Stripe Checkout sessions using inline `price_data` (no pre-created price IDs needed). Items: `messages-5` ($4.99), `extra-call` ($4.99), `video-call` ($6.99), `undo-close` ($2.99), `membership` ($19.99/month subscription). On success redirects to `/extras/success?session_id=XXX&item=<itemId>`. `POST /api/stripe/extras-activate` verifies payment/subscription and grants benefits via `user_benefits`. `cancel_url` → `/profile?checkout=cancelled`. Profile page has bfcache `pageshow` listener and cancel-toast detection. Subscription mode uses `price_data.recurring: { interval: "month" }`.
-   **Elevate System**: Stores boost state in the local `user_elevates` table (not Supabase). Columns: `elevateType`, `expiresAt`, `activatedAt` (precise session window start), `elevateCredits`, `superElevateCredits`.
    -   **Weighted algorithm** (`weightedSample` in `server/storage.ts`): Normal=1x, Elevate=3x, Super Elevate=8x per slot draw. Each position in the result list is sampled probabilistically. `getActiveElevatesMap()` pulls live elevate rows from local DB and `mergeElevatesIntoProfiles()` injects them before sampling runs. Routes: `GET /api/elevate/status` · `GET /api/elevate/session-stats`
    -   Elevate = 30-minute boost; Super Elevate = 60-minute boost. Credits system: 4 packs (1/$9.99, 3/$26.99, 5/$39.99, Super/$34.99).
    -   **Stripe payment flow**: `POST /api/stripe/elevate-checkout` creates a Stripe Checkout session. On success, Stripe redirects to `/elevate/success?session_id=XXX`. `POST /api/stripe/elevate-activate` verifies payment, adds all credits, and auto-activates one boost immediately. Webhook at `POST /api/stripe/webhook` via `stripe-replit-sync`.
    -   **Success page** (`client/src/pages/elevate-success.tsx`): Full live status experience — verifying spinner → live status card with MM:SS countdown + animated views/matches counters + remaining credits badge → "Continue Exploring" to /likes.
    -   **Two-step purchase flow** in `ElevateModal` (`client/src/components/elevate-modal.tsx`): Browse step (pricing) → Checkout step (order summary + "Pay [price]" button). Shows credits banner with "Activate" button when unused boosts are available.
    -   **`ElevateStatusCard`** (`client/src/components/elevate-status-card.tsx`): Premium live status shown on Likes screen. Shimmer/glow animations, live countdown, animated views/matches from `/api/elevate/session-stats`. Two variants: Elevate (warm rose) and Super Elevate (deep dark with radial glow).
    -   **Shared utils** (`client/src/lib/elevate-utils.ts`): `useCountdownSecs`, `useAnimatedCount`, `formatCountdown` — shared between ElevateStatusCard and the success page.
    -   **Session stats**: `getElevateSessionStats` uses `activatedAt` as the window start (falls back to `expiresAt - duration`) so stats only count the current active session.
-   **Location Radius**: Configurable search radius (5-100 miles).
-   **Photo Verification**: Provides a verified badge on profiles.
-   **Spin Economy**: Manages eligibility and usage of "spins" for the Intention Wheel, with earning conditions and purchase options.

**Design Language**:
-   **Color Scheme**: Warm rose-blush primary (HSL 350 45% 52%), sage green accents (HSL 155 25%), and warm cream backgrounds.
-   **Typography**: Playfair Display for headings and Plus Jakarta Sans for body text.
-   **Aesthetics**: Calm, spacious, minimal, aiming for a "luxury boutique hotel" feel. Explicitly avoids gamification and casino mechanics.

**Performance Optimisations**:
-   **Client-side Token Caching**: `setCachedToken` stores Supabase JWT in memory to reduce redundant `getSession()` calls.
-   **Server-side JWT Caching**: `verifyJwt()` caches Supabase user results for 2 minutes to minimize authentication overhead.
-   **Parallelized Database Queries**: Extensive use of `Promise.all` across multiple API routes (e.g., `getMatchesForUser`, `getMatch`, `getDiscoverProfiles`, `getConsecutiveLikeDays`, `spin-status`) to reduce N+1 problems and improve response times.
-   **Optimised Supabase Integration**: Streamlined `use-auth.ts` hook and simplified `getMatchCount` for efficiency.

## External Dependencies
-   **Supabase**:
    -   **Supabase Auth**: For user authentication (email/password).
    -   **Supabase Database (PostgreSQL)**: The primary data store.
    -   **Supabase Realtime**: For real-time features like messaging, unread counts, typing indicators, and call signaling.
-   **Vite**: Frontend build tool.
-   **React**: Frontend JavaScript library.
-   **Tailwind CSS**: Utility-first CSS framework.
-   **shadcn/ui**: UI component library.
-   **Express.js**: Backend web framework.
-   **Drizzle ORM**: Used for defining database schemas (`user_benefits` table in local PostgreSQL).