/**
 * Candidate responses may arrive after a member has started a spin. The active
 * Wheel presentation must keep its original candidate order until that result
 * is explicitly finished, rather than accepting a late background response.
 */
export function canApplyWheelCandidateUpdate(presentationLocked: boolean): boolean {
  return !presentationLocked;
}

export function resolveWheelDismissal(deleteSucceeded: boolean): {
  releasePresentation: boolean;
  reopenResult: boolean;
} {
  return {
    releasePresentation: deleteSucceeded,
    reopenResult: !deleteSucceeded,
  };
}