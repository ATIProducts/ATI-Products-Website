// api/login.js
//
// POST { username, password } -> sets a session cookie on success.
// Rate limiting note: Vercel serverless functions are stateless between
// invocations, so a persistent rate-limit counter isn't possible without
// adding a database. As a floor against brute-forcing, use a genuinely
// strong ADMIN_PASSWORD (SETUP.md shows how to generate one) — with a
// long random password, guessing attacks are not practical even without
// rate limiting.

const { createSessionCookie, constantTimeStringEqual } = require('../lib/auth');

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

  const expectedUser = process.env.ADMIN_USERNAME || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;

  const missing = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    res.status(500).json({
      error: `The admin isn't set up yet. Missing Vercel setting(s): ${missing.join(', ')}. Add them in Vercel, then redeploy (see the setup guide).`,
    });
    return;
  }

  const userOk = constantTimeStringEqual(username || '', expectedUser);
  const passOk = constantTimeStringEqual(password || '', expectedPass);

  if (!userOk || !passOk) {
    res.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }

  res.setHeader('Set-Cookie', createSessionCookie());
  res.status(200).json({ ok: true });
};
