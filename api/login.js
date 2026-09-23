// api/login.js
//
// POST { username, password } -> sets a session cookie on success.
// Works for the main admin account (from Vercel settings) and for anyone
// added on the admin's "People" screen.
//
// Rate limiting note: Vercel functions keep no memory between requests, so
// there's no attempt counter without a database. Passwords created by the
// admin are long and random, and people choosing their own must use at
// least 10 characters, which keeps guessing impractical.

const { createSessionCookie } = require('../lib/auth');
const { authenticate } = require('../lib/users');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  const { username, password } = body || {};

  const missing = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    res.status(500).json({
      error: `The admin isn't set up yet. Missing Vercel setting(s): ${missing.join(', ')}. Add them in Vercel, then redeploy (see the setup guide).`,
    });
    return;
  }

  let person;
  try {
    person = await authenticate(username, password);
  } catch (e) {
    res.status(502).json({ error: e.message });
    return;
  }

  if (!person) {
    res.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }

  res.setHeader('Set-Cookie', createSessionCookie(person));
  res.status(200).json({ ok: true });
};
