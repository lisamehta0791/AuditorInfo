require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const app = express();

// Security headers — relax CSP for fonts/SSE
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — allow both file:// and live-server origins
const allowedOrigins = [
  process.env.FRONTEND_ORIGIN,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'null',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === 'null' || allowedOrigins.includes(origin)) return cb(null, true);
    // Allow any localhost / 127.0.0.1 port (Live Server may use 5500, 5501, etc.)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error('CORS: ' + origin + ' not allowed'));
  },
  credentials: true,
}));

app.use(cookieParser(process.env.COOKIE_SECRET));
// Default express.json() body limit is 100kb — too small for bulk CSV import
// payloads (hundreds of rows serialized as JSON easily exceeds that).
app.use(express.json({ limit: '25mb' }));
// Internal tool, not a public API — 300 req/15min was tuned for casual
// browsing and is easily exceeded by legitimate bulk imports (which can
// make several requests per row) combined with normal page activity in the
// same window. Raised generously; chunked import (see /appointments/import)
// keeps individual requests small regardless.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 6000 }));

app.use('/api/fy',           require('./routes/fy'));
app.use('/api/sectors',      require('./routes/sectors'));
app.use('/api/companies',    require('./routes/companies'));
app.use('/api/firms',        require('./routes/firms'));
app.use('/api/members',      require('./routes/members'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/dq',           require('./routes/dq'));
app.use('/api/alerts',       require('./routes/alerts'));
app.use('/api/analytics',    require('./routes/analytics'));
app.use('/api/events',       require('./routes/events'));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Auditor Info API running on port ${PORT}`));