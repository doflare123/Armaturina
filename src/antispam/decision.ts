export interface Decision {
  decision: 'ALLOW' | 'ASK_ADMIN';
  reason: string;
}

/** ACTIVE permits message deletion only; never bans or mutes an author. */
export function activeAction(
  score: number | null,
  protectedUser: boolean,
  threshold: number,
  approved: boolean,
): 'DELETE' | 'NONE' {
  return approved &&
    threshold >= 0.9 &&
    decide(score, protectedUser, threshold).decision === 'ASK_ADMIN'
    ? 'DELETE'
    : 'NONE';
}
/** Deliberately cannot return DELETE in phase 2, even for score=1. */
export function decide(score: number | null, protectedUser = false, threshold = 0.6): Decision {
  if (protectedUser) return { decision: 'ALLOW', reason: 'protected_user' };
  if (score === null || !Number.isFinite(score) || score < 0 || score > 1)
    return { decision: 'ALLOW', reason: 'no_valid_score' };
  if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 1)
    return { decision: 'ALLOW', reason: 'invalid_threshold' };
  return score >= threshold
    ? { decision: 'ASK_ADMIN', reason: 'classifier_above_review_threshold' }
    : { decision: 'ALLOW', reason: 'below_review_threshold' };
}
