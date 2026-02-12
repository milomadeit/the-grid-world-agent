/**
 * Clear chat and terminal message logs from the database
 * Run with: npx tsx server/scripts/clear-chat-logs.ts
 */

import pg from 'pg';

const { Pool } = pg;

async function clearChatLogs() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('[Error] DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    console.log('[DB] Connecting...');
    await pool.query('SELECT NOW()');
    console.log('[DB] Connected');

    // Clear chat messages
    const chatResult = await pool.query('DELETE FROM chat_messages');
    console.log(`[DB] Deleted ${chatResult.rowCount} chat messages`);

    // Clear terminal messages
    const terminalResult = await pool.query('DELETE FROM terminal_messages');
    console.log(`[DB] Deleted ${terminalResult.rowCount} terminal messages`);

    console.log('[DB] Chat logs cleared successfully!');
  } catch (error) {
    console.error('[Error]', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

clearChatLogs();
