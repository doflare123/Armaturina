import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { activeAction } from '../src/antispam/decision.ts';
import { charCounts, type ModelArtifact, SpamClassifier } from '../src/antispam/model.ts';
import { ContextSignals } from '../src/antispam/signals.ts';
import { SpamStore } from '../src/antispam/store.ts';
import { SpamTelegram } from '../src/antispam/telegram.ts';

const text = 'купите рекламу прямо сейчас большая скидка';
const vocabulary = [...charCounts(text).keys()];
const model: ModelArtifact = {
  format: 1,
  normalizerVersion: 1,
  vocabulary,
  idf: vocabulary.map(() => 1),
  weights: vocabulary.map(() => 0),
  intercept: 8,
  metrics: { tp: 5, fp: 0, tn: 5, fn: 0, precision: 1, recall: 1, f1: 1, falsePositiveRate: 0 },
  iterations: 1,
  spamSamples: 20,
  normalSamples: 20,
  trainHashes: Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(64, '0')),
  validationHashes: Array.from({ length: 10 }, (_, i) => (i + 30).toString(16).padStart(64, '0')),
};
const signals = new ContextSignals(new SpamClassifier(model)).assess(text, [], 10, Date.now(), {
  observed: 1,
  last60s: 1,
  last10m: 1,
  joinedAt: null,
  sinceJoin: null,
  recent: [],
  references: [],
});
function message(id: number, raw = text, user = 10): Message {
  return {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -12, type: 'supergroup', title: 'test' },
    from: { id: user, is_bot: false, first_name: 'User' },
    text: raw,
  };
}
function fixture(positive = 200, falsePositives = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'spam-active-')),
    file = join(dir, 'db.sqlite');
  const deleted: number[] = [],
    responses: string[] = [];
  const state = { admin: true, rights: true, fail: false, targetAdmin: false, onTarget: () => {} };
  const api = {
    getMe: async () => ({ id: 999 }),
    getChatMember: async (_: number, id: number) => {
      if (id === 10) state.onTarget();
      return {
        status:
          id === 999 || (id === 1 && state.admin) || (id === 10 && state.targetAdmin)
            ? 'administrator'
            : 'member',
        can_delete_messages: state.rights,
        user: { id, is_bot: id === 999, first_name: 'User' },
      };
    },
    sendMessage: async (_: number, value: string) => {
      responses.push(value);
      return { message_id: 90000 + responses.length };
    },
    deleteMessage: async (_: number, id: number) => {
      deleted.push(id);
      if (state.fail) throw new Error('Timeout');
    },
  } as unknown as Api;
  const bot = new SpamTelegram(api, { databasePath: file, chatIds: [-12], retentionDays: 180 });
  const store = bot.store,
    safety = store.governance.active;
  const version = store.activateModel(-12, model, 'test');
  store.governance.setThreshold(-12, version, 0.95, 1);
  const evaluation = safety.prepare(-12, version, 1);
  const db = new DatabaseSync(file);
  const insert = db.prepare(
    'INSERT INTO labels(message_id,label,source,admin_id,created_at) VALUES (?,?,?,?,?)',
  );
  for (let i = 0; i < 1000; i++) {
    const id = store.capture(
      message(i + 1, `контрольный уникальный образец ${String(i).split('').join('_')}`),
    );
    assert.ok(id);
    const score = i < positive ? 0.99 : 0.1;
    store.prediction(
      id,
      version,
      score,
      score >= 0.95 ? 'ASK_ADMIN' : 'ALLOW',
      'test',
      null,
      score,
      signals,
      { mode: 'SHADOW', threshold: 0.95 },
    );
    const label = i < positive - falsePositives ? 1 : 0;
    insert.run(id, label, label ? 'ADMIN_CONFIRMED' : 'ADMIN_REJECTED', 1, Date.now() + 1);
  }
  return {
    bot,
    file,
    store,
    safety,
    version,
    evaluation,
    db,
    deleted,
    responses,
    state,
    close() {
      bot.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('ACTIVE needs a checked complete prospective cohort and explicit enable; precision and FPR both gate', () => {
  for (const [positive, fp, passed] of [
    [200, 0, true],
    [200, 5, false],
    [600, 5, false],
  ] as const) {
    const f = fixture(positive, fp);
    try {
      assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
      assert.throws(() => f.safety.enable(-12, f.evaluation, 1));
      const report = f.safety.check(-12, f.evaluation, 1);
      assert.equal(report.passed, passed);
      if (passed) {
        assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
        f.safety.enable(-12, f.evaluation, 1);
        assert.equal(f.store.governance.policy(-12, f.version).mode, 'ACTIVE');
        assert.equal(f.store.governance.policy(-12, 'unrelated_version').mode, 'SHADOW');
        const reopened = new SpamStore(f.file);
        try {
          assert.equal(reopened.governance.policy(-12, f.version).mode, 'ACTIVE');
        } finally {
          reopened.close();
        }
        f.db.prepare('DELETE FROM labels WHERE message_id=1000').run();
        assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
      } else assert.throws(() => f.safety.enable(-12, f.evaluation, 1));
      assert.throws(() => f.safety.enable(-99, f.evaluation, 1));
    } finally {
      f.close();
    }
  }
});

test('ACTIVE command requires a current admin and bot delete permission; no automatic training labels', async () => {
  const f = fixture();
  try {
    f.safety.check(-12, f.evaluation, 1);
    await f.bot.message(message(5001, `/spam active enable ${f.evaluation}`, 10), 'bot');
    assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
    f.state.rights = false;
    await f.bot.message(message(5002, `/spam active enable ${f.evaluation}`, 1), 'bot');
    assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
    f.state.rights = true;
    await f.bot.message(message(5003, `/spam active enable ${f.evaluation}`, 1), 'bot');
    assert.equal(f.store.governance.policy(-12, f.version).mode, 'ACTIVE');
    await f.bot.message(message(6001), 'bot');
    await f.bot.message(message(6001), 'bot');
    await f.bot.message(message(6002), 'bot');
    assert.deepEqual(f.deleted, [6001]);
    assert.equal(f.db.prepare('SELECT status FROM active_actions').get()?.status, 'DELETED');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM labels').get()?.n, 1000);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM moderation_cases').get()?.n, 0);
    const action = f.safety.log(-12)[0];
    assert.ok(action);
    assert.equal(f.safety.reviewMessage(-99, action.prediction_id), null);
    const review = f.store.createCase(action.message_id);
    assert.ok(f.store.resolve(review.id, 1, 'normal'));
    assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
  } finally {
    f.close();
  }
});

test('revoked admin, changed permissions, protected author and edited snapshot prevent ACTIVE deletion', async () => {
  for (const kind of ['admin', 'rights', 'target', 'edit'] as const) {
    const f = fixture();
    try {
      f.safety.check(-12, f.evaluation, 1);
      f.safety.enable(-12, f.evaluation, 1);
      if (kind === 'admin') f.state.admin = false;
      if (kind === 'rights') f.state.rights = false;
      if (kind === 'target') f.state.targetAdmin = true;
      if (kind === 'edit') {
        let calls = 0;
        f.state.onTarget = () => {
          if (++calls === 2)
            f.store.capture(
              {
                ...message(6001, 'обычный исправленный текст'),
                edit_date: Math.floor(Date.now() / 1000) + 1,
              },
              999,
            );
        };
      }
      await f.bot.message(message(6001), 'bot', 100);
      assert.deepEqual(f.deleted, []);
      if (kind === 'admin' || kind === 'rights')
        assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
    } finally {
      f.close();
    }
  }
});

test('failed or unknown deletion is logged once and downgrades to SHADOW', async () => {
  const f = fixture();
  try {
    f.safety.check(-12, f.evaluation, 1);
    f.safety.enable(-12, f.evaluation, 1);
    f.state.fail = true;
    await f.bot.message(message(6001), 'bot');
    await f.bot.message(message(6001), 'bot');
    assert.deepEqual(f.deleted, [6001]);
    assert.equal(
      f.db.prepare('SELECT status FROM active_actions').get()?.status,
      'FAILED_OR_UNKNOWN',
    );
    assert.equal(f.store.governance.policy(-12, f.version).mode, 'SHADOW');
  } finally {
    f.close();
  }
});

test('threshold changes, model replacement, expiry and valid artifact tampering revoke approval', () => {
  for (const change of ['threshold', 'model', 'expiry', 'artifact'] as const) {
    const f = fixture();
    try {
      f.safety.check(-12, f.evaluation, 1);
      f.safety.enable(-12, f.evaluation, 1);
      if (change === 'threshold') f.store.governance.setThreshold(-12, f.version, 0.95, 1);
      if (change === 'model') f.store.activateModel(-12, model, 'new');
      if (change === 'expiry') f.db.prepare('UPDATE active_grants SET expires_at=0').run();
      if (change === 'artifact')
        f.db
          .prepare('UPDATE model_versions SET artifact_json=?')
          .run(JSON.stringify({ ...model, intercept: 7 }));
      assert.equal(
        f.store.governance.policy(-12, f.store.activeModel(-12)?.version ?? '').mode,
        'SHADOW',
      );
    } finally {
      f.close();
    }
  }
});

test('DecisionEngine needs ACTIVE approval, a valid high threshold, and an unprotected author', () => {
  assert.equal(activeAction(0.99, false, 0.95, true), 'DELETE');
  for (const value of [null, NaN, Infinity, -1, 1.1, 0.94])
    assert.equal(activeAction(value, false, 0.95, true), 'NONE');
  assert.equal(activeAction(1, true, 0.95, true), 'NONE');
  assert.equal(activeAction(1, false, 0.6, true), 'NONE');
  assert.equal(activeAction(1, false, 0.95, false), 'NONE');
});
