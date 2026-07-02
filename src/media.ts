import { normalizeTags } from './tags.ts';
import type { MediaMetadata } from './types.ts';

/** Loose metadata shape, e.g. straight off a Gemini JSON response. */
export interface MetadataInput {
  tags?: unknown;
  mood?: unknown;
  caption?: unknown;
  analysisFileId?: unknown;
  analysisMimeType?: unknown;
  taggedAt?: unknown;
}

/** Coerce a loose, possibly-partial metadata blob into the canonical shape. */
export function normalizeMetadata(metadata: MetadataInput = {}): MediaMetadata {
  return {
    tags: normalizeTags(metadata.tags),
    mood: asStringOrNull(metadata.mood),
    caption: asStringOrNull(metadata.caption),
    analysisFileId: asStringOrNull(metadata.analysisFileId),
    analysisMimeType: asStringOrNull(metadata.analysisMimeType),
    taggedAt: asStringOrNull(metadata.taggedAt),
  };
}

function asStringOrNull(value: unknown): string | null {
  return value ? String(value) : null;
}
