import type { DatabaseSync } from 'node:sqlite';
import { ActiveSafety } from './active.ts';

export type SpamMode = 'LEARNING' | 'SHADOW' | 'ACTIVE';
export interface PredictionPolicy {
  mode: SpamMode;
  threshold: number;
}
export interface EvaluationRow {
  id: number;
  score: number;
  label: number | null;
  reduced_text: string;
  text_hash: string;
  created_at: number;
  mode: SpamMode;
  threshold: number;
}

export function quality(rows: { score: number; label: number }[], threshold: number) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const row of rows) {
    if (row.score >= threshold) {
      if (row.label === 1) tp++;
      else fp++;
    } else if (row.label === 1) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return {
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1: 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : null,
    falsePositiveRate: fp + tn ? fp / (fp + tn) : null,
  };
}

/** One earliest prospective observation per duplicate group; conflicting truth abstains. */
export function evaluationGroups(rows: EvaluationRow[]) {
  const groups = new Map<string, EvaluationRow[]>();
  for (const row of rows) {
    if (row.label !== 0 && row.label !== 1) continue;
    const group = groups.get(row.reduced_text) ?? [];
    group.push(row);
    groups.set(row.reduced_text, group);
  }
  return [...groups.values()]
    .filter((group) => new Set(group.map((r) => r.label)).size === 1)
    .map((group) => group.reduce((a, b) => (a.id < b.id ? a : b)))
    .sort((a, b) => a.id - b.id) as (EvaluationRow & { label: number })[];
}

/** Temporal holdout is never used to choose the threshold. Recommendation only. */
export function calibrate(rows: EvaluationRow[]) {
  const groups = evaluationGroups(rows);
  const cut = Math.floor(groups.length * 0.6),
    fit = groups.slice(0, cut),
    holdout = groups.slice(cut);
  const enough = (part: typeof groups) =>
    [0, 1].every((label) => part.filter((r) => r.label === label).length >= 10);
  if (!enough(fit) || !enough(holdout))
    throw new Error(
      'Недостаточно новых размеченных данных: нужны минимум 10 spam и 10 normal в каждой части временного split 60/40.',
    );
  const candidates = Array.from({ length: 96 }, (_, i) => (i + 5) / 100);
  const scored = candidates
    .map((threshold) => ({ threshold, metrics: quality(fit, threshold) }))
    .filter((r) => r.metrics.tp + r.metrics.fp >= 10 && (r.metrics.precision ?? 0) >= 0.95)
    .sort((a, b) => (b.metrics.recall ?? 0) - (a.metrics.recall ?? 0) || b.threshold - a.threshold);
  const best = scored[0];
  if (!best)
    throw new Error(
      'Нет порога с precision ≥95% и минимум 10 положительными прогнозами на calibration.',
    );
  const holdoutMetrics = quality(holdout, best.threshold);
  return {
    threshold: best.threshold,
    calibration: best.metrics,
    holdout: holdoutMetrics,
    accepted:
      (holdoutMetrics.precision ?? 0) >= 0.95 && holdoutMetrics.tp + holdoutMetrics.fp >= 10,
    calibrationSize: fit.length,
    holdoutSize: holdout.length,
  };
}

/** Runtime policy is separate from immutable learned model artifacts. */
export class SpamGovernance {
  private readonly db: DatabaseSync;
  readonly active: ActiveSafety;
  constructor(db: DatabaseSync) {
    this.db = db;
    this.active = new ActiveSafety(db);
  }
  static migrate(db: DatabaseSync) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS spam_modes(chat_id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('LEARNING','SHADOW')));
      CREATE TABLE IF NOT EXISTS model_thresholds(version TEXT PRIMARY KEY REFERENCES model_versions(version),
        threshold REAL NOT NULL CHECK(threshold BETWEEN 0.05 AND 1));
      CREATE TABLE IF NOT EXISTS prediction_policy(prediction_id INTEGER PRIMARY KEY REFERENCES predictions(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('LEARNING','SHADOW')),
        threshold REAL NOT NULL CHECK(threshold BETWEEN 0.05 AND 1), policy_version INTEGER NOT NULL CHECK(policy_version=1));
      CREATE TABLE IF NOT EXISTS model_audit(id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,
        admin_id INTEGER,action TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS model_audit_chat ON model_audit(chat_id,id);
      PRAGMA user_version=7; COMMIT;`);
  }
  policy(chatId: number, version: string): PredictionPolicy {
    return {
      mode: this.active.grant(chatId, version)
        ? 'ACTIVE'
        : ((this.db.prepare('SELECT mode FROM spam_modes WHERE chat_id=?').get(chatId)?.mode ??
            'LEARNING') as SpamMode),
      threshold: Number(
        this.db.prepare('SELECT threshold FROM model_thresholds WHERE version=?').get(version)
          ?.threshold ?? 0.6,
      ),
    };
  }
  audit(chatId: number, adminId: number | null, action: string, details: unknown) {
    this.db
      .prepare(
        'INSERT INTO model_audit(chat_id,admin_id,action,details,created_at) VALUES (?,?,?,?,?)',
      )
      .run(chatId, adminId, action, JSON.stringify(details), Date.now());
  }
  revision(chatId: number) {
    return Number(
      this.db.prepare('SELECT MAX(id) AS id FROM model_audit WHERE chat_id=?').get(chatId)?.id ?? 0,
    );
  }
  setMode(chatId: number, mode: SpamMode, adminId: number) {
    if (mode !== 'SHADOW' && mode !== 'LEARNING') throw new Error('Режим: SHADOW или LEARNING.');
    this.change(() => {
      this.active.revoke(chatId, 'mode_changed');
      this.db
        .prepare(
          'INSERT INTO spam_modes VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode',
        )
        .run(chatId, mode);
      this.audit(chatId, adminId, 'mode', { mode });
    });
  }
  setThreshold(chatId: number, version: string, threshold: number, adminId: number) {
    if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 1)
      throw new Error('Порог должен быть от 0.05 до 1.');
    this.change(() => {
      if (
        !this.db
          .prepare('SELECT 1 FROM model_versions WHERE chat_id=? AND version=? AND active=1')
          .get(chatId, version)
      )
        throw new Error('Активная модель изменилась. Повторите команду.');
      this.db
        .prepare(
          'INSERT INTO model_thresholds VALUES (?,?) ON CONFLICT(version) DO UPDATE SET threshold=excluded.threshold',
        )
        .run(version, threshold);
      this.active.revoke(chatId, 'threshold_changed');
      this.audit(chatId, adminId, 'threshold', { version, threshold });
    });
  }
  record(predictionId: number, policy: PredictionPolicy) {
    this.db
      .prepare('INSERT INTO prediction_policy VALUES (?,?,?,1)')
      .run(predictionId, policy.mode, policy.threshold);
  }
  rows(
    chatId: number,
    version: string,
    excludedHashes: string[],
    now = Date.now(),
  ): EvaluationRow[] {
    const excluded = new Set(excludedHashes);
    const known = this.db
      .prepare(
        'SELECT text_hash,reduced_text FROM messages WHERE chat_id=? AND text_hash IN (SELECT value FROM json_each(?))',
      )
      .all(chatId, JSON.stringify(excludedHashes)) as { text_hash: string; reduced_text: string }[];
    const reduced = new Set(
      known.filter((r) => excluded.has(r.text_hash)).map((r) => r.reduced_text),
    );
    const rows = this.db
      .prepare(`SELECT p.id,p.final_score AS score,m.text_hash,m.reduced_text,p.created_at,g.mode,g.threshold,
      CASE WHEN l.source IN ('ADMIN_CONFIRMED','ADMIN_REJECTED') AND l.created_at>=p.created_at THEN l.label ELSE NULL END AS label
      FROM predictions p JOIN messages m ON m.id=p.message_id JOIN prediction_policy g ON g.prediction_id=p.id
      JOIN prediction_signals s ON s.prediction_id=p.id AND s.policy_version=1
      LEFT JOIN labels l ON l.message_id=m.id
      WHERE m.chat_id=? AND p.model_version=? AND p.created_at>=? AND p.final_score IS NOT NULL
      AND p.reason<>'protected_user' ORDER BY p.id DESC LIMIT 10000`)
      .all(chatId, version, now - 30 * 86_400_000) as unknown as EvaluationRow[];
    return rows.filter((r) => !excluded.has(r.text_hash) && !reduced.has(r.reduced_text));
  }
  private change(action: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
