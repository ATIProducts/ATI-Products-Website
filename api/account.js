// api/account.js — "My account", for anyone logged in.
//
// POST { action: 'name', name }              — change your display name
// POST { currentPassword, newPassword }      — change your password
// On success the person gets a fresh session cookie; any other sessions
// they had (another computer, a lost laptop) stop working.

const { requireAuth } = require('../lib/requireAuth');
const { createSessionCookie } = require('../lib/auth');
const users = require('../lib/users');

module.exports = requireAuth(async (req, res) => {
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
  const { currentPassword, newPassword } = body || {};

  // ----- change the name shown for you in the admin and in the change history -----
  if (body && body.action === 'name') {
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) {
      res.status(400).json({ error: 'Please type your name.' });
      return;
    }
    try {
      await users.updateUsers((list, main) => {
        if (req.user.builtIn) {
          main.name = name;
          return;
        }
        const u = list.find((x) => x.username === req.user.username);
        if (!u) {
          const e = new Error('Your login wasn’t found. Please log in again.');
          e.status = 401;
          e.expose = true;
          throw e;
        }
        u.name = name;
      }, `${req.user.name} changed their admin display name to ${name}`);
      res.status(200).json({ ok: true, name });
    } catch (e) {
      res.status(e.expose ? e.status : 502).json({ error: e.message });
    }
    return;
  }

  if (req.user.builtIn) {
    res.status(400).json({
      error: 'This is the main admin account. Its password is the ADMIN_PASSWORD setting in Vercel. Change it there, then redeploy.',
    });
    return;
  }

  const next = String(newPassword || '');
  if (next.length < 10) {
    res.status(400).json({ error: 'Please choose a password with at least 10 characters.' });
    return;
  }
  if (/^(.)\1+$/.test(next) || /^(password|1234567890|qwertyuiop)/i.test(next)) {
    res.status(400).json({ error: 'That password is too easy to guess. Please choose another.' });
    return;
  }

  try {
    let updated = null;
    await users.updateUsers((list) => {
      const u = list.find((x) => x.username === req.user.username);
      if (!u) {
        const e = new Error('Your login wasn’t found. Please log in again.');
        e.status = 401;
        e.expose = true;
        throw e;
      }
      if (!users.checkPassword(currentPassword, u.password)) {
        const e = new Error('Your current password isn’t right.');
        e.status = 400;
        e.expose = true;
        throw e;
      }
      if (users.checkPassword(next, u.password)) {
        const e = new Error('The new password must be different from the current one.');
        e.status = 400;
        e.expose = true;
        throw e;
      }
      u.password = users.hashPassword(next);
      u.ver = users.newVersion();
      u.mustChangePassword = false;
      updated = { username: u.username, ver: u.ver };
    }, `${req.user.name} changed their admin password`);

    res.setHeader('Set-Cookie', createSessionCookie(updated));
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(e.expose ? e.status : 502).json({ error: e.message });
  }
});
