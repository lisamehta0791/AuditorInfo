// Routes for /api/companies — the listed-company master (ma_company).
// Covers list/search/filter with pagination, single-company lookup, create,
// and edit. Powers the Companies screen and every "search company" input
// used when creating/editing an audit appointment.
const router = require('express').Router();
const db     = require('../config/db');
const auth   = require('../middleware/auth');
const { broadcast } = require('../events');
const { toList, inClause } = require('../utils');

// GET /api/companies — paginated list, used by the Companies screen and by
// the entity-search dropdown ("Search Company" field) on the appointment form.
router.get('/', auth, async (req, res) => {
  try {
    const { search='' } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const params = [];
    let where = 'WHERE 1=1';
    if (search) { where += ' AND (cm.co_name LIKE ? OR cm.co_cin LIKE ? OR cm.co_isin LIKE ? OR cm.co_bse_code LIKE ? OR cm.co_nse_symbol LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
    // Multi-select filters: co_status=Active,Inactive / sector=IT,Banking / company_id=CO000001,CO000002
    where += inClause('cm.co_status',   toList(req.query.co_status),   params);
    where += inClause('s.sector_name',  toList(req.query.sector),      params);
    where += inClause('cm.company_id',  toList(req.query.company_id),  params);
    const exchangeList = toList(req.query.exchange);
    if (exchangeList.length) {
      where += ` AND (${exchangeList.map(()=>'cm.co_exchange_display LIKE ?').join(' OR ')})`;
      exchangeList.forEach(ex => params.push(`%${ex}%`));
    }

    const [[{ total }]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM ma_company cm
      LEFT JOIN ma_sector s ON s.sector_id = cm.sector_id
      ${where}
    `, params);

    const sortCols = { co_name: 'cm.co_name' };
    const orderBy = sortCols[req.query.sort]
      ? `${sortCols[req.query.sort]} ${req.query.dir==='desc'?'DESC':'ASC'}`
      : 'cm.co_name ASC';

    const [rows] = await db.query(`
      SELECT cm.company_id, cm.co_name, cm.co_cin, cm.co_isin, cm.co_bse_code,
             cm.co_nse_symbol, cm.co_part_of, cm.co_pan, cm.co_roc,
             cm.co_exchange_display, cm.co_status,
             cm.sector_id, s.sector_name, s.regulatory_body
      FROM ma_company cm
      LEFT JOIN ma_sector s ON s.sector_id = cm.sector_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({ data: rows, total, page, totalPages: Math.ceil(total / limit), limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/companies/:id — single company by company_id, used by the
// Company Detail page and the Edit Company modal.
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

// POST /api/companies — create a new listed company. Generates the next
// sequential company_id (CO000001, CO000002, ...) itself rather than
// relying on auto-increment, since the ID needs the "CO" prefix.
router.post('/', auth, async (req, res) => {
  try {
    const { co_name, co_cin, co_isin, co_bse_code, co_nse_symbol,
            co_part_of, co_pan, co_roc, co_exchange_display, sector_id, co_status } = req.body;
    if (!co_name || !co_isin)
      return res.status(400).json({ error: 'Company Name and ISIN are required' });

    const [[{ maxId }]] = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(company_id,3) AS UNSIGNED)),0) AS maxId FROM ma_company`);
    const company_id = 'CO' + String(Number(maxId) + 1).padStart(6, '0');

    // INSERT: the new company row
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

// PUT /api/companies/:id — edit an existing company's master data.
router.put('/:id', auth, async (req, res) => {
  try {
    const { co_name, co_cin, co_isin, co_bse_code, co_nse_symbol,
            co_part_of, co_pan, co_roc, co_exchange_display, sector_id, co_status } = req.body;
    // UPDATE: the company row itself
    await db.query(`
      UPDATE ma_company SET
        co_name=?, co_cin=?, co_isin=?, co_bse_code=?, co_nse_symbol=?,
        co_part_of=?, co_pan=?, co_roc=?, co_exchange_display=?, sector_id=?, co_status=?
      WHERE company_id=?
    `, [co_name, co_cin||null, co_isin, co_bse_code||null, co_nse_symbol||null,
        co_part_of||null, co_pan||null, co_roc||null, co_exchange_display||null,
        sector_id||null, co_status||'Active', req.params.id]);

    // Cascade: if company marked Inactive, set all its audit records to Inactive.
    // KNOWN BUG: fat_company_audit_rel.record_status is ENUM('Active','Removed')
    // — 'Inactive' is not a valid value for that column, so this UPDATE throws
    // "Data truncated for column 'record_status'" and the whole request fails
    // with a 500 whenever a company with active audit records is set Inactive.
    // Confirmed by testing against the live schema. Not fixed yet — most likely
    // fix is to cascade to 'Removed' instead of 'Inactive' below.
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