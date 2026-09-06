/** Shared domain types for the whole bot. Runtime-free — safe to import anywhere. */

import type { Api } from 'grammy';

export type Pool = 'regular' | 'ultra';
export type RetagScope = Pool | 'all';
export type MediaType = 'sticker' | 'animation';
export type LefVariant = 'горловой' | 'слюнявый' | 'минет';

export interface MediaMetadata {
  tags: string[];
  mood: string | null;
  caption: string | null;
  analysisFileId: string | null;
  analysisMimeType: string | null;
  taggedAt: string | null;
}

export interface MediaItem extends MediaMetadata {
  type: MediaType;
  fileId: string;
  pool: Pool;
  /** Only stickers belong to a set; animations leave this absent. */
  setName?: string | null;
}

/** A piece of Telegram media to analyse, plus the file best suited for it. */
export interface MediaDescriptor {
  kind: MediaType;
  fileId: string;
  thumbnailFileId?: string | null;
  isAnimated?: boolean;
  isVideo?: boolean;
}

/** Anything that can turn Telegram media into tag metadata (implemented by Gemini). */
export interface MediaTagger {
  readonly maxTagsPerPack: number;
  tagTelegramMedia(api: Api, media: MediaDescriptor): Promise<MediaMetadata>;
}

/** A person the parser found in a message (mention, reply, or the sender). */
export interface Target {
  userId?: number | null;
  username?: string | null;
  messageId?: number | null;
  text?: string;
  label: string;
}

/** A target resolved to a concrete user, ready for moderation / stats. */
export interface ResolvedTarget {
  userId: number | null;
  username: string | null;
  label: string;
}

/** Discriminated union of everything the parser can recognise. */
export type Action =
  | { type: 'none' }
  | { type: 'help' }
  | { type: 'pool' }
  | { type: 'stats' }
  | { type: 'top' }
  | { type: 'lef_top' }
  | { type: 'lef'; target: Target | null; variant: LefVariant }
  | { type: 'hit'; target: Target }
  | { type: 'mute'; target: Target | null; minutes: number | null }
  | { type: 'ban'; target: Target | null }
  | { type: 'add_sticker_pack'; packName: string | null; pool: Pool }
  | { type: 'add_gif'; pool: Pool }
  | { type: 'retag'; pool: RetagScope; limit: number };

export type MuteAction = Extract<Action, { type: 'mute' }>;
export type BanAction = Extract<Action, { type: 'ban' }>;
export type LefAction = Extract<Action, { type: 'lef' }>;

/** A target resolved to a concrete user id, required for moderation actions. */
export interface ModerationTarget {
  userId: number;
  username: string | null;
  label: string;
}

export interface GeminiConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTagsPerPack: number;
  debug: boolean;
}

export interface Config {
  antispam?: import('./antispam/config.ts').SpamConfig;
  token: string;
  dataFilePath: string;
  lefAssetsPath: string;
  gemini: GeminiConfig;
}
