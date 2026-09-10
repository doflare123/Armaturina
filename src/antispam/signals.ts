import type { Entity } from './features.ts';
import type { SpamClassifier, SparseVector } from './model.ts';
import { normalizeMessage } from './normalizer.ts';

export interface ReferenceMessage {
  id: number;
  normalized_text: string;
  label: number;
}
export interface RecentMessage {
  id: number;
  normalized_text: string;
  text_hash: string;
  raw_text: string;
  metadata: string;
  user_id: number;
  changed_at: number;
}
export interface SignalContext {
  observed: number;
  last60s: number;
  last10m: number;
  joinedAt: number | null;
  sinceJoin: number | null;
  recent: RecentMessage[];
  references: ReferenceMessage[];
}
export interface SignalAssessment {
  policyVersion: 1;
  spamSimilarity: number | null;
  normalSimilarity: number | null;
  spamReferenceId: number | null;
  normalReferenceId: number | null;
  campaignUsers: number;
  campaignScore: number;
  campaignMessageIds: number[];
  firstObserved: boolean;
  messagesObserved: number;
  messagesSinceJoin: number | null;
  secondsSinceJoin: number | null;
  messagesLast60s: number;
  messagesLast10m: number;
  duplicatesLastHour: number;
  sameUrlOtherUsers: number;
  behaviorScore: number;
}

/** Exact URL identity retains path/query: normalizer's <URL> is not a destination. */
export function messageUrls(raw: string, entities: readonly Entity[] = []): Set<string> {
  const urls = [...raw.matchAll(/(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)[^\s<>]+/giu)].map(
    (m) => m[0],
  );
  for (const e of entities) {
    if (
      !Number.isInteger(e.offset) ||
      !Number.isInteger(e.length) ||
      e.offset < 0 ||
      e.length <= 0 ||
      e.offset + e.length > raw.length
    )
      continue;
    if (e.type === 'text_link' && e.url) urls.push(e.url);
    if (e.type === 'url') urls.push(raw.slice(e.offset, e.offset + e.length));
  }
  const result = new Set<string>();
  for (const rawUrl of urls.slice(0, 32)) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      url.hash = '';
      result.add(url.href);
    } catch {
      /* Invalid destinations supply no URL signal. */
    }
  }
  return result;
}

/** Bounded cache belongs to one model instance; never fits on live/validation texts. */
export class ContextSignals {
  private readonly cache = new Map<string, SparseVector>();
  private cachedComponents = 0;
  private readonly classifier: SpamClassifier;
  constructor(classifier: SpamClassifier) {
    this.classifier = classifier;
  }
  private vector(text: string) {
    const cached = this.cache.get(text);
    if (cached) {
      this.cache.delete(text);
      this.cache.set(text, cached);
      return cached;
    }
    const vector = this.classifier.similarityVector(text);
    while (this.cache.size >= 512 || this.cachedComponents + vector.length > 200_000) {
      const key = this.cache.keys().next().value;
      if (key === undefined) break;
      this.cachedComponents -= this.cache.get(key)?.length ?? 0;
      this.cache.delete(key);
    }
    this.cache.set(text, vector);
    this.cachedComponents += vector.length;
    return vector;
  }
  assess(
    raw: string,
    entities: readonly Entity[],
    userId: number,
    now: number,
    context: SignalContext,
  ): SignalAssessment {
    const text = normalizeMessage(raw);
    const vector = new Map(this.vector(text.normalizedText));
    const cosine = (other: string): number | null => {
      const candidate = this.vector(other);
      if (!vector.size || !candidate.length) return null;
      // Very low vocabulary coverage must not turn unrelated OOV messages into exact matches.
      if (vector.size < 10 || candidate.length < 10) return null;
      return Math.min(
        1,
        Math.max(
          0,
          candidate.reduce((s, [i, v]) => s + v * (vector.get(i) ?? 0), 0),
        ),
      );
    };
    let spamSimilarity: number | null = null,
      normalSimilarity: number | null = null;
    let spamReferenceId: number | null = null,
      normalReferenceId: number | null = null;
    for (const reference of context.references) {
      const score = cosine(reference.normalized_text);
      if (score === null) continue;
      if (reference.label === 1 && (spamSimilarity === null || score > spamSimilarity)) {
        spamSimilarity = score;
        spamReferenceId = reference.id;
      }
      if (reference.label === 0 && (normalSimilarity === null || score > normalSimilarity)) {
        normalSimilarity = score;
        normalReferenceId = reference.id;
      }
    }
    const users = new Set([userId]),
      campaignMessageIds: number[] = [];
    const urls = messageUrls(raw, entities),
      urlUsers = new Set<number>();
    let duplicatesLastHour = 0;
    for (const recent of context.recent) {
      if (recent.user_id === userId && recent.text_hash === text.textHash) duplicatesLastHour++;
      if (recent.user_id === userId) continue;
      if (recent.changed_at >= now - 600_000 && (cosine(recent.normalized_text) ?? 0) >= 0.9) {
        users.add(recent.user_id);
        campaignMessageIds.push(recent.id);
      }
      if (urls.size) {
        const metadata = JSON.parse(recent.metadata) as { entities?: Entity[] };
        if ([...messageUrls(recent.raw_text, metadata.entities)].some((url) => urls.has(url)))
          urlUsers.add(recent.user_id);
      }
    }
    const campaignUsers = users.size;
    const campaignScore =
      campaignUsers >= 5 ? 1 : campaignUsers >= 3 ? 0.6 : campaignUsers >= 2 ? 0.3 : 0;
    const secondsSinceJoin = context.joinedAt === null ? null : (now - context.joinedAt) / 1000;
    const behaviorScore = Math.min(
      1,
      (context.observed === 1 ? 0.15 : 0) +
        (secondsSinceJoin !== null && secondsSinceJoin < 60 ? 0.15 : 0) +
        (urls.size ? 0.2 : 0) +
        (urlUsers.size ? 0.3 : 0) +
        (context.last60s > 3 ? 0.2 : 0),
    );
    return {
      policyVersion: 1,
      spamSimilarity,
      normalSimilarity,
      spamReferenceId,
      normalReferenceId,
      campaignUsers,
      campaignScore,
      campaignMessageIds,
      firstObserved: context.observed === 1,
      messagesObserved: context.observed,
      messagesSinceJoin: context.sinceJoin,
      secondsSinceJoin,
      messagesLast60s: context.last60s,
      messagesLast10m: context.last10m,
      duplicatesLastHour,
      sameUrlOtherUsers: urlUsers.size,
      behaviorScore,
    };
  }
}

/** Heuristic review priority, not a calibrated spam probability. Never fabricates a base score. */
export function contextualScore(base: number | null, signals: SignalAssessment): number | null {
  if (base === null || !Number.isFinite(base) || base < 0 || base > 1) return null;
  const similarity =
    (signals.spamSimilarity ?? 0) >= 0.95 &&
    (signals.spamSimilarity ?? 0) > (signals.normalSimilarity ?? 0) + 0.02
      ? 1
      : 0;
  const boost = 0.2 * similarity + 0.15 * signals.campaignScore + 0.1 * signals.behaviorScore;
  return base + (1 - base) * boost;
}
