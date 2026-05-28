---
name: Safari keyframe crash pattern
description: Safari/WebKit crashes when inline animation styles reference @keyframes that are injected via useEffect — keyframes must exist before the element renders.
---

## Rule
Never use `useEffect` to inject `@keyframes` CSS when those keyframes are already referenced in inline `animation:` style props on rendered elements. Inject at module scope instead.

**Why:** React's `useEffect` runs *after* the browser paint commit. During that first paint, Safari's WebKit animation engine encounters an inline `animation: keyframeName ...` style, looks up `keyframeName` in the CSSOM, finds nothing, and in some WebKit versions this triggers an unhandled exception that propagates as a JavaScript error — caught by React's error boundary as a page crash. Chrome/desktop is more lenient and silently skips missing keyframes.

**How to apply:**
```ts
// At module scope (top of the file, outside any component):
if (typeof document !== "undefined") {
  const id = "my-keyframe-style";
  if (!document.getElementById(id)) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `@keyframes myAnim { ... }`;
    document.head.appendChild(s);
  }
}
```

**Also:** avoid inline JSX `<style>` elements (rendered in body) that define keyframes used by sibling elements higher in the same JSX tree — the `<style>` element is appended to the DOM after its siblings, creating the same missing-keyframe window in Safari.

**Fixed in:** `client/src/components/elevate-status-card.tsx` (glow-pulse + shimmer keyframes) and `client/src/pages/likes.tsx` (matchFloat keyframe).
