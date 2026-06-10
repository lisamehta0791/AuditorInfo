const router = require('express').Router();
const db     = require('../config/db');
const { broadcast } = require('../events');

router.get('/', async (req, res) => {
  try {
    const { status='open' } = req.query;
    const [rows] = await db.query(`
      SELECT al.*, cm.co_name, fm.fr_name, mm.mem_name, fy.fy_label
      FROM log_alert al
      JOIN ma_company cm      ON cm.company_id = al.company_id
      LEFT JOIN ma_firm fm    ON fm.fr_reg_no  = al.firm_id
                              OR fm.firm_id    = al.firm_id
      LEFT JOIN ma_member mm  ON mm.mem_no     = al.member_id
                              OR mm.member_id  = al.member_id
      LEFT JOIN ma_fy fy      ON fy.fy_id      = al.fy_id
      WHERE al.status = ?
        AND (al.snoozed_until IS NULL OR al.snoozed_until < CURDATE())
      ORDER BY al.created_at DESC
    `, [status]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/rotation', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM v_rotation_alerts ORDER BY tenure_years DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/acknowledge', async (req, res) => {
  try {
    await db.query(
      `UPDATE log_alert SET status='acknowledged', acknowledged_at=NOW() WHERE alert_id=?`,
      [req.params.id]
    );
    broadcast('alert_acknowledged', { alert_id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/snooze', async (req, res) => {
  try {
    const { snooze_until } = req.body;
    if (!snooze_until) return res.status(400).json({ error: 'snooze_until required' });
    await db.query(
      `UPDATE log_alert SET snoozed_until=? WHERE alert_id=?`,
      [snooze_until, req.params.id]
    );
    broadcast('alert_snoozed', { alert_id: req.params.id, snoozed_until: snooze_until });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;