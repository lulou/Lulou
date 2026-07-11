---
name: iOS PWA push safeOptions
description: What properties are safe to pass to showNotification() for iOS 16.4-17.x PWA push notifications.
---

## The Rule

Tier-1 `showNotification(title, options)` must use **only** `{ body, tag }`.

**Why:** On iOS 16.4-17.x, any additional property in the options dict — including `data`, `icon`, `badge`, `requireInteraction`, `vibrate` — can cause `showNotification` to resolve without actually displaying. iOS falls back silently to "AppName — Notification" instead of showing the notification content. The failure is silent (no throw, no error).

## How to Apply

In `client/public/sw.js`, the tier-1 safeOptions block is:
```js
const safeOptions = {
  body,   // required — the notification text
  tag,    // for deduplication; also used for URL reconstruction in notificationclick
};
```

For Chrome/Android, the enhanced options with `data`, `icon`, `badge`, `vibrate` are used in tier-2 (the `await self.registration.showNotification(title, enhancedOptions)` fallback).

## URL Reconstruction from Tag

Since `data.url` is absent in tier-1 notifications, `notificationclick` must reconstruct the navigation URL from `event.notification.tag`:

```js
const data = event.notification.data || {};
const tag  = event.notification.tag || "";
let url = data.url;
if (!url) {
  if (tag.startsWith("call_"))        url = "/messages/" + tag.slice(5);
  else if (tag.startsWith("msg_"))    url = "/messages/" + tag.slice(4);
  else if (tag.startsWith("missed_")) url = "/messages/" + tag.slice(7);
  else                                url = "/";
}
```

## SW Version Bump

Whenever safeOptions changes, bump `SW_VERSION` (currently `"3.2"`) so iOS re-downloads the service worker.
