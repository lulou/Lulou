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
-   **Elevate System**: `elevateType` and `elevateExpiresAt` fields on `profiles` table provide temporary visibility boosts (Elevate for medium, Super Elevate for top-tier) in Discovery and Intention Wheel.
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