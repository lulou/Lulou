---
name: forcedIncomingMatch missing guards
description: App.tsx forcedIncomingMatch scan was missing dismissedCallKey and callInitiatorId checks, causing dismissed calls to re-appear as random incoming calls.
---

## The Rule
`forcedIncomingMatch` in `App.tsx` (inside the JSX render, gated by `startupVerified`) MUST include ALL the same guards as the `incomingCall` memo. Missing any guard creates a bypass.

## The Bug
`forcedIncomingMatch` was intentionally created as a "stronger" check that ignores derived memo outputs. It had most guards (`isArmedSession`, `!isCallSessionCancelled`, `!isEndedCall`, `!isStaleCall`) but was MISSING:
1. `!!m.callInitiatorId` — required by `incomingCall` but not `forcedIncomingMatch`
2. `dismissedCallKey` check — `incomingCall` memo respects the user's Decline action; `forcedIncomingMatch` ignored it

## The Symptom
- User presses Decline on an incoming call
- `handleDismiss` sets `dismissedCallKey = "${matchId}:${sessionId}"`
- `incomingCall` memo returns null (checks `dismissedCallKey`) ✓
- `forcedIncomingMatch` re-runs, finds the match still armed, bypasses `dismissedCallKey` → renders `IncomingCallOverlay` again
- User sees incoming call overlay reappear immediately after dismissing — looks like a "random" incoming call

## The Fix
```js
const forcedIncomingMatch = (matches ?? []).find(m =>
  !!m.callStartedAt &&
  !!m.callInitiatorId &&            // ← ADDED
  m.callCompleted !== true &&
  m.callInitiatorId !== userId &&
  m.callAnswered !== true &&
  !!m.callSessionId &&
  isArmedSession(m.callSessionId) &&
  !isCallSessionCancelled(m.id, m.callSessionId) &&
  !isEndedCall(m) &&
  !isStaleCall(m) &&
  `${m.id}:${m.callSessionId}` !== dismissedCallKey  // ← ADDED
) ?? null;
```

**Why:** `dismissedCallKey` is local state in `CallDetectors`; it's captured in the render closure and available inside the JSX IIFE. Adding it here makes `forcedIncomingMatch` fully consistent with `incomingCall`.

**How to apply:** Whenever the `incomingCall` memo gains new guard conditions, audit `forcedIncomingMatch` to ensure it has the same conditions.
