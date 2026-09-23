// lib/users.js
//
// Everyone who can log in to the admin.
//
// There are two kinds of account:
//
//   * The MAIN ADMIN account comes from Vercel settings (ADMIN_USERNAME /
//     ADMIN_PASSWORD). It always works, can't be removed from inside the
//     admin, and is the way back in if anything ever goes wrong with the
//     user list. Changing ADMIN_PASSWORD in Vercel logs it out everywhere.
//
//   * EVERYONE ELSE is stored in admin/users.enc.json in the GitHub repo,
//     managed from the admin's "People" screen. Because there's no
//     database, the list has to live in the repo — and files in the repo
//     can be downloaded by anyone who knows the address. So the whole file
//     is ENCRYPTED (AES-256-GCM, key derived from SESSION_SECRET), and
//     passwords inside it are additionally one-way scrambled (scrypt) so
//     not even the site can read them back.
//
// Roles:  "admin"  — can edit, and can add/remove people and reset passwords
//         "editor" — can edit pages and write posts only

const crypto = require('crypto');
const { getFile, putFile } = require('./github');

const USERS_PATH = 'admin/users.enc.json';
const ROLES = ['admin', 'editor'];
const CACHE_MS = 30 * 1000;

// ---------- the main admin account (from Vercel settings) ----------

function mainAdmin() {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  // Version is derived from the password, so changing ADMIN_PASSWORD in
  // Vercel automatically ends every existing main-admin session.
  const ver = crypto
    .createHash('sha256')
    .update('main-admin:' + (process.env.ADMIN_PASSWORD || ''))
    .digest('base64url')
    .slice(0, 12);
  return { username, name: 'Main admin', role: 'admin', ver, builtIn: true, email: '' };
}

// ---------- encryption ----------

function fileKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set in Vercel.');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'ati-admin-users', 'users-file-v1', 32));
}

function encryptList(users) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ users }), 'utf8'), cipher.final()]);
  return (
    JSON.stringify(
      {
        about: 'Encrypted list of website admin logins. Managed from the admin "People" screen. Do not edit by hand.',
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      },
      null,
      2
    ) + '\n'
  );
}

function decryptList(text) {
  let box;
  try {
    box = JSON.parse(text);
  } catch {
    throw new Error('The user list file (admin/users.enc.json) is damaged.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey(), Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain);
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    const err = new Error(
      'The user list can’t be unlocked. This happens if SESSION_SECRET in Vercel was changed. ' +
        'Put the old SESSION_SECRET back, or log in with the main admin account and use “Start a Fresh List” on the People & logins screen.'
    );
    err.code = 'USERS_LOCKED';
    throw err;
  }
}

// ---------- loading & saving (with a short cache) ----------

let cache = null; // { users, sha, at }

async function loadUsers(opts) {
  const fresh = opts && opts.fresh;
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const file = await getFile(USERS_PATH);
  if (!file) {
    cache = { users: [], sha: null, at: Date.now() };
    return cache;
  }
  cache = { users: decryptList(file.content), sha: file.sha, at: Date.now() };
  return cache;
}

async function saveUsers(users, sha, message) {
  const result = await putFile(USERS_PATH, encryptList(users), message, sha || undefined);
  cache = {
    users,
    sha: (result && result.content && result.content.sha) || null,
    at: Date.now(),
  };
}

// Read-modify-write with the freshest copy, so two admins working at once
// can't silently overwrite each other (GitHub rejects a stale sha).
async function updateUsers(mutator, message) {
  const current = await loadUsers({ fresh: true });
  const users = current.users.map((u) => Object.assign({}, u));
  const result = mutator(users);
  await saveUsers(users, current.sha, message);
  return result;
}

// Starts an empty user list, replacing one that can't be unlocked any more
// (only offered to the main admin, only when the list is locked).
async function resetList(message) {
  const file = await getFile(USERS_PATH);
  await saveUsers([], file ? file.sha : null, message);
}

// ---------- passwords ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function checkPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(record.salt, 'base64'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Easy to read aloud and type: no 0/O, 1/l/I.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < 16) {
    const bytes = crypto.randomBytes(32);
    for (let i = 0; i < bytes.length && out.length < 16; i++) {
      if (bytes[i] < limit) out += alphabet[bytes[i] % alphabet.length];
    }
  }
  return out.match(/.{4}/g).join('-');
}

function newVersion() {
  return crypto.randomBytes(6).toString('base64url');
}

// ---------- helpers used by the API routes ----------

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function validUsername(u) {
  return /^[a-z0-9][a-z0-9._-]{1,39}$/.test(u);
}

// What's safe to send to the browser about a person.
function publicUser(u) {
  return {
    username: u.username,
    name: u.name,
    email: u.email || '',
    role: u.role,
    builtIn: !!u.builtIn,
    createdAt: u.createdAt || null,
    mustChangePassword: !!u.mustChangePassword,
  };
}

// Looks up who a (signature-verified) session belongs to, and confirms it
// is still valid. Returns the person, or null.
async function resolveSession(session) {
  if (!session || !session.u) return null;
  const main = mainAdmin();
  if (session.u === main.username) {
    return session.v === main.ver ? main : null;
  }
  const { users } = await loadUsers();
  const person = users.find((x) => x.username === session.u);
  if (!person || person.ver !== session.v) return null;
  return person;
}

// Checks a username + password. Returns the person, or null.
async function authenticate(username, password) {
  const name = normalizeUsername(username);
  const main = mainAdmin();
  if (name === main.username) {
    const expected = process.env.ADMIN_PASSWORD || '';
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return ok ? main : null;
  }
  const { users } = await loadUsers();
  const person = users.find((x) => x.username === name);
  if (!person) {
    // Spend the same time as a real check so usernames can't be probed.
    checkPassword(password, { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: Buffer.alloc(64).toString('base64') });
    return null;
  }
  return checkPassword(password, person.password) ? person : null;
}

module.exports = {
  USERS_PATH,
  ROLES,
  mainAdmin,
  loadUsers,
  updateUsers,
  resetList,
  hashPassword,
  checkPassword,
  generatePassword,
  newVersion,
  normalizeUsername,
  validUsername,
  publicUser,
  resolveSession,
  authenticate,
  // exported for tests
  _encryptList: encryptList,
  _decryptList: decryptList,
  _resetCache: () => { cache = null; },
};
