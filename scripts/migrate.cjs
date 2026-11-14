/* Forward-only SQL migrations. Direct Neon URL recommended for migrations. */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
async function migrate() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL or DATABASE_URL is required');
  const db = new Client({connectionString: url, connectionTimeoutMillis: 15000});
  try {
    await db.connect();
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(42871845)');
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(x => x.name));
    const dir = path.resolve(__dirname, '../migrations');
    for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
      if (existing.has(file)) continue;
      await db.query(fs.readFileSync(path.join(dir,file),'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
      console.log('Applied migration:', file);
    }
    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch {}
    throw err;
  } finally { await db.end(); }
}
migrate().catch(err => { console.error('Migration failed:',err.message);process.exit(1); });
