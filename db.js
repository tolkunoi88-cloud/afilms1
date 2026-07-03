import { createClient } from '@libsql/client';

/**
 * Persistent database layer using libSQL (SQLite-compatible).
 *
 * - In production on Vercel, set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN
 *   environment variables (from a free Turso database at https://turso.tech).
 *   This is a real remote database, so data survives cold starts, redeploys,
 *   and multiple serverless instances (unlike writing to /tmp on Vercel,
 *   which is wiped constantly and was the cause of movies "disappearing").
 *
 * - Locally (no TURSO_DATABASE_URL set), it falls back to a local SQLite
 *   file on disk (dbPath), so `npm run dev` keeps working with zero setup.
 */
export class Database {
  constructor(dbPath) {
    const remoteUrl = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (remoteUrl) {
      this.client = createClient({ url: remoteUrl, authToken });
      this.isRemote = true;
    } else {
      // Local SQLite file fallback (development only).
      const localPath = dbPath.endsWith('.json')
        ? dbPath.replace(/\.json$/, '.sqlite')
        : dbPath;
      this.client = createClient({ url: `file:${localPath}` });
      this.isRemote = false;
    }
  }

  async exec(sql) {
    // Support multiple ";"-separated statements defensively, though callers
    // in this project always pass a single statement.
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await this.client.execute(stmt);
    }
  }

  prepare(sql) {
    const client = this.client;
    return {
      async all(...params) {
        const res = await client.execute({ sql, args: params });
        return res.rows.map(row => rowToObject(row, res.columns));
      },
      async run(...params) {
        const res = await client.execute({ sql, args: params });
        return {
          lastInsertRowid: res.lastInsertRowid !== undefined && res.lastInsertRowid !== null
            ? Number(res.lastInsertRowid)
            : 0,
          changes: res.rowsAffected || 0
        };
      }
    };
  }
}

function rowToObject(row, columns) {
  const obj = {};
  columns.forEach((col, i) => {
    obj[col] = row[i];
  });
  return obj;
}
