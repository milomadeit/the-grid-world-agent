/**
 * Get Telegram Chat ID
 * 1. Send any message to your bot on Telegram
 * 2. Run this script to get your Chat ID
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const TG_HTTP_API = process.env.TG_HTTP_API;

if (!TG_HTTP_API) {
  console.log('ERROR: TG_HTTP_API not set in .env.local');
  process.exit(1);
}

console.log('Fetching recent messages from your Telegram bot...\n');

const response = await fetch(`https://api.telegram.org/bot${TG_HTTP_API}/getUpdates`);
const data = await response.json();

if (!data.ok) {
  console.log('ERROR:', data.description);
  process.exit(1);
}

if (data.result.length === 0) {
  console.log('No messages found.');
  console.log('\n👉 Please send any message to your bot on Telegram first!');
  console.log('   Then run this script again.');
  process.exit(0);
}

console.log('Found messages:\n');
const seen = new Set();

for (const update of data.result) {
  const chat = update.message?.chat || update.my_chat_member?.chat;
  if (chat && !seen.has(chat.id)) {
    seen.add(chat.id);
    const name = chat.title || chat.first_name || chat.username || 'Unknown';
    const type = chat.type;
    console.log(`  Chat: "${name}" (${type})`);
    console.log(`  Chat ID: ${chat.id}`);
    console.log('');
  }
}

const firstChatId = [...seen][0];
if (firstChatId) {
  console.log('═══════════════════════════════════════');
  console.log('ADD TO YOUR .env.local:');
  console.log('═══════════════════════════════════════');
  console.log(`TG_CHAT_ID=${firstChatId}`);
}
