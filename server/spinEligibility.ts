export const DAILY_ELIGIBLE_LIKE_GOAL = 10;

export function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function utcWeekStartKey(now = new Date()): string {
  const date = new Date(`${utcDateKey(now)}T00:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return utcDateKey(date);
}

export function getFreeSpinEntitlementKey(dailyEligibleLikes: number, now = new Date()): string {
  return dailyEligibleLikes >= DAILY_ELIGIBLE_LIKE_GOAL
    ? `daily:${utcDateKey(now)}`
    : `weekly:${utcWeekStartKey(now)}`;
}

export function isDailySpinEntitlement(dailyEligibleLikes: number): boolean {
  return dailyEligibleLikes >= DAILY_ELIGIBLE_LIKE_GOAL;
}