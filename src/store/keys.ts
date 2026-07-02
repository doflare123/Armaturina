import type { User } from 'grammy/types';
import type { ResolvedTarget } from '../types.ts';

export function normalizeUsername(username: string): string {
  return username.replace(/^@/, '').toLowerCase();
}

/** Stable per-chat identity for a target: id, else username, else label. */
export function targetKey(target: Pick<ResolvedTarget, 'userId' | 'username' | 'label'>): string {
  if (target.userId) {
    return `id:${target.userId}`;
  }
  if (target.username) {
    return `username:${normalizeUsername(target.username)}`;
  }
  return `label:${target.label}`;
}

export function userKey(user: User): string {
  if (user.id) {
    return `id:${user.id}`;
  }
  if (user.username) {
    return `username:${normalizeUsername(user.username)}`;
  }
  return `label:${userLabel(user)}`;
}

export function userLabel(user: User): string {
  if (user.username) {
    return `@${user.username}`;
  }
  return user.first_name || user.last_name || String(user.id || 'user');
}
