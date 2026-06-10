const router  = require('express').Router();
const auth    = require('../middleware/auth');
const { emitter } = require('../events');

// GET /api/events  — SSE stream for real-time updates
router.get('/', auth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send a heartbeat every 20s to keep connection alive
  const hb = setInterval(() => res.write(':heartbeat\n\n'), 20000);

  const handler = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  emitter.on('update', handler);

  req.on('close', () => {
    clearInterval(hb);
    emitter.removeListener('update', handler);
  });
});

module.exports = router;