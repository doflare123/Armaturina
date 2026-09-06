import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from 'grammy/types';
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
      if (version !== 0 && version !== 1) throw new Error('Unsupported antispam schema version');
      if (version === 0) this.migrate();
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

  capture(message: Message): number | null {
    const raw = message.text ?? message.caption;
    if (raw === undefined || !raw.trim()) return null;
    const text = normalizeMessage(raw);
    // Preserve the exact first observed version. Edits must not silently change a labeled sample.
    this.db
      .prepare(`INSERT INTO messages
      (chat_id,telegram_message_id,user_id,sender_chat_id,username,raw_text,normalized_text,
       reduced_text,text_hash,normalizer_version,metadata,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,telegram_message_id) DO NOTHING`)
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
        JSON.stringify({
          edit_date: message.edit_date ?? null,
          reply_to_message_id: message.reply_to_message?.message_id ?? null,
          has_photo: !!message.photo,
          has_video: !!message.video,
          has_document: !!message.document,
          entities: message.entities ?? message.caption_entities ?? [],
          forward_info: message.forward_origin ?? null,
        }),
        message.date * 1000,
      );
    const row = this.db
      .prepare(
        'SELECT id,raw_text,metadata FROM messages WHERE chat_id=? AND telegram_message_id=?',
      )
      .get(message.chat.id, message.message_id);
    if (
      row?.raw_text !== raw ||
      JSON.parse(String(row.metadata)).edit_date !== (message.edit_date ?? null)
    ) {
      this.invalidateEdited(message);
      return null;
    }
    return Number(row?.id);
  }

  createCase(messageId: number, now = Date.now()): ReviewCase {
    this.expire(now);
    this.db
      .prepare(`INSERT INTO moderation_cases(id,message_id,created_at,expires_at)
      VALUES (?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(randomUUID(), messageId, now, now + 30 * 60_000);
    return this.db
      .prepare(`SELECT c.*,m.chat_id,m.telegram_message_id,m.user_id,m.sender_chat_id,m.raw_text
      FROM moderation_cases c JOIN messages m ON m.id=c.message_id WHERE c.message_id=?
      ORDER BY c.rowid DESC LIMIT 1`)
      .get(messageId) as unknown as ReviewCase;
  }

  getCase(id: string): ReviewCase | undefined {
    return this.db
      .prepare(`SELECT c.*,m.chat_id,m.telegram_message_id,m.user_id,m.sender_chat_id,m.raw_text
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
        deletion_status=? WHERE id=? AND status='PENDING'`)
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
    return this.db.prepare('SELECT * FROM training_dataset WHERE chat_id=?').all(chatId);
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

  invalidateEdited(message: Message) {
    this.db
      .prepare(`UPDATE moderation_cases SET status='EXPIRED' WHERE status='PENDING'
      AND message_id IN (SELECT id FROM messages WHERE chat_id=? AND telegram_message_id=?)`)
      .run(message.chat.id, message.message_id);
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
