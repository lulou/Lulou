import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeMeetAvailability,
  decideMeetAvailabilityAcceptance,
  resolveMeetAvailability,
} from "../../shared/meet-availability";

const morning = "2026-09-23 10:00";
const afternoon = "2026-09-23 14:00";

test("resolves all post-call meet availability states", () => {
  assert.equal(resolveMeetAvailability(null, null).state, "none_submitted");
  assert.equal(resolveMeetAvailability(JSON.stringify([morning]), null).state, "self_only");
  assert.equal(resolveMeetAvailability(null, JSON.stringify([afternoon])).state, "other_only");
  assert.equal(
    resolveMeetAvailability(JSON.stringify([afternoon]), JSON.stringify([afternoon])).state,
    "both_match",
  );
  assert.equal(
    resolveMeetAvailability(JSON.stringify([morning]), JSON.stringify([afternoon])).state,
    "both_mismatch",
  );
});

test("matches on canonical slot values rather than display text", () => {
  const state = resolveMeetAvailability(
    JSON.stringify([morning, afternoon]),
    JSON.stringify([afternoon]),
  );
  assert.deepEqual(state.matchingAvailability, [afternoon]);
});

test("normalizes, deduplicates, and rejects malformed slots", () => {
  assert.equal(
    canonicalizeMeetAvailability([afternoon, morning, afternoon]),
    JSON.stringify([morning, afternoon]),
  );
  assert.equal(canonicalizeMeetAvailability(["Wednesday afternoon"]), null);
  assert.equal(canonicalizeMeetAvailability([]), null);
});

test("accept copies the exact persisted value and rejects a changed counterpart", () => {
  const persisted = JSON.stringify([morning, afternoon]);
  assert.deepEqual(
    decideMeetAvailabilityAcceptance(null, persisted, persisted),
    { ok: true, copiedAvailability: persisted },
  );
  assert.deepEqual(
    decideMeetAvailabilityAcceptance(null, JSON.stringify([morning]), persisted),
    { ok: false, reason: "stale_other" },
  );
});

test("accept rejects a receiver who already responded", () => {
  assert.deepEqual(
    decideMeetAvailabilityAcceptance(
      JSON.stringify([morning]),
      JSON.stringify([afternoon]),
      JSON.stringify([afternoon]),
    ),
    { ok: false, reason: "already_responded" },
  );
});