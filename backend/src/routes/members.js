// Routes for /api/members — two related entities live in this one file:
//   1. CA Members (ma_member) — the individual partner/signing-member master.
//   2. Partner Records (fat_member_firm_rel, "MFR") — the join table linking
//      a member to a firm over time (designation, from/to dates, active flag).
// A member can have many MFR rows across their career (job changes); at
// most one is "current" (active_flag='Active') per firm at a time.
const router = require('express').Router();
const db     = require('../config/db');
const { broadcast } = require('../events');
const { toList, inClause } = require('../utils');

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

// GET /api/members — paginated list of CA Members, used by the CA Members
// screen and every "partner" search field. Excludes Inactive/Expired/Not-a-
// Member members by default unless ?include_inactive= or ?status= is given.
router.get('/', async (req, res) => {
  try {
    const { search='', include_inactive='' } = req.query;
    const statusList = toList(req.query.status);
    const firmList = toList(req.query.fr_reg_no || req.query.firm_id);
    const memNoList = toList(req.query.mem_no);
    const qualList = toList(req.query.qualification);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const params = [];
    let where = (include_inactive || statusList.length)
      ? 'WHERE 1=1'
      : "WHERE mm.mem_status NOT IN ('Inactive','Expired','Not a Member')";

    if (search)  { where += ' AND (mm.mem_name LIKE ? OR mm.mem_no LIKE ?)'; params.push(`%${search}%`,`%${search}%`); }
    if (statusList.length) { where += ` AND mm.mem_status IN (${statusList.map(()=>'?').join(',')})`; params.push(...statusList); }
    if (memNoList.length)  { where += ` AND mm.mem_no IN (${memNoList.map(()=>'?').join(',')})`; params.push(...memNoList); }
    if (qualList.length)   { where += ` AND mm.mem_qualification IN (${qualList.map(()=>'?').join(',')})`; params.push(...qualList); }

    // Multi-select firm filter: fr_reg_no=001234S,005678W
    if (firmList.length) {
      where += ` AND mm.mem_no IN (
        SELECT mem_no FROM fat_member_firm_rel
        WHERE (fr_reg_no IN (${firmList.map(()=>'?').join(',')}) OR firm_id IN (${firmList.map(()=>'?').join(',')}))
        AND active_flag='Active'
      )`;
      params.push(...firmList, ...firmList);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM ma_member mm ${where}`, params);

    // PERF: resolve "current firm" via a per-row correlated subquery limited to the
    // ≤500 rows on THIS page (uses idx_mfr_mem_active_from), instead of materialising
    // a ROW_NUMBER() window over the entire ~150k-row relationship table on every
    // request — that previously cost ~1.8s on every member-list load.
    const sortCols = { mem_name: 'mm.mem_name' };
    const sortCol = sortCols[req.query.sort] || 'mm.mem_name';
    const sortDir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

    const [rows] = await db.query(`
      SELECT page.*, fm.fr_name AS current_firm_name, fm.fr_reg_no AS current_firm_reg
      FROM (
        SELECT mm.*,
          (SELECT mfr.fr_reg_no FROM fat_member_firm_rel mfr
           WHERE mfr.mem_no = mm.mem_no AND mfr.active_flag = 'Active'
           ORDER BY mfr.from_date DESC LIMIT 1) AS _cur_fr_reg_no
        FROM ma_member mm
        ${where}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT ? OFFSET ?
      ) page
      LEFT JOIN ma_firm fm ON fm.fr_reg_no = page._cur_fr_reg_no
      ORDER BY page.mem_name ${sortDir}
    `, [...params, limit, offset]);
    rows.forEach(r => delete r._cur_fr_reg_no);
    res.json({ data: rows, total, page, totalPages: Math.ceil(total / limit), limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/members/relationships — lightweight active-only partner list
// (mfr_id/mem_no/fr_reg_no/designation/firm name only, no pagination, no
// master-table joins beyond firm name) used by the UI wherever it needs a
// quick firm↔member relationship lookup rather than the full paginated
// Partner Records view below.
router.get('/relationships', async (req, res) => {
  try {
    // Lightweight lookup used by the UI for firm-member dropdowns.
    // Only return active relationships with a safety limit.
    const [rows] = await db.query(`
      SELECT mfr.mfr_id, mfr.mem_no, mfr.fr_reg_no,
             mfr.designation, mfr.active_flag,
             fm.fr_name
      FROM fat_member_firm_rel mfr
      JOIN ma_firm fm ON fm.fr_reg_no = mfr.fr_reg_no
      WHERE mfr.active_flag = 'Active'
      LIMIT 10000`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PARTNER RECORDS ──────────────────────────────────────────────────
// One row per firm-member relationship (fat_member_firm_rel), enriched with
// firm name, member name and designation.
// NOTE: declared before '/:id' so the literal path is not captured by :id.
router.get('/partner-records', async (req, res) => {
  try {
    const { search='' } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const sortCol = req.query.sort === 'mem_name' ? 'mem_name' : 'fr_name';
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

    // Filters that live directly on fat_member_firm_rel — no join required to apply them.
    // All support multi-select (comma-separated values -> IN clause).
    const params = [];
    let mfrWhere = 'WHERE 1=1';
    mfrWhere += inClause('mfr.fr_reg_no',   toList(req.query.fr_reg_no),   params);
    mfrWhere += inClause('mfr.mem_no',      toList(req.query.mem_no),      params);
    mfrWhere += inClause('mfr.active_flag', toList(req.query.status),      params);
    mfrWhere += inClause('mfr.designation', toList(req.query.designation), params);
    if (req.query.mfr_id) { mfrWhere += ' AND mfr.mfr_id = ?'; params.push(req.query.mfr_id); }

    let total, rows;
    if (search) {
      // Name search needs both master tables — slower path, only hit when the user types a query.
      const searchParams = [...params, `%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`];
      const searchWhere = mfrWhere + ' AND (fm.fr_name LIKE ? OR fm.fr_reg_no LIKE ? OR mm.mem_name LIKE ? OR mm.mem_no LIKE ?)';

      const [[c]] = await db.query(
        `SELECT COUNT(*) AS total
         FROM fat_member_firm_rel mfr
         JOIN ma_firm fm   ON fm.fr_reg_no = mfr.fr_reg_no
         JOIN ma_member mm ON mm.mem_no    = mfr.mem_no
         ${searchWhere}`, searchParams);
      total = c.total;

      [rows] = await db.query(`
        SELECT mfr.mfr_id, mfr.fr_reg_no, mfr.mem_no, mfr.designation,
               mfr.relationship_type, mfr.from_date, mfr.to_date,
               mfr.active_flag, mfr.member_id, mfr.firm_id,
               fm.fr_name, fm.fr_group, fm.fr_region,
               mm.mem_name, mm.mem_qualification, mm.mem_status
        FROM fat_member_firm_rel mfr
        JOIN ma_firm fm   ON fm.fr_reg_no = mfr.fr_reg_no
        JOIN ma_member mm ON mm.mem_no    = mfr.mem_no
        ${searchWhere}
        ORDER BY ${sortCol === 'fr_name' ? 'fm.fr_name' : 'mm.mem_name'} ${dir}
        LIMIT ? OFFSET ?
      `, [...searchParams, limit, offset]);
    } else {
      // PERF: count directly off fat_member_firm_rel (no join — these filters are all
      // native mfr columns). Previously this always joined ma_firm (94k) + ma_member
      // (137k), costing ~1.1-1.6s on every load even with zero filters.
      const [[c]] = await db.query(
        `SELECT COUNT(*) AS total FROM fat_member_firm_rel mfr ${mfrWhere}`, params);
      total = c.total;

      // PERF: only join the ONE master table needed to satisfy the requested sort
      // column, and do it INSIDE the paging subquery (before LIMIT) — ma_firm.fr_name
      // and ma_member.mem_name both have name indexes, so MySQL drives the scan from
      // whichever side is being sorted and never touches the other ~94k/137k table
      // until after the page is cut down to ≤500 rows. Previously both joins ran
      // before LIMIT, scanning all 150k relationship rows on every load (~1-3.7s).
      const sql = sortCol === 'fr_name' ? `
        SELECT page.mfr_id, page.fr_reg_no, page.mem_no, page.designation,
               page.relationship_type, page.from_date, page.to_date,
               page.active_flag, page.member_id, page.firm_id,
               page.fr_name, fm2.fr_group, fm2.fr_region,
               mm.mem_name, mm.mem_qualification, mm.mem_status
        FROM (
          SELECT mfr.mfr_id, mfr.fr_reg_no, mfr.mem_no, mfr.designation,
                 mfr.relationship_type, mfr.from_date, mfr.to_date,
                 mfr.active_flag, mfr.member_id, mfr.firm_id, fm.fr_name
          FROM fat_member_firm_rel mfr
          JOIN ma_firm fm ON fm.fr_reg_no = mfr.fr_reg_no
          ${mfrWhere}
          ORDER BY fm.fr_name ${dir}
          LIMIT ? OFFSET ?
        ) page
        JOIN ma_firm fm2  ON fm2.fr_reg_no = page.fr_reg_no
        JOIN ma_member mm ON mm.mem_no     = page.mem_no
        ORDER BY page.fr_name ${dir}
      ` : `
        SELECT page.mfr_id, page.fr_reg_no, page.mem_no, page.designation,
               page.relationship_type, page.from_date, page.to_date,
               page.active_flag, page.member_id, page.firm_id,
               fm.fr_name, fm.fr_group, fm.fr_region,
               page.mem_name, mm2.mem_qualification, mm2.mem_status
        FROM (
          SELECT mfr.mfr_id, mfr.fr_reg_no, mfr.mem_no, mfr.designation,
                 mfr.relationship_type, mfr.from_date, mfr.to_date,
                 mfr.active_flag, mfr.member_id, mfr.firm_id, mm.mem_name
          FROM fat_member_firm_rel mfr
          JOIN ma_member mm ON mm.mem_no = mfr.mem_no
          ${mfrWhere}
          ORDER BY mm.mem_name ${dir}
          LIMIT ? OFFSET ?
        ) page
        JOIN ma_member mm2 ON mm2.mem_no    = page.mem_no
        JOIN ma_firm fm    ON fm.fr_reg_no  = page.fr_reg_no
        ORDER BY page.mem_name ${dir}
      `;
      [rows] = await db.query(sql, [...params, limit, offset]);
    }

    res.json({ data: rows, total, page, totalPages: Math.ceil(total / limit), limit });
  } catch(e) { console.error('[partner-records] error:', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/members/:id — single member by MRN or member_id, plus their
// full firm-relationship history (not just the current one). Used by the
// Member Detail page.
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

// POST /api/members — create a new CA Member. Generates the next
// sequential member_id itself (MEM137501, ...); mem_no (MRN) is the
// user-supplied ICAI membership number and is the real business key.
router.post('/', async (req, res) => {
  try {
    let { mem_name, mem_no, mem_city, mem_designation='Partner', mem_qualification='ACA',
          mem_gender, mem_dob, mem_since_year, fca_year,
          mem_email, mem_phone, mem_status='Active',
          current_firm_reg_no } = req.body;

    if (!mem_name || !mem_no)
      return res.status(400).json({ error: 'Name and MRN required' });

    // Firm linkage is no longer required at member creation. Members are linked
    // to firms via the Partner Records / Add Partner flow. current_firm_reg_no
    // is still accepted (e.g. legacy CSV import) but optional.
    let firmRow = null;
    if (current_firm_reg_no) {
      const [[fm]] = await db.query('SELECT fr_reg_no FROM ma_firm WHERE fr_reg_no=?', [current_firm_reg_no]);
      if (!fm) return res.status(400).json({ error: 'Firm not found: ' + current_firm_reg_no });
      firmRow = fm;
    }

    // FCA members store both years (fca derived from aca+5 if not supplied);
    // ACA-only members have no fca_year.
    if (mem_qualification === 'FCA' && !fca_year && mem_since_year)
      fca_year = Number(mem_since_year) + 5;
    if (mem_qualification !== 'FCA') fca_year = null;

    const member_id = await nextMemberId();

    // INSERT: the new member row
    await db.query(`
      INSERT INTO ma_member
        (member_id, mem_name, mem_no, mem_city, mem_designation, mem_qualification,
         mem_gender, mem_dob, mem_since_year, fca_year, mem_email, mem_phone, mem_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [member_id, mem_name, mem_no, mem_city||null, mem_designation, mem_qualification,
        mem_gender||null, mem_dob||null, mem_since_year||null, fca_year||null,
        mem_email||null, mem_phone||null, mem_status]);

    // Only create a firm-member relationship when a firm was explicitly supplied
    // (legacy import path). Normal member creation creates no MFR row.
    const allFirmRegs = (Array.isArray(req.body.firm_reg_nos) && req.body.firm_reg_nos.length)
      ? req.body.firm_reg_nos : (firmRow ? [current_firm_reg_no] : []);
    for (const regNo of allFirmRegs) {
      const mfr_id = await nextMfrId();
      // INSERT: link this new member to the supplied firm(s) (import path only)
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

// PUT /api/members/:id — edit an existing member. When status is switched
// to Inactive/Expired/Not a Member, also cascades: closes out their active
// firm relationship(s), and attempts to mark their active audit records
// inactive too (see bug note below). If current_firm_reg_no changes, also
// closes the old firm relationship and opens/reactivates one for the new firm.
router.put('/:id', async (req, res) => {
  try {
    let { mem_name, mem_no, mem_city, mem_designation, mem_qualification,
          mem_gender, mem_dob, mem_since_year, fca_year,
          mem_email, mem_phone, mem_status,
          current_firm_reg_no } = req.body;

    const [[current]] = await db.query(
      'SELECT mem_no, mem_designation FROM ma_member WHERE mem_no=? OR member_id=?',
      [req.params.id, req.params.id]);
    if (!current) return res.status(404).json({ error: 'Not found' });
    const currentMemNo = current.mem_no;

    // Designation is no longer edited from the member form (it lives on the
    // firm-member relationship). Preserve the existing value if not supplied.
    const designation = mem_designation || current.mem_designation || 'Partner';

    // Derive / clear fca_year based on qualification.
    if (mem_qualification === 'FCA' && !fca_year && mem_since_year)
      fca_year = Number(mem_since_year) + 5;
    if (mem_qualification && mem_qualification !== 'FCA') fca_year = null;

    const validStatus = ['Active','Inactive','Not a Member','Expired'].includes(mem_status) ? mem_status : 'Active';
    // UPDATE: the member row itself
    await db.query(`
      UPDATE ma_member SET
        mem_name=?, mem_no=?, mem_city=?, mem_designation=?, mem_qualification=?,
        mem_gender=?, mem_dob=?, mem_since_year=?, fca_year=?,
        mem_email=?, mem_phone=?, mem_status=?
      WHERE mem_no=?
    `, [mem_name, mem_no, mem_city||null, designation, mem_qualification||'ACA',
        mem_gender||null, mem_dob||null, mem_since_year||null, fca_year||null,
        mem_email||null, mem_phone||null, validStatus, currentMemNo]);

    if (['Inactive','Expired','Not a Member'].includes(validStatus)) {
      // KNOWN BUG: same issue as companies.js and firms.js — record_status is
      // ENUM('Active','Removed'), so 'Inactive' is not a legal value and this
      // UPDATE throws "Data truncated for column 'record_status'", failing the
      // whole request whenever the member has active audit records. Confirmed
      // by testing against the live schema. Not fixed yet.
      await db.query(
        `UPDATE fat_company_audit_rel SET record_status='Inactive'
         WHERE mem_no=? AND record_status='Active'`,
        [mem_no||currentMemNo]);
      // UPDATE: close out this member's active firm relationship(s)
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
    // UPDATE: deactivate this one member-firm relationship row
    await db.query(
      `UPDATE fat_member_firm_rel SET active_flag='Inactive', to_date=CURDATE()
       WHERE mem_no=? AND fr_reg_no=? AND active_flag='Active'`,
      [mem_no, fr_reg_no]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add a new partner record (firm-member relationship). Firm and member must
// both already exist. Designation defaults to Partner; status defaults Active.
router.post('/partner-records', async (req, res) => {
  try {
    const { fr_reg_no, mem_no, designation='Partner', from_date, to_date,
            active_flag='Active', relationship_type='Partner' } = req.body;
    if (!fr_reg_no || !mem_no)
      return res.status(400).json({ error: 'fr_reg_no and mem_no required' });

    const [[firm]] = await db.query('SELECT firm_id FROM ma_firm WHERE fr_reg_no=?', [fr_reg_no]);
    if (!firm) return res.status(404).json({ error: 'Firm not found' });
    const [[member]] = await db.query('SELECT member_id FROM ma_member WHERE mem_no=?', [mem_no]);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const [[existing]] = await db.query(
      `SELECT mfr_id FROM fat_member_firm_rel
       WHERE mem_no=? AND fr_reg_no=? AND active_flag='Active'`, [mem_no, fr_reg_no]);
    if (existing) return res.status(409).json({ error: 'This member is already an active partner at this firm' });

    const flag = (active_flag==='Active') ? 'Active' : 'Inactive';
    // To Date only makes sense for an Inactive record; default it to today when
    // the record is being added as Inactive and no explicit date was given.
    const resolvedToDate = flag === 'Inactive' ? (to_date || new Date().toISOString().slice(0,10)) : null;

    const mfr_id = await nextMfrId();
    // INSERT: the new firm-member relationship (partner record) row
    await db.query(`
      INSERT INTO fat_member_firm_rel
        (mfr_id, member_id, firm_id, mem_no, fr_reg_no, designation,
         relationship_type, from_date, to_date, active_flag)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [mfr_id, member.member_id, firm.firm_id, mem_no, fr_reg_no, designation,
        relationship_type, from_date || new Date().toISOString().slice(0,10),
        resolvedToDate, flag]);

    broadcast('partner_added', { fr_reg_no, mem_no });
    res.status(201).json({ mfr_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit an existing partner record. Firm and member are NOT editable — only
// designation, from_date, to_date and status (active_flag).
router.put('/partner-records/:mfr_id', async (req, res) => {
  try {
    const { designation, from_date, to_date, active_flag, relationship_type } = req.body;
    const [[rel]] = await db.query(
      'SELECT mfr_id, mem_no FROM fat_member_firm_rel WHERE mfr_id=?', [req.params.mfr_id]);
    if (!rel) return res.status(404).json({ error: 'Partner record not found' });

    const flag = (active_flag === 'Active') ? 'Active' : 'Inactive';
    // When deactivating: use the explicit to_date if supplied, otherwise keep an
    // existing one, otherwise stamp today. When reactivating, always clear it.
    // UPDATE: the partner record row (designation/dates/status)
    await db.query(`
      UPDATE fat_member_firm_rel SET
        designation = COALESCE(?, designation),
        relationship_type = COALESCE(?, relationship_type),
        from_date = COALESCE(?, from_date),
        active_flag = ?,
        to_date = CASE WHEN ?='Inactive' THEN COALESCE(?, to_date, CURDATE()) ELSE NULL END
      WHERE mfr_id=?
    `, [designation||null, relationship_type||null, from_date||null, flag, flag, to_date||null, req.params.mfr_id]);

    broadcast('partner_updated', { mfr_id: req.params.mfr_id, mem_no: rel.mem_no });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;