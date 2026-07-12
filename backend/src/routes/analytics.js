// Routes for /api/analytics — all read-only aggregate/reporting queries
// (no INSERT/UPDATE in this file). Powers the Dashboard and Analytics
// screens: summary counts, top firms, sector distribution, market share,
// and the firm x financial-year appointment heatmap.
const router = require('express').Router();
const db     = require('../config/db');
const auth   = require('../middleware/auth');

// GET /api/analytics/dashboard?fy_id= — summary numbers for the Dashboard
// screen: total/confirmed/draft company counts, engaged-firm count, total
// appointments, top 5 firms by appointment count, sector distribution, and
// open DQ issue counts — all scoped to one financial year.
router.get('/dashboard', auth, async (req, res) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

    const [[counts]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM ma_company WHERE co_status='Active') AS total_companies,
        COUNT(DISTINCT CASE WHEN f.record_status='Active'    THEN f.company_id END) AS confirmed,
        COUNT(DISTINCT CASE WHEN f.record_status='Inactive'  THEN f.company_id END) AS draft,
        COUNT(DISTINCT f.fr_reg_no) AS firms_engaged,
        COUNT(*) AS total_appointments
      FROM fat_company_audit_rel f
      WHERE f.fy_id = ?
    `, [fy_id]);

    const [topFirms] = await db.query(`
      SELECT fm.fr_reg_no AS firm_id, fm.fr_name,
             COUNT(*) AS appt_count,
             COUNT(DISTINCT f.company_id) AS company_count
      FROM fat_company_audit_rel f
      JOIN ma_firm fm ON fm.fr_reg_no = f.fr_reg_no
      WHERE f.fy_id = ? AND f.record_status = 'Active'
      GROUP BY fm.fr_reg_no ORDER BY appt_count DESC LIMIT 5
    `, [fy_id]);

    const [sectorDist] = await db.query(`
      SELECT s.sector_name, COUNT(*) AS appt_count
      FROM fat_company_audit_rel f
      JOIN ma_company cm ON cm.company_id = f.company_id
      JOIN ma_sector s   ON s.sector_id   = cm.sector_id
      WHERE f.fy_id = ?
      GROUP BY s.sector_name ORDER BY appt_count DESC
    `, [fy_id]);

    const [dqCounts] = await db.query(`
      SELECT severity, COUNT(*) AS cnt
      FROM log_dq_issue
      WHERE fy_id = ? AND status = 'open'
      GROUP BY severity
    `, [fy_id]);

    res.json({ ...counts, topFirms, sectorDist, dqCounts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analytics/market-share?fy_id= — each firm's share of total
// appointments for one FY, sourced from the DB view v_firm_fy_market_share.
// Used by the Analytics screen's market-share chart.
router.get('/market-share', auth, async (req, res) => {
  try {
    const { fy_id } = req.query;
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });
    const [rows] = await db.query(
      'SELECT * FROM v_firm_fy_market_share WHERE fy_id = ? ORDER BY appointment_count DESC',
      [fy_id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/analytics/heatmap — raw firm x financial-year appointment counts
// across ALL years (not scoped to one fy_id). This is the data source for
// the "10-Year Appointment Trend by Firm" table on the Analytics screen;
// the frontend groups these rows by firm NAME (not firm_id) client-side —
// see the renderAnalytics() heatmap section in frontend/index.html — because
// the same firm can appear under more than one fr_reg_no/firm_id over time
// (e.g. branch registrations), and grouping by name is what makes firms
// with multiple registration numbers show as one consolidated row.
router.get('/heatmap', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT fm.fr_reg_no AS firm_id, fm.fr_name, fy.fy_label, COUNT(*) AS cnt
      FROM fat_company_audit_rel f
      JOIN ma_firm fm ON fm.fr_reg_no = f.fr_reg_no
      JOIN ma_fy fy   ON fy.fy_id     = f.fy_id
      GROUP BY fm.fr_reg_no, fy.fy_label
      ORDER BY fm.fr_name, fy.fy_start_date DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;