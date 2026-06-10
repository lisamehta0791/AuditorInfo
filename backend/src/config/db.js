const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               process.env.DB_PORT,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           '+05:30',          // IST
});

// Test on startup
pool.getConnection()
  .then(c => { console.log('✓ MySQL connected'); c.release(); })
  .catch(e => { console.error('✗ MySQL connection failed:', e.message); process.exit(1); });

module.exports = pool;
