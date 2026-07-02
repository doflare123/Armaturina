import type { User } from 'grammy/types';
import { MODERATION_ABUSE_WINDOW_MS } from '../constants.ts';
import type { ResolvedTarget } from '../types.ts';
import { isoWeekKey } from '../util/time.ts';
import { targetKey, userKey, userLabel } from './keys.ts';

interface Victim {
  userId: number | null;
  username: string | null;
  label: string;
  totalHits: number;
  ultraHits: number;
  weeklyHits: Record<string, number>;
}

interface ChatHits {
  totalHits: number;
  ultraHits: number;
  weeklyHits: Record<string, number>;
  victims: Map<string, Victim>;
}

export interface Snake {
  userId: number | null;
  username: string | null;
  label: string;
  total: number;
}

interface ChatLef {
  total: number;
  targets: Map<string, Snake>;
}

export interface AbuseEntry {
  userId: number | null;
  username: string | null;
  label: string;
  count: number;
  lastAt: number;
}

export interface ChatStatsSummary {
  totalHits: number;
  ultraHits: number;
  uniqueVictims: number;
  weekHits: number;
  weekKey: string;
  leader: WeeklyVictim | null;
}

export interface WeeklyVictim {
  userId: number | null;
  username: string | null;
  label: string;
  totalHits: number;
  ultraHits: number;
  weeklyHits: number;
}

interface SerializedChatHits {
  totalHits?: number;
  ultraHits?: number;
  weeklyHits?: Record<string, number>;
  victims?: Record<string, Partial<Victim>>;
}

interface SerializedChatLef {
  total?: number;
  targets?: Record<string, Partial<Snake>>;
}

/** The on-disk (JSON) shape of the stats, all fields optional for tolerance. */
export interface StatsFile {
  stats?: Record<string, SerializedChatHits>;
  lefStats?: Record<string, SerializedChatLef>;
  moderationAbuse?: Record<string, Record<string, Partial<AbuseEntry>>>;
}

/** Per-chat hit stats, lef/snake counts and non-admin moderation-abuse counters. */
export class StatsStore {
  private hits = new Map<string, ChatHits>();
  private lef = new Map<string, ChatLef>();
  private abuse = new Map<string, Map<string, AbuseEntry>>();

  recordHit(chatId: number, target: ResolvedTarget, isUltra: boolean): void {
    const chat = this.chatHits(chatId);
    const weekKey = isoWeekKey(new Date());
    const key = targetKey(target);
    const victim: Victim = chat.victims.get(key) ?? {
      userId: target.userId || null,
      username: target.username || null,
      label: target.label || target.username || String(target.userId || key),
      totalHits: 0,
      ultraHits: 0,
      weeklyHits: {},
    };

    victim.userId = target.userId || victim.userId;
    victim.username = target.username || victim.username;
    victim.label = target.label || victim.label;
    victim.totalHits += 1;
    victim.ultraHits += isUltra ? 1 : 0;
    victim.weeklyHits[weekKey] = (victim.weeklyHits[weekKey] ?? 0) + 1;

    chat.totalHits += 1;
    chat.ultraHits += isUltra ? 1 : 0;
    chat.weeklyHits[weekKey] = (chat.weeklyHits[weekKey] ?? 0) + 1;
    chat.victims.set(key, victim);
  }

  chatSummary(chatId: number): ChatStatsSummary {
    const chat = this.chatHits(chatId);
    const weekKey = isoWeekKey(new Date());

    return {
      totalHits: chat.totalHits,
      ultraHits: chat.ultraHits,
      uniqueVictims: chat.victims.size,
      weekHits: chat.weeklyHits[weekKey] ?? 0,
      weekKey,
      leader: this.weeklyTop(chatId, 1)[0] ?? null,
    };
  }

  weeklyTop(chatId: number, limit: number): WeeklyVictim[] {
    const chat = this.chatHits(chatId);
    const weekKey = isoWeekKey(new Date());

    return [...chat.victims.values()]
      .map((victim) => ({
        userId: victim.userId,
        username: victim.username,
        label: victim.label,
        totalHits: victim.totalHits,
        ultraHits: victim.ultraHits,
        weeklyHits: victim.weeklyHits[weekKey] ?? 0,
      }))
      .filter((victim) => victim.weeklyHits > 0)
      .sort((left, right) => right.weeklyHits - left.weeklyHits || right.totalHits - left.totalHits)
      .slice(0, limit);
  }

  recordLef(chatId: number, target: ResolvedTarget): void {
    const chat = this.chatLef(chatId);
    const key = targetKey(target);
    const snake: Snake = chat.targets.get(key) ?? {
      userId: target.userId || null,
      username: target.username || null,
      label: target.label || target.username || String(target.userId || key),
      total: 0,
    };

    snake.userId = target.userId || snake.userId;
    snake.username = target.username || snake.username;
    snake.label = target.label || snake.label;
    snake.total += 1;
    chat.total += 1;
    chat.targets.set(key, snake);
  }

  lefTop(chatId: number, limit: number): Snake[] {
    return [...this.chatLef(chatId).targets.values()]
      .sort((left, right) => right.total - left.total)
      .slice(0, limit);
  }

  recordModerationAbuse(chatId: number, user: User, now: number): AbuseEntry {
    const chatAbuse = this.chatAbuse(chatId);
    const key = userKey(user);
    const current = chatAbuse.get(key);
    const expired = !current || now - current.lastAt > MODERATION_ABUSE_WINDOW_MS;
    const entry: AbuseEntry = expired
      ? {
          userId: user.id || null,
          username: user.username || null,
          label: userLabel(user),
          count: 0,
          lastAt: 0,
        }
      : current;

    entry.userId = user.id || entry.userId;
    entry.username = user.username || entry.username;
    entry.label = userLabel(user) || entry.label;
    entry.count += 1;
    entry.lastAt = now;
    chatAbuse.set(key, entry);

    return { ...entry };
  }

  load(file: StatsFile): void {
    this.hits = new Map();
    this.lef = new Map();
    this.abuse = new Map();

    for (const [chatId, chat] of Object.entries(file.stats ?? {})) {
      const victims = new Map<string, Victim>();
      for (const [key, victim] of Object.entries(chat.victims ?? {})) {
        victims.set(key, {
          userId: victim.userId || null,
          username: victim.username || null,
          label: victim.label || victim.username || key,
          totalHits: victim.totalHits || 0,
          ultraHits: victim.ultraHits || 0,
          weeklyHits: victim.weeklyHits || {},
        });
      }
      this.hits.set(chatId, {
        totalHits: chat.totalHits || 0,
        ultraHits: chat.ultraHits || 0,
        weeklyHits: chat.weeklyHits || {},
        victims,
      });
    }

    for (const [chatId, chat] of Object.entries(file.lefStats ?? {})) {
      const targets = new Map<string, Snake>();
      for (const [key, snake] of Object.entries(chat.targets ?? {})) {
        targets.set(key, {
          userId: snake.userId || null,
          username: snake.username || null,
          label: snake.label || snake.username || key,
          total: snake.total || 0,
        });
      }
      this.lef.set(chatId, { total: chat.total || 0, targets });
    }

    for (const [chatId, chatAbuse] of Object.entries(file.moderationAbuse ?? {})) {
      const entries = new Map<string, AbuseEntry>();
      for (const [key, entry] of Object.entries(chatAbuse ?? {})) {
        entries.set(key, {
          userId: entry.userId || null,
          username: entry.username || null,
          label: entry.label || entry.username || key,
          count: entry.count || 0,
          lastAt: entry.lastAt || 0,
        });
      }
      this.abuse.set(chatId, entries);
    }
  }

  snapshot(): Required<StatsFile> {
    return {
      stats: Object.fromEntries(
        [...this.hits].map(([chatId, chat]) => [
          chatId,
          {
            totalHits: chat.totalHits,
            ultraHits: chat.ultraHits,
            weeklyHits: chat.weeklyHits,
            victims: Object.fromEntries(chat.victims),
          },
        ]),
      ),
      lefStats: Object.fromEntries(
        [...this.lef].map(([chatId, chat]) => [
          chatId,
          { total: chat.total, targets: Object.fromEntries(chat.targets) },
        ]),
      ),
      moderationAbuse: Object.fromEntries(
        [...this.abuse].map(([chatId, chatAbuse]) => [chatId, Object.fromEntries(chatAbuse)]),
      ),
    };
  }

  private chatHits(chatId: number): ChatHits {
    const key = String(chatId);
    let chat = this.hits.get(key);
    if (!chat) {
      chat = { totalHits: 0, ultraHits: 0, weeklyHits: {}, victims: new Map() };
      this.hits.set(key, chat);
    }
    return chat;
  }

  private chatLef(chatId: number): ChatLef {
    const key = String(chatId);
    let chat = this.lef.get(key);
    if (!chat) {
      chat = { total: 0, targets: new Map() };
      this.lef.set(key, chat);
    }
    return chat;
  }

  private chatAbuse(chatId: number): Map<string, AbuseEntry> {
    const key = String(chatId);
    let chat = this.abuse.get(key);
    if (!chat) {
      chat = new Map();
      this.abuse.set(key, chat);
    }
    return chat;
  }
}
