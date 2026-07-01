const router = require('express').Router();
const db     = require('../config/db');
const { broadcast } = require('../events');
const { toList, inClause } = require('../utils');

function normaliseRtype(r) { return (r||'').replace(/\s*—\s*/g,' ').trim(); }

function computeDQ(d) {
  if ((d.tenure_years||0) > 10)                              return 'C';
  if (!d.signing_date)                                       return 'B';
  if (!d.audit_opinion && d.record_status==='Active')        return 'B';
  if (!d.tenure_years)                                       return 'B';
  return 'A';
}

function rotStatus(yr) {
  const y = parseInt(yr)||0;
  if (y > 5)  return 'Overdue';
  if (y === 5) return 'Due';
  if (y >= 4) return 'Approaching';
  return 'OK';
}

router.get('/', async (req, res) => {
  try {
    const { sort='', dir='' } = req.query;
    const page  = parseInt(req.query.page)  || 0;
    const limit = parseInt(req.query.limit) || 0;
    const search   = req.query.search   || '';
    const audit_rel_id_filter = req.query.audit_rel_id || '';
    const fr_reg_noList   = toList(req.query.fr_reg_no || req.query.firm_id);
    const mem_noList      = toList(req.query.mem_no    || req.query.member_id);
    const designationList = toList(req.query.designation);

    const params = [];
    let where = 'WHERE 1=1';
    if (audit_rel_id_filter) { where += ' AND f.audit_rel_id=?'; params.push(audit_rel_id_filter); }
    // Multi-select filters: company_id=CO1,CO2 / fy_id=1,2 / status=Active,Inactive / opinion=.../designation=...
    where += inClause('f.company_id',      toList(req.query.company_id), params);
    where += inClause('f.fy_id',           toList(req.query.fy_id),      params);
    where += inClause('f.fr_reg_no',       fr_reg_noList, params);
    where += inClause('f.mem_no',          mem_noList,    params);
    // Exclude 'Removed' records by default; only include if explicitly requested via status=Removed
    const statusList = toList(req.query.status);
    if (statusList.length) {
      where += inClause('f.record_status', statusList, params);
    } else {
      where += " AND f.record_status != 'Removed'";
    }
    where += inClause('f.audit_opinion',   toList(req.query.opinion), params);
    where += inClause('f.report_type',     toList(req.query.report_type), params);
    where += inClause('f.rotation_status', toList(req.query.rotation_status), params);
    where += inClause('mm.mem_designation', designationList, params);
    if (search) {
      where += ' AND (fm.fr_name LIKE ? OR mm.mem_name LIKE ? OR cm.co_name LIKE ?)';
      params.push(`%${search}%`,`%${search}%`,`%${search}%`);
    }
    const sortCols = {
      seq_no: 'f.seq_no', signing_date: 'f.signing_date', tenure_years: 'f.tenure_years',
      fr_name: 'fm.fr_name', mem_name: 'mm.mem_name', co_name: 'cm.co_name'
    };
    const orderBy = sortCols[sort]
      ? `${sortCols[sort]} ${dir==='asc'?'ASC':'DESC'}, cm.co_name`
      : 'fy.fy_start_date DESC, cm.co_name, f.seq_no';

    // STRAIGHT_JOIN forces MySQL to drive the join from the small fact table
    // (fat_company_audit_rel, ~600 rows) instead of letting the optimizer pick
    // the huge ma_firm (94k) / ma_member (137k) tables as the driving table,
    // which produced a multi-second nested-loop scan and made the unfiltered
    // /appointments request time out on the client.
    const sql = `
      SELECT STRAIGHT_JOIN
             f.*, cm.co_name, cm.co_cin, cm.co_isin, cm.co_bse_code, s.sector_name,
             fm.fr_name, fm.fr_reg_no,
             mm.mem_name, mm.mem_no, mm.mem_designation, mm.mem_status,
             fy.fy_label
      FROM fat_company_audit_rel f
      JOIN ma_company cm  ON cm.company_id = f.company_id
      JOIN ma_firm fm     ON fm.fr_reg_no  = f.fr_reg_no
      JOIN ma_member mm   ON mm.mem_no     = f.mem_no
      JOIN ma_fy fy       ON fy.fy_id      = f.fy_id
      LEFT JOIN ma_sector s ON s.sector_id = cm.sector_id
      ${where} ORDER BY ${orderBy}`;

    if (page > 0 && limit > 0) {
      // COUNT only needs ma_firm/ma_member joins when a name search is active.
      // Otherwise all filters touch f.* columns, so count the fact table alone
      // (≈600 rows) instead of joining the 94k/137k firm & member tables.
      let total;
      const _tc = Date.now();
      if (search) {
        const [[c]] = await db.query(
          `SELECT COUNT(*) AS total FROM fat_company_audit_rel f
           JOIN ma_company cm ON cm.company_id=f.company_id
           JOIN ma_firm fm    ON fm.fr_reg_no=f.fr_reg_no
           JOIN ma_member mm  ON mm.mem_no=f.mem_no
           JOIN ma_fy fy      ON fy.fy_id=f.fy_id
           LEFT JOIN ma_sector s ON s.sector_id=cm.sector_id ${where}`, params);
        total = c.total;
      } else {
        // Rebuild a where clause that only references f.* (designation is the only
        // join-dependent filter; if it's set we must keep the member join).
        if (designationList.length) {
          const [[c]] = await db.query(
            `SELECT COUNT(*) AS total FROM fat_company_audit_rel f
             JOIN ma_member mm ON mm.mem_no=f.mem_no ${where}`, params);
          total = c.total;
        } else {
          const [[c]] = await db.query(
            `SELECT COUNT(*) AS total FROM fat_company_audit_rel f ${where}`, params);
          total = c.total;
        }
      }
      const _td = Date.now();
      const [rows] = await db.query(sql+' LIMIT ? OFFSET ?', [...params, limit, (page-1)*limit]);
      console.log(`[appointments] page ${page}: count ${_td-_tc}ms, data ${Date.now()-_td}ms, ${rows.length} rows`);
      return res.json({ data: rows, total, page, totalPages: Math.ceil(total/limit) });
    }
    // No pagination: add a safety cap to prevent unbounded full-table scans
    const _t0 = Date.now();
    const [rows] = await db.query(sql + ' LIMIT 5000', params);
    console.log(`[appointments] returned ${rows.length} rows in ${Date.now()-_t0}ms`);
    res.json(rows);
  } catch(e) { console.error('[appointments] error:', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const [[row]] = await db.query(`
      SELECT f.*, cm.co_name, cm.co_isin, cm.co_bse_code,
             fm.fr_name, fm.fr_reg_no, mm.mem_name, mm.mem_no, fy.fy_label
      FROM fat_company_audit_rel f
      JOIN ma_company cm ON cm.company_id = f.company_id
      JOIN ma_firm fm    ON fm.fr_reg_no  = f.fr_reg_no
      JOIN ma_member mm  ON mm.mem_no     = f.mem_no
      JOIN ma_fy fy      ON fy.fy_id      = f.fy_id
      WHERE f.audit_rel_id=? ORDER BY f.seq_no LIMIT 1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { company_id, fy_id,
            auditor_role='Statutory', audit_opinion, signing_date,
            sebi_filing_date, tenure_years, record_status='Active', remarks,
            audit_fee, tax_audit_fee, other_capacity_fee, certification_fee,
            report_start_date, report_end_date } = req.body;
    const fr_reg_no = req.body.fr_reg_no || req.body.firm_id   || '';
    const mem_no    = req.body.mem_no    || req.body.member_id || '';

    // report_type comes from front-end (hidden field based on which button was clicked)
    const rtype = normaliseRtype(req.body.report_type || 'Annual Standalone');

    if (!company_id||!fy_id||!fr_reg_no||!mem_no)
      return res.status(400).json({ error: 'company_id, fy_id, fr_reg_no, mem_no required' });

    // Duplicate check: same company+FY+firm+member+report_type
    const [dup] = await db.query(
      `SELECT audit_rel_id FROM fat_company_audit_rel
       WHERE company_id=? AND fy_id=? AND fr_reg_no=? AND mem_no=? AND report_type=?`,
      [company_id, fy_id, fr_reg_no, mem_no, rtype]);
    if (dup.length) return res.status(409).json({ error: 'Duplicate appointment' });

    const [[co]] = await db.query('SELECT co_name FROM ma_company WHERE company_id=?', [company_id]);
    const [[fm]] = await db.query('SELECT fr_name FROM ma_firm WHERE fr_reg_no=?', [fr_reg_no]);
    const [[mm]] = await db.query('SELECT mem_name FROM ma_member WHERE mem_no=?', [mem_no]);
    if (!co||!fm||!mm) return res.status(400).json({ error: 'Invalid company, firm or member' });

    const rot = rotStatus(tenure_years);
    const dq  = computeDQ({ signing_date, audit_opinion, tenure_years, record_status });

    // Reuse existing audit_rel_id for same company+FY, or create new
    const [[existing]] = await db.query(
      `SELECT audit_rel_id, MAX(seq_no) AS max_seq
       FROM fat_company_audit_rel
       WHERE company_id=? AND fy_id=?
       GROUP BY audit_rel_id`,
      [company_id, fy_id]);

    let audit_rel_id, seq_no;
    if (existing && existing.audit_rel_id) {
      audit_rel_id = existing.audit_rel_id;
      seq_no = (existing.max_seq || 0) + 1;
    } else {
      const [[{ maxAr }]] = await db.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(audit_rel_id,3) AS UNSIGNED)),0) AS maxAr
         FROM fat_company_audit_rel`);
      audit_rel_id = 'AR' + String(Number(maxAr)+1).padStart(6,'0');
      seq_no = 1;
    }

    await db.query(`
      INSERT INTO fat_company_audit_rel
        (audit_rel_id, seq_no, company_id, fy_id, fr_reg_no, mem_no, report_type,
         auditor_role, audit_opinion, signing_date, sebi_filing_date,
         tenure_years, record_status, dq_status, rotation_status, remarks,
         audit_fee, tax_audit_fee, other_capacity_fee, certification_fee,
         report_start_date, report_end_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [audit_rel_id, seq_no, company_id, fy_id, fr_reg_no, mem_no, rtype,
        auditor_role, audit_opinion||null, signing_date||null, sebi_filing_date||null,
        tenure_years||null, record_status, dq, rot, remarks||null,
        audit_fee||null, tax_audit_fee||null, other_capacity_fee||null, certification_fee||null,
        report_start_date||null, report_end_date||null]);

    if (rot !== 'OK') {
      await db.query(`
        INSERT INTO log_alert
          (alert_type,company_id,firm_id,member_id,fy_id,audit_rel_id,tenure_years,regulatory_limit,alert_message)
        VALUES (?,?,?,?,?,?,?,?,?)
      `, [rot==='Overdue'?'rotation_overdue':rot==='Due'?'rotation_due':'rotation_approaching',
          company_id, fr_reg_no, mem_no, fy_id, audit_rel_id, tenure_years, 5,
          `${co.co_name}: ${fm.fr_name} tenure ${tenure_years}yr (limit 5)`]);
    }
    await generateDQ(db, audit_rel_id, company_id, fy_id, req.body);
    broadcast('appointment_added', { audit_rel_id, seq_no, company_id, fy_id });
    res.status(201).json({ audit_rel_id, seq_no });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { report_type, auditor_role, audit_opinion, signing_date,
            sebi_filing_date, tenure_years, record_status, remarks, seq_no,
            audit_fee, tax_audit_fee, other_capacity_fee, certification_fee,
            report_start_date, report_end_date } = req.body;

    if (signing_date && sebi_filing_date && sebi_filing_date < signing_date)
      return res.status(400).json({ error: 'SEBI filing date cannot be before signing date' });

    const rtype = report_type ? normaliseRtype(report_type) : null;
    const dq    = computeDQ({ signing_date, audit_opinion, tenure_years, record_status });
    const rot   = rotStatus(tenure_years);

    const whereSeq  = seq_no ? 'AND seq_no=?' : '';
    const seqParams = seq_no ? [seq_no] : [];

    const setClauses = [];
    const setParams  = [];
    if (rtype)        { setClauses.push('report_type=?');    setParams.push(rtype); }
    if (auditor_role) { setClauses.push('auditor_role=?');   setParams.push(auditor_role); }
    setClauses.push('audit_opinion=?');    setParams.push(audit_opinion||null);
    setClauses.push('signing_date=?');     setParams.push(signing_date||null);
    setClauses.push('sebi_filing_date=?'); setParams.push(sebi_filing_date||null);
    setClauses.push('tenure_years=?');     setParams.push(tenure_years||null);
    if (record_status){ setClauses.push('record_status=?');  setParams.push(record_status); }
    setClauses.push('dq_status=?');        setParams.push(dq);
    setClauses.push('rotation_status=?');  setParams.push(rot);
    setClauses.push('remarks=?');          setParams.push(remarks||null);
    setClauses.push('audit_fee=?');          setParams.push(audit_fee!=null?audit_fee:null);
    setClauses.push('tax_audit_fee=?');      setParams.push(tax_audit_fee!=null?tax_audit_fee:null);
    setClauses.push('other_capacity_fee=?'); setParams.push(other_capacity_fee!=null?other_capacity_fee:null);
    setClauses.push('certification_fee=?');  setParams.push(certification_fee!=null?certification_fee:null);
    setClauses.push('report_start_date=?');  setParams.push(report_start_date||null);
    setClauses.push('report_end_date=?');    setParams.push(report_end_date||null);

    await db.query(
      `UPDATE fat_company_audit_rel SET ${setClauses.join(', ')} WHERE audit_rel_id=? ${whereSeq}`,
      [...setParams, req.params.id, ...seqParams]);

    const [[appt]] = await db.query(
      'SELECT company_id, fy_id, fr_reg_no, mem_no FROM fat_company_audit_rel WHERE audit_rel_id=? LIMIT 1',
      [req.params.id]);
    if (!appt) return res.status(404).json({ error: 'Not found' });

    await db.query(`DELETE FROM log_dq_issue WHERE audit_rel_id=? AND status='open'`, [req.params.id]);
    await generateDQ(db, req.params.id, appt.company_id, appt.fy_id, req.body);

    await db.query(
      `DELETE FROM log_alert WHERE audit_rel_id=?
       AND alert_type IN ('rotation_overdue','rotation_due','rotation_approaching') AND status='open'`,
      [req.params.id]);

    if (rot !== 'OK') {
      const [[co]] = await db.query('SELECT co_name FROM ma_company WHERE company_id=?', [appt.company_id]);
      const [[fm]] = await db.query('SELECT fr_name FROM ma_firm WHERE fr_reg_no=?', [appt.fr_reg_no]);
      if (co && fm) await db.query(`
        INSERT INTO log_alert
          (alert_type,company_id,firm_id,member_id,fy_id,audit_rel_id,tenure_years,regulatory_limit,alert_message)
        VALUES (?,?,?,?,?,?,?,?,?)
      `, [rot==='Overdue'?'rotation_overdue':rot==='Due'?'rotation_due':'rotation_approaching',
          appt.company_id, appt.fr_reg_no, appt.mem_no, appt.fy_id, req.params.id,
          tenure_years, 5, `${co.co_name}: ${fm.fr_name} tenure ${tenure_years}yr (limit 5)`]);
    }
    broadcast('appointment_updated', { audit_rel_id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id/status — mark Removed (cannot re-activate via this endpoint)
router.patch('/:id/status', async (req, res) => {
  try {
    const { record_status, seq_no } = req.body;
    if (record_status !== 'Removed')
      return res.status(400).json({ error: 'Only Removed is accepted via this endpoint' });
    const whereSeq = seq_no ? 'AND seq_no=?' : '';
    const seqParams = seq_no ? [seq_no] : [];
    await db.query(
      `UPDATE fat_company_audit_rel SET record_status='Removed' WHERE audit_rel_id=? ${whereSeq}`,
      [req.params.id, ...seqParams]);
    broadcast('appointment_updated', { audit_rel_id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.query(`DELETE FROM log_dq_issue WHERE audit_rel_id=?`, [req.params.id]);
    await db.query(`DELETE FROM log_alert WHERE audit_rel_id=?`, [req.params.id]);
    await db.query('DELETE FROM fat_company_audit_rel WHERE audit_rel_id=?', [req.params.id]);
    broadcast('appointment_deleted', { audit_rel_id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/import', async (req, res) => {
  const { rows = [] } = req.body;
  if (!rows.length) return res.status(400).json({ error: 'No rows provided' });

  let inserted = 0, updated = 0, skipped = 0;
  const errors = [];
  const fyCache = {}, coCache = {}, fmCache = {}, mmCache = {};

  const [fyRows] = await db.query('SELECT fy_id, fy_label FROM ma_fy WHERE is_active=1');
  fyRows.forEach(f => { fyCache[f.fy_label.trim()] = f.fy_id; });

  const [[{ maxAr }]] = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(audit_rel_id,3) AS UNSIGNED)),0) AS maxAr FROM fat_company_audit_rel`);
  let nextId = Number(maxAr) + 1;

  for (const [i, row] of rows.entries()) {
    try {
      const fyLabel = (row.fy_label||'').trim();
      const fy_id = fyCache[fyLabel];
      if (!fy_id) { errors.push(`Row ${i+1}: unknown fy_label '${fyLabel}'`); skipped++; continue; }

      let company_id = row.company_id;
      if (!company_id && row.co_isin) {
        if (!coCache[row.co_isin]) {
          const [[co]] = await db.query('SELECT company_id FROM ma_company WHERE co_isin=?', [row.co_isin]);
          if (co) coCache[row.co_isin] = co;
        }
        company_id = coCache[row.co_isin]?.company_id;
      }
      if (!company_id) { errors.push(`Row ${i+1}: company not found`); skipped++; continue; }

      const firmKey = (row.firm_reg_no||'').trim();
      if (firmKey && !fmCache[firmKey]) {
        const [[fm]] = await db.query('SELECT fr_reg_no FROM ma_firm WHERE fr_reg_no=?', [firmKey]);
        if (fm) fmCache[firmKey] = fm;
      }
      const fr_reg_no = fmCache[firmKey]?.fr_reg_no || row.fr_reg_no || '';
      if (!fr_reg_no) { errors.push(`Row ${i+1}: firm not found`); skipped++; continue; }

      const memKey = (row.member_no||'').trim();
      if (memKey && !mmCache[memKey]) {
        const [[mm]] = await db.query('SELECT mem_no FROM ma_member WHERE mem_no=?', [memKey]);
        if (mm) mmCache[memKey] = mm;
      }
      const mem_no = mmCache[memKey]?.mem_no || row.mem_no || '';
      if (!mem_no) { errors.push(`Row ${i+1}: member not found`); skipped++; continue; }

      const rtype = normaliseRtype(
        ['Annual Standalone','Annual Consolidated'].includes(row.report_type)
          ? row.report_type : 'Annual Standalone');
      const record_status = ['Active','Inactive'].includes(row.record_status) ? row.record_status : 'Active';
      const tenure_years  = row.tenure_years ? parseInt(row.tenure_years)||null : null;
      const audit_opinion = row.audit_opinion || null;
      const signing_date  = row.signing_date  || null;
      const sebi_filing_date = row.sebi_filing_date || null;
      const remarks = row.remarks || null;
      const rot = rotStatus(tenure_years);
      const dq  = computeDQ({ signing_date, audit_opinion, tenure_years, record_status });

      const [[dup]] = await db.query(
        `SELECT audit_rel_id FROM fat_company_audit_rel
         WHERE company_id=? AND fy_id=? AND fr_reg_no=? AND mem_no=? AND report_type=?`,
        [company_id, fy_id, fr_reg_no, mem_no, rtype]);

      if (dup) {
        await db.query(`
          UPDATE fat_company_audit_rel SET
            audit_opinion=?, signing_date=?, sebi_filing_date=?, tenure_years=?,
            record_status=?, dq_status=?, rotation_status=?, remarks=?
          WHERE audit_rel_id=? AND fr_reg_no=? AND mem_no=?
        `, [audit_opinion, signing_date, sebi_filing_date, tenure_years,
            record_status, dq, rot, remarks, dup.audit_rel_id, fr_reg_no, mem_no]);
        updated++;
      } else {
        const [[existing]] = await db.query(
          `SELECT audit_rel_id, MAX(seq_no) AS max_seq FROM fat_company_audit_rel
           WHERE company_id=? AND fy_id=? GROUP BY audit_rel_id`, [company_id, fy_id]);
        let audit_rel_id, seq_no;
        if (existing && existing.audit_rel_id) {
          audit_rel_id = existing.audit_rel_id;
          seq_no = (existing.max_seq || 0) + 1;
        } else {
          audit_rel_id = 'AR' + String(nextId++).padStart(6,'0');
          seq_no = 1;
        }
        await db.query(`
          INSERT INTO fat_company_audit_rel
            (audit_rel_id, seq_no, company_id, fy_id, fr_reg_no, mem_no,
             report_type, auditor_role, audit_opinion, signing_date,
             sebi_filing_date, tenure_years, record_status, dq_status, rotation_status, remarks)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [audit_rel_id, seq_no, company_id, fy_id, fr_reg_no, mem_no, rtype, 'Statutory',
            audit_opinion, signing_date, sebi_filing_date, tenure_years, record_status,
            dq, rot, remarks]);
        inserted++;
      }
    } catch(e) { errors.push(`Row ${i+1}: ${e.message}`); skipped++; }
  }

  broadcast('appointment_added', { bulk: true });
  res.json({ inserted, updated, skipped, errors });
});

async function generateDQ(db, audit_rel_id, company_id, fy_id, data) {
  const issues = [];
  if (!data.signing_date)  issues.push(['warning','missing','signing_date','Signing date not recorded']);
  if (!data.tenure_years)  issues.push(['info','missing','tenure_years','Audit tenure not entered']);
  if ((parseInt(data.tenure_years)||0)>10) issues.push(['error','tenure','tenure_years','Tenure exceeds 10-year maximum']);
  if (!data.audit_opinion && data.record_status==='Active')
    issues.push(['info','missing','audit_opinion','Audit opinion not recorded on confirmed record']);
  for (const [sev,type,field,desc] of issues)
    await db.query(
      `INSERT INTO log_dq_issue (audit_rel_id,company_id,fy_id,severity,issue_type,field_name,description) VALUES (?,?,?,?,?,?,?)`,
      [audit_rel_id, company_id, fy_id, sev, type, field, desc]);
}

module.exports = router;