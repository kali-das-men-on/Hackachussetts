// Run a SQL file against DATABASE_URL (from the environment or the repo-root .env), in one transaction.
//   node db-apply.js ../schema/supabase.sql
//   npm run db:schema   |   npm run db:seed
// Same as `psql "$DATABASE_URL" -f FILE`, for machines without psql.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { loadEnv, pgConfig } = require('./env');

loadEnv();
const file = process.argv[2];
if (!file) {
  console.error('usage: node db-apply.js FILE.sql');
  process.exit(2);
}
if (!process.env.DATABASE_URL || !/^postgres/.test(process.env.DATABASE_URL)) {
  console.error('DATABASE_URL is not a Postgres URL');
  process.exit(2);
}

(async () => {
  const sql = fs.readFileSync(path.resolve(file), 'utf8');
  const c = new Client(pgConfig(process.env.DATABASE_URL));
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
    console.log(`applied ${file}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`failed, nothing applied: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
