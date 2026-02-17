import { Client } from "pg";

const currentDatabaseUrl = process.env.CURRENT_DATABASE_URL;
const pitrDatabaseUrl = process.env.PITR_DATABASE_URL;

if (!currentDatabaseUrl) {
  console.error("ERROR: CURRENT_DATABASE_URL is required");
  process.exit(1);
}

if (!pitrDatabaseUrl) {
  console.error("ERROR: PITR_DATABASE_URL is required");
  process.exit(1);
}

const TABLES = ["chat_messages", "terminal_messages"] as const;
const BATCH_SIZE = 250;
const ACK_LOOP_REGEX =
  "^[^,]{1,40},\\s*acknowledged\\.\\s*i saw your ping and i am acting on it now\\.\\s*$";
const EXCLUDE_ACK_LOOP = process.env.EXCLUDE_ACK_LOOP !== "0";

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function tableRef(table: string): string {
  return `${quoteIdent("public")}.${quoteIdent(table)}`;
}

async function getTableColumns(client: Client, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [table]
  );
  return res.rows.map((row) => row.column_name);
}

function buildInsertQuery(table: string, columns: string[], rowCount: number): string {
  const tableSql = tableRef(table);
  const columnsSql = columns.map(quoteIdent).join(", ");
  const valueGroups: string[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const placeholders: string[] = [];
    for (let colIndex = 0; colIndex < columns.length; colIndex += 1) {
      const paramIndex = rowIndex * columns.length + colIndex + 1;
      placeholders.push(`$${paramIndex}`);
    }
    valueGroups.push(`(${placeholders.join(", ")})`);
  }

  return `INSERT INTO ${tableSql} (${columnsSql}) VALUES ${valueGroups.join(", ")}`;
}

async function main(): Promise<void> {
  const source = new Client({ connectionString: pitrDatabaseUrl });
  const target = new Client({ connectionString: currentDatabaseUrl });

  await source.connect();
  await target.connect();

  try {
    await target.query("BEGIN");

    for (const table of TABLES) {
      await target.query(`DELETE FROM ${tableRef(table)}`);
    }

    for (const table of TABLES) {
      const sourceColumns = await getTableColumns(source, table);
      const targetColumns = await getTableColumns(target, table);

      if (sourceColumns.join(",") !== targetColumns.join(",")) {
        throw new Error(`Column mismatch for ${table}`);
      }

      let sourceRows;
      if (table === "chat_messages" && EXCLUDE_ACK_LOOP) {
        const excluded = await source.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ${tableRef(table)} WHERE message ~* $1`,
          [ACK_LOOP_REGEX]
        );
        if ((excluded.rows[0]?.count ?? 0) > 0) {
          console.log(
            `Skipping ${excluded.rows[0].count} acknowledged-loop chat rows from PITR source`
          );
        }
        sourceRows = await source.query<Record<string, unknown>>(
          `SELECT * FROM ${tableRef(table)} WHERE message !~* $1 ORDER BY id ASC`,
          [ACK_LOOP_REGEX]
        );
      } else {
        sourceRows = await source.query<Record<string, unknown>>(
          `SELECT * FROM ${tableRef(table)} ORDER BY id ASC`
        );
      }

      for (let start = 0; start < sourceRows.rows.length; start += BATCH_SIZE) {
        const batch = sourceRows.rows.slice(start, start + BATCH_SIZE);
        if (batch.length === 0) continue;

        const params: unknown[] = [];
        for (const row of batch) {
          for (const column of sourceColumns) {
            params.push(row[column]);
          }
        }

        const insertSql = buildInsertQuery(table, sourceColumns, batch.length);
        await target.query(insertSql, params);
      }
    }

    await target.query(
      "SELECT setval(pg_get_serial_sequence('public.chat_messages', 'id'), COALESCE((SELECT MAX(id) FROM public.chat_messages), 1), true)"
    );
    await target.query(
      "SELECT setval(pg_get_serial_sequence('public.terminal_messages', 'id'), COALESCE((SELECT MAX(id) FROM public.terminal_messages), 1), true)"
    );

    const counts = await target.query<{
      chat_count: number;
      terminal_count: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM public.chat_messages) AS chat_count,
        (SELECT COUNT(*)::int FROM public.terminal_messages) AS terminal_count
    `);

    await target.query("COMMIT");
    const { chat_count: chatCount, terminal_count: terminalCount } = counts.rows[0];
    console.log(`Restore complete: chat_messages=${chatCount}, terminal_messages=${terminalCount}`);
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
