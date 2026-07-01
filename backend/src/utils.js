// Splits a comma-separated query param into a trimmed, de-duped array.
// Supports both single values ("Active") and multi-select ("Active,Inactive"),
// used to build SQL IN(...) clauses for the Amazon-style multi-select filters.
function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) v = v.join(',');
  return [...new Set(String(v).split(',').map(s => s.trim()).filter(Boolean))];
}

// Builds " AND col IN (?,?,...)" + pushes params, or '' if list is empty.
function inClause(col, list, params) {
  if (!list.length) return '';
  params.push(...list);
  return ` AND ${col} IN (${list.map(()=>'?').join(',')})`;
}

module.exports = { toList, inClause };
