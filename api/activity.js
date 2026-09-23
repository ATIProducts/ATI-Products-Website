// api/activity.js — the Activity log (admins only).
//
// GET ?page=1  →  { entries: [...], hasMore, people: [{username, name}] }
//
// There's no separate log file to keep in sync: every change made through
// the admin is already a GitHub commit that records who made it (see
// lib/github.js). This reads that history and turns each commit into a
// plain-English line like "Jane Smith edited the About page".
// Changes made directly on GitHub (not through the admin) show up too,
// marked as such.

const { requireAuth } = require('../lib/requireAuth');
const { listCommits } = require('../lib/github');
const { getManifest } = require('../lib/manifest');
const users = require('../lib/users');

const PER_PAGE = 100;
const ADMIN_EMAIL_DOMAIN = '@ati-website-admin.local';
const PHOTO_WINDOW_MS = 15 * 60 * 1000;

// Turns one commit message (without the "(by …)" part) into
// { kind, action, detail }. kind "hidden" = behind-the-scenes bookkeeping
// that's part of a bigger action (e.g. adding a new post to the sitemap).
function describe(msg, titles, nameOf) {
  let m;
  if ((m = msg.match(/^Update (.+?) via admin$/))) {
    const t = titles[m[1]];
    const isPost = t && t.isPost;
    return { kind: 'edit', action: isPost ? 'Edited a blog post' : 'Edited a page', detail: (t && t.title) || m[1] };
  }
  if ((m = msg.match(/^Add blog post: (.+)$/))) return { kind: 'post', action: 'Published a new blog post', detail: m[1] };
  if (/^List new blog post (on blog\.html|in admin manifest): /.test(msg) || /^Add \S+ to sitemap$/.test(msg)) {
    return { kind: 'hidden' };
  }
  if ((m = msg.match(/^Upload image (.+?) via admin$/))) return { kind: 'photo', action: 'Uploaded a photo', detail: m[1].replace(/^.*\//, '') };
  if ((m = msg.match(/^Add admin login for (.+) \((admin|editor)\)$/))) {
    return { kind: 'people', action: 'Added a login', detail: `${m[1]} (${m[2]})` };
  }
  // Person references look like "jsmith (Jane Smith)" (older ones: just "jsmith").
  const person = (u, n) => nameOf(u, n);
  if ((m = msg.match(/^Reset admin password for (\S+)(?: \((.+)\))?$/))) return { kind: 'people', action: 'Reset someone’s password', detail: person(m[1], m[2]) };
  if ((m = msg.match(/^Make (\S+)(?: \((.+)\))? (an admin|an editor)$/))) return { kind: 'people', action: 'Changed someone’s access', detail: `${person(m[1], m[2])} is now ${m[3]}` };
  if ((m = msg.match(/^Remove admin login for (\S+)(?: \((.+)\))?$/))) return { kind: 'people', action: 'Removed a login', detail: person(m[1], m[2]) };
  if ((m = msg.match(/ changed their admin display name to (.+)$/))) return { kind: 'account', action: 'Changed their name', detail: `to “${m[1]}”` };
  if (/ changed their admin password$/.test(msg)) return { kind: 'account', action: 'Changed their password', detail: '' };
  if (/^Start a fresh admin user list/.test(msg)) return { kind: 'people', action: 'Started a fresh login list', detail: '' };
  return { kind: 'other', action: msg, detail: '' };
}

module.exports = requireAuth(
  async (req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    const page = Math.max(1, Math.min(50, parseInt((req.query && req.query.page) || '1', 10) || 1));

    try {
      // Page titles and people's current names make the log readable.
      // Neither is essential, so the log still works if one can't load.
      const titles = {};
      try {
        (await getManifest()).pages.forEach((p) => { titles[p.file] = p; });
      } catch { /* fall back to file names */ }

      const byEmail = {};
      const byUsername = {};
      let main = users.mainAdmin();
      try {
        const loaded = await users.loadUsers();
        main = users.mainAdmin(loaded.main);
        loaded.users.forEach((u) => {
          byUsername[u.username] = u.name;
          if (u.email) byEmail[u.email.toLowerCase()] = u.username;
        });
      } catch { /* names from the commit messages are used instead */ }
      byUsername[main.username] = main.name;
      const nameOf = (username, fallback) => byUsername[username] || fallback || username;

      const commits = await listCommits(page, PER_PAGE);

      const raw = commits.map((c) => {
        const info = c.commit || {};
        const firstLine = String(info.message || '').split('\n')[0].trim();
        const by = firstLine.match(/^(.*) \(by (.+)\)$/);
        const author = info.author || {};
        const email = String(author.email || '').toLowerCase();
        let username = null;
        if (email.endsWith(ADMIN_EMAIL_DOMAIN)) username = email.slice(0, -ADMIN_EMAIL_DOMAIN.length);
        else if (byEmail[email]) username = byEmail[email];

        const base = {
          id: c.sha,
          when: author.date || (info.committer && info.committer.date) || null,
          url: c.html_url || null,
        };
        if (!by) {
          // Saved by the admin before separate logins existed (no "(by …)" yet).
          const early = describe(firstLine, titles, nameOf);
          if (early.kind !== 'other') {
            return Object.assign(base, early, { viaAdmin: true, username: null, who: 'Admin (before separate logins)' });
          }
          // Not made through the admin (e.g. files uploaded on GitHub).
          return Object.assign(base, {
            viaAdmin: false,
            username: null,
            who: author.name || (c.author && c.author.login) || 'Someone on GitHub',
            kind: 'github',
            action: 'Changed files directly on GitHub (not through the admin)',
            detail: firstLine,
          });
        }
        const d = describe(by[1], titles, nameOf);
        return Object.assign(base, d, {
          viaAdmin: true,
          username,
          who: username ? nameOf(username) : by[2],
        });
      });

      // Photos uploaded as part of an edit or a new post are folded into
      // that entry ("… with 2 photos") instead of being listed separately.
      // Walk oldest → newest: uploads come just before the save they belong to.
      const pendingPhotos = {};
      const out = [];
      raw.slice().reverse().forEach((e) => {
        if (e.kind === 'hidden') return;
        const key = e.username || e.who;
        if (e.kind === 'photo') {
          (pendingPhotos[key] = pendingPhotos[key] || []).push(e);
          return;
        }
        if ((e.kind === 'edit' || e.kind === 'post') && pendingPhotos[key]) {
          const t = Date.parse(e.when);
          const mine = pendingPhotos[key].filter((p) => !(t - Date.parse(p.when) <= PHOTO_WINDOW_MS));
          e.photos = pendingPhotos[key].length - mine.length;
          out.push(...mine);
          delete pendingPhotos[key];
        }
        out.push(e);
      });
      Object.keys(pendingPhotos).forEach((k) => out.push(...pendingPhotos[k]));
      out.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));

      const people = Object.keys(byUsername)
        .map((u) => ({ username: u, name: byUsername[u] }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.status(200).json({
        entries: out.map(({ kind, id, when, url, who, username, action, detail, photos, viaAdmin }) =>
          ({ kind, id, when, url, who, username, action, detail, photos: photos || 0, viaAdmin })),
        hasMore: commits.length === PER_PAGE,
        page,
        people,
      });
    } catch (e) {
      res.status(e.expose ? e.status : 502).json({ error: e.message });
    }
  },
  { role: 'admin' }
);
