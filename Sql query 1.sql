-- AuditLens — Company ID format fix
-- Run once against your database (already applied to this one).
--
-- Problem: ma_company.company_id was seeded as 4-digit (CO0001..CO0504),
-- but the "Add Company" code was generating new IDs as 6-digit
-- (CO000505, CO000506, ...), producing an inconsistent format.
--
-- Decision: keep 6 digits going forward (room for up to 999,999 companies).
-- This statement re-pads all existing 4-digit IDs to match.
--
-- Safe to run: company_id is referenced by fat_company_audit_rel, log_alert,
-- log_dq_issue, and txn_company_listing, all with ON UPDATE CASCADE — so
-- this single statement updates every linked row automatically. No manual
-- updates to those tables are needed.
--
-- Verified on the live database before running: 504 rows renamed,
-- 601 linked audit records + 9 linked DQ issues cascaded, 0 orphans, 0 collisions.

UPDATE ma_company
SET company_id = CONCAT('CO', LPAD(CAST(SUBSTRING(company_id, 3) AS UNSIGNED), 6, '0'))
WHERE company_id REGEXP '^CO[0-9]{1,5}$';
