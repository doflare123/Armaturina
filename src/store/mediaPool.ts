import type { Sticker } from 'grammy/types';
import { normalizeMetadata } from '../media.ts';
import { countTagMatches, normalizeTags } from '../tags.ts';
import type { MediaItem, MediaMetadata, Pool } from '../types.ts';
import { pickRandom } from '../util/random.ts';

/** A persisted media entry as it appears in the JSON file (loosely typed). */
export interface RawMedia extends Partial<MediaMetadata> {
  fileId?: string;
  setName?: string | null;
}

export interface RawPool {
  setNames?: string[];
  stickers?: RawMedia[];
  animations?: RawMedia[];
}

export interface PoolSnapshot {
  setNames: string[];
  stickers: MediaItem[];
  animations: MediaItem[];
}

/**
 * One media pool (regular or ultra). Owning the sticker/animation maps here
 * removes the `pool === 'ultra' ? … : …` branching the store used to repeat.
 */
export class MediaPool {
  private readonly stickers = new Map<string, MediaItem>();
  private readonly animations = new Map<string, MediaItem>();
  private readonly setNames = new Set<string>();
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  get stickerCount(): number {
    return this.stickers.size;
  }

  get animationCount(): number {
    return this.animations.size;
  }

  get setCount(): number {
    return this.setNames.size;
  }

  get size(): number {
    return this.stickers.size + this.animations.size;
  }

  addStickerSet(
    setName: string,
    stickers: Sticker[],
    metadataByFileId: Map<string, MediaMetadata>,
  ): number {
    this.setNames.add(setName);

    for (const sticker of stickers) {
      if (sticker?.file_id) {
        this.stickers.set(sticker.file_id, {
          type: 'sticker',
          fileId: sticker.file_id,
          setName,
          pool: this.pool,
          ...normalizeMetadata(metadataByFileId.get(sticker.file_id)),
        });
      }
    }

    return stickers.length;
  }

  addAnimation(fileId: string, metadata: Partial<MediaMetadata>): void {
    this.animations.set(fileId, {
      type: 'animation',
      fileId,
      pool: this.pool,
      ...normalizeMetadata(metadata),
    });
  }

  list(): MediaItem[] {
    return [...this.stickers.values(), ...this.animations.values()];
  }

  random(): MediaItem | null {
    const media = this.list();
    return media.length > 0 ? pickRandom(media) : null;
  }

  /** Highest tag-overlap item, breaking ties at random. */
  bestByTags(wantedTags: string[]): MediaItem | null {
    const wanted = normalizeTags(wantedTags);
    const media = this.list();
    if (media.length === 0 || wanted.length === 0) {
      return null;
    }

    const scored = media
      .map((item) => ({ item, score: countTagMatches(item.tags, wanted) }))
      .filter((entry) => entry.score > 0);
    if (scored.length === 0) {
      return null;
    }

    const bestScore = Math.max(...scored.map((entry) => entry.score));
    const best = scored.filter((entry) => entry.score === bestScore);

    return pickRandom(best).item;
  }

  untagged(limit: number): MediaItem[] {
    return this.list()
      .filter((item) => item.tags.length === 0)
      .slice(0, limit);
  }

  taggedCount(): number {
    return this.list().filter((item) => item.tags.length > 0).length;
  }

  find(fileId: string): MediaItem | null {
    return this.stickers.get(fileId) ?? this.animations.get(fileId) ?? null;
  }

  updateMetadata(fileId: string, metadata: Partial<MediaMetadata>): boolean {
    const media = this.find(fileId);
    if (!media) {
      return false;
    }

    Object.assign(media, normalizeMetadata(metadata));
    return true;
  }

  load(raw: RawPool): void {
    this.stickers.clear();
    this.animations.clear();
    this.setNames.clear();

    for (const name of raw.setNames ?? []) {
      this.setNames.add(name);
    }

    for (const sticker of raw.stickers ?? []) {
      if (sticker?.fileId) {
        this.stickers.set(sticker.fileId, {
          type: 'sticker',
          fileId: sticker.fileId,
          setName: sticker.setName || null,
          pool: this.pool,
          ...normalizeMetadata(sticker),
        });
      }
    }

    for (const animation of raw.animations ?? []) {
      if (animation?.fileId) {
        this.animations.set(animation.fileId, {
          type: 'animation',
          fileId: animation.fileId,
          pool: this.pool,
          ...normalizeMetadata(animation),
        });
      }
    }
  }

  snapshot(): PoolSnapshot {
    return {
      setNames: [...this.setNames],
      stickers: [...this.stickers.values()],
      animations: [...this.animations.values()],
    };
  }
}
