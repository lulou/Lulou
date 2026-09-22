/** True only when an opted-in target was active on the viewer's local day. */
export function isActiveToday(
  lastActive: Date | string | null | undefined,
  showLastActive: boolean,
  now = new Date(),
): boolean {
  if (!showLastActive || !lastActive) return false;
  const active = typeof lastActive === "string" ? new Date(lastActive) : lastActive;
  if (Number.isNaN(active.getTime())) return false;
  return active.getFullYear() === now.getFullYear()
    && active.getMonth() === now.getMonth()
    && active.getDate() === now.getDate();
}
