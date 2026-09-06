import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { loadSpamConfig } from './config.ts';
import { SpamStore } from './store.ts';

const [chat, file] = process.argv.slice(2);
const config = loadSpamConfig();
const chatId = Number(chat);
if (!config?.chatIds.includes(chatId) || !file) {
  throw new Error('Usage: node src/antispam/import.ts <configured-chat-id> <dataset.json>');
}
if (statSync(file).size > 10 * 1024 * 1024) throw new Error('Bootstrap file exceeds 10 MiB');
const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
const store = new SpamStore(config.databasePath);
try {
  console.log(`Imported: ${store.importBootstrap(chatId, input)}`);
} finally {
  store.close();
}
