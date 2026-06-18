export const GUIDE_KEYS = {
  WELCOME:                  "welcome",
  DISCOVER_OPEN:            "discover_open",
  DISCOVER_CLOSE:           "discover_close",
  DISCOVER_UNDO:            "discover_undo",
  CONNECTIONS_FIRST_MATCH:  "connections_first_match",
  CHAT_FIRST_MESSAGE:       "chat_first_message",
  CALLS_FIRST_PHONE:        "calls_first_phone",
  CALLS_FIRST_VIDEO:        "calls_first_video",
  WHEEL_ENTRY:              "wheel_entry",
  ELEVATE_SCREEN:           "elevate_screen",
  MEMBERSHIP_VIEW:          "membership_view",
} as const;

export type GuideKey = typeof GUIDE_KEYS[keyof typeof GUIDE_KEYS];

const storageKey = (userId: string) => `lulou_guides_${userId}`;

type GuideRecord = { seen: boolean; seenAt: string };
type GuideMap = Partial<Record<string, GuideRecord>>;

function readMap(userId: string): GuideMap {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? (JSON.parse(raw) as GuideMap) : {};
  } catch { return {}; }
}

function writeMap(userId: string, map: GuideMap): void {
  try { localStorage.setItem(storageKey(userId), JSON.stringify(map)); } catch {}
}

export function isGuideSeen(userId: string | undefined, key: string): boolean {
  if (!userId) return false;
  return readMap(userId)[key]?.seen === true;
}

export function markGuideSeen(userId: string | undefined, key: string): void {
  if (!userId) return;
  const map = readMap(userId);
  map[key] = { seen: true, seenAt: new Date().toISOString() };
  writeMap(userId, map);
}

export function resetGuide(userId: string | undefined, key: string): void {
  if (!userId) return;
  const map = readMap(userId);
  delete map[key];
  writeMap(userId, map);
}

export function resetAllGuides(userId: string | undefined): void {
  if (!userId) return;
  writeMap(userId, {});
}

export function getSeenGuides(userId: string | undefined): Set<string> {
  if (!userId) return new Set();
  const map = readMap(userId);
  return new Set(
    Object.entries(map)
      .filter(([, v]) => v?.seen)
      .map(([k]) => k),
  );
}
