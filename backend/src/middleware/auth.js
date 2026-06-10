// No authentication — open access, no user tracking
module.exports = function requireAuth(req, res, next) { next(); };