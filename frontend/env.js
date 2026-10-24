// .env loading and database settings shared by server.js, store-supabase.js and db-apply.js.
const fs = require('node:fs');
const path = require('node:path');

// Load the repo-root .env (the same file backend/main.py reads). Variables already set in the
// environment win, so `DATABASE_URL= node server.js` still forces the local file store.
function loadEnv() {
  for (const file of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}

// Supabase URLs written for SQLAlchemy ("postgresql+psycopg://") work here too.
function pgConfig(url) {
  const u = new URL(url.replace(/^postgres(ql)?\+\w+:/, 'postgresql:'));
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  u.searchParams.delete('sslmode'); // pg would override the ssl option below with it
  return {
    connectionString: u.toString(),
    // Supabase requires TLS. Its pooler certificate is not in Node's default CA list,
    // so the connection is encrypted but the certificate is not verified.
    ssl: local ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  };
}

module.exports = { loadEnv, pgConfig };
