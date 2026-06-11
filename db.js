const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_results (
      id SERIAL PRIMARY KEY,
      team1 VARCHAR(100) NOT NULL,
      score1 INTEGER NOT NULL,
      team2 VARCHAR(100) NOT NULL,
      score2 INTEGER NOT NULL,
      group_name VARCHAR(10),
      played_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('DB initialized');
}

async function addResult({ team1, score1, team2, score2, group }) {
  await pool.query(
    'INSERT INTO match_results (team1, score1, team2, score2, group_name) VALUES ($1, $2, $3, $4, $5)',
    [team1, score1, team2, score2, group]
  );
}

async function getResults() {
  const { rows } = await pool.query('SELECT * FROM match_results ORDER BY played_at DESC');
  return rows;
}

async function deleteLastResult() {
  const { rows } = await pool.query(
    'DELETE FROM match_results WHERE id = (SELECT id FROM match_results ORDER BY played_at DESC LIMIT 1) RETURNING *'
  );
  return rows[0] || null;
}

init().catch(console.error);

module.exports = { addResult, getResults, deleteLastResult };
