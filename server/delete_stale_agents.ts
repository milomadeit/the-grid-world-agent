import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { Pool } = pg;

async function deleteStaleAgents() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is not defined in .env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    console.log('Connected to database...');

    // Delete non-real agents
    // Real agents are: Smith (9), Oracle (10), Clank (30)
    const result = await pool.query(`
      DELETE FROM agents 
      WHERE erc8004_agent_id IS NULL 
         OR erc8004_agent_id NOT IN ('9', '10', '30');
    `);

    console.log(`Deleted ${result.rowCount} stale agents.`);

    // Verify remaining agents
    const remaining = await pool.query('SELECT id, visual_name, erc8004_agent_id FROM agents');
    console.log('Remaining agents:', remaining.rows);

  } catch (error) {
    console.error('Error deleting agents:', error);
  } finally {
    await pool.end();
  }
}

deleteStaleAgents();
