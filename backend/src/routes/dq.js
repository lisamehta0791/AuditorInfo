const router = require('express').Router();
const db     = require('../config/db');

router.get('/', async (req, res) => {
  try {
    const { severity='', type='', fy_id='', company_id='' } = req.query;
    const params = []; let where = "WHERE dq.status='open'";
    if (severity)   { where += ' AND dq.severity=?';   params.push(severity); }
    if (type)       { where += ' AND dq.issue_type=?';  params.push(type); }
    if (fy_id)      { where += ' AND dq.fy_id=?';       params.push(fy_id); }
    if (company_id) { where += ' AND dq.company_id=?';  params.push(company_id); }
    const [rows] = await db.query(`
      SELECT dq.*, cm.co_name, fy.fy_label
      FROM log_dq_issue dq
      JOIN ma_company cm ON cm.company_id = dq.company_id
      JOIN ma_fy fy      ON fy.fy_id      = dq.fy_id
      ${where}
      ORDER BY FIELD(dq.severity,'error','warning','info'), cm.co_name
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/resolve', async (req, res) => {
  try {
    const { waive_reason } = req.body;
    const action = waive_reason ? 'waived' : 'resolved';
    await db.query(
      `UPDATE log_dq_issue SET status=?, resolved_at=NOW(), waive_reason=? WHERE dq_issue_id=?`,
      [action, waive_reason||null, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;