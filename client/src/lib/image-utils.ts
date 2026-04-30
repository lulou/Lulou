/**
 * Shared image utilities used by every photo-rendering component.
 *
 * ## Storage format
 * Every photo in Lulou is stored as a `data:image/jpeg;base64,…` string directly
 * in a PostgreSQL text[] column.  Photos are NOT uploaded to Supabase Storage, so
 * Supabase Storage image-transform query params (?width=…&quality=…) do not apply
 * and are never added.  Client-side compression happens at upload time in
 * `photo-utils.ts` (max 800×800 px, ≤ 150 KB JPEG).
 *
 * ## Module-level singletons
 * Both exports survive route changes and component unmounts because they live at
 * module scope (not inside a React component).  A photo decoded on Discovery is
 * immediately visible on Likes / Matches without a second decode pass.
 */

/**
 * URLs that the browser has already decoded into a bitmap this session.
 * Components should render already-decoded images at opacity 1 immediately
 * (skip the fade-in delay).  After decoding, `onLoad` should add the URL here.
 */
export const decodedPhotos = new Set<string>();

/**
 * Fire-and-forget background preload.
 * Creates a hidden Image element so the browser decodes the photo into its
 * bitmap cache before any visible <img> element requests it.  Subsequent
 * renders with the same src hit the cache with zero additional decode cost.
 *
 * Safe to call multiple times — skips URLs already in decodedPhotos.
 */
export function preloadPhoto(src: string): void {
  if (!src || decodedPhotos.has(src)) return;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => decodedPhotos.add(src);
  img.src = src;
}
