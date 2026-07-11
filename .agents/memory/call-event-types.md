---
name: Call event type naming and display
description: The three call event types stored in __CALL_EVENT__ messages and how they should be displayed perspective-aware.
---

## Event Types (server/routes.ts)

| type | when created | senderId |
|------|-------------|----------|
| `cancelled` | Caller pressed cancel while ringing (before callee answered) | callerId |
| `declined` | Callee pressed Decline | callerId |
| `ended` | Call completed normally (either side hung up) | callerId |

**Note:** Before this fix, `cancelled` was stored as `"missed"`. Old DB rows may still have `type:"missed"` — treat it identically to `"cancelled"` everywhere.

## Perspective-Aware Display

`msg.senderId === callerId`, so `isMe = (msg.senderId === user.id)` means "I was the caller".

| type | isMe (I was caller) | !isMe (Other was caller) |
|------|---------------------|--------------------------|
| `cancelled` / `missed` | "📞 You called {match.profile.firstName}" | "📞 Missed call from {ev.callerName}" |
| `declined` | "📞 Call declined" | "📞 Call declined" |
| `ended` | "📞 Call ended" | "📞 Call ended" |

## In-Chat Rendering (matches.tsx, messaging.tsx)

Both components use the perspective-aware table above. In `messaging.tsx`, the other person's name comes from `matchDetail?.profile?.firstName` (fallback to `ev.callerName`).

## Conversation Preview (renderMatchPreview in matches.tsx)

The standalone `renderMatchPreview()` helper takes `msg`, `userId`, `otherFirstName`, and `t`. For call events it applies `isMe` logic. For all other content types it delegates to `renderMessageContent()` with the `you_label` prefix.

## Why Not renderMessageContent for Preview

`renderMessageContent()` has no `isMe` or `otherFirstName` context, so it can only return a generic "📞 Missed call". The MatchCard preview needs perspective-aware text.
