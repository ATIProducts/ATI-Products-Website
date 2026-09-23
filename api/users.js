// api/users.js — the "People" screen (admins only).
//
// GET  /api/users                                   -> everyone who can log in
// POST /api/users { action: "add", name, username, email, role }
//                                                   -> creates the login, returns a temporary password ONCE
// POST /api/users { action: "reset", username }     -> new temporary password; old password and sessions stop working
// POST /api/users { action: "role", username, role }-> make someone an admin or an editor
// POST /api/users { action: "remove", username }    -> deletes the login; their sessions stop working
//
// Each change is saved to admin/users.enc.json in GitHub (encrypted).

const { requireAuth } = require('../lib/requireAuth');
const users = require('../lib/users');

function bodyOf(req) {
  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  return body || {};
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true; // safe to pass this status to the browser
  return e;
}

module.exports = requireAuth(
  async (req, res) => {
    try {
      if (req.method === 'GET') {
        let list;
        try {
          list = (await users.loadUsers({ fresh: true })).users;
        } catch (e) {
          if (e.code !== 'USERS_LOCKED') throw e;
          res.status(409).json({ error: e.message, locked: true, canReset: !!req.user.builtIn });
          return;
        }
        const people = [users.mainAdmin()].concat(
          list.slice().sort((a, b) => a.name.localeCompare(b.name))
        );
        res.status(200).json({ people: people.map(users.publicUser), you: req.user.username });
        return;
      }

      if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }

      const body = bodyOf(req);
      const action = body.action;
      const username = users.normalizeUsername(body.username);
      const main = users.mainAdmin();

      if (action === 'add') {
        const name = String(body.name || '').trim().slice(0, 80);
        const email = String(body.email || '').trim().slice(0, 120);
        const role = users.ROLES.includes(body.role) ? body.role : 'editor';
        if (!name) throw fail(400, 'Please enter the person’s name.');
        if (!users.validUsername(username)) {
          throw fail(400, 'Usernames can use lowercase letters, numbers, dots, dashes and underscores (2–40 characters), like "jsmith" or "jane.smith".');
        }
        if (username === main.username) throw fail(409, `"${username}" is the main admin account’s username. Choose another.`);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'That email address doesn’t look right.');

        const password = users.generatePassword();
        await users.updateUsers((list) => {
          if (list.some((u) => u.username === username)) throw fail(409, `Someone already has the username "${username}".`);
          list.push({
            username,
            name,
            email,
            role,
            password: users.hashPassword(password),
            ver: users.newVersion(),
            mustChangePassword: true,
            createdAt: new Date().toISOString(),
            createdBy: req.user.username,
          });
        }, `Add admin login for ${name} (${role})`);
        res.status(200).json({ ok: true, username, name, password });
        return;
      }

      if (action === 'start-fresh') {
        if (!req.user.builtIn) throw fail(403, 'Only the main admin account can do that.');
        try {
          await users.loadUsers({ fresh: true });
          throw fail(400, 'The user list is working fine, so there\u2019s nothing to replace.');
        } catch (e) {
          if (e.code !== 'USERS_LOCKED') throw e;
        }
        await users.resetList('Start a fresh admin user list (the old one could not be unlocked)');
        res.status(200).json({ ok: true });
        return;
      }

      if (!username) throw fail(400, 'Missing username.');
      if (username === main.username) {
        throw fail(400, 'The main admin account is managed in Vercel (its password is the ADMIN_PASSWORD setting) and can’t be changed here.');
      }

      if (action === 'reset') {
        const password = users.generatePassword();
        let name = username;
        await users.updateUsers((list) => {
          const u = list.find((x) => x.username === username);
          if (!u) throw fail(404, 'That person wasn’t found. Refresh the page.');
          u.password = users.hashPassword(password);
          u.ver = users.newVersion();
          u.mustChangePassword = true;
          name = u.name;
        }, `Reset admin password for ${username}`);
        res.status(200).json({ ok: true, username, name, password });
        return;
      }

      if (action === 'role') {
        const role = body.role;
        if (!users.ROLES.includes(role)) throw fail(400, 'Unknown role.');
        if (username === req.user.username && role !== 'admin') {
          throw fail(400, 'You can’t remove your own admin access. Ask another admin to do it.');
        }
        await users.updateUsers((list) => {
          const u = list.find((x) => x.username === username);
          if (!u) throw fail(404, 'That person wasn’t found. Refresh the page.');
          u.role = role;
        }, `Make ${username} ${role === 'admin' ? 'an admin' : 'an editor'}`);
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'remove') {
        if (username === req.user.username) throw fail(400, 'You can’t remove yourself. Ask another admin to do it.');
        await users.updateUsers((list) => {
          const i = list.findIndex((x) => x.username === username);
          if (i === -1) throw fail(404, 'That person wasn’t found. Refresh the page.');
          list.splice(i, 1);
        }, `Remove admin login for ${username}`);
        res.status(200).json({ ok: true });
        return;
      }

      throw fail(400, 'Unknown action.');
    } catch (e) {
      res.status(e.expose ? e.status : 502).json({ error: e.message });
    }
  },
  { role: 'admin' }
);
