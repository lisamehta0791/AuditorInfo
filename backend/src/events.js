const EventEmitter = require('events');
const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function broadcast(type, payload) {
  emitter.emit('update', { type, payload, ts: Date.now() });
}

module.exports = { emitter, broadcast };