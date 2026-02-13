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
- Mutual matching system
- Matches page with expandable inline chatrooms per match card
- Limited messaging (15 messages per person, 500 chars max)
- Call prompt after message limit

## Design Language
- Color scheme: Sage green primary (#4d8b7a), warm cream backgrounds
- Fonts: Playfair Display (serif headings), Plus Jakarta Sans (body)
- Calm, spacious, minimal - "luxury boutique hotel" feel
- No gamification, no casino mechanics

## Project Structure
- `client/src/pages/` - Landing, Onboarding, Discover, Matches, Messaging, Profile
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

## API Routes
- `GET /api/profile` - Get current user's profile
- `POST /api/profile` - Create/update profile
- `GET /api/discover` - Get discoverable profiles
- `POST /api/interactions` - Create open/close interaction
- `GET /api/matches` - Get user's matches
- `GET /api/matches/:id` - Get match details with messages
- `POST /api/matches/:id/messages` - Send message
