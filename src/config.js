require('dotenv').config();
const path = require('path');

function loadConfig() {
  const token = process.env.BOT_TOKEN;

  if (!token) {
    throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set the token.');
  }

  return {
    token,
    dataFilePath: process.env.DATA_FILE || path.join(process.cwd(), 'data', 'media-pool.json')
  };
}

module.exports = {
  loadConfig
};
