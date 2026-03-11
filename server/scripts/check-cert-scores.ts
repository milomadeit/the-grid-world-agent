import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const r = await pool.query(`
    SELECT cr.agent_id, a.visual_name, cr.status, cr.started_at,
           (cr.verification_result->>'score')::int as score,
           cr.verification_result->'breakdown' as breakdown
    FROM certification_runs cr
    LEFT JOIN agents a ON a.id = cr.agent_id
    ORDER BY a.visual_name, cr.started_at ASC
  `);

  let current = '';
  for (const row of r.rows) {
    if (row.visual_name !== current) {
      current = row.visual_name;
      console.log(`\n=== ${current} ===`);
    }
    const time = new Date(row.started_at).toISOString().slice(5, 16);
    const bd = row.breakdown || {};
    const dims = Object.entries(bd)
      .map(([k, v]: [string, any]) => `${k.replace(/_/g, '').slice(0, 6)}:${v?.score ?? '?'}`)
      .join(' ');
    console.log(`  #${r.rows.indexOf(row) + 1} ${row.status.padEnd(8)} score=${String(row.score ?? '?').padStart(2)}  ${time}  ${dims}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
