---
name: PWA blank-screen prevention
description: Why installed Safari needs a visible, timed pre-React recovery path in addition to React error boundaries.
---

The initial HTML must provide a visible boot surface and bounded recovery before
the application module executes. Do not rely only on React boundaries or global
`error` / `unhandledrejection` events.

**Why:** An installed iOS PWA can fail or stall while loading an entry module
graph from an older document after deployment. Safari does not reliably surface
that failure to page-level handlers, so an empty React root can remain white
forever. Missing frontend configuration can also throw before React mounts.

**How to apply:** Keep navigation and API responses network-authoritative. On a
pre-React stall or same-origin startup-asset error, update the worker, clear only
app-owned versioned caches, and perform one cache-busted reload. Guard against
reload loops; after the one attempt, show a recovery action without clearing
auth, preferences, or unrelated storage. Reset the guard only after React
actually replaces the initial shell.