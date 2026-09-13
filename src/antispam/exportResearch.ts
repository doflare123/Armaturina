import 'dotenv/config';
import { loadSpamConfig } from './config.ts';
import { exportResearch } from './research.ts';
import { SpamStore } from './store.ts';

const [chatArg, path, ...options] = process.argv.slice(2);
const chatId = Number(chatArg),
  config = loadSpamConfig();
if (
  !config?.chatIds.includes(chatId) ||
  !path ||
  options.some((value) => value !== '--include-text')
)
  throw new Error(
    'Usage: node src/antispam/exportResearch.ts <configured-chat-id> <new-output.jsonl> [--include-text]',
  );
const store = new SpamStore(config.databasePath);
try {
  console.log(
    JSON.stringify(exportResearch(store, chatId, path, 10000, options.includes('--include-text'))),
  );
} finally {
  store.close();
}
