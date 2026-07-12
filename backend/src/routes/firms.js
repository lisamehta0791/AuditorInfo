// Routes for /api/firms — the CA firm master (ma_firm). Covers
// list/search/filter with pagination, single-firm lookup (by reg. no. or
// firm_id), create, and edit. Powers the CA Firms screen, Firm Detail page,
// and every "CA Firm" search field used when creating/editing an
// appointment or a partner record.
const router = require('express').Router();
const db     = require('../config/db');
const { broadcast } = require('../events');
const { toList, inClause } = require('../utils');

// Live partner count subquery — replaces fat_firm_partner_count table
const PARTNER_COUNT_SQL = `(
  SELECT COUNT(*) FROM fat_member_firm_rel
  WHERE fr_reg_no = fm.fr_reg_no AND active_flag = 'Active'
) AS active_partner_count_live`;

// GET /api/firms — paginated list (used by the CA Firms screen and
// firm-search dropdowns), OR a single-firm lookup when ?lookup=<reg_no or
// firm_id> is passed (used by places that just need one firm's data by ID).
router.get('/', async (req, res) => {
  try {
    const lookup = req.query.lookup || '';
    if (lookup) {
      const [[firm]] = await db.query(`
        SELECT fm.*, ${PARTNER_COUNT_SQL}
        FROM ma_firm fm
        WHERE fm.fr_reg_no = ? OR fm.firm_id = ?
      `, [lookup, lookup]);
      if (!firm) return res.status(404).json({ error: 'Not found' });
      return res.json(firm);
    }

    const { search='' } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const params = [];
    let where = 'WHERE 1=1';
    if (search)  { where += ' AND (fm.fr_name LIKE ? OR fm.fr_reg_no LIKE ?)'; params.push(`%${search}%`,`%${search}%`); }
    // Multi-select filters: status=Active,Inactive / region=Northern,Western / group=Big4,Mid-Tier
    where += inClause('fm.fr_reg_no',     toList(req.query.fr_reg_no), params);
    where += inClause('fm.fr_status',     toList(req.query.status), params);
    where += inClause('fm.fr_region',     toList(req.query.region), params);
    where += inClause('fm.fr_group',      toList(req.query.group),  params);
    where += inClause('fm.fr_firm_type',  toList(req.query.firm_type), params);

    const sortCols = { fr_name: 'fm.fr_name' };
    const orderBy = sortCols[req.query.sort]
      ? `${sortCols[req.query.sort]} ${req.query.dir==='desc'?'DESC':'ASC'}`
      : 'fm.fr_name ASC';

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM ma_firm fm ${where}`, params);
    const [rows] = await db.query(`
      SELECT fm.*, ${PARTNER_COUNT_SQL}
      FROM ma_firm fm
      ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    res.json({ data: rows, total, page, totalPages: Math.ceil(total / limit), limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/firms/:id — single firm by reg. no. or firm_id (path-param
// version of the ?lookup= case above). Used by the Firm Detail page.
router.get('/{*id}', async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [[firm]] = await db.query(`
      SELECT fm.*, ${PARTNER_COUNT_SQL}
      FROM ma_firm fm
      WHERE fm.fr_reg_no = ? OR fm.firm_id = ?
    `, [id, id]);
    if (!firm) return res.status(404).json({ error: 'Not found' });
    res.json(firm);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/firms — create a new CA firm. Generates the next sequential
// internal firm_id itself (FM100001, FM100002, ...); fr_reg_no is the
// user-supplied, ICAI-issued registration number and is the real business key.
router.post('/', async (req, res) => {
  try {
    const { fr_name, fr_reg_no, fr_city, fr_region, fr_group,
            fr_firm_type, fr_icai_category, fr_established_year,
            fr_email, fr_phone, fr_website, fr_status } = req.body;
    if (!fr_name || !fr_reg_no) return res.status(400).json({ error: 'Name and registration number required' });
    if (!fr_firm_type) return res.status(400).json({ error: 'Firm type is required' });

    const [[{ maxId }]] = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(firm_id,3) AS UNSIGNED)),100000) AS maxId FROM ma_firm`);
    const firm_id = 'FM' + (Number(maxId) + 1);

    // INSERT: the new firm row
    await db.query(`
      INSERT INTO ma_firm
        (firm_id, fr_name, fr_reg_no, fr_city, fr_region, fr_group,
         fr_firm_type, fr_icai_category, fr_established_year,
         fr_email, fr_phone, fr_website, fr_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [firm_id, fr_name, fr_reg_no, fr_city||null, fr_region||null, fr_group||null,
        fr_firm_type||null, fr_icai_category||null, fr_established_year||null,
        fr_email||null, fr_phone||null, fr_website||null, fr_status||'Active']);

    broadcast('firm_added', { fr_reg_no, fr_name });
    res.status(201).json({ fr_reg_no, firm_id });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Registration number already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/firms/:id — edit an existing firm. When status is switched to
// Inactive/Dissolved, also cascades: closes out all its active partner
// relationships (fat_member_firm_rel, to_date=today) and attempts to mark
// its active audit records inactive too.
router.put('/{*id}', async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { fr_name, fr_reg_no, fr_city, fr_region, fr_group,
            fr_firm_type, fr_icai_category, fr_established_year,
            fr_email, fr_phone, fr_website, fr_status } = req.body;
    if (!fr_firm_type) return res.status(400).json({ error: 'Firm type is required' });
    // UPDATE: the firm row itself
    await db.query(`
      UPDATE ma_firm SET
        fr_name=?, fr_reg_no=?, fr_city=?, fr_region=?, fr_group=?,
        fr_firm_type=?, fr_icai_category=?, fr_established_year=?,
        fr_email=?, fr_phone=?, fr_website=?, fr_status=?
      WHERE fr_reg_no=? OR firm_id=?
    `, [fr_name, fr_reg_no, fr_city||null, fr_region||null, fr_group||null,
        fr_firm_type||null, fr_icai_category||null, fr_established_year||null,
        fr_email||null, fr_phone||null, fr_website||null, fr_status||'Active',
        id, id]);

    if (fr_status === 'Inactive' || fr_status === 'Dissolved') {
      // KNOWN BUG: same issue as companies.js's PUT /:id — record_status is
      // ENUM('Active','Removed'), so 'Inactive' is not a legal value here and
      // this UPDATE throws "Data truncated for column 'record_status'",
      // failing the whole request whenever the firm has active audit
      // records. Confirmed by testing against the live schema. Not fixed yet.
      await db.query(
        `UPDATE fat_company_audit_rel SET record_status='Inactive'
         WHERE fr_reg_no=? AND record_status='Active'`,
        [fr_reg_no || id]);
      // UPDATE: close out this firm's active partner relationships
      await db.query(
        `UPDATE fat_member_firm_rel SET active_flag='Inactive', to_date=CURDATE()
         WHERE fr_reg_no=? AND active_flag='Active'`,
        [fr_reg_no || id]);
    }
    broadcast('firm_updated', { fr_reg_no: id });
    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Registration number already exists' });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;