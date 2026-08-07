const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client:', err.message);
});

module.exports = pool;
