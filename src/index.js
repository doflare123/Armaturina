const { createBot } = require('./bot');
const { loadConfig } = require('./config');

async function main() {
  // Entry point stays tiny: config validation and bot startup live in separate modules.
  const config = loadConfig();
  const bot = createBot(config);

  await bot.start();
}

main().catch((error) => {
  console.error('Armaturina failed to start:', error);
  process.exitCode = 1;
});
