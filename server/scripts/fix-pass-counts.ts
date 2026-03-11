import 'dotenv/config';
import pg from 'pg';

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const r = await pool.query(`
    SELECT cr.id, cr.agent_id, a.visual_name, cr.started_at
    FROM certification_runs cr
    JOIN agents a ON a.id = cr.agent_id
    WHERE cr.status = 'passed' AND cr.template_id = 'SWAP_EXECUTION_V1'
    ORDER BY a.visual_name, cr.started_at ASC
  `);

  // Target pass counts
  const keep: Record<string, number> = { Clank: 2, Mouse: 1, Oracle: 3, Smith: 3 };
  const byAgent = new Map<string, any[]>();
  for (const row of r.rows) {
    const name = row.visual_name;
    if (!byAgent.has(name)) byAgent.set(name, []);
    byAgent.get(name)!.push(row);
  }

  const toDelete: string[] = [];
  for (const [name, runs] of byAgent.entries()) {
    const keepCount = keep[name] ?? 3;
    console.log(`${name}: ${runs.length} passed, keeping ${keepCount}`);
    const excess = runs.slice(keepCount);
    for (const run of excess) {
      toDelete.push(run.id);
    }
  }

  console.log(`\nExpiring ${toDelete.length} excess runs...`);
  if (toDelete.length > 0) {
    const result = await pool.query(
      `UPDATE certification_runs SET status = 'expired' WHERE id = ANY($1::text[]) RETURNING id`,
      [toDelete]
    );
    console.log(`Updated ${result.rowCount} runs to expired`);
  }

  // Verify
  const verify = await pool.query(`
    SELECT a.visual_name, COUNT(*)::int as passes
    FROM certification_runs cr
    JOIN agents a ON a.id = cr.agent_id
    WHERE cr.status = 'passed' AND cr.template_id = 'SWAP_EXECUTION_V1'
    GROUP BY a.visual_name
    ORDER BY a.visual_name
  `);
  console.log('\nFinal pass counts:');
  for (const row of verify.rows) {
    const locked = row.passes >= 3 ? ' (LOCKED)' : '';
    console.log(`  ${row.visual_name}: ${row.passes}${locked}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
