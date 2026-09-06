import 'dotenv/config';
import { loadSpamConfig } from './config.ts';
import { LearningService } from './learning.ts';
import { SpamStore } from './store.ts';

const chatId = Number(process.argv[2]);
const config = loadSpamConfig();
if (!config?.chatIds.includes(chatId))
  throw new Error('Usage: node src/antispam/train.ts <configured-chat-id>');
const store = new SpamStore(config.databasePath);
const learning = new LearningService(store);
try {
  store.prune(config.retentionDays);
  console.log(`Model activated for suggestions: ${await learning.train(chatId)}`);
} finally {
  learning.close();
  store.close();
}
