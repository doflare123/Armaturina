export interface Decision {
  decision: 'ALLOW' | 'ASK_ADMIN';
  reason: string;
}
/** Deliberately cannot return DELETE in phase 2, even for score=1. */
export function decide(score: number | null, protectedUser = false): Decision {
  if (protectedUser) return { decision: 'ALLOW', reason: 'protected_user' };
  if (score === null || !Number.isFinite(score) || score < 0 || score > 1)
    return { decision: 'ALLOW', reason: 'no_valid_score' };
  return score >= 0.6
    ? { decision: 'ASK_ADMIN', reason: 'classifier_above_review_threshold' }
    : { decision: 'ALLOW', reason: 'below_review_threshold' };
}
