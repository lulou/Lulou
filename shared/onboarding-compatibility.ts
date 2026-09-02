export const MANDATORY_ONBOARDING_ROLLOUT_AT = new Date("2026-08-20T00:00:00.000Z");

type LegacyProfileEvidence = {
  createdAt?: Date | string | null;
  onboardingComplete?: boolean | null;
};

export function isLegacyEstablishedProfile(
  profile: LegacyProfileEvidence | null | undefined,
): boolean {
  if (profile?.onboardingComplete !== true || !profile.createdAt) return false;
  const createdAt = profile.createdAt instanceof Date
    ? profile.createdAt
    : new Date(profile.createdAt);
  return Number.isFinite(createdAt.getTime())
    && createdAt < MANDATORY_ONBOARDING_ROLLOUT_AT;
}

export type PersistedOnboardingStep = "tutorial" | "dna" | "app";

export function resolvePersistedOnboardingStep(input: {
  tutorialCompleted: boolean;
  dnaCompleted: boolean;
  legacyEstablished: boolean;
}): PersistedOnboardingStep {
  if (input.legacyEstablished) return "app";
  if (!input.tutorialCompleted) return "tutorial";
  if (!input.dnaCompleted) return "dna";
  return "app";
}