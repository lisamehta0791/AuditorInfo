// Route for /api/events — the Server-Sent Events (SSE) stream that pushes
// live cross-tab updates (e.g. 'firm_added', 'company_updated',
// 'alert_acknowledged' — see broadcast() calls throughout the other route
// files). The frontend opens one long-lived connection to this endpoint per
// tab and re-fetches whichever list is on screen when a relevant event
// arrives, so multiple open tabs/users stay in sync without polling.
const router  = require('express').Router();
const auth    = require('../middleware/auth');
const { emitter } = require('../events');

// GET /api/events — opens the SSE stream. Sends a heartbeat comment every
// 20s to keep the connection from being closed by proxies/browsers, and
// forwards every 'update' event from the shared emitter (see events.js)
// straight through to this client until the connection closes.
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