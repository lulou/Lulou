---
name: i18n variable shadowing
description: Using t() from useLanguageContext in components that already use `const t` as a timeout/RAF handle inside useEffect.
---

When wiring `const { t } = useLanguageContext()` into a component, check for any local `const t = setTimeout(...)` or `const t = requestAnimationFrame(...)` assignments inside useEffect hooks — they shadow the outer `t` and TypeScript will warn. Rename the local vars (e.g., `timerId`, `rafId`) before adding the i18n hook.

**Why:** Happened in `likes.tsx` (MatchOverlay had `const t = setTimeout` × 2, ProfileModal had `const t = requestAnimationFrame`) when i18n hook was added.

**How to apply:** Before adding `useLanguageContext()` to any component, grep for `const t =` inside that file.
