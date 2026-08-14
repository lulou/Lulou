---
name: SpinRoom proven production bugs
description: Root causes confirmed by Railway telemetry from real iPhone spins; fixes applied.
---

## React error #31 — object {key,text} in a <p>

**Rule:** `dnaReasonsData?.reasons?.[0]` is typed `string` but arrives from
`/api/dna/reasons/:id` as a `{key,text}` object at runtime.  Always extract via
`renderText(reasons[0] as unknown) || t('spin_room_compat_fallback')` — never
render it directly.

**Why:** The server's `generateReasons()` may return structured objects.  The
TypeScript type `{ reasons: string[] }` is wrong at runtime.

**How to apply:** Any new code that reads `dnaReasonsData.reasons[n]` must pass
through `renderText()` before rendering.

---

## Photo jump — FLIP handoff at 'pause' phase

**Rule:** The orbit carousel parent has `transition: opacity 1.4s` to 0 at
'reveal'.  By 'pause' (+2 300 ms) the orbit card is visually gone but still in
DOM.  The full-size photo wrapper must read the orbit card's
`getBoundingClientRect()` inside a `useLayoutEffect` on `spinRoomPhase==='pause'`,
apply an initial FLIP transform (translate+scale to match card viewport rect),
then animate to `translate(0,0) scale(1)` via a CSS transition on the next two
rAFs.  The `srWinnerIn` CSS keyframe must NOT be on the wrapper.

**Why:** Previously, a new full-size photo appeared at large size with a keyframe
animation — no visual continuity from the orbit card.

**How to apply:** `winnerPhotoWrapperRef` ref + `useLayoutEffect` on 'pause' +
no animation on the JSX wrapper div.  `pendingWinnerRef.current.index` gives the
winner slot for `orbitCardRefs.current[winnerIdx]`.

---

## Retry Result 401 — bare fetch omits auth headers

**Rule:** `onReset` in IntentResultBoundary must use `apiRequest('GET', '/api/spin/result')`
not `fetch(API_BASE + '/api/spin/result', { credentials:'include' })`.

**Why:** `isAuthenticated` middleware checks the `Authorization` header (Supabase
JWT) and `X-Session-Id` header.  `credentials:'include'` only sends cookies; it
does NOT add the Authorization or X-Session-Id headers that `apiRequest()` builds
via `getAuthHeaders()` + `getAppSessionId()`.  Result: 401 hasAuthHeader=false.

**How to apply:** Any authenticated GET inside intent.tsx that previously used bare
fetch must be replaced with `apiRequest`.  `apiRequest` prepends `API_BASE`
internally — pass a plain `/api/…` path.

---

## Text words invisible — under investigation

**Status:** text_3 milestone fires at 6200 ms (confirmed by Railway), so timer
reaches all milestones.  The [INTENTION_WHEEL_WINNER_NODE] winner_node Railway
transport (added in commit 16a5dbd) captures `textOpacity`, `textDisplay`,
`textVisibility`, `ancestorHidesText` at each checkpoint.  Next iPhone spin will
confirm root cause.  DO NOT change `animation: "srTextIn 0.6s ease both"` timings
until winner_node logs are reviewed.
