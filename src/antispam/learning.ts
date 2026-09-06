import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { type ModelArtifact, type Sample, SpamClassifier } from './model.ts';
import type { SpamStore } from './store.ts';
import { splitDataset } from './training.ts';

function fingerprint(samples: Sample[]): string {
  return createHash('sha256').update(JSON.stringify(samples)).digest('hex');
}

/** One training worker per bot, separate models per group; no synchronous training in handlers. */
export class LearningService {
  private readonly store: SpamStore;
  private readonly cache = new Map<number, { version: string; classifier: SpamClassifier }>();
  private worker: Worker | null = null;
  private closed = false;
  constructor(store: SpamStore) {
    this.store = store;
  }

  current(chatId: number) {
    const cached = this.cache.get(chatId);
    const row = this.store.activeModel(chatId, cached?.version);
    if (row) {
      try {
        this.cache.set(chatId, {
          version: row.version,
          classifier: new SpamClassifier(JSON.parse(row.artifact_json)),
        });
      } catch {
        console.error('antispam_model_load_failed');
      }
    }
    return this.cache.get(chatId);
  }

  train(chatId: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Service closed'));
    if (this.worker) return Promise.reject(new Error('Обучение уже выполняется.'));
    const samples = this.store.dataset(chatId);
    if (samples.length > 10_000)
      return Promise.reject(
        new Error('Лимит обучения — 10000 уникальных примеров. Сократите период хранения.'),
      );
    const split = splitDataset(samples);
    if (split.spam < 50 || split.normal < 200)
      return Promise.reject(
        new Error(`COLD_START: уникальных spam ${split.spam}/50, normal ${split.normal}/200.`),
      );
    const hash = fingerprint(samples);
    // URL points to .ts in source runs and .js in compiled runs.
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = new Worker(new URL(`./trainWorker.${extension}`, import.meta.url), {
      workerData: samples,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(
        () => finish(new Error('Training timed out; previous model retained')),
        120_000,
      );
      const finish = (error?: Error, version?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.worker = null;
        void worker.terminate();
        if (error) reject(error);
        else resolve(version ?? '');
      };
      worker.once('error', () =>
        finish(new Error('Training worker failed; previous model retained')),
      );
      worker.once('exit', () =>
        finish(new Error('Training worker stopped; previous model retained')),
      );
      worker.once('message', (result: { model?: ModelArtifact; error?: string }) => {
        if (finished) return;
        try {
          if (this.closed) throw new Error('Service closed');
          if (!result.model) throw new Error(result.error ?? 'Training failed');
          if (fingerprint(this.store.dataset(chatId)) !== hash)
            throw new Error('Разметка изменилась во время обучения. Повторите /spam train.');
          const classifier = new SpamClassifier(result.model);
          const version = this.store.activateModel(chatId, result.model, hash);
          this.cache.set(chatId, { version, classifier });
          finish(undefined, version);
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Training failed'));
        }
      });
    });
  }

  close() {
    this.closed = true;
    if (this.worker) void this.worker.terminate();
    this.cache.clear();
  }
}
