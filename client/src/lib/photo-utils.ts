/**
 * Converts any browser-supported image to a JPEG data URL.
 *
 * Target: ≤ 150 KB per photo so base64 strings stored in Supabase stay small enough
 * for the photos-column SELECT query to complete well within the 8-second statement
 * timeout. Larger files caused query timeouts (code 57014) for some users.
 *
 * Strategy:
 *  1. Resize to fit within MAX_DIM × MAX_DIM (preserves aspect ratio).
 *  2. Encode at QUALITY_INITIAL. If the result is still over TARGET_BYTES, shrink by
 *     10 % and re-encode up to MAX_PASSES times until it fits (or we give up).
 *
 * HEIC/HEIF:
 *  - Safari / iOS can natively decode HEIC — conversion works fine there.
 *  - Chrome / Firefox cannot — the image fires onerror and we reject with a clear
 *    user-friendly message so they can re-select in JPEG/PNG format.
 *
 * Returns: base64 data URL string  (data:image/jpeg;base64,...)
 * Throws:  Error with user-friendly message if the file cannot be loaded/converted.
 */

const MAX_DIM         = 800;     // px — keeps base64 under ~150 KB for typical photos
const QUALITY_INITIAL = 0.72;   // JPEG quality for first attempt
const TARGET_BYTES    = 150_000; // ~112 KB base64 when expressed as string length
const MAX_PASSES      = 4;       // re-encode attempts before giving up on size reduction

/** Photos larger than this string length are large enough to cause DB statement timeouts. */
export const OVERSIZED_THRESHOLD = 400_000; // ~300 KB base64

export async function convertPhotoToJpeg(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;

      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width  = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not create canvas context."));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      let quality = QUALITY_INITIAL;
      let jpeg    = canvas.toDataURL("image/jpeg", quality);

      if (!jpeg || jpeg === "data:,") {
        reject(new Error("Could not convert image. Please try a different photo."));
        return;
      }

      // Iteratively reduce quality until the data URL fits within TARGET_BYTES.
      for (let pass = 0; pass < MAX_PASSES && jpeg.length > TARGET_BYTES; pass++) {
        quality = Math.max(quality - 0.10, 0.40);
        jpeg    = canvas.toDataURL("image/jpeg", quality);
      }

      console.log(
        `[PHOTO_CONVERT] ${file.name} → ${width}×${height}px, q=${quality.toFixed(2)}, ` +
        `${(jpeg.length / 1024).toFixed(0)} KB base64`
      );

      resolve(jpeg);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      const isHeic =
        file.type === "image/heic" ||
        file.type === "image/heif" ||
        file.name.toLowerCase().endsWith(".heic") ||
        file.name.toLowerCase().endsWith(".heif");
      if (isHeic) {
        reject(
          new Error(
            "HEIC photos can't be used in this browser. Please export as JPEG or PNG from your camera roll and try again."
          )
        );
      } else {
        reject(new Error("Could not load this photo. Please try a different image."));
      }
    };

    img.src = url;
  });
}

/**
 * Re-compresses an existing base64 JPEG data URL through the same canvas pipeline.
 * Used to shrink oversized photos already stored in the database that would cause
 * Supabase statement timeouts when read back.
 *
 * Returns the (possibly smaller) data URL. Never throws — returns the original if
 * canvas is unavailable so we don't break the editing flow.
 */
export async function recompressPhotoDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      let { width, height } = img;

      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width  = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(dataUrl); return; }

      ctx.drawImage(img, 0, 0, width, height);

      let quality = QUALITY_INITIAL;
      let jpeg    = canvas.toDataURL("image/jpeg", quality);

      for (let pass = 0; pass < MAX_PASSES && jpeg.length > TARGET_BYTES; pass++) {
        quality = Math.max(quality - 0.10, 0.40);
        jpeg    = canvas.toDataURL("image/jpeg", quality);
      }

      console.log(
        `[PHOTO_RECOMPRESS] ${width}×${height}px, q=${quality.toFixed(2)}, ` +
        `${(jpeg.length / 1024).toFixed(0)} KB base64 (was ${(dataUrl.length / 1024).toFixed(0)} KB)`
      );

      resolve(jpeg);
    };

    img.onerror = () => resolve(dataUrl); // fall back to original if load fails

    img.src = dataUrl;
  });
}
