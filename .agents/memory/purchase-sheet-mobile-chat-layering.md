---
name: Purchase sheet above mobile chat
description: Layering requirement for portalled purchase sheets opened from the fixed mobile chat surface.
---

Portalled purchase overlays and content must use a z-index higher than the fixed mobile chat shell. A successfully mounted sheet at the shared default dialog layer can remain hidden behind that shell.

**Why:** A real installed-iPhone tap reached the Video Unlock handler and changed prompt state, but the purchase sheet was behind the mobile chat surface because the chat shell used a much higher stacking layer than the shared sheet defaults.

**How to apply:** When opening a modal or sheet from the expanded mobile chat, compare both the portal overlay and content layers against the chat shell. Verify the result from a real installed device; bundle text and React state alone do not prove visibility.