// Routes for /api/sectors — read-only lookup list of industry sectors
// (ma_sector), used to populate the "Sector" dropdown/filter on the
// Companies screen and the Add/Edit Company form. Nothing writes here —
// sectors are seeded directly in the database, not managed through the app.
const router = require('express').Router();
const db     = require('../config/db');
const auth   = require('../middleware/auth');

// GET /api/sectors — list all active sectors, alphabetically.
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT sector_id, sector_name, regulatory_body FROM ma_sector WHERE is_active=1 ORDER BY sector_name'
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;