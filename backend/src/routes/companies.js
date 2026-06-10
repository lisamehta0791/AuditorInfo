const router = require('express').Router();
const db     = require('../config/db');
const auth   = require('../middleware/auth');
const { broadcast } = require('../events');

router.get('/', auth, async (req, res) => {
  try {
    const { search='', sector='', exchange='', co_status='' } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const params = [];
    let where = 'WHERE 1=1';
    if (search)    { where += ' AND (cm.co_name LIKE ? OR cm.co_cin LIKE ? OR cm.co_isin LIKE ? OR cm.co_bse_code LIKE ? OR cm.co_nse_symbol LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    if (co_status) { where += ' AND cm.co_status=?'; params.push(co_status); }
    if (sector)    { where += ' AND s.sector_name = ?'; params.push(sector); }
    if (exchange)  { where += ' AND cm.co_exchange_display LIKE ?'; params.push(`%${exchange}%`); }

    const [[{ total }]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM ma_company cm
      LEFT JOIN ma_sector s ON s.sector_id = cm.sector_id
      ${where}
    `, params);

    const [rows] = await db.query(`
      SELECT cm.company_id, cm.co_name, cm.co_cin, cm.co_isin, cm.co_bse_code,
             cm.co_nse_symbol, cm.co_part_of, cm.co_pan, cm.co_roc,
             cm.co_exchange_display, cm.co_status,
             cm.sector_id, s.sector_name, s.regulatory_body
      FROM ma_company cm
      LEFT JOIN ma_sector s ON s.sector_id = cm.sector_id
      ${where}
      ORDER BY cm.co_name
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({ data: rows, total, page, totalPages: Math.ceil(total / limit), limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const [[company]] = await db.query(`
      SELECT cm.*, s.sector_name, s.regulatory_body
      FROM ma_company cm
      LEFT JOIN ma_sector s ON s.sector_id = cm.sector_id
      WHERE cm.company_id = ?
    `, [req.params.id]);
    if (!company) return res.status(404).json({ error: 'Not found' });
    res.json(company);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { co_name, co_cin, co_isin, co_bse_code, co_nse_symbol,
            co_part_of, co_pan, co_roc, co_exchange_display, sector_id, co_status } = req.body;
    if (!co_name || !co_isin)
      return res.status(400).json({ error: 'Company Name and ISIN are required' });

    const [[{ maxId }]] = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(company_id,3) AS UNSIGNED)),0) AS maxId FROM ma_company`);
    const company_id = 'CO' + String(Number(maxId) + 1).padStart(6, '0');

    await db.query(`
      INSERT INTO ma_company
        (company_id, co_name, co_cin, co_isin, co_bse_code, co_nse_symbol,
         co_part_of, co_pan, co_roc, co_exchange_display, sector_id, co_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [company_id, co_name, co_cin||null, co_isin, co_bse_code||null, co_nse_symbol||null,
        co_part_of||null, co_pan||null, co_roc||null, co_exchange_display||null,
        sector_id||null, co_status||'Active']);

    broadcast('company_added', { company_id, co_name });
    res.status(201).json({ company_id });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'CIN, ISIN, or BSE Code already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { co_name, co_cin, co_isin, co_bse_code, co_nse_symbol,
            co_part_of, co_pan, co_roc, co_exchange_display, sector_id, co_status } = req.body;
    await db.query(`
      UPDATE ma_company SET
        co_name=?, co_cin=?, co_isin=?, co_bse_code=?, co_nse_symbol=?,
        co_part_of=?, co_pan=?, co_roc=?, co_exchange_display=?, sector_id=?, co_status=?
      WHERE company_id=?
    `, [co_name, co_cin||null, co_isin, co_bse_code||null, co_nse_symbol||null,
        co_part_of||null, co_pan||null, co_roc||null, co_exchange_display||null,
        sector_id||null, co_status||'Active', req.params.id]);

    // Cascade: if company marked Inactive, set all its audit records to Inactive
    if (co_status === 'Inactive') {
      await db.query(
        `UPDATE fat_company_audit_rel SET record_status='Inactive'
         WHERE company_id=? AND record_status='Active'`,
        [req.params.id]);
    }
    broadcast('company_updated', { company_id: req.params.id });
    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'CIN, ISIN, or BSE Code already exists' });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;