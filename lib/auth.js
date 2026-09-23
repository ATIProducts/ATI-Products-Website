// lib/auth.js
//
// Session handling for the /admin area. No external dependencies — just
// Node's built-in crypto module.
//
// How it works:
//   1. On successful login (api/login.js) we issue a signed cookie. The
//      cookie's value is base64url(payload) + "." + HMAC-SHA256(payload),
//      where the payload says who is logged in (username) plus a version
//      number for that person's login.
//   2. Every protected API route (lib/requireAuth.js) re-verifies the
//      signature with SESSION_SECRET, then checks the person still exists
//      and their version still matches. Removing someone, or resetting
//      their password, bumps the version — so their old sessions stop
//      working immediately, even though cookies can't be recalled.
//   3. The cookie is HttpOnly, so JavaScript on the page can't read it.

const crypto = require('crypto');

const COOKIE_NAME = 'ati_admin_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET environment variable is not set. Add it in Vercel Project Settings > Environment Variables.'
    );
  }
  return secret;
}

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, hmac] = token.split('.');
  if (!data || !hmac) return null;

  let expected;
  try {
    expected = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  } catch {
    return null;
  }

  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (!payload.u) return null; // sessions from before multi-user logins
    return payload;
  } catch {
    return null;
  }
}

// who: { username, ver }
function createSessionCookie(who) {
  const payload = { u: who.username, v: who.ver, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 };
  const token = sign(payload);
  const secure = process.env.VERCEL ? 'Secure; ' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; ${secure}SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  });
  return out;
}

// Returns the signed payload ({ u, v, exp }) or null. Does NOT check that
// the person still exists — lib/users.js resolveSession() does that.
function readSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verify(cookies[COOKIE_NAME]);
}

// Compares two strings without leaking timing information.
function constantTimeStringEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a));
  const bufB = Buffer.from(String(b == null ? '' : b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  COOKIE_NAME,
  createSessionCookie,
  clearSessionCookie,
  readSession,
  parseCookies,
  constantTimeStringEqual,
};
