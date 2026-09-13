import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface TraceStage {
  stage: string;
  status: 'completed' | 'skipped' | 'error';
  duration_ms: number | null;
  started_offset_ms: number;
  result: Record<string, unknown>;
}
export function scoreResult(score: number | null, kind: string, threshold = 0.5) {
  return {
    score_kind: kind,
    spam_score: score,
    normal_score: score === null ? null : 1 - score,
    calibrated_probability: false,
    predicted_label: score === null ? null : score >= threshold ? 'spam' : 'normal',
    threshold,
  };
}
/** Monotonic elapsed time. Stages are exclusive; total includes waits and instrumentation. */
export class InferenceTrace {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  private readonly start = performance.now();
  readonly stages: TraceStage[] = [];
  modelVersion: string | null = null;
  predictionId: number | null = null;
  metadata: Record<string, unknown> = {};
  outcome: Record<string, unknown> = { status: 'processing', action: 'none' };
  begin(stage: string) {
    const start = performance.now();
    return (result: Record<string, unknown>) =>
      this.stages.push({
        stage,
        status: 'completed',
        duration_ms: performance.now() - start,
        started_offset_ms: start - this.start,
        result,
      });
  }
  run<T>(
    stage: string,
    operation: () => T,
    describe: (value: T) => Record<string, unknown> = () => ({}),
  ): T {
    const start = performance.now();
    try {
      const value = operation(),
        end = performance.now();
      this.stages.push({
        stage,
        status: 'completed',
        duration_ms: end - start,
        started_offset_ms: start - this.start,
        result: describe(value),
      });
      return value;
    } catch (error) {
      this.stages.push({
        stage,
        status: 'error',
        duration_ms: performance.now() - start,
        started_offset_ms: start - this.start,
        result: { error: 'stage_failed' },
      });
      throw error;
    }
  }
  async wait<T>(
    stage: string,
    operation: () => Promise<T>,
    describe: (value: T) => Record<string, unknown> = () => ({}),
  ): Promise<T> {
    const start = performance.now();
    try {
      const value = await operation(),
        end = performance.now();
      this.stages.push({
        stage,
        status: 'completed',
        duration_ms: end - start,
        started_offset_ms: start - this.start,
        result: describe(value),
      });
      return value;
    } catch (error) {
      this.stages.push({
        stage,
        status: 'error',
        duration_ms: performance.now() - start,
        started_offset_ms: start - this.start,
        result: { error: 'stage_failed' },
      });
      throw error;
    }
  }
  skip(stage: string, reason: string) {
    this.stages.push({
      stage,
      status: 'skipped',
      duration_ms: null,
      started_offset_ms: performance.now() - this.start,
      result: { reason },
    });
  }
  finish() {
    const computeStages = new Set([
      'normalization',
      'char_tfidf',
      'word_tfidf',
      'numeric_features',
      'logistic_regression',
      'markov',
      'lr_markov_blend',
      'similarity_vector',
      'similarity',
      'campaigns',
      'behavior',
      'final_ensemble',
      'decision',
    ]);
    return {
      schema_version: 1,
      trace_id: this.id,
      started_at: new Date(this.startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      total_duration_ms: performance.now() - this.start,
      compute_stage_duration_ms: this.stages.reduce(
        (sum, s) => sum + (computeStages.has(s.stage) ? (s.duration_ms ?? 0) : 0),
        0,
      ),
      last_executed_stage: this.stages.findLast((s) => s.status !== 'skipped')?.stage ?? null,
      timing_scope: 'after_capture_and_prediction_dedup_to_action_completion_before_trace_write',
      timer: 'performance.now',
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      pipeline: 'ensemble_v1',
      model_version: this.modelVersion,
      prediction_id: this.predictionId,
      ...this.metadata,
      stages: this.stages,
      outcome: this.outcome,
    };
  }
}
export type ResearchTrace = ReturnType<InferenceTrace['finish']>;
