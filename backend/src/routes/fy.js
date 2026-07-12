// Routes for /api/fy — Financial Years (ma_fy). Every appointment, DQ
// issue, and alert is scoped to an fy_id (see fk_car_fy / fk_alert_fy /
// fk_dq_fy foreign keys, all ON UPDATE CASCADE). This is the master list
// used to populate every "Financial Year" dropdown in the frontend.
const router = require('express').Router();
const db     = require('../config/db');
const auth   = require('../middleware/auth');

// GET /api/fy — list all active financial years, most recent first.
router.get('/', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT fy_id, fy_label, fy_code, fy_start_date, fy_end_date, is_current
     FROM ma_fy WHERE is_active=1 ORDER BY fy_start_date DESC`
  );
  res.json(rows);
});

// POST /api/fy — add a new financial year and make it the current one
// (clears is_current on every other row first, so exactly one FY is ever
// "current" at a time).
router.post('/', auth, async (req, res) => {
  try {
    const { fy_label, fy_code, fy_start_date, fy_end_date } = req.body;
    if (!fy_label || !fy_code || !fy_start_date || !fy_end_date)
      return res.status(400).json({ error: 'All fields required' });

    const [[existing]] = await db.query(
      'SELECT fy_id FROM ma_fy WHERE fy_label = ? OR fy_code = ?',
      [fy_label, fy_code]);
    if (existing)
      return res.status(409).json({ error: `${fy_label} already exists` });

    // UPDATE: clear the current-FY flag off every existing row
    await db.query('UPDATE ma_fy SET is_current = 0');
    // INSERT: the new financial year row, flagged as the new current FY
    await db.query(
      `INSERT INTO ma_fy (fy_label, fy_code, fy_start_date, fy_end_date, is_current, is_active)
       VALUES (?, ?, ?, ?, 1, 1)`,
      [fy_label, fy_code, fy_start_date, fy_end_date]);

    res.status(201).json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;