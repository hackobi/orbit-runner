const { Pool } = require('pg');

// Database connection pool
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
}

// Initialize database tables
async function initDatabase() {
  if (!pool) {
    throw new Error('Database not configured - DATABASE_URL not found');
  }
  const client = await pool.connect();
  try {
    console.log('🗄️ Initializing database tables...');
    
    // Create leaderboard_scores table
    await client.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_scores (
        id SERIAL PRIMARY KEY,
        address VARCHAR(66) NOT NULL,
        player_name VARCHAR(50),
        points INTEGER DEFAULT 0,
        kills INTEGER DEFAULT 0,
        asteroids INTEGER DEFAULT 0,
        belt_time_sec INTEGER DEFAULT 0,
        survival_sec INTEGER DEFAULT 0,
        sessions INTEGER DEFAULT 1,
        submission_method VARCHAR(20) DEFAULT 'blockchain',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leaderboard_address ON leaderboard_scores(address);
      CREATE INDEX IF NOT EXISTS idx_leaderboard_points ON leaderboard_scores(points DESC);
      CREATE INDEX IF NOT EXISTS idx_leaderboard_created ON leaderboard_scores(created_at DESC);
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get top scores for all categories
async function getLeaderboards() {
  if (!pool) {
    throw new Error('Database not configured');
  }
  const client = await pool.connect();
  try {
    // Get top 10 in each category
    const [pointsResult, killsResult, asteroidsResult, beltResult, survivalResult, sessionsResult] = await Promise.all([
      client.query('SELECT address, points, created_at as timestamp FROM leaderboard_scores WHERE points > 0 ORDER BY points DESC LIMIT 10'),
      client.query('SELECT address, kills, created_at as timestamp FROM leaderboard_scores WHERE kills > 0 ORDER BY kills DESC LIMIT 10'),
      client.query('SELECT address, asteroids, created_at as timestamp FROM leaderboard_scores WHERE asteroids > 0 ORDER BY asteroids DESC LIMIT 10'),
      client.query('SELECT address, belt_time_sec as "beltTimeSec", created_at as timestamp FROM leaderboard_scores WHERE belt_time_sec > 0 AND belt_time_sec <= 600 ORDER BY belt_time_sec DESC LIMIT 10'),
      client.query('SELECT address, survival_sec as "survivalSec", created_at as timestamp FROM leaderboard_scores WHERE survival_sec > 0 AND survival_sec <= 600 ORDER BY survival_sec DESC LIMIT 10'),
      client.query('SELECT address, sessions, created_at as timestamp FROM leaderboard_scores ORDER BY sessions DESC LIMIT 10')
    ]);

    return {
      points: pointsResult.rows.map(row => ({
        address: row.address,
        points: row.points,
        timestamp: new Date(row.timestamp).getTime()
      })),
      kills: killsResult.rows.map(row => ({
        address: row.address,
        kills: row.kills,
        timestamp: new Date(row.timestamp).getTime()
      })),
      asteroids: asteroidsResult.rows.map(row => ({
        address: row.address,
        asteroids: row.asteroids,
        timestamp: new Date(row.timestamp).getTime()
      })),
      belt: beltResult.rows.map(row => ({
        address: row.address,
        beltTimeSec: row.beltTimeSec,
        timestamp: new Date(row.timestamp).getTime()
      })),
      survival: survivalResult.rows.map(row => ({
        address: row.address,
        survivalSec: row.survivalSec,
        timestamp: new Date(row.timestamp).getTime()
      })),
      sessions: sessionsResult.rows.map(row => ({
        address: row.address,
        sessions: row.sessions,
        timestamp: new Date(row.timestamp).getTime()
      }))
    };
  } finally {
    client.release();
  }
}

// Submit a new score
async function submitScore(scoreData) {
  const client = await pool.connect();
  try {
    const {
      address,
      name,
      points = 0,
      kills = 0,
      asteroids = 0,
      beltTimeSec = 0,
      survivalSec = 0,
      submissionMethod = 'blockchain'
    } = scoreData;

    // Check if player exists
    const existingResult = await client.query(
      'SELECT * FROM leaderboard_scores WHERE address = $1',
      [address]
    );

    let result;
    if (existingResult.rows.length > 0) {
      // Update existing record with better scores
      const existing = existingResult.rows[0];
      result = await client.query(`
        UPDATE leaderboard_scores SET
          player_name = COALESCE($2, player_name),
          points = GREATEST(points, $3),
          kills = GREATEST(kills, $4),
          asteroids = GREATEST(asteroids, $5),
          belt_time_sec = GREATEST(belt_time_sec, $6),
          survival_sec = GREATEST(survival_sec, $7),
          sessions = sessions + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE address = $1
        RETURNING *
      `, [address, name, points, kills, asteroids, beltTimeSec, survivalSec]);
    } else {
      // Insert new record
      result = await client.query(`
        INSERT INTO leaderboard_scores 
        (address, player_name, points, kills, asteroids, belt_time_sec, survival_sec, sessions, submission_method)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
        RETURNING *
      `, [address, name, points, kills, asteroids, beltTimeSec, survivalSec, submissionMethod]);
    }

    return result.rows[0];
  } finally {
    client.release();
  }
}

// Get current top score (for jackpot detection)
async function getTopScore() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT points FROM leaderboard_scores ORDER BY points DESC LIMIT 1'
    );
    return result.rows[0]?.points || 0;
  } finally {
    client.release();
  }
}

// Clear all leaderboards (for testing)
async function clearLeaderboards() {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM leaderboard_scores');
    console.log('🗑️ All leaderboard data cleared');
  } finally {
    client.release();
  }
}

// Close database connections
async function closeDatabase() {
  await pool.end();
}

module.exports = {
  initDatabase,
  getLeaderboards,
  submitScore,
  getTopScore,
  clearLeaderboards,
  closeDatabase
};