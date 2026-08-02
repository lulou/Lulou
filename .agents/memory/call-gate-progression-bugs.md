---
name: Call gate progression rendering bugs
description: Why the call gate card disappeared after a declined call, and how it was fixed
---

## Three Root Causes (all in messaging.tsx)

### Bug 1: `!isDeclinedSession` permanently hid the call gate
`declinedSessionIds` state was added to `messaging.tsx` and populated whenever a call session was cleared without completing. The call gate condition included `&& !isDeclinedSession`. Once set, `declinedSessionIds` was never cleared during the component's lifetime — so after any decline, the gate was hidden forever until page reload.

**Fix:** Removed `!isDeclinedSession` from the call gate condition. Added a retry banner _inside_ the call gate card when `isDeclinedSession && callStage === 0` ("Call not completed — try again when you're both ready"). The gate stays visible; the banner informs.

### Bug 2: Cross-user gate missing — user2 saw "15 left" after decline
`isLimitReached` was per-user: `messagesRemaining <= 0`. In the affected match (`message_count_1=15, message_count_2=0`), user2 hadn't sent messages, so their `isLimitReached=false`. After the decline, the call gate condition `isLimitReached || callStage>=2` was false for user2 → normal composer + "15 left".

**Fix:** Added `partnerAtLimit` (true when the other user's message count ≥ msgLimit at stage 0). Added `effectiveIsLimitReached = isLimitReached || partnerAtLimit || (callStage===0 && firstCallPromptSeen)`. Used `effectiveIsLimitReached` everywhere instead of `isLimitReached` for the gate condition and status label.

**Why:** The match is at FIRST_CALL_GATE as a whole, not per-user. Either user hitting the limit OR the Spec-3 `firstCallPromptSeen` flag (pressed Continue in matches.tsx) constitutes the gate state.

### Bug 3: `callStage ?? 0` regression during refetch
`const callStage = matchDetail?.callStage ?? 0` — when `matchDetail` is null/stale during a refetch triggered by decline/cancel, callStage falls to 0, showing Stage-1 behavior temporarily.

**Fix:** Added `lastKnownStageRef = useRef<number | null>(null)` and monotonic guard: `lastKnownStageRef.current = Math.max(prev, serverCallStage)`. `callStage = lastKnownStageRef.current ?? serverCallStage ?? 0` never decreases.

## DB State of Affected Match

`id: 5efddfde-09b2-4b28-8007-ac633382f0f6`
- `call_stage = 0` ✓ (correct — declined call must NOT advance stage)
- `message_count_1 = 15` ✓ (user1 used all messages)
- `message_count_2 = 0` ✓ (user2 hadn't sent in this stage)
- `call_avail_1 = NULL`, `call_avail_2 = NULL` (never set — old pre-Spec-3 flow)
- No DB repair needed; issue was purely client-side rendering.

## `cancelCall` in storage.ts

Only clears: `call_started_at`, `call_initiator_id`, `call_answered`, `call_completed`. Does NOT touch `call_stage`, `message_count_1/2`, `call_avail_1/2`. Safe.

## Added Logging

`[PROGRESSION_RENDER]` useEffect logs full state on every gate-relevant change:
`serverCallStage`, `callStage`, `lastKnownStage`, `isLimitReached`, `partnerAtLimit`, `firstCallPromptSeen`, `effectiveIsLimitReached`, `isDeclinedSession`, `messagesRemaining`, `callGateRendered`, `composerRendered`, `reason`.
