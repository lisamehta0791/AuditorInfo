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
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: ' + origin + ' not allowed'));
  },
  credentials: true,
}));

app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// Routes
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

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Auditor Info API running on port ${PORT}`));