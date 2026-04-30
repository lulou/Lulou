/**
 * Shared image utilities used by every photo-rendering component.
 *
 * ## Storage format
 * Photos are stored as `data:image/jpeg;base64,…` strings in PostgreSQL
 * OR as short Supabase Storage URLs after migration.
 * Client-side compression in `photo-utils.ts` caps uploads at ≤ 150 KB.
 *
 * ## Module-level singletons
 * All exports survive route changes because they live at module scope.
 * A photo decoded on Discovery is immediately visible on Likes / Matches
 * without a second decode pass.
 *
 * ## Performance design
 * `decodedPhotos.has(url)` is called INLINE in JSX style props on every render.
 * For a 150 KB base64 string, a naive Set<string> would hash all 150 K characters
 * each call.  We fingerprint long strings down to a short key so every lookup
 * is O(1) regardless of photo format (base64 or Storage URL).
 *
 * ## Cache limits
 * Both the decoded-set and the in-flight-set are capped so they never grow
 * without bound across a long session.
 */

const MAX_DECODED = 200;   // keep at most 200 decoded-photo fingerprints
const MAX_LOADING = 50;    // never allow more than 50 concurrent preloads

/** Internal FIFO set of fingerprints for fully-decoded photos. */
const DECODED_SET = new Set<string>();

/** Internal set of fingerprints for images currently preloading. */
const LOADING_SET = new Set<string>();

/**
 * Produce a short, stable fingerprint for any photo URL.
 *
 * • Storage URLs  (~80 chars): used as-is — already O(1) to hash.
 * • Base64 data-URLs (~200 K chars): `length:tail32`.
 *   Two base64 images of different content almost always differ in length
 *   OR in the last 32 characters, making collisions astronomically unlikely.
 */
function fp(src: string): string {
  return src.length > 200
    ? `${src.length}:${src.slice(-32)}`
    : src;
}

/**
 * Add a fingerprint to DECODED_SET, evicting the oldest 50 entries when full.
 * Eviction uses Set's guaranteed insertion-order iteration (FIFO).
 */
function addDecoded(src: string): void {
  if (DECODED_SET.size >= MAX_DECODED) {
    const iter = DECODED_SET.values();
    for (let i = 0; i < 50; i++) {
      const entry = iter.next();
      if (entry.done) break;
      DECODED_SET.delete(entry.value);
    }
  }
  DECODED_SET.add(fp(src));
}

/**
 * Duck-typed Set interface exported for backward compatibility.
 * All existing `decodedPhotos.has(url)` and `decodedPhotos.add(url)` call
 * sites continue to work without modification; internally the lookup uses
 * the short fingerprint, not the full base64 string.
 *
 * `.has(src)` → O(1): hashes only the 32-char fingerprint tail.
 * `.add(src)` → O(1): same.
 */
export const decodedPhotos: { has: (src: string) => boolean; add: (src: string) => void } = {
  has: (src: string) => DECODED_SET.has(fp(src)),
  add: (src: string) => addDecoded(src),
};

/**
 * Stable empty array to use instead of `[]` literal when no photos are loaded.
 * Passing the same reference keeps useEffect / useMemo dependency arrays stable
 * so they don't re-run on every render while photos are still loading.
 */
export const EMPTY_PHOTOS: string[] = [];

/**
 * Fire-and-forget background image preload.
 *
 * Creates a hidden Image element so the browser decodes the photo into its
 * bitmap cache before any visible <img> element requests it.
 *
 * Guarantees:
 *   • Skips URLs already decoded  (DECODED_SET check).
 *   • Skips URLs already in-flight (LOADING_SET check) — no duplicate Images.
 *   • Cleans up onload/onerror references after completion.
 *   • Caps concurrent preloads at MAX_LOADING so a large list never floods
 *     the browser's network/decode queue.
 */
export function preloadPhoto(src: string): void {
  if (!src) return;
  const key = fp(src);
  if (DECODED_SET.has(key) || LOADING_SET.has(key)) return;
  if (LOADING_SET.size >= MAX_LOADING) return; // shed load when queue is full

  LOADING_SET.add(key);
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    img.onload = null;
    img.onerror = null;
    LOADING_SET.delete(key);
    addDecoded(src);
  };
  img.onerror = () => {
    img.onload = null;
    img.onerror = null;
    LOADING_SET.delete(key);
    // Do NOT add to DECODED_SET — failed images should retry on next render
  };
  img.src = src;
}
