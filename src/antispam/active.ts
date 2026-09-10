import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { quality } from './governance.ts';
import { validateModel } from './model.ts';

interface Evaluation {
  id: string;
  chat_id: number;
  version: string;
  threshold: number;
  created_at: number;
  status: string;
  excluded_json: string;
  fingerprint: string | null;
}
export interface ActiveGrant {
  evaluation_id: string;
  version: string;
  threshold: number;
  admin_id: number;
  expires_at: number;
}
/** Prospective, score-blind cohort. Deletion authority never comes from calibration alone. */
export class ActiveSafety {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  static migrate(db: DatabaseSync) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE prediction_policy RENAME TO prediction_policy_v7;
      CREATE TABLE prediction_policy(prediction_id INTEGER PRIMARY KEY REFERENCES predictions(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('LEARNING','SHADOW','ACTIVE')),
        threshold REAL NOT NULL CHECK(threshold BETWEEN 0.05 AND 1),policy_version INTEGER NOT NULL CHECK(policy_version=1));
      INSERT INTO prediction_policy SELECT * FROM prediction_policy_v7;
      DROP TABLE prediction_policy_v7;
      CREATE TABLE IF NOT EXISTS active_evaluations(id TEXT PRIMARY KEY,chat_id INTEGER NOT NULL,
        version TEXT NOT NULL REFERENCES model_versions(version),threshold REAL NOT NULL,
        created_at INTEGER NOT NULL,status TEXT NOT NULL,excluded_json TEXT NOT NULL,fingerprint TEXT);
      CREATE TABLE IF NOT EXISTS active_samples(evaluation_id TEXT NOT NULL REFERENCES active_evaluations(id),
        prediction_id INTEGER NOT NULL UNIQUE REFERENCES predictions(id) ON DELETE CASCADE,
        reduced_text TEXT NOT NULL,PRIMARY KEY(evaluation_id,reduced_text));
      CREATE TABLE IF NOT EXISTS active_grants(chat_id INTEGER PRIMARY KEY,evaluation_id TEXT NOT NULL REFERENCES active_evaluations(id),
        version TEXT NOT NULL,threshold REAL NOT NULL,admin_id INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS active_actions(prediction_id INTEGER PRIMARY KEY REFERENCES predictions(id) ON DELETE CASCADE,
        evaluation_id TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS active_evaluations_chat ON active_evaluations(chat_id,status);
      CREATE INDEX IF NOT EXISTS active_actions_time ON active_actions(created_at);
      PRAGMA user_version=8; COMMIT;`);
  }
  private current(chatId: number) {
    const row = this.db
      .prepare('SELECT version,artifact_json FROM model_versions WHERE chat_id=? AND active=1')
      .get(chatId) as { version: string; artifact_json: string } | undefined;
    if (!row) throw new Error('Сначала нужна активная обученная модель.');
    const threshold = Number(
      this.db.prepare('SELECT threshold FROM model_thresholds WHERE version=?').get(row.version)
        ?.threshold ?? 0.6,
    );
    return { ...row, threshold };
  }
  private event(chatId: number, adminId: number | null, action: string, details: unknown) {
    this.db
      .prepare(
        'INSERT INTO model_audit(chat_id,admin_id,action,details,created_at) VALUES (?,?,?,?,?)',
      )
      .run(chatId, adminId, action, JSON.stringify(details), Date.now());
  }
  /** Caller may already own a SQLite transaction. */
  revoke(chatId: number, reason: string) {
    const deleted = this.db
      .prepare('DELETE FROM active_grants WHERE chat_id=?')
      .run(chatId).changes;
    this.db
      .prepare(
        "UPDATE active_evaluations SET status='INVALID' WHERE chat_id=? AND status IN ('COLLECTING','READY')",
      )
      .run(chatId);
    if (deleted) {
      this.db
        .prepare(
          "INSERT INTO spam_modes VALUES (?,'SHADOW') ON CONFLICT(chat_id) DO UPDATE SET mode='SHADOW'",
        )
        .run(chatId);
      this.event(chatId, null, 'active_disabled', { reason });
    }
  }
  prepare(chatId: number, version: string, adminId: number) {
    return this.transaction(() => {
      const current = this.current(chatId);
      if (current.version !== version) throw new Error('Укажите текущую версию из /spam models.');
      if (current.threshold < 0.9)
        throw new Error('Для ACTIVE установите фиксированный порог ≥0.90.');
      const model = validateModel(JSON.parse(current.artifact_json));
      const hashes = [...model.trainHashes, ...model.validationHashes];
      const reduced = this.db
        .prepare(
          'SELECT DISTINCT reduced_text FROM messages WHERE chat_id=? AND text_hash IN (SELECT value FROM json_each(?))',
        )
        .all(chatId, JSON.stringify(hashes))
        .map((r) => String(r.reduced_text));
      this.revoke(chatId, 'new_evaluation');
      this.db
        .prepare(
          "INSERT INTO spam_modes VALUES (?,'SHADOW') ON CONFLICT(chat_id) DO UPDATE SET mode='SHADOW'",
        )
        .run(chatId);
      const id = randomUUID();
      this.db.prepare("INSERT INTO active_evaluations VALUES (?,?,?,?,?,'COLLECTING',?,NULL)").run(
        id,
        chatId,
        version,
        current.threshold,
        Date.now(),
        JSON.stringify({
          hashes,
          reduced,
          artifactHash: createHash('sha256').update(current.artifact_json).digest('hex'),
        }),
      );
      this.event(chatId, adminId, 'active_prepare', { id, version, threshold: current.threshold });
      return id;
    });
  }
  enroll(predictionId: number) {
    const row = this.db
      .prepare(`SELECT p.model_version,p.reason,p.final_score,g.threshold,g.mode,m.chat_id,m.text_hash,m.reduced_text
      FROM predictions p JOIN prediction_policy g ON g.prediction_id=p.id JOIN messages m ON m.id=p.message_id
      WHERE p.id=? AND p.final_score IS NOT NULL AND g.mode='SHADOW' AND p.reason<>'protected_user'`)
      .get(predictionId);
    if (!row) return;
    const evaluation = this.db
      .prepare(
        "SELECT * FROM active_evaluations WHERE chat_id=? AND status='COLLECTING' ORDER BY rowid DESC LIMIT 1",
      )
      .get(Number(row.chat_id)) as unknown as Evaluation | undefined;
    if (
      !evaluation ||
      evaluation.version !== row.model_version ||
      evaluation.threshold !== row.threshold
    )
      return;
    const count = Number(
      this.db
        .prepare('SELECT COUNT(*) AS n FROM active_samples WHERE evaluation_id=?')
        .get(evaluation.id)?.n,
    );
    if (count >= 1000) return;
    const excluded = JSON.parse(evaluation.excluded_json) as {
      hashes: string[];
      reduced: string[];
    };
    if (
      excluded.hashes.includes(String(row.text_hash)) ||
      excluded.reduced.includes(String(row.reduced_text))
    )
      return;
    this.db
      .prepare('INSERT OR IGNORE INTO active_samples VALUES (?,?,?)')
      .run(evaluation.id, predictionId, String(row.reduced_text));
  }
  private evaluation(chatId: number, id: string) {
    const row = this.db
      .prepare('SELECT * FROM active_evaluations WHERE chat_id=? AND id=?')
      .get(chatId, id) as unknown as Evaluation | undefined;
    if (!row || !['COLLECTING', 'READY'].includes(row.status))
      throw new Error('Допуск отсутствует или отозван. Выполните /spam active prepare <version>.');
    const current = this.current(chatId);
    if (
      current.version !== row.version ||
      current.threshold !== row.threshold ||
      row.created_at < Date.now() - 30 * 86_400_000
    )
      throw new Error(
        'Версия/порог изменились либо проверка старше 30 дней. Начните новую проверку.',
      );
    validateModel(JSON.parse(current.artifact_json));
    if (
      JSON.parse(row.excluded_json).artifactHash !==
      createHash('sha256').update(current.artifact_json).digest('hex')
    )
      throw new Error('Артефакт модели изменён. Начните новую проверку.');
    return row;
  }
  report(chatId: number, id: string) {
    const evaluation = this.evaluation(chatId, id);
    const rows = this.db
      .prepare(`SELECT p.id,p.final_score AS score,m.reduced_text,
      CASE WHEN l.source IN ('ADMIN_CONFIRMED','ADMIN_REJECTED') AND l.created_at>=p.created_at THEN l.label ELSE NULL END AS label
      FROM active_samples s JOIN predictions p ON p.id=s.prediction_id JOIN messages m ON m.id=p.message_id
      LEFT JOIN labels l ON l.message_id=m.id WHERE s.evaluation_id=? ORDER BY p.id`)
      .all(id) as unknown as {
      id: number;
      score: number;
      label: number | null;
      reduced_text: string;
    }[];
    const labelled = rows.filter((r) => r.label === 0 || r.label === 1) as {
      id: number;
      score: number;
      label: number;
      reduced_text: string;
    }[];
    const metrics = quality(labelled, evaluation.threshold);
    const passed =
      rows.length === 1000 &&
      labelled.length === 1000 &&
      metrics.tp + metrics.fp >= 100 &&
      metrics.tn + metrics.fp >= 400 &&
      (metrics.precision ?? 0) >= 0.99 &&
      metrics.falsePositiveRate !== null &&
      metrics.falsePositiveRate <= 0.01;
    const fingerprint = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    return {
      id,
      version: evaluation.version,
      threshold: evaluation.threshold,
      samples: rows.length,
      labelled: labelled.length,
      metrics,
      passed,
      fingerprint,
    };
  }
  check(chatId: number, id: string, adminId: number) {
    return this.transaction(() => {
      const result = this.report(chatId, id);
      if (result.passed)
        this.db
          .prepare("UPDATE active_evaluations SET status='READY',fingerprint=? WHERE id=?")
          .run(result.fingerprint, id);
      this.event(chatId, adminId, 'active_check', result);
      return result;
    });
  }
  enable(chatId: number, id: string, adminId: number) {
    this.transaction(() => {
      const evaluation = this.evaluation(chatId, id),
        report = this.report(chatId, id);
      if (
        evaluation.status !== 'READY' ||
        !report.passed ||
        evaluation.fingerprint !== report.fingerprint
      )
        throw new Error(
          'Сначала нужна успешная /spam active check <id>; данные не должны измениться.',
        );
      this.db
        .prepare('INSERT OR REPLACE INTO active_grants VALUES (?,?,?,?,?,?)')
        .run(
          chatId,
          id,
          evaluation.version,
          evaluation.threshold,
          adminId,
          Date.now() + 7 * 86_400_000,
        );
      this.event(chatId, adminId, 'active_enabled', {
        id,
        version: evaluation.version,
        threshold: evaluation.threshold,
      });
    });
  }
  grant(chatId: number, version: string): ActiveGrant | null {
    const grant = this.db
      .prepare('SELECT * FROM active_grants WHERE chat_id=?')
      .get(chatId) as unknown as ActiveGrant | undefined;
    if (!grant) return null;
    try {
      const report = this.report(chatId, grant.evaluation_id);
      const evaluation = this.evaluation(chatId, grant.evaluation_id);
      if (
        grant.threshold !== report.threshold ||
        grant.expires_at <= Date.now() ||
        !report.passed ||
        evaluation.fingerprint !== report.fingerprint
      )
        throw new Error('Invalid grant');
      return grant.version === version ? grant : null;
    } catch {
      this.revoke(chatId, 'quality_or_policy_changed');
      return null;
    }
  }
  nextSample(chatId: number, id: string): number | null {
    this.evaluation(chatId, id);
    return (
      Number(
        this.db
          .prepare(`SELECT p.message_id FROM active_samples s JOIN predictions p ON p.id=s.prediction_id
      LEFT JOIN labels l ON l.message_id=p.message_id WHERE s.evaluation_id=? AND l.id IS NULL ORDER BY p.id LIMIT 1`)
          .get(id)?.message_id,
      ) || null
    );
  }
  claim(predictionId: number, grant: ActiveGrant): boolean {
    // Durable at-most-once attempt, never retried automatically after timeout/restart.
    return !!this.db
      .prepare(`INSERT INTO active_actions SELECT p.id,?,?,'PENDING' FROM predictions p
      JOIN messages m ON m.id=p.message_id WHERE p.id=? AND m.telegram_message_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM active_grants g JOIN model_versions v ON v.version=g.version AND v.active=1
        JOIN active_evaluations e ON e.id=g.evaluation_id AND e.status='READY'
        JOIN prediction_policy pp ON pp.prediction_id=p.id AND pp.mode='ACTIVE' AND pp.threshold=g.threshold
        WHERE g.chat_id=m.chat_id AND g.evaluation_id=? AND g.version=p.model_version AND g.threshold=?
        AND g.expires_at>? AND p.final_score>=g.threshold
        AND g.threshold=COALESCE((SELECT threshold FROM model_thresholds WHERE version=g.version),0.6))
      AND NOT EXISTS(SELECT 1 FROM labels WHERE message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM moderation_cases WHERE message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM active_actions a JOIN predictions x ON x.id=a.prediction_id JOIN messages y ON y.id=x.message_id
        WHERE y.chat_id=m.chat_id AND a.created_at>?) ON CONFLICT(prediction_id) DO NOTHING`)
      .run(
        grant.evaluation_id,
        Date.now(),
        predictionId,
        grant.evaluation_id,
        grant.threshold,
        Date.now(),
        Date.now() - 60_000,
      ).changes;
  }
  finish(predictionId: number, status: 'DELETED' | 'FAILED_OR_UNKNOWN') {
    this.db
      .prepare('UPDATE active_actions SET status=? WHERE prediction_id=?')
      .run(status, predictionId);
  }
  log(chatId: number) {
    return this.db
      .prepare(`SELECT a.prediction_id,a.status,a.created_at,m.id AS message_id,m.raw_text
      FROM active_actions a JOIN predictions p ON p.id=a.prediction_id JOIN messages m ON m.id=p.message_id
      WHERE m.chat_id=? ORDER BY a.created_at DESC,a.prediction_id DESC LIMIT 10`)
      .all(chatId) as {
      prediction_id: number;
      status: string;
      created_at: number;
      message_id: number;
      raw_text: string;
    }[];
  }
  reviewMessage(chatId: number, predictionId: number): number | null {
    return (
      Number(
        this.db
          .prepare(`SELECT m.id FROM active_actions a JOIN predictions p ON p.id=a.prediction_id
      JOIN messages m ON m.id=p.message_id WHERE a.prediction_id=? AND m.chat_id=?`)
          .get(predictionId, chatId)?.id,
      ) || null
    );
  }
  feedback(messageId: number) {
    const row = this.db
      .prepare(`SELECT m.chat_id FROM active_actions a JOIN predictions p ON p.id=a.prediction_id
      JOIN messages m ON m.id=p.message_id WHERE m.id=?`)
      .get(messageId);
    if (row) this.revoke(Number(row.chat_id), 'human_reported_false_positive');
  }
  feedbackChanged(messageId: number) {
    const row = this.db
      .prepare(`SELECT g.chat_id FROM active_samples s JOIN active_grants g ON g.evaluation_id=s.evaluation_id
      JOIN predictions p ON p.id=s.prediction_id WHERE p.message_id=?`)
      .get(messageId);
    if (row) this.revoke(Number(row.chat_id), 'evaluation_label_changed');
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
