import { closeSync, openSync, writeFileSync } from 'node:fs';
import { quality } from './governance.ts';
import type { SpamStore } from './store.ts';

type ExportRow = ReturnType<SpamStore['researchRows']> extends Generator<infer T> ? T : never;
type VariantRow = { score: number; label: number; group: string };
function timing(values: number[]) {
  if (!values.length)
    return { n: 0, mean_ms: null, p50_ms: null, p95_ms: null, min_ms: null, max_ms: null };
  values.sort((a, b) => a - b);
  const percentile = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
  return {
    n: values.length,
    mean_ms: values.reduce((s, v) => s + v, 0) / values.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    min_ms: values[0],
    max_ms: values.at(-1),
  };
}
export class ResearchSummary {
  private readonly groups = new Map<
    string,
    {
      rows: number;
      labelled: number;
      timings: Map<string, number[]>;
      skipped: Map<string, number>;
      errors: Map<string, number>;
      outcomes: Map<string, number>;
      variants: Map<string, VariantRow[]>;
      threshold: number;
    }
  >();
  add(row: ExportRow) {
    const meta = row as unknown as Record<string, unknown>;
    const threshold = typeof meta.threshold === 'number' ? meta.threshold : 0.6;
    const key = JSON.stringify({
      model_version: row.model_version,
      context_policy_version: meta.context_policy_version ?? null,
      threshold,
      mode: meta.mode ?? null,
      dataset_size: meta.dataset_size ?? null,
    });
    let group = this.groups.get(key);
    if (!group) {
      group = {
        rows: 0,
        labelled: 0,
        timings: new Map(),
        skipped: new Map(),
        errors: new Map(),
        outcomes: new Map(),
        variants: new Map(),
        threshold,
      };
      this.groups.set(key, group);
    }
    group.rows++;
    const outcome = String(row.outcome.status);
    group.outcomes.set(outcome, (group.outcomes.get(outcome) ?? 0) + 1);
    const eligible =
      row.prediction_id !== null &&
      row.outcome.status === 'completed' &&
      row.true_label !== null &&
      row.label_is_prospective &&
      meta.seen_in_training_or_validation === false &&
      meta.protected_user === false;
    if (eligible) group.labelled++;
    for (const stage of row.stages) {
      if (stage.status === 'completed' && stage.duration_ms !== null) {
        const values = group.timings.get(stage.stage) ?? [];
        values.push(stage.duration_ms);
        group.timings.set(stage.stage, values);
      } else if (stage.status === 'skipped')
        group.skipped.set(stage.stage, (group.skipped.get(stage.stage) ?? 0) + 1);
      else if (stage.status === 'error')
        group.errors.set(stage.stage, (group.errors.get(stage.stage) ?? 0) + 1);
    }
    for (const [name, value] of [
      ['total_duration', row.total_duration_ms],
      ['compute_stages', row.compute_stage_duration_ms],
    ] as const) {
      const values = group.timings.get(name) ?? [];
      values.push(value);
      group.timings.set(name, values);
    }
    if (!eligible) return;
    const ablation = row.stages.find((s) => s.stage === 'diagnostic_ablations')?.result.scores as
      | Record<string, number | null>
      | undefined;
    const markov = row.stages.find((s) => s.stage === 'markov')?.result.spam_score;
    const variants = { ...ablation, markov_only: typeof markov === 'number' ? markov : null };
    for (const [name, score] of Object.entries(variants)) {
      if (score === null || !Number.isFinite(score)) continue;
      const values = group.variants.get(name) ?? [];
      values.push({
        score,
        label: row.true_label === 'spam' ? 1 : 0,
        group: String(meta.duplicate_group),
      });
      group.variants.set(name, values);
    }
  }
  finish() {
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      notes: [
        'Quality uses prospective human labels only; unlabelled, protected and known train/validation duplicates are excluded.',
        'Metrics are deduplicated by reduced text; conflicting labels are excluded. Latest exported example represents a group.',
        'Manual labelling is selected, not a random population sample. These metrics do not replace ACTIVE approval.',
        'Ablations mask fixed ensemble components; models are not retrained. This is not a causal effect estimate.',
        'Timings are monotonic elapsed milliseconds, not CPU time; include warm/cold caches. Total excludes capture and final trace write, but includes the pre-action checkpoint and instrumentation.',
        'Null precision/recall means undefined, not zero. Runtime thresholds are shared for comparison, not tuned for each baseline.',
      ],
      groups: [...this.groups].map(([key, g]) => ({
        ...JSON.parse(key),
        traces: g.rows,
        eligible_labelled_traces: g.labelled,
        timings: Object.fromEntries(
          [...g.timings].map(([stage, values]) => [stage, timing(values)]),
        ),
        skipped: Object.fromEntries(g.skipped),
        errors: Object.fromEntries(g.errors),
        outcomes: Object.fromEntries(g.outcomes),
        variants: Object.fromEntries(
          [...g.variants].map(([name, values]) => {
            const unique = new Map<string, VariantRow>(),
              conflicts = new Set<string>();
            for (const value of values) {
              const previous = unique.get(value.group);
              if (previous && previous.label !== value.label) conflicts.add(value.group);
              if (!previous) unique.set(value.group, value);
            }
            const rows = [...unique.values()].filter((v) => !conflicts.has(v.group));
            return [
              name,
              {
                n: rows.length,
                excluded_conflicting_groups: conflicts.size,
                ...quality(rows, g.threshold),
              },
            ];
          }),
        ),
      })),
    };
  }
}

/** Local export only. Exclusive creation avoids silently overwriting a previous experiment. */
export function exportResearch(
  store: SpamStore,
  chatId: number,
  path: string,
  limit = 10000,
  includeText = false,
) {
  const output = openSync(path, 'wx');
  let summaryFile: number | undefined;
  try {
    summaryFile = openSync(`${path}.summary.json`, 'wx');
    const summary = new ResearchSummary();
    let count = 0;
    for (const row of store.researchRows(chatId, limit, includeText)) {
      writeFileSync(output, `${JSON.stringify(row)}\n`);
      summary.add(row);
      count++;
    }
    writeFileSync(summaryFile, JSON.stringify(summary.finish(), null, 2));
    return { count, path, summaryPath: `${path}.summary.json` };
  } finally {
    closeSync(output);
    if (summaryFile !== undefined) closeSync(summaryFile);
  }
}
