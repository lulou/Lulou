/**
 * Photo pipeline utilities.
 *
 * ## Compression
 * `convertPhotoToJpeg` and `recompressPhotoDataUrl` run a canvas resize + JPEG
 * encode pipeline and return a base64 data URL.  New photos are uploaded to
 * Storage, so the image can retain enough detail for a Retina Discover hero;
 * base64 remains a compatibility fallback only.
 *
 * ## Storage upload (new photos)
 * `uploadPhotoToStorage` converts an already-compressed base64 data URL to a
 * Blob and uploads it to the "profile-photos" Supabase Storage bucket, then
 * returns the permanent public HTTPS URL.  Storing a short URL instead of a
 * 150 KB base64 string removes the photos column from the query hot-path
 * entirely and allows the browser to HTTP-cache the images between sessions.
 *
 * The upload happens at save time (not selection time) so the existing
 * selection preview UX is completely unchanged.
 *
 * ## Backwards compatibility
 * Existing profiles still carry base64 strings (data:image/jpeg;base64,…).
 * All rendering components accept both formats — `<img src>` handles both
 * natively and the decodedPhotos bitmap cache in image-utils.ts is keyed on
 * the exact src string, so it works for both.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// A Discover hero displays at roughly 390 CSS pixels on a modern iPhone.
// 1600px keeps 3× screens sharp without asking the browser to upscale a tiny
// thumbnail. The Storage URL is the normal persisted form, so this does not
// inflate the profile-list query (which deliberately omits `photos`).
const MAX_DIM         = 1600;
const QUALITY_INITIAL = 0.82;
const TARGET_BYTES    = 450_000; // high-quality Storage upload; base64 is fallback only
const MAX_PASSES      = 4;

/** Photos larger than this string length may cause DB statement timeouts. */
export const OVERSIZED_THRESHOLD = 400_000;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Convert a base64 data URL to a Blob without re-encoding through canvas. */
function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(",");
  const header   = dataUrl.slice(0, commaIdx);
  const base64   = dataUrl.slice(commaIdx + 1);
  const mime     = header.match(/:(.*?);/)?.[1] ?? "image/jpeg";
  const bytes    = atob(base64);
  const buf      = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Converts a File to a compressed JPEG data URL (base64).
 * Used for the photo selection preview and as a fallback if Storage upload fails.
 */
export async function convertPhotoToJpeg(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(file);
    const img    = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objUrl);

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
      if (!ctx) { reject(new Error("Could not create canvas context.")); return; }

      ctx.drawImage(img, 0, 0, width, height);

      let quality = QUALITY_INITIAL;
      let jpeg    = canvas.toDataURL("image/jpeg", quality);
      if (!jpeg || jpeg === "data:,") { reject(new Error("Could not convert image. Please try a different photo.")); return; }

      for (let pass = 0; pass < MAX_PASSES && jpeg.length > TARGET_BYTES; pass++) {
        quality = Math.max(quality - 0.10, 0.40);
        jpeg    = canvas.toDataURL("image/jpeg", quality);
      }

      console.log(`[PHOTO_CONVERT] ${file.name} → ${width}×${height}px, q=${quality.toFixed(2)}, ${(jpeg.length / 1024).toFixed(0)} KB base64`);
      resolve(jpeg);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      const isHeic =
        file.type === "image/heic" ||
        file.type === "image/heif" ||
        file.name.toLowerCase().endsWith(".heic") ||
        file.name.toLowerCase().endsWith(".heif");
      reject(new Error(
        isHeic
          ? "HEIC photos can't be used in this browser. Please export as JPEG or PNG from your camera roll and try again."
          : "Could not load this photo. Please try a different image."
      ));
    };

    img.src = objUrl;
  });
}

/**
 * Re-compresses an existing base64 JPEG data URL through the canvas pipeline.
 * Used to shrink oversized photos already stored in the database that would
 * cause Supabase statement timeouts when read back.
 * Never throws — returns the original if canvas is unavailable.
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

      console.log(`[PHOTO_RECOMPRESS] ${width}×${height}px, q=${quality.toFixed(2)}, ${(jpeg.length / 1024).toFixed(0)} KB (was ${(dataUrl.length / 1024).toFixed(0)} KB)`);
      resolve(jpeg);
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * Uploads an already-compressed base64 JPEG data URL to the "profile-photos"
 * Supabase Storage bucket and returns the permanent public HTTPS URL.
 *
 * File path: `{userId}/{timestamp}_{random6}.jpg`
 * Matches the RLS INSERT policy: `(storage.foldername(name))[1] = auth.uid()::text`
 *
 * @throws if the upload fails — caller should fall back to storing the base64.
 */
export async function uploadPhotoToStorage(
  dataUrl: string,
  userId: string,
  supabaseClient: SupabaseClient,
): Promise<string> {
  const blob   = dataUrlToBlob(dataUrl);
  const random = Math.random().toString(36).slice(2, 8);
  const path   = `${userId}/${Date.now()}_${random}.jpg`;

  const { error } = await supabaseClient.storage
    .from("profile-photos")
    .upload(path, blob, { contentType: "image/jpeg", upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: { publicUrl } } = supabaseClient.storage
    .from("profile-photos")
    .getPublicUrl(path);

  console.log(`[PHOTO_UPLOAD] ${(blob.size / 1024).toFixed(0)} KB → ${publicUrl.split("?")[0].slice(-50)}`);
  return publicUrl;
}
