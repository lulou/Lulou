/**
 * Converts any browser-supported image to a JPEG data URL.
 * - Resizes to max 1200×1600px (preserves aspect ratio) to keep stored size small
 * - Compresses at 0.82 quality — looks great, typically 100-300 KB per photo
 * - HEIC/HEIF files are supported on Safari/iOS (which can natively decode them).
 *   On Chrome/Firefox, HEIC files are rejected with a clear error so users can
 *   re-select in JPEG/PNG format instead of silently storing a broken image.
 *
 * Returns: base64 data URL string  (data:image/jpeg;base64,...)
 * Throws:  Error with user-friendly message if the file cannot be loaded/converted
 */
export async function convertPhotoToJpeg(file: File, maxDim = 1200): Promise<string> {
  const MAX_JPEG_QUALITY = 0.82;

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;

      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not create canvas context."));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      const jpeg = canvas.toDataURL("image/jpeg", MAX_JPEG_QUALITY);
      if (!jpeg || jpeg === "data:,") {
        reject(new Error("Could not convert image. Please try a different photo."));
        return;
      }

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
