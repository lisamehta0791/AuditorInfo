const router = require('express').Router();
const db     = require('../config/db');
const { broadcast } = require('../events');

// Safe MFR ID generator — seeds from actual current max
async function nextMfrId() {
  const [[{ maxMfr }]] = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(mfr_id,4) AS UNSIGNED)),150000) AS maxMfr FROM fat_member_firm_rel`);
  return 'MFR' + String(Number(maxMfr)+1).padStart(6,'0');
}

// Safe member_id generator — seeds from actual current max
async function nextMemberId() {
  const [[{ maxId }]] = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(member_id,4) AS UNSIGNED)),137500) AS maxId FROM ma_member`);
  return 'MEM' + String(Number(maxId)+1);
}

router.get('/', async (req, res) => {
  try {
    const { search='', fr_reg_no='', firm_id='', include_inactive='', status='' } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const params = [];
    let where = (include_inactive || status)
      ? 'WHERE 1=1'
      : "WHERE mm.mem_status NOT IN ('Inactive','Expired','Not a Member')";

    if (search)  { where += ' AND (mm.mem_name LIKE ? OR mm.mem_no LIKE ?)'; params.push(`%${search}%`,`%${search}%`); }
    if (status)  { where += ' AND mm.mem_status=?'; params.push(status); }

    const firmFilter = fr_reg_no || firm_id;
    if (firmFilter) {
      where += ` AND mm.mem_no IN (
        SELECT mem_no FROM fat_member_firm_rel
        WHERE (fr_reg_no=? OR firm_id=?) AND active_flag='Active'
      )`;
      params.push(firmFilter, firmFilter);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM ma_member mm ${where}`, params);

    const [rows] = await db.query(`
      SELECT mm.*,
             fm.fr_name AS current_firm_name,
             fm.fr_reg_no AS current_firm_reg
      FROM ma_member mm
      LEFT JOIN fat_member_firm_rel mfr
        ON mfr.mfr_id = (
          SELECT mfr2.mfr_id FROM fat_member_firm_rel mfr2
          WHERE mfr2.mem_no = mm.mem_no AND mfr2.active_flag = 'Active'
          ORDER BY mfr2.from_date DESC
          LIMIT 1
        )
      LEFT JOIN ma_firm fm ON fm.fr_reg_no = mfr.fr_reg_no
      ${where}
      ORDER BY mm.mem_name LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    res.json({ data: rows, total, page, totalPages: Math.ceil(total / limit), limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/relationships', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT mfr.mfr_id, mfr.mem_no, mfr.fr_reg_no,
             mfr.designation, mfr.active_flag,
             fm.fr_name
      FROM fat_member_firm_rel mfr
      JOIN ma_firm fm ON fm.fr_reg_no = mfr.fr_reg_no
      WHERE mfr.active_flag = 'Active'`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const [[member]] = await db.query(`
      SELECT mm.*,
             fm.fr_name AS current_firm_name,
             fm.fr_reg_no AS current_firm_reg
      FROM ma_member mm
      LEFT JOIN fat_member_firm_rel mfr
        ON mfr.mem_no = mm.mem_no AND mfr.active_flag = 'Active'
      LEFT JOIN ma_firm fm ON fm.fr_reg_no = mfr.fr_reg_no
      WHERE mm.mem_no=? OR mm.member_id=?
    `, [req.params.id, req.params.id]);
    if (!member) return res.status(404).json({ error: 'Not found' });

    const [history] = await db.query(`
      SELECT mfr.*, fm.fr_name, fm.fr_reg_no
      FROM fat_member_firm_rel mfr
      JOIN ma_firm fm ON fm.fr_reg_no = mfr.fr_reg_no
      WHERE mfr.mem_no=?
      ORDER BY mfr.active_flag DESC, mfr.from_date DESC
    `, [member.mem_no]);
    res.json({ ...member, firm_history: history });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    let { mem_name, mem_no, mem_designation='Partner', mem_qualification='ACA',
          mem_gender, mem_dob, mem_since_year,
          mem_email, mem_phone, mem_status='Active',
          current_firm_reg_no } = req.body;

    if (!mem_name || !mem_no)
      return res.status(400).json({ error: 'Name and MRN required' });

    const fromImport = !!current_firm_reg_no || req.body._from_import;
    if (!current_firm_reg_no && !fromImport)
      return res.status(400).json({ error: 'Current firm required (current_firm_reg_no)' });

    let firmRow = null;
    if (current_firm_reg_no) {
      const [[fm]] = await db.query('SELECT fr_reg_no FROM ma_firm WHERE fr_reg_no=?', [current_firm_reg_no]);
      if (!fm) return res.status(400).json({ error: 'Firm not found: ' + current_firm_reg_no });
      firmRow = fm;
    }

    const member_id = await nextMemberId();

    await db.query(`
      INSERT INTO ma_member
        (member_id, mem_name, mem_no, mem_designation, mem_qualification,
         mem_gender, mem_dob, mem_since_year, mem_email, mem_phone, mem_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `, [member_id, mem_name, mem_no, mem_designation, mem_qualification,
        mem_gender||null, mem_dob||null, mem_since_year||null,
        mem_email||null, mem_phone||null, mem_status]);

    const allFirmRegs = (Array.isArray(req.body.firm_reg_nos) && req.body.firm_reg_nos.length)
      ? req.body.firm_reg_nos : (firmRow ? [current_firm_reg_no] : []);
    for (const regNo of allFirmRegs) {
      const mfr_id = await nextMfrId();
      await db.query(`
        INSERT IGNORE INTO fat_member_firm_rel
          (mfr_id, member_id, firm_id, mem_no, fr_reg_no, designation, from_date, active_flag)
        SELECT ?, ?, f.firm_id, ?, f.fr_reg_no, ?, CURDATE(), 'Active'
        FROM ma_firm f WHERE f.fr_reg_no=?
      `, [mfr_id, member_id, mem_no, mem_designation, regNo]);
    }

    broadcast('member_added', { mem_no, mem_name });
    res.status(201).json({ mem_no, member_id });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'MRN already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    let { mem_name, mem_no, mem_designation, mem_qualification,
          mem_gender, mem_dob, mem_since_year,
          mem_email, mem_phone, mem_status,
          current_firm_reg_no } = req.body;

    const [[current]] = await db.query(
      'SELECT mem_no FROM ma_member WHERE mem_no=? OR member_id=?',
      [req.params.id, req.params.id]);
    if (!current) return res.status(404).json({ error: 'Not found' });
    const currentMemNo = current.mem_no;

    const validStatus = ['Active','Inactive','Not a Member','Expired'].includes(mem_status) ? mem_status : 'Active';
    await db.query(`
      UPDATE ma_member SET
        mem_name=?, mem_no=?, mem_designation=?, mem_qualification=?,
        mem_gender=?, mem_dob=?, mem_since_year=?,
        mem_email=?, mem_phone=?, mem_status=?
      WHERE mem_no=?
    `, [mem_name, mem_no, mem_designation||'Partner', mem_qualification||'ACA',
        mem_gender||null, mem_dob||null, mem_since_year||null,
        mem_email||null, mem_phone||null, validStatus, currentMemNo]);

    if (['Inactive','Expired','Not a Member'].includes(validStatus)) {
      await db.query(
        `UPDATE fat_company_audit_rel SET record_status='Inactive'
         WHERE mem_no=? AND record_status='Active'`,
        [mem_no||currentMemNo]);
      await db.query(
        `UPDATE fat_member_firm_rel SET active_flag='Inactive', to_date=CURDATE()
         WHERE mem_no=? AND active_flag='Active'`,
        [mem_no||currentMemNo]);
    }

    if (current_firm_reg_no) {
      const [[currentRel]] = await db.query(
        `SELECT fr_reg_no FROM fat_member_firm_rel
         WHERE mem_no=? AND active_flag='Active' LIMIT 1`,
        [mem_no||currentMemNo]);

      if (!currentRel || currentRel.fr_reg_no !== current_firm_reg_no) {
        if (currentRel) {
          await db.query(
            `UPDATE fat_member_firm_rel SET active_flag='Inactive', to_date=CURDATE()
             WHERE mem_no=? AND fr_reg_no=? AND active_flag='Active'`,
            [mem_no||currentMemNo, currentRel.fr_reg_no]);
        }
        const [[ex]] = await db.query(
          `SELECT mfr_id FROM fat_member_firm_rel
           WHERE mem_no=? AND fr_reg_no=? AND active_flag='Inactive' LIMIT 1`,
          [mem_no||currentMemNo, current_firm_reg_no]);
        if (ex) {
          await db.query(
            `UPDATE fat_member_firm_rel SET active_flag='Active', to_date=NULL WHERE mfr_id=?`,
            [ex.mfr_id]);
        } else {
          const mfr_id = await nextMfrId();
          await db.query(`
            INSERT INTO fat_member_firm_rel
              (mfr_id, member_id, firm_id, mem_no, fr_reg_no, designation, from_date, active_flag)
            SELECT ?, m.member_id, f.firm_id, ?, f.fr_reg_no, ?, CURDATE(), 'Active'
            FROM ma_member m, ma_firm f
            WHERE m.mem_no=? AND f.fr_reg_no=?
          `, [mfr_id, mem_no||currentMemNo, current_firm_reg_no,
              mem_no||currentMemNo, current_firm_reg_no]);
        }
      }
    }

    broadcast('member_updated', { mem_no: mem_no||currentMemNo });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /firm-inactive — mark a specific member-firm association as Inactive (one-way only)
router.patch('/firm-inactive', async (req, res) => {
  try {
    const { mem_no, fr_reg_no } = req.body;
    if (!mem_no || !fr_reg_no)
      return res.status(400).json({ error: 'mem_no and fr_reg_no required' });
    await db.query(
      `UPDATE fat_member_firm_rel SET active_flag='Inactive', to_date=CURDATE()
       WHERE mem_no=? AND fr_reg_no=? AND active_flag='Active'`,
      [mem_no, fr_reg_no]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;