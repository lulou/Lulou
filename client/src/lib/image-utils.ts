/**
 * Shared image utilities used by every photo-rendering component.
 *
 * Module-level singletons survive route changes and component unmounts,
 * so a photo decoded on Discovery is instantly visible on Likes / Profile
 * without a second decode pass.
 */

/**
 * URLs that the browser has already decoded into a bitmap this session.
 * Components should render already-decoded images at opacity 1 immediately
 * (skip the fade-in delay).  After decoding, `onLoad` should add the URL here.
 */
export const decodedPhotos = new Set<string>();

/**
 * Returns a Supabase Storage image-transform URL with width and quality params.
 * All other URL types (base64 data URIs, external URLs) are returned unchanged.
 * Idempotent — won't add params if a `width` param already exists.
 *
 * @param url     Raw photo URL from the database
 * @param width   Target pixel width (default 600 for profile cards)
 * @param quality JPEG quality 0-100 (default 75)
 */
export function getOptimizedImageUrl(url: string, width = 600, quality = 75): string {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.pathname.includes("/storage/v1/object/public/")) return url;
  if (parsed.searchParams.has("width")) return url;
  parsed.searchParams.set("width", String(width));
  if (!parsed.searchParams.has("quality")) parsed.searchParams.set("quality", String(quality));
  return parsed.toString();
}

/**
 * Fire-and-forget background preload.
 * Creates a hidden Image element so the browser decodes the photo into its
 * bitmap cache before any visible <img> element requests it.  Subsequent
 * renders with the same src are served from cache with zero network cost.
 *
 * Safe to call multiple times — skips URLs already in decodedPhotos.
 */
export function preloadPhoto(src: string): void {
  if (!src || decodedPhotos.has(src)) return;
  const img = new Image();
  img.onload = () => decodedPhotos.add(src);
  img.src = src;
}
