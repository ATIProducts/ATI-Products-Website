// lib/auth.js
//
// Minimal session handling for the /admin area. No external dependencies —
// just Node's built-in crypto module, so this deploys on Vercel with zero
// npm installs required.
//
// How it works:
//   1. On successful login (api/login.js) we issue a signed cookie. The
//      cookie's value is base64url(payload) + "." + HMAC-SHA256(payload).
//   2. Every protected API route (see lib/requireAuth.js) re-verifies that
//      signature using the same secret (SESSION_SECRET env var) before
//      doing anything. If the signature doesn't match, or the payload has
//      expired, the request is rejected.
//   3. The cookie is HttpOnly, so it can't be read or stolen by JavaScript
//      running on the page — only the browser and our server ever see it.

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
    return payload;
  } catch {
    return null;
  }
}

function createSessionCookie() {
  const payload = { exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 };
  const token = sign(payload);
  // "Secure" only makes sense over HTTPS, which is all Vercel serves in
  // production. Locally (vercel dev over http) it's safe to omit.
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
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = verify(cookies[COOKIE_NAME]);
  return !!payload;
}

// Compares two strings without leaking timing information about where the
// first mismatched character is — important for comparing passwords.
function constantTimeStringEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a));
  const bufB = Buffer.from(String(b == null ? '' : b));
  if (bufA.length !== bufB.length) {
    // Still do a dummy timingSafeEqual so short/wrong-length guesses take
    // the same time as a correct-length wrong guess.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  COOKIE_NAME,
  createSessionCookie,
  clearSessionCookie,
  isAuthenticated,
  parseCookies,
  constantTimeStringEqual,
};
