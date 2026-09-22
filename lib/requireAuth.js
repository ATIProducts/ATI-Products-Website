// lib/requireAuth.js
//
// Wraps an API route handler so it always checks the session cookie first.
// This is the real security boundary — the /admin page redirect (see
// middleware.js) is a convenience for the browser, but every write to
// GitHub happens through one of these wrapped routes, so a request can't
// reach GitHub without a valid, unexpired session cookie no matter how
// it's sent.

const { isAuthenticated } = require('./auth');

function requireAuth(handler) {
  return async (req, res) => {
    if (!isAuthenticated(req)) {
      res.status(401).json({ error: 'Not authenticated. Please log in again.' });
      return;
    }
    return handler(req, res);
  };
}

module.exports = { requireAuth };
