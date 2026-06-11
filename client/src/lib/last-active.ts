export function formatLastActive(
  lastActive: Date | string | null | undefined,
  showLastActive: boolean,
): string | null {
  if (!showLastActive || !lastActive) return null;
  const d = typeof lastActive === "string" ? new Date(lastActive) : lastActive;
  if (isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 2) return "Active now";
  if (diffMin < 60) return `Active ${diffMin}m ago`;
  if (diffHr < 24) return `Active ${diffHr}h ago`;
  if (diffDay === 1) return "Active yesterday";
  if (diffDay < 7) return `Active ${diffDay}d ago`;
  return null;
}
