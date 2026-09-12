import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const milestone = readFileSync("client/src/components/post-call-milestone.tsx", "utf8");
const matchesPage = readFileSync("client/src/pages/matches.tsx", "utf8");
const messagingPage = readFileSync("client/src/pages/messaging.tsx", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");
const schema = readFileSync("shared/schema.ts", "utf8");

describe("post-call voice-note milestone regressions", () => {
  it("uses the persisted post-call unlock as its only entitlement source", () => {
    expect(routes).toContain('unlockSource: "post_call"');
    expect(routes).toContain('existing?.unlockSource === "post_call"');
    expect(matchesPage).toContain("if (voiceNotesUnlocked && voiceNoteData?.popupSeen === false)");
    expect(messagingPage).toContain("if (voiceNotesUnlocked && voiceNoteData?.popupSeen === false)");
  });

  it("presents the approved professional milestone copy and icon", () => {
    expect(milestone).toContain("First call complete");
    expect(milestone).toContain(
      "You’ve reached the next stage of your connection. Voice notes are now unlocked.",
    );
    expect(milestone).toContain("Keep getting to know each other between calls.");
    expect(milestone).toContain("<Mic");
    expect(milestone).not.toContain("🎙️");
    expect(milestone).not.toContain("Congratulations");
  });

  it("uses the shared milestone in both active chat implementations", () => {
    expect(matchesPage).toContain("<PostCallMilestone");
    expect(messagingPage).toContain("<PostCallMilestone");
  });

  it("persists acknowledgement per user and match without gating entitlement", () => {
    expect(schema).toContain('pgTable("voice_note_popup_seen"');
    expect(schema).toContain("primaryKey({ columns: [table.matchId, table.userId] })");
    expect(
      matchesPage.split('`vn_popup_${match.id}_${user?.id ?? "anonymous"}`').length - 1,
    ).toBe(2);
    expect(matchesPage).not.toContain('`vn_popup_${match.id}_${userId ?? "anonymous"}`');
    expect(
      messagingPage.split('`vn_popup_${matchId}_${user?.id ?? "anonymous"}`').length - 1,
    ).toBe(3);
    expect(messagingPage).not.toContain("`vn_popup_${matchId}`");
    expect(matchesPage).toContain('apiRequest("POST", `/api/voice-notes/popup-seen/${match.id}`)');
    expect(messagingPage).toContain('apiRequest("POST", `/api/voice-notes/popup-seen/${matchId}`)');
    expect(matchesPage).toContain("const voiceNotesUnlocked = voiceNoteData?.unlocked ?? false");
    expect(messagingPage).toContain("const voiceNotesUnlocked = voiceNoteData?.unlocked ?? false");
  });

  it("does not restore the obsolete eight-message unlock copy", () => {
    expect(matchesPage).not.toContain("You've both sent 8 messages");
    expect(messagingPage).not.toContain("You've both sent 8 messages");
  });
});