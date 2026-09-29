import assert from "node:assert/strict";
import test from "node:test";
import { committedVoiceMessage, voiceContentForWrite, voiceUploadPath } from "../voice-note-media";

test("bridge voice notes retain public URL content and independent sender paths", () => {
  const senderPath = voiceUploadPath("match-1", "sender", "request-1");
  assert.notEqual(senderPath, voiceUploadPath("match-1", "recipient", "request-1"));
  assert.equal(senderPath, "match-1/sender/voice_request-1.m4a");
  assert.equal(voiceContentForWrite(() => `https://example.test/storage/v1/object/public/voice-notes/${senderPath}`),
    `__VOICE__:https://example.test/storage/v1/object/public/voice-notes/${senderPath}`);
});

test("voice-note retries return only the original author's committed message", () => {
  const row = { id: "message-1", match_id: "match-1", sender_id: "sender",
    content: "__VOICE__:https://example.test/voice.m4a", reaction: null, created_at: null };
  assert.deepEqual(committedVoiceMessage(row, "match-1", "sender"), {
    id: "message-1", matchId: "match-1", senderId: "sender", content: row.content, reaction: null, createdAt: null,
  });
  assert.equal(committedVoiceMessage(row, "match-2", "sender"), null);
  assert.equal(committedVoiceMessage(row, "match-1", "recipient"), null);
  assert.equal(committedVoiceMessage({ ...row, content: "hello" }, "match-1", "sender"), null);
});