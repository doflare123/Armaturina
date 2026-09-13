import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { SpamClassifier, sigmoid } from '../src/antispam/model.ts';
import { normalizeMessage } from '../src/antispam/normalizer.ts';
import { exportResearch, ResearchSummary } from '../src/antispam/research.ts';
import { ContextSignals, type SignalContext } from '../src/antispam/signals.ts';
import { SpamStore } from '../src/antispam/store.ts';
import { SpamTelegram } from '../src/antispam/telegram.ts';
import { InferenceTrace } from '../src/antispam/trace.ts';
import { trainModel } from '../src/antispam/training.ts';

const spam = 'Деньги реклама заработок купи сейчас акция';
const normal = 'Обсуждаем проект встреча завтра спасибо друзья';
const model = trainModel(
  Array.from({ length: 40 }, (_, i) => {
    const n = normalizeMessage(`${i < 20 ? spam : normal} ${i}`);
    return {
      text_hash: n.textHash,
      normalized_text: n.normalizedText,
      reduced_text: n.reducedText,
      label: i < 20 ? 1 : 0,
    };
  }),
  20,
  20,
);
function message(id: number, text = spam, chat = -12): Message {
  return {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chat, type: 'supergroup', title: 'test' },
    from: { id: 10, is_bot: false, first_name: 'User' },
    text,
  };
}

test('tracing preserves classifier and context scores and exposes real additive LR contributions', () => {
  const classifier = new SpamClassifier(model);
  for (const text of [spam, normal, '', '🦊'.repeat(20), 'а'.repeat(5000)]) {
    const trace = new InferenceTrace();
    const actual = classifier.assess(text, [], trace);
    assert.deepEqual(actual, classifier.assess(text));
    for (const stage of trace.stages) {
      if (stage.status === 'skipped') assert.equal(stage.duration_ms, null);
      else assert.ok(stage.duration_ms !== null && stage.duration_ms >= 0);
    }
    const attribution = trace.stages.find((s) => s.stage === 'logit_attribution');
    if (attribution) {
      const parts = attribution.result.logit_contributions as Record<string, number>;
      assert.ok(
        Math.abs(
          sigmoid(Object.values(parts).reduce((a, b) => a + b, 0)) - (actual.classifierScore ?? 0),
        ) < 1e-12,
      );
      assert.equal(trace.stages.find((s) => s.stage === 'char_tfidf')?.result.spam_score, null);
    }
    const markov = trace.stages.find((s) => s.stage === 'markov');
    if (actual.markovScore !== null) {
      assert.ok(markov);
      assert.equal(
        sigmoid(Number(markov.result.log_likelihood_ratio_per_transition)),
        actual.markovScore,
      );
    }
  }
  const now = Date.now(),
    n = normalizeMessage(spam);
  const context: SignalContext = {
    observed: 4,
    last60s: 4,
    last10m: 4,
    joinedAt: now - 1000,
    sinceJoin: 4,
    references: [{ id: 5, normalized_text: n.normalizedText, label: 1 }],
    recent: [10, 11, 12].map((user, i) => ({
      id: i + 1,
      user_id: user,
      changed_at: now,
      normalized_text: n.normalizedText,
      text_hash: n.textHash,
      raw_text: spam,
      metadata: '{}',
    })),
  };
  const engine = new ContextSignals(classifier),
    trace = new InferenceTrace();
  assert.deepEqual(
    engine.assess(spam, [], 10, now, context, trace),
    engine.assess(spam, [], 10, now, context),
  );
  assert.deepEqual(
    trace.stages.map((s) => s.stage),
    ['similarity_vector', 'similarity', 'campaigns', 'behavior'],
  );
});

test('legacy model reports skipped components and errors retain an elapsed stage without false scores', async () => {
  const classifier = new SpamClassifier({
    ...model,
    format: 1,
    weights: model.weights.slice(0, model.vocabulary.length),
  });
  const trace = new InferenceTrace();
  assert.deepEqual(classifier.assess(spam, [], trace), classifier.assess(spam));
  for (const name of ['word_tfidf', 'numeric_features', 'markov']) {
    assert.equal(trace.stages.find((s) => s.stage === name)?.status, 'skipped');
  }
  assert.throws(() =>
    trace.run('broken_compute', () => {
      throw new Error('private details');
    }),
  );
  await assert.rejects(
    trace.wait('broken_network', async () => {
      throw new Error('private details');
    }),
  );
  for (const stage of trace.stages.filter((s) => s.status === 'error')) {
    assert.ok(stage.duration_ms !== null && stage.duration_ms >= 0);
    assert.deepEqual(stage.result, { error: 'stage_failed' });
  }
});

test('adapter traces cold start, SHA continuation and edited revisions; labels and undo are export-time truth', async () => {
  const bot = new SpamTelegram(
    {
      getChatMember: async () => ({ status: 'member' }),
      sendMessage: async () => ({ message_id: 100 }),
      deleteMessage: async () => assert.fail('No automatic deletion in LEARNING'),
    } as unknown as Api,
    { databasePath: ':memory:', chatIds: [-12], retentionDays: 180 },
  );
  try {
    await bot.message(message(1), 'bot', 1);
    let rows = [...bot.store.researchRows(-12)];
    assert.equal(rows[0]?.outcome.status, 'cold_start');
    assert.equal(rows[0]?.prediction_id, null);
    assert.equal(rows[0]?.stages.find((s) => s.stage === 'logistic_regression')?.status, 'skipped');
    const referenceId = bot.store.capture(message(2));
    assert.ok(referenceId);
    const reference = bot.store.createCase(referenceId);
    bot.store.resolve(reference.id, 1, 'spam');
    bot.store.activateModel(-12, model, 'research-test');
    await bot.message(message(1), 'bot', 2);
    await bot.message(message(1), 'bot', 2);
    rows = [...bot.store.researchRows(-12)];
    assert.equal(rows.length, 2);
    const row = rows.find((r) => r.prediction_id !== null);
    assert.ok(row);
    const sha = row.stages.find((s) => s.stage === 'sha256_lookup');
    assert.equal(sha?.result.match_score, 1);
    assert.equal(sha?.result.terminal, false);
    assert.equal(sha?.result.used_in_decision, false);
    assert.equal(row.stages.find((s) => s.stage === 'logistic_regression')?.status, 'completed');
    assert.equal(row.true_label, null);
    assert.equal('raw_text' in row, false);
    assert.equal([...bot.store.researchRows(-99)].length, 0);
    const item = bot.store.createCase(Number(row.database_message_id));
    assert.ok(bot.store.resolve(item.id, 1, 'normal', Date.now() + 1));
    const labelled = [...bot.store.researchRows(-12)].find((r) => r.prediction_id !== null);
    assert.equal(labelled?.true_label, 'normal');
    assert.equal(labelled?.label_is_prospective, true);
    assert.equal([...bot.store.researchRows(-12, 100, true)][0]?.raw_text, spam);
    assert.ok(bot.store.undo(item.id, 1));
    assert.ok([...bot.store.researchRows(-12)].every((r) => r.true_label === null));
    await bot.edited({ ...message(1, normal), edit_date: Math.floor(Date.now() / 1000) + 1 }, 3);
    rows = [...bot.store.researchRows(-12)];
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r.revision)).size, 2);
    assert.ok(rows.every((r) => r.message_id === 1));
  } finally {
    bot.close();
  }
});

test('summary excludes leakage and conflicts, compares fixed variants and keeps thresholds separate', () => {
  type Row = Parameters<ResearchSummary['add']>[0];
  const base = {
    ...new InferenceTrace().finish(),
    model_version: 'v1',
    prediction_id: 1,
    outcome: { status: 'completed' },
    true_label: 'spam',
    label_is_prospective: true,
    seen_in_training_or_validation: false,
    protected_user: false,
    duplicate_group: 'a',
    threshold: 0.6,
    mode: 'SHADOW',
    dataset_size: 40,
    stages: [
      {
        stage: 'diagnostic_ablations',
        status: 'completed',
        duration_ms: 2,
        started_offset_ms: 0,
        result: { scores: { full: 0.8, lr: 0.4 } },
      },
    ],
  } as unknown as Row;
  const summary = new ResearchSummary();
  summary.add(base);
  summary.add(base); // exact duplicate is not a second true positive
  summary.add({ ...base, duplicate_group: 'b', true_label: 'normal' } as Row);
  summary.add({ ...base, duplicate_group: 'c', seen_in_training_or_validation: true } as Row);
  summary.add({ ...base, duplicate_group: 'd', protected_user: true } as Row);
  summary.add({ ...base, duplicate_group: 'e', true_label: null } as Row);
  summary.add({ ...base, duplicate_group: 'conflict' } as Row);
  summary.add({ ...base, duplicate_group: 'conflict', true_label: 'normal' } as Row);
  summary.add({ ...base, threshold: 0.9 } as Row);
  const groups = summary.finish().groups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.variants.full?.n, 2);
  assert.equal(groups[0]?.variants.full?.excluded_conflicting_groups, 1);
  assert.equal(groups[0]?.variants.full?.precision, 0.5);
  assert.equal(groups[0]?.variants.full?.falsePositiveRate, 1);
  assert.equal(groups[0]?.variants.lr?.fn, 1);
  assert.equal(groups[0]?.timings.diagnostic_ablations?.p95_ms, 2);
  assert.equal(groups[1]?.variants.full?.precision, null);
});

test('v8 migration, trace checkpoint update, local JSONL export and retention cascade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spam-research-')),
    path = join(dir, 'db.sqlite');
  let store = new SpamStore(path);
  store.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE inference_traces; PRAGMA user_version=8;');
  db.close();
  try {
    store = new SpamStore(path);
    const id = store.capture(message(1));
    assert.ok(id);
    const trace = new InferenceTrace();
    trace.outcome = { status: 'action_pending' };
    store.saveTrace(id, trace);
    trace.outcome.status = 'completed';
    store.saveTrace(id, trace);
    assert.equal([...store.researchRows(-12)].length, 1);
    assert.equal([...store.researchRows(-12)][0]?.outcome.status, 'completed');
    const output = join(dir, 'experiment.jsonl');
    assert.equal(exportResearch(store, -12, output).count, 1);
    const text = readFileSync(output, 'utf8');
    assert.equal(JSON.parse(text).message_id, 1);
    assert.equal(JSON.parse(readFileSync(`${output}.summary.json`, 'utf8')).groups.length, 1);
    assert.throws(() => exportResearch(store, -12, output), /EEXIST/);
    assert.equal(readFileSync(output, 'utf8'), text);
    store.prune(1, Date.now() + 2 * 86400000);
    assert.equal([...store.researchRows(-12)].length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
