import type { Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { AdminChecker } from '../services/admin.ts';
import type { GeminiService } from '../services/gemini.ts';
import type { FileStore } from '../store/fileStore.ts';
import type { Config } from '../types.ts';

/** Everything the message handlers need, assembled once by {@link createBot}. */
export interface BotDeps {
  api: Api;
  config: Config;
  store: FileStore;
  gemini: GeminiService;
  admins: AdminChecker;
  /** Cached `getMe`, so moderation checks don't re-hit the API. */
  getBotInfo(): Promise<UserFromGetMe>;
}
