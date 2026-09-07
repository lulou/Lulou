---
name: Installed PWA deployment verification
description: How to distinguish a UI implementation failure from an undeployed or stale installed-PWA bundle
---

Do not treat a local frontend commit as visible in an installed PWA. Confirm the commit reached `origin/main`, production HTML references a new hashed app bundle, and `/sw.js` reports that same commit before judging device behavior.

**Why:** Two correct local availability-selection changes appeared to have no effect because neither commit had been pushed; production and the installed iPhone still served an older commit.

**How to apply:** For installed-PWA regressions, verify all three versions explicitly after pushing. The service worker should be commit-qualified and served with no-store headers so reopening the PWA can activate the new build.