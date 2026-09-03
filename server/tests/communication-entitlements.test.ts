import assert from "node:assert/strict";
import test from "node:test";
import { resolveCommunicationEntitlements } from "../../shared/communication-entitlements";

test("locks calls and reports precise remaining messages before thresholds", () => {
  const state = resolveCommunicationEntitlements({
    callStage: 0,
    messageCount1: 12,
    messageCount2: 15,
  });

  assert.equal(state.audio.state, "locked");
  assert.equal(state.audio.reason, "waiting_for_partner");
  assert.equal(state.audio.remainingMessages, 3);
  assert.equal(state.video.reason, "complete_first_call");
});

test("unlocks the included audio call exactly at the first threshold", () => {
  const state = resolveCommunicationEntitlements({
    callStage: 0,
    messageCount1: 15,
    messageCount2: 15,
  });

  assert.equal(state.audio.state, "available");
  assert.equal(state.video.state, "locked");
  assert.equal(state.voiceNote.state, "locked");
  assert.equal(state.voiceNote.reason, "complete_first_call");
});

test("voice notes stay locked until the first valid included call completes", () => {
  const beforeCall = resolveCommunicationEntitlements({
    callStage: 0,
    messageCount1: 99,
    messageCount2: 99,
  });
  const afterCall = resolveCommunicationEntitlements({
    callStage: 1,
    messageCount1: 0,
    messageCount2: 0,
    voiceNotesUnlocked: true,
  });

  assert.equal(beforeCall.voiceNote.state, "locked");
  assert.equal(beforeCall.voiceNote.remainingMessages, 0);
  assert.equal(afterCall.voiceNote.state, "available");
});

test("call availability and call completion remain separate states", () => {
  const callAvailable = resolveCommunicationEntitlements({
    callStage: 0,
    messageCount1: 15,
    messageCount2: 15,
    voiceNotesUnlocked: false,
  });
  const stageAdvancedWithoutPersistedCompletion = resolveCommunicationEntitlements({
    callStage: 1,
    messageCount1: 0,
    messageCount2: 0,
    voiceNotesUnlocked: false,
  });

  assert.equal(callAvailable.audio.state, "available");
  assert.equal(callAvailable.video.state, "locked");
  assert.equal(callAvailable.voiceNote.state, "locked");
  assert.equal(stageAdvancedWithoutPersistedCompletion.voiceNote.state, "locked");
});

test("unlocks included video only after the post-call message stage", () => {
  const locked = resolveCommunicationEntitlements({
    callStage: 1,
    messageCount1: 11,
    messageCount2: 12,
    voiceNotesUnlocked: true,
  });
  const available = resolveCommunicationEntitlements({
    callStage: 1,
    messageCount1: 12,
    messageCount2: 12,
    voiceNotesUnlocked: true,
  });

  assert.equal(locked.video.state, "locked");
  assert.equal(locked.video.remainingMessages, 1);
  assert.equal(available.video.state, "available");
  assert.equal(available.audio.state, "used_paid");
});

test("completed included calls remain used after reload-shaped resolution", () => {
  const state = resolveCommunicationEntitlements({
    callStage: 2,
    messageCount1: 0,
    messageCount2: 0,
    voiceNotesUnlocked: true,
  });

  assert.equal(state.audio.state, "used_paid");
  assert.equal(state.video.state, "used_paid");
  assert.equal(state.voiceNote.state, "available");
});