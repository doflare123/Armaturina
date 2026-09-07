import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from 'grammy/types';
import { type ModelArtifact, type Sample, validateModel } from './model.ts';
import { normalizeMessage } from './normalizer.ts';

export type Verdict = 'spam' | 'normal' | 'skip';
export interface ReviewCase {
  id: string;
  message_id: number;
  chat_id: number;
  telegram_message_id: number | null;
  user_id: number | null;
  sender_chat_id: number | null;
  raw_text: string;
  status: string;
  card_id: number | null;
  expires_at: number;
  revision: number;
  metadata: string;
}

/** SQLite owns arbitration; no network request is made inside a transaction. */
export class SpamStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
        throw new Error('Unsupported antispam schema version');
      if (version === 0) this.migrate();
      if (version === 0 || version === 1) this.migrateModels();
      if (version === 0 || version === 1 || version === 2) this.migrateRevisions();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate() {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, telegram_message_id INTEGER,
        user_id INTEGER, sender_chat_id INTEGER, username TEXT,
        raw_text TEXT NOT NULL, normalized_text TEXT NOT NULL, reduced_text TEXT NOT NULL,
        text_hash TEXT NOT NULL, normalizer_version INTEGER NOT NULL,
        metadata TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(chat_id, telegram_message_id)
      );
      CREATE INDEX messages_hash ON messages(chat_id, text_hash);
      CREATE INDEX messages_age ON messages(created_at);
      CREATE TABLE moderation_cases (
        id TEXT PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN
          ('PENDING','RESOLVED_SPAM','RESOLVED_NORMAL','SKIPPED','EXPIRED','UNDONE')),
        card_id INTEGER, resolved_by INTEGER, resolved_at INTEGER,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        deletion_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
          CHECK(deletion_status IN ('NOT_REQUESTED','PENDING','DELETED','FAILED'))
      );
      CREATE INDEX cases_status ON moderation_cases(status, expires_at);
      CREATE UNIQUE INDEX cases_message ON moderation_cases(message_id) WHERE status <> 'UNDONE';
      CREATE TABLE labels (
        id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        label INTEGER NOT NULL CHECK(label IN (0,1)),
        source TEXT NOT NULL CHECK(source IN ('ADMIN_CONFIRMED','ADMIN_REJECTED','BOOTSTRAP','AUTO_PREDICTION')),
        admin_id INTEGER, created_at INTEGER NOT NULL,
        CHECK((source='ADMIN_CONFIRMED' AND label=1 AND admin_id IS NOT NULL)
          OR (source='ADMIN_REJECTED' AND label=0 AND admin_id IS NOT NULL)
          OR source IN ('BOOTSTRAP','AUTO_PREDICTION'))
      );
      CREATE TABLE feedback_audit (
        id INTEGER PRIMARY KEY, case_id TEXT NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
        admin_id INTEGER NOT NULL, verdict TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE VIEW training_dataset AS
        SELECT m.chat_id, m.text_hash, MIN(m.normalized_text) AS normalized_text,
          MIN(m.reduced_text) AS reduced_text, MIN(l.label) AS label, COUNT(*) AS duplicate_count
        FROM messages m JOIN labels l ON l.message_id=m.id
        WHERE l.source IN ('ADMIN_CONFIRMED','ADMIN_REJECTED','BOOTSTRAP')
        GROUP BY m.chat_id, m.text_hash
        HAVING MIN(l.label)=MAX(l.label);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }

  private migrateModels() {
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE model_versions (
        version TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, trained_at INTEGER NOT NULL,
        artifact_json TEXT NOT NULL, metrics_json TEXT NOT NULL, dataset_hash TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1))
      );
      CREATE UNIQUE INDEX model_active_chat ON model_versions(chat_id) WHERE active=1;
      CREATE TABLE predictions (
        id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        model_version TEXT NOT NULL REFERENCES model_versions(version),
        classifier_score REAL CHECK(classifier_score BETWEEN 0 AND 1),
        decision TEXT NOT NULL CHECK(decision IN ('ALLOW','ASK_ADMIN')),
        reason TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      ALTER TABLE moderation_cases ADD COLUMN prediction_id INTEGER REFERENCES predictions(id) ON DELETE SET NULL;
      PRAGMA user_version=2;
      COMMIT;`);
  }

  activeModel(chatId: number, knownVersion?: string) {
    return this.db
      .prepare(
        'SELECT version,artifact_json,metrics_json FROM model_versions WHERE chat_id=? AND active=1 AND version<>?',
      )
      .get(chatId, knownVersion ?? '') as
      | { version: string; artifact_json: string; metrics_json: string }
      | undefined;
  }

  private migrateRevisions() {
    this.db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE messages ADD COLUMN source_message_id INTEGER;
      ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN last_update_id INTEGER;
      UPDATE messages SET source_message_id=telegram_message_id;
      CREATE INDEX messages_revisions ON messages(chat_id,source_message_id,revision);
      PRAGMA user_version=3;
      COMMIT;`);
  }

  isCurrent(messageId: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM messages WHERE id=? AND telegram_message_id IS NOT NULL')
      .get(messageId);
  }

  activateModel(chatId: number, input: ModelArtifact, datasetHash: string): string {
    const model = validateModel(input);
    const version = randomUUID();
    this.transaction(() => {
      this.db.prepare('UPDATE model_versions SET active=0 WHERE chat_id=?').run(chatId);
      this.db
        .prepare('INSERT INTO model_versions VALUES (?,?,?,?,?,?,1)')
        .run(
          version,
          chatId,
          Date.now(),
          JSON.stringify(model),
          JSON.stringify(model.metrics),
          datasetHash,
        );
    });
    return version;
  }

  prediction(
    messageId: number,
    version: string,
    score: number | null,
    decision: string,
    reason: string,
  ): number | null {
    const inserted = this.db
      .prepare(`INSERT INTO predictions(message_id,model_version,classifier_score,decision,reason,created_at)
      SELECT id,?,?,?,?,? FROM messages WHERE id=? AND telegram_message_id IS NOT NULL
      AND chat_id=(SELECT chat_id FROM model_versions WHERE version=?)
      ON CONFLICT(message_id) DO NOTHING`)
      .run(version, score, decision, reason, Date.now(), messageId, version);
    return inserted.changes ? Number(inserted.lastInsertRowid) : null;
  }

  canPropose(chatId: number, now = Date.now()): boolean {
    this.expire(now);
    const row = this.db
      .prepare(`SELECT COUNT(CASE WHEN c.status='PENDING' THEN 1 END) AS pending,
      MAX(CASE WHEN c.prediction_id IS NOT NULL THEN c.created_at END) AS last
      FROM moderation_cases c JOIN messages m ON m.id=c.message_id WHERE m.chat_id=?`)
      .get(chatId);
    return Number(row?.pending ?? 0) < 20 && Number(row?.last ?? 0) <= now - 60_000;
  }

  capture(message: Message, updateId?: number): number | null {
    const raw = message.text ?? message.caption ?? '';
    const text = normalizeMessage(raw);
    const metadata = {
      edit_date: message.edit_date ?? null,
      reply_to_message_id: message.reply_to_message?.message_id ?? null,
      has_photo: !!message.photo,
      has_video: !!message.video,
      has_document: !!message.document,
      entities: message.entities ?? message.caption_entities ?? [],
      forward_info: message.forward_origin ?? null,
      media_id:
        message.photo?.at(-1)?.file_unique_id ??
        message.video?.file_unique_id ??
        message.document?.file_unique_id ??
        null,
    };
    return this.transaction(() => {
      const previous = this.db
        .prepare('SELECT * FROM messages WHERE chat_id=? AND telegram_message_id=?')
        .get(message.chat.id, message.message_id);
      let revision = 0;
      if (previous) {
        const old = JSON.parse(String(previous.metadata));
        const oldDate = Number(old.edit_date ?? message.date),
          newDate = message.edit_date ?? message.date;
        if (newDate < oldDate) return null;
        const same =
          previous.raw_text === raw &&
          JSON.stringify(old.entities ?? []) === JSON.stringify(metadata.entities) &&
          !!old.has_photo === metadata.has_photo &&
          !!old.has_video === metadata.has_video &&
          !!old.has_document === metadata.has_document &&
          (old.media_id === undefined || old.media_id === metadata.media_id);
        if (newDate === oldDate && same) {
          if (updateId !== undefined)
            this.db
              .prepare(
                'UPDATE messages SET last_update_id=MAX(COALESCE(last_update_id,?),?) WHERE id=?',
              )
              .run(updateId, updateId, Number(previous.id));
          return raw.trim() ? Number(previous.id) : null;
        }
        if (
          newDate === oldDate &&
          (updateId === undefined ||
            previous.last_update_id === null ||
            updateId <= Number(previous.last_update_id))
        )
          return null;
        // Archive the snapshot, preserving its label/prediction/audit. Only the newest
        // snapshot retains the unique (chat_id,telegram_message_id) slot.
        this.db
          .prepare(
            "UPDATE moderation_cases SET status='EXPIRED' WHERE message_id=? AND status='PENDING'",
          )
          .run(Number(previous.id));
        this.db
          .prepare('UPDATE messages SET telegram_message_id=NULL WHERE id=?')
          .run(Number(previous.id));
        revision = Number(previous.revision) + 1;
      } else if (!raw.trim()) return null;
      const result = this.db
        .prepare(`INSERT INTO messages
        (chat_id,telegram_message_id,user_id,sender_chat_id,username,raw_text,normalized_text,
         reduced_text,text_hash,normalizer_version,metadata,created_at,source_message_id,revision,last_update_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          message.chat.id,
          message.message_id,
          message.from?.id ?? null,
          message.sender_chat?.id ?? null,
          message.from?.username ?? null,
          raw,
          text.normalizedText,
          text.reducedText,
          text.textHash,
          text.normalizerVersion,
          JSON.stringify(metadata),
          message.date * 1000,
          message.message_id,
          revision,
          updateId ?? null,
        );
      return raw.trim() ? Number(result.lastInsertRowid) : null;
    });
  }

  createCase(messageId: number, now = Date.now(), predictionId: number | null = null): ReviewCase {
    if (!this.isCurrent(messageId)) throw new Error('Message revision is no longer current');
    this.expire(now);
    this.db
      .prepare(`INSERT INTO moderation_cases(id,message_id,created_at,expires_at,prediction_id)
      VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(randomUUID(), messageId, now, now + 30 * 60_000, predictionId);
    return this.db
      .prepare(`SELECT c.*,m.chat_id,COALESCE(m.telegram_message_id,m.source_message_id) AS telegram_message_id,
      m.user_id,m.sender_chat_id,m.raw_text,m.revision,m.metadata
      FROM moderation_cases c JOIN messages m ON m.id=c.message_id WHERE c.message_id=?
      ORDER BY c.rowid DESC LIMIT 1`)
      .get(messageId) as unknown as ReviewCase;
  }

  getCase(id: string): ReviewCase | undefined {
    return this.db
      .prepare(`SELECT c.*,m.chat_id,COALESCE(m.telegram_message_id,m.source_message_id) AS telegram_message_id,
      m.user_id,m.sender_chat_id,m.raw_text,m.revision,m.metadata
      FROM moderation_cases c JOIN messages m ON m.id=c.message_id WHERE c.id=?`)
      .get(id) as unknown as ReviewCase | undefined;
  }

  bindCard(id: string, cardId: number) {
    this.db
      .prepare('UPDATE moderation_cases SET card_id=? WHERE id=? AND card_id IS NULL')
      .run(cardId, id);
  }

  resolve(id: string, adminId: number, verdict: Verdict, now = Date.now()): boolean {
    if (!['spam', 'normal', 'skip'].includes(verdict)) throw new Error('Invalid verdict');
    return this.transaction(() => {
      this.expire(now);
      const status =
        verdict === 'spam' ? 'RESOLVED_SPAM' : verdict === 'normal' ? 'RESOLVED_NORMAL' : 'SKIPPED';
      const result = this.db
        .prepare(`UPDATE moderation_cases SET status=?,resolved_by=?,resolved_at=?,
        deletion_status=? WHERE id=? AND status='PENDING'
        AND message_id IN (SELECT id FROM messages WHERE telegram_message_id IS NOT NULL)`)
        .run(status, adminId, now, verdict === 'spam' ? 'PENDING' : 'NOT_REQUESTED', id);
      if (!result.changes) return false;
      if (verdict !== 'skip') {
        this.db
          .prepare(`INSERT INTO labels(message_id,label,source,admin_id,created_at)
          SELECT message_id,?,?,?,? FROM moderation_cases WHERE id=?`)
          .run(
            verdict === 'spam' ? 1 : 0,
            verdict === 'spam' ? 'ADMIN_CONFIRMED' : 'ADMIN_REJECTED',
            adminId,
            now,
            id,
          );
      }
      this.db
        .prepare('INSERT INTO feedback_audit(case_id,admin_id,verdict,created_at) VALUES (?,?,?,?)')
        .run(id, adminId, verdict, now);
      return true;
    });
  }

  undo(id: string, adminId: number, now = Date.now()): boolean {
    return this.transaction(() => {
      const changed = this.db
        .prepare(`UPDATE moderation_cases SET status='UNDONE'
        WHERE id=? AND status IN ('RESOLVED_SPAM','RESOLVED_NORMAL','SKIPPED')`)
        .run(id);
      if (!changed.changes) return false;
      this.db
        .prepare(
          'DELETE FROM labels WHERE message_id=(SELECT message_id FROM moderation_cases WHERE id=?)',
        )
        .run(id);
      this.db
        .prepare('INSERT INTO feedback_audit(case_id,admin_id,verdict,created_at) VALUES (?,?,?,?)')
        .run(id, adminId, 'undo', now);
      return true;
    });
  }

  recordDeletion(id: string, success: boolean) {
    this.db
      .prepare('UPDATE moderation_cases SET deletion_status=? WHERE id=?')
      .run(success ? 'DELETED' : 'FAILED', id);
  }

  importBootstrap(chatId: number, input: unknown, now = Date.now()): number {
    if (!Number.isSafeInteger(chatId) || chatId >= 0) throw new Error('Expected group chat ID');
    if (!Array.isArray(input) || input.length > 10_000)
      throw new Error('Expected array of at most 10000 samples');
    const samples = input.map((item: unknown) => {
      if (
        !item ||
        typeof item !== 'object' ||
        !('text' in item) ||
        !('label' in item) ||
        typeof item.text !== 'string' ||
        !item.text.trim() ||
        item.text.length > 16_384 ||
        (item.label !== 'spam' && item.label !== 'normal')
      )
        throw new Error('Invalid bootstrap sample');
      return { ...normalizeMessage(item.text), label: item.label === 'spam' ? 1 : 0 };
    });
    return this.transaction(() => {
      let imported = 0;
      for (const sample of samples) {
        const existing = this.db
          .prepare(`SELECT l.label FROM messages m JOIN labels l ON l.message_id=m.id
          WHERE m.chat_id=? AND m.text_hash=? AND l.source IN ('ADMIN_CONFIRMED','ADMIN_REJECTED','BOOTSTRAP')`)
          .all(chatId, sample.textHash);
        if (existing.some((row) => row.label !== sample.label))
          throw new Error('Conflicting bootstrap labels');
        if (existing.length) continue;
        const row = this.db
          .prepare(`INSERT INTO messages(chat_id,raw_text,normalized_text,reduced_text,
          text_hash,normalizer_version,metadata,created_at) VALUES (?,?,?,?,?,1,'{}',?)`)
          .run(
            chatId,
            sample.rawText,
            sample.normalizedText,
            sample.reducedText,
            sample.textHash,
            now,
          );
        this.db
          .prepare(
            "INSERT INTO labels(message_id,label,source,created_at) VALUES (?,?,'BOOTSTRAP',?)",
          )
          .run(row.lastInsertRowid, sample.label, now);
        imported++;
      }
      return imported;
    });
  }

  dataset(chatId: number) {
    return this.db
      .prepare(`SELECT d.*, m.raw_text, m.metadata FROM training_dataset d
        JOIN messages m ON m.id=(SELECT MIN(candidate.id) FROM messages candidate
          JOIN labels l ON l.message_id=candidate.id
          WHERE candidate.chat_id=d.chat_id AND candidate.text_hash=d.text_hash
          AND l.source IN ('ADMIN_CONFIRMED','ADMIN_REJECTED','BOOTSTRAP'))
        WHERE d.chat_id=? ORDER BY d.text_hash`)
      .all(chatId) as unknown as Sample[];
  }

  stats(chatId: number) {
    this.expire(Date.now());
    return this.db
      .prepare(`SELECT
      (SELECT COUNT(*) FROM messages WHERE chat_id=?) AS messages,
      (SELECT COUNT(*) FROM training_dataset WHERE chat_id=? AND label=1) AS spam,
      (SELECT COUNT(*) FROM training_dataset WHERE chat_id=? AND label=0) AS normal,
      (SELECT COUNT(*) FROM moderation_cases c JOIN messages m ON m.id=c.message_id
        WHERE m.chat_id=? AND c.status='PENDING') AS pending`)
      .get(chatId, chatId, chatId, chatId);
  }

  expire(now: number) {
    this.db
      .prepare(
        "UPDATE moderation_cases SET status='EXPIRED' WHERE status='PENDING' AND expires_at<=?",
      )
      .run(now);
  }

  prune(retentionDays: number, now = Date.now()) {
    this.db
      .prepare('DELETE FROM messages WHERE created_at<?')
      .run(now - retentionDays * 86_400_000);
    this.expire(now);
  }

  close() {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
