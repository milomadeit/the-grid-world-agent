import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Pool } = pg;

async function verifyRecentPrimitives() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is not defined in .env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    const args = process.argv.slice(2);
    const hoursArg = args.find(arg => arg.startsWith('--hours='));
    let hours = 24; // Default to 24 hours

    if (hoursArg) {
      const value = parseInt(hoursArg.split('=')[1], 10);
      if (!isNaN(value) && value > 0) {
        hours = value;
      }
    }

    const result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM world_primitives 
      WHERE created_at >= NOW() - INTERVAL '1 hour' * $1;
    `, [hours]);

    console.log(`There are ${result.rows[0].count} primitives created in the last ${hours} hours remaining in the database.`);
  } catch (error) {
    console.error('Error verifying primitives:', error);
  } finally {
    await pool.end();
  }
}

verifyRecentPrimitives();
