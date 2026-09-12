const NON_PROFILE_FILENAMES =
  /^(placeholder|default[-_]?(avatar|profile)|app[-_]?icon|lulou[-_]?logo)(?:[-_.]|$)/;

export function isUsableProfilePhotoUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url || url === "null" || url === "undefined") return false;

  const lower = url.toLowerCase();
  if (lower.startsWith("data:image/heic") || lower.startsWith("data:image/heif")) return false;
  if (lower.startsWith("data:image/svg") || lower.startsWith("data:image/x-icon")) return false;
  if (lower.startsWith("data:image/")) return true;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const pathname = parsed.pathname.toLowerCase();
    const filename = pathname.split("/").filter(Boolean).at(-1) ?? "";
    if (NON_PROFILE_FILENAMES.test(filename)) return false;
    if (pathname.split("/").includes("icons")) return false;
    if (/\.(heic|heif|svg|ico)$/.test(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function getUsableProfilePhotos(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(isUsableProfilePhotoUrl).map(url => url.trim()))];
}