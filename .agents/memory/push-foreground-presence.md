---
name: Push foreground presence
description: Why message-push suppression must use explicit page visibility rather than authentication activity.
---

Message push suppression must rely on a short-lived foreground-presence lease that is refreshed only while the document is visible and cleared on visibility change or page hide. Authentication/session heartbeats must not be used as proof that the app is foregrounded.

**Why:** Browser and installed-PWA authentication heartbeats can remain fresh after the app is backgrounded. Treating them as foreground activity suppresses legitimate background notifications.

**How to apply:** Keep exact-chat presence separate from general foreground presence. Suppress a system notification only when exact-chat or visible-app presence is currently fresh; let missing teardown requests expire through a short server freshness window.