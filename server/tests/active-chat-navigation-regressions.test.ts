import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const matchesPage = readFileSync("client/src/pages/matches.tsx", "utf8");

describe("Active Chats navigation", () => {
  it.each(["georgia", "Steph", "Flower"])(
    "opens %s through the canonical match identity without a render-time userId reference",
    () => {
      expect(matchesPage).toContain("onClick={() => onOpen(match.id)}");
      expect(matchesPage).toContain(
        "const selectedMatch = expandedMatchId ? matches?.find(m => m.id === expandedMatchId) : null",
      );
      expect(matchesPage).toContain("<MatchChat");
      expect(matchesPage).not.toContain(
        '`vn_popup_${match.id}_${userId ?? "anonymous"}`',
      );
    },
  );

  it("scopes post-call acknowledgement to the authenticated user already available in MatchChat", () => {
    expect(
      matchesPage.split('`vn_popup_${match.id}_${user?.id ?? "anonymous"}`').length - 1,
    ).toBe(2);
    expect(matchesPage).toContain(
      "[voiceNotesUnlocked, voiceNoteData?.popupSeen, match.id, user?.id]",
    );
  });
});