import type { Message, Sticker, User } from 'grammy/types';
import type { MediaItem, MediaMetadata, Pool, ResolvedTarget, Target } from '../types.ts';
import { normalizeUsername } from './keys.ts';
import { MediaPool, type RawMedia } from './mediaPool.ts';
import {
  type AbuseEntry,
  type ChatStatsSummary,
  type Snake,
  type StatsFile,
  StatsStore,
  type WeeklyVictim,
} from './stats.ts';

interface LastMessage {
  messageId: number;
  userId: number;
  username: string | null;
  text: string;
}

export interface PoolSummary {
  stickerSets: number;
  stickers: number;
  animations: number;
  ultraStickerSets: number;
  ultraStickers: number;
  ultraAnimations: number;
  taggedRegular: number;
  taggedUltra: number;
}

export interface MediaPoolFile {
  stickerSets: string[];
  stickers: MediaItem[];
  animations: MediaItem[];
  ultraStickerSets: string[];
  ultraStickers: MediaItem[];
  ultraAnimations: MediaItem[];
  stats: Required<StatsFile>['stats'];
  lefStats: Required<StatsFile>['lefStats'];
  moderationAbuse: Required<StatsFile>['moderationAbuse'];
}

export interface MediaPoolImport extends StatsFile {
  stickerSets?: string[];
  stickers?: RawMedia[];
  animations?: RawMedia[];
  ultraStickerSets?: string[];
  ultraStickers?: RawMedia[];
  ultraAnimations?: RawMedia[];
}

/**
 * In-memory media pools, per-chat stats and the last message each user sent.
 * Mutations funnel through {@link persist}, a no-op here that {@link FileStore}
 * overrides to write the JSON file.
 */
export class MemoryStore {
  protected readonly pools: Record<Pool, MediaPool> = {
    regular: new MediaPool('regular'),
    ultra: new MediaPool('ultra'),
  };
  protected readonly stats = new StatsStore();

  // Last messages are chat-scoped because replies must land in the same group.
  private readonly lastByUserId = new Map<number, Map<number, LastMessage>>();
  private readonly lastByUsername = new Map<number, Map<string, LastMessage>>();

  /** Overridden by persistent subclasses; here it does nothing. */
  protected async persist(): Promise<void> {}

  rememberMessage(message: Message): void {
    if (!message.from || !message.chat) {
      return;
    }

    const chatId = message.chat.id;
    const last: LastMessage = {
      messageId: message.message_id,
      userId: message.from.id,
      username: message.from.username ? normalizeUsername(message.from.username) : null,
      text: message.text || message.caption || '',
    };

    getOrCreateMap(this.lastByUserId, chatId).set(message.from.id, last);

    if (message.from.username) {
      getOrCreateMap(this.lastByUsername, chatId).set(
        normalizeUsername(message.from.username),
        last,
      );
    }
  }

  getLastMessage(
    chatId: number,
    target: Pick<Target, 'userId' | 'username'> | null,
  ): LastMessage | null {
    if (!target) {
      return null;
    }

    if (target.userId) {
      const message = this.lastByUserId.get(chatId)?.get(target.userId);
      if (message) {
        return message;
      }
    }

    if (!target.username) {
      return null;
    }

    return this.lastByUsername.get(chatId)?.get(normalizeUsername(target.username)) ?? null;
  }

  async addStickerSet(
    setName: string,
    stickers: Sticker[],
    pool: Pool = 'regular',
    metadataByFileId: Map<string, MediaMetadata> = new Map(),
  ): Promise<number> {
    const added = this.pools[pool].addStickerSet(setName, stickers, metadataByFileId);
    await this.persist();
    return added;
  }

  async addAnimation(
    fileId: string,
    pool: Pool = 'regular',
    metadata: Partial<MediaMetadata> = {},
  ): Promise<void> {
    this.pools[pool].addAnimation(fileId, metadata);
    await this.persist();
  }

  async updateMediaMetadata(
    fileId: string,
    pool: Pool = 'regular',
    metadata: Partial<MediaMetadata> = {},
  ): Promise<boolean> {
    const updated = this.pools[pool].updateMetadata(fileId, metadata);
    if (updated) {
      await this.persist();
    }
    return updated;
  }

  getRandomMedia(pool: Pool = 'regular'): MediaItem | null {
    return this.pools[pool].random();
  }

  getBestMediaByTags(pool: Pool = 'regular', wantedTags: string[] = []): MediaItem | null {
    return this.pools[pool].bestByTags(wantedTags);
  }

  getUntaggedMedia(pool: Pool = 'regular', limit = 25): MediaItem[] {
    return this.pools[pool].untagged(limit);
  }

  hasMedia(pool: Pool = 'regular'): boolean {
    return this.pools[pool].size > 0;
  }

  async recordHit(chatId: number, target: ResolvedTarget, isUltra = false): Promise<void> {
    this.stats.recordHit(chatId, target, isUltra);
    await this.persist();
  }

  getChatStats(chatId: number): ChatStatsSummary {
    return this.stats.chatSummary(chatId);
  }

  getWeeklyTop(chatId: number, limit = 10): WeeklyVictim[] {
    return this.stats.weeklyTop(chatId, limit);
  }

  async recordLef(chatId: number, target: ResolvedTarget): Promise<void> {
    this.stats.recordLef(chatId, target);
    await this.persist();
  }

  getLefTop(chatId: number, limit = 10): Snake[] {
    return this.stats.lefTop(chatId, limit);
  }

  async recordModerationAbuse(chatId: number, user: User, now = Date.now()): Promise<AbuseEntry> {
    const entry = this.stats.recordModerationAbuse(chatId, user, now);
    await this.persist();
    return entry;
  }

  getStats(): PoolSummary {
    const { regular, ultra } = this.pools;

    return {
      stickerSets: regular.setCount,
      stickers: regular.stickerCount,
      animations: regular.animationCount,
      ultraStickerSets: ultra.setCount,
      ultraStickers: ultra.stickerCount,
      ultraAnimations: ultra.animationCount,
      taggedRegular: regular.taggedCount(),
      taggedUltra: ultra.taggedCount(),
    };
  }

  exportMediaPool(): MediaPoolFile {
    const regular = this.pools.regular.snapshot();
    const ultra = this.pools.ultra.snapshot();
    const stats = this.stats.snapshot();

    return {
      stickerSets: regular.setNames,
      stickers: regular.stickers,
      animations: regular.animations,
      ultraStickerSets: ultra.setNames,
      ultraStickers: ultra.stickers,
      ultraAnimations: ultra.animations,
      stats: stats.stats,
      lefStats: stats.lefStats,
      moderationAbuse: stats.moderationAbuse,
    };
  }

  importMediaPool(data: MediaPoolImport): void {
    this.pools.regular.load({
      setNames: data.stickerSets,
      stickers: data.stickers,
      animations: data.animations,
    });
    this.pools.ultra.load({
      setNames: data.ultraStickerSets,
      stickers: data.ultraStickers,
      animations: data.ultraAnimations,
    });
    this.stats.load(data);
  }
}

function getOrCreateMap<K, V>(outer: Map<number, Map<K, V>>, chatId: number): Map<K, V> {
  let inner = outer.get(chatId);
  if (!inner) {
    inner = new Map<K, V>();
    outer.set(chatId, inner);
  }
  return inner;
}
