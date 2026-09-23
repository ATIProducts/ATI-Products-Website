// lib/requireAuth.js
//
// Wraps an API route so it only runs for someone who is logged in (and,
// optionally, has a particular role). This is the real security boundary:
// every read of page content and every save to GitHub goes through a
// wrapped route, and each one re-checks the signed session cookie AND
// that the person still exists with the same login version.
//
// It also records who is making the request, so that commits saved to
// GitHub are credited to that person (see lib/github.js).

const { AsyncLocalStorage } = require('async_hooks');
const { readSession } = require('./auth');
const { resolveSession } = require('./users');

const requestContext = new AsyncLocalStorage();

function requireAuth(handler, options) {
  const needRole = options && options.role;
  return async (req, res) => {
    let person = null;
    try {
      person = await resolveSession(readSession(req));
    } catch (e) {
      res.status(502).json({ error: e.message });
      return;
    }
    if (!person) {
      res.status(401).json({ error: 'Not logged in (or your login was reset). Please log in again.' });
      return;
    }
    if (needRole && person.role !== needRole) {
      res.status(403).json({ error: 'Only admins can do that.' });
      return;
    }
    req.user = person;
    return requestContext.run({ user: person }, () => handler(req, res));
  };
}

// The person making the current request, or null.
function currentUser() {
  const store = requestContext.getStore();
  return store ? store.user : null;
}

module.exports = { requireAuth, currentUser };
