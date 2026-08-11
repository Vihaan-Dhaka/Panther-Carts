export type SubmissionLock = { current: boolean };

export function claimSubmission(lock: SubmissionLock): boolean {
  if (lock.current) {
    return false;
  }
  lock.current = true;
  return true;
}

export function releaseSubmission(lock: SubmissionLock): void {
  lock.current = false;
}
