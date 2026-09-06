import path from 'node:path';

export interface SpamConfig {
  chatIds: number[];
  databasePath: string;
  retentionDays: number;
}

export function loadSpamConfig(env: NodeJS.ProcessEnv = process.env): SpamConfig | undefined {
  if (!env.ANTISPAM_CHAT_IDS?.trim()) return undefined;
  const chatIds = env.ANTISPAM_CHAT_IDS.split(',').map((value) => Number(value.trim()));
  if (chatIds.some((id) => !Number.isSafeInteger(id) || id >= 0)) {
    throw new Error('ANTISPAM_CHAT_IDS must contain negative group IDs separated by commas');
  }
  const retentionDays = Number(env.TRAINING_DATA_RETENTION_DAYS ?? 180);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error('TRAINING_DATA_RETENTION_DAYS must be 1..3650');
  }
  return {
    chatIds: [...new Set(chatIds)],
    databasePath: path.resolve(env.ANTISPAM_DATABASE_PATH || 'data/antispam.sqlite'),
    retentionDays,
  };
}
