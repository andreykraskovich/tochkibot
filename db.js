const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      home_team VARCHAR(100) NOT NULL,
      away_team VARCHAR(100) NOT NULL,
      home_score INTEGER,
      away_score INTEGER,
      status VARCHAR(50) DEFAULT 'SCHEDULED',
      match_date TIMESTAMP NOT NULL,
      group_name VARCHAR(10),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id),
      user_id BIGINT NOT NULL,
      username VARCHAR(100),
      prediction VARCHAR(10) NOT NULL,
      points INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(match_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notified_matches (
      match_id INTEGER PRIMARY KEY,
      notified_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('DB initialized');
}

// Matches
async function upsertMatch(match) {
  await pool.query(`
    INSERT INTO matches (id, home_team, away_team, home_score, away_score, status, match_date, group_name, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (id) DO UPDATE SET
      home_score = EXCLUDED.home_score,
      away_score = EXCLUDED.away_score,
      status = EXCLUDED.status,
      updated_at = NOW()
  `, [match.id, match.home_team, match.away_team, match.home_score, match.away_score, match.status, match.match_date, match.group_name]);
}

async function getMatchById(id) {
  const { rows } = await pool.query('SELECT * FROM matches WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getTodayMatches() {
  const { rows } = await pool.query(`
    SELECT * FROM matches
    WHERE DATE(match_date AT TIME ZONE 'Europe/Moscow') = DATE(NOW() AT TIME ZONE 'Europe/Moscow')
    ORDER BY match_date ASC
  `);
  return rows;
}

async function getUpcomingMatches(limit = 5) {
  const { rows } = await pool.query(`
    SELECT * FROM matches
    WHERE status = 'SCHEDULED' AND match_date > NOW()
    ORDER BY match_date ASC
    LIMIT $1
  `, [limit]);
  return rows;
}

async function getFinishedMatches() {
  const { rows } = await pool.query(`
    SELECT * FROM matches WHERE status = 'FINISHED' ORDER BY match_date DESC
  `);
  return rows;
}

// Predictions
async function savePrediction(matchId, userId, username, prediction) {
  await pool.query(`
    INSERT INTO predictions (match_id, user_id, username, prediction)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (match_id, user_id) DO UPDATE SET
      prediction = EXCLUDED.prediction,
      username = EXCLUDED.username
  `, [matchId, userId, username, prediction]);
}

async function getPredictionsForMatch(matchId) {
  const { rows } = await pool.query(
    'SELECT * FROM predictions WHERE match_id = $1',
    [matchId]
  );
  return rows;
}

async function getUserPrediction(matchId, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM predictions WHERE match_id = $1 AND user_id = $2',
    [matchId, userId]
  );
  return rows[0] || null;
}

async function awardPoints(matchId, winner) {
  // winner: 'HOME', 'DRAW', 'AWAY'
  await pool.query(`
    UPDATE predictions
    SET points = CASE WHEN prediction = $2 THEN 3 ELSE 0 END
    WHERE match_id = $1
  `, [matchId, winner]);
}

async function getLeaderboard() {
  const { rows } = await pool.query(`
    SELECT username, SUM(points) as total_points, COUNT(*) as total_predictions,
           SUM(CASE WHEN points > 0 THEN 1 ELSE 0 END) as correct
    FROM predictions
    GROUP BY user_id, username
    ORDER BY total_points DESC, correct DESC
  `);
  return rows;
}

// Notified matches
async function isMatchNotified(matchId) {
  const { rows } = await pool.query('SELECT 1 FROM notified_matches WHERE match_id = $1', [matchId]);
  return rows.length > 0;
}

async function markMatchNotified(matchId) {
  await pool.query('INSERT INTO notified_matches (match_id) VALUES ($1) ON CONFLICT DO NOTHING', [matchId]);
}

init().catch(console.error);

module.exports = {
  upsertMatch, getMatchById, getTodayMatches, getUpcomingMatches, getFinishedMatches,
  savePrediction, getPredictionsForMatch, getUserPrediction, awardPoints, getLeaderboard,
  isMatchNotified, markMatchNotified
};
