const router = require('express').Router();
const db     = require('../config/db');
const { broadcast } = require('../events');
const { toList, inClause } = require('../utils');

// Live partner count subquery — replaces fat_firm_partner_count table
const PARTNER_COUNT_SQL = `(
  SELECT COUNT(*) FROM fat_member_firm_rel
  WHERE fr_reg_no = fm.fr_reg_no AND active_flag = 'Active'
) AS active_partner_count_live`;

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

router.put('/{*id}', async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { fr_name, fr_reg_no, fr_city, fr_region, fr_group,
            fr_firm_type, fr_icai_category, fr_established_year,
            fr_email, fr_phone, fr_website, fr_status } = req.body;
    if (!fr_firm_type) return res.status(400).json({ error: 'Firm type is required' });
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
      await db.query(
        `UPDATE fat_company_audit_rel SET record_status='Inactive'
         WHERE fr_reg_no=? AND record_status='Active'`,
        [fr_reg_no || id]);
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