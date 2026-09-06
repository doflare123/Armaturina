import { parentPort, workerData } from 'node:worker_threads';
import { trainModel } from './training.ts';

try {
  parentPort?.postMessage({ model: trainModel(workerData) });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Training failed' });
}
