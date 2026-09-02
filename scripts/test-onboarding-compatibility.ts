import assert from "node:assert/strict";
import {
  isLegacyEstablishedProfile,
  resolvePersistedOnboardingStep,
} from "../shared/onboarding-compatibility";

assert.equal(
  isLegacyEstablishedProfile({
    createdAt: "2026-08-19T23:59:59.999Z",
    onboardingComplete: true,
  }),
  true,
  "completed pre-rollout profiles are established legacy accounts",
);
assert.equal(
  isLegacyEstablishedProfile({
    createdAt: "2026-08-20T00:00:00.000Z",
    onboardingComplete: true,
  }),
  false,
  "accounts created at the rollout boundary are modern accounts",
);
assert.equal(
  isLegacyEstablishedProfile({
    createdAt: "2026-08-19T23:59:59.999Z",
    onboardingComplete: false,
  }),
  false,
  "an abandoned pre-rollout profile is not grandfathered",
);

assert.equal(
  resolvePersistedOnboardingStep({
    tutorialCompleted: false,
    dnaCompleted: false,
    legacyEstablished: true,
  }),
  "app",
  "established legacy accounts enter the app without fabricated DNA",
);
assert.equal(
  resolvePersistedOnboardingStep({
    tutorialCompleted: false,
    dnaCompleted: false,
    legacyEstablished: false,
  }),
  "tutorial",
  "fresh accounts cannot bypass the tutorial",
);
assert.equal(
  resolvePersistedOnboardingStep({
    tutorialCompleted: true,
    dnaCompleted: false,
    legacyEstablished: false,
  }),
  "dna",
  "fresh accounts cannot bypass Connection DNA",
);
assert.equal(
  resolvePersistedOnboardingStep({
    tutorialCompleted: true,
    dnaCompleted: true,
    legacyEstablished: false,
  }),
  "app",
  "fully completed modern accounts enter the app",
);

console.log("Onboarding compatibility regression tests passed");