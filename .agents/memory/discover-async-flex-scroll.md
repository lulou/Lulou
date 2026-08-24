---
name: Discover async flex scroll
description: WebKit can retain a skeleton-sized flex child after asynchronous Discover profile content mounts.
---

The loaded Discover content root must be a natural-height, non-flexing child of
the app shell's single scrolling region (`flex: 0 0 auto`). Do not make it
`flex: 1` again.

**Why:** On iOS/WebKit, a nested overflow flex container can preserve the
initial short loading allocation when a tall profile replaces its skeleton. The
lower profile then appears visually but does not extend the owner's scroll
range until another layout event occurs.

**How to apply:** Keep the shell as the sole vertical scroll owner. For
asynchronously expanding Discover content, let the direct child size to its
complete natural height and test the skeleton-to-profile scroll-range
lifecycle, rather than adding nested scrollbars, delays, or gesture overrides.