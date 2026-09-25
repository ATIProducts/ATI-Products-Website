// api/pages.js
//
// GET  /api/pages             -> list of every editable page (read live
//                                 from admin/content-manifest.json, so
//                                 newly published posts show up too)
// GET  /api/pages?file=x.html -> current raw HTML of one page (fetched
//                                 live from GitHub, so it always reflects
//                                 the real deployed source, not a stale
//                                 copy)
// PUT  /api/pages { file, content } -> commits the edited HTML back to
//                                 GitHub, which triggers Vercel to
//                                 rebuild and redeploy automatically.
//
// IMPORTANT: this intentionally edits full page source, not individual
// fields. Every page on this site was hand-built with its own layout, so
// there's no single structured "content model" to map form fields onto
// without a much larger rebuild (see SETUP.md for why). The admin UI
// wraps this in a source editor with a live preview so non-technical
// edits are still safe to make.

//
// POST /api/pages { mode: 'simple' | 'copy', title, slug?, description?,
//                   addToFooter, ...simple: subtitle, heroImageSrc,
//                   heroImageAlt, bodyHtml | copy: sourceFile }
//                              -> creates a brand-new page. The page, its
//                                 entry in the admin's page list, the
//                                 sitemap, and (optionally) a footer link
//                                 on every page are saved together as ONE
//                                 commit, so the site redeploys once.

const { requireAuth } = require('../lib/requireAuth');
const { getFile, putFile, getHeadSha, commitFiles } = require('../lib/github');
const { getManifest } = require('../lib/manifest');
const { SITE_URL } = require('../lib/site');
const { renderSitemapEntry } = require('../lib/blogTemplate');
const { renderSimplePage, copyPage, addFooterLink, removeFooterLink } = require('../lib/pageTemplate');

const PAGE_TEMPLATE = 'admin/templates/page-template.html';
const POST_TEMPLATE = 'admin/templates/blog-post-template.html';
const MANIFEST = 'admin/content-manifest.json';

function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

// Reads many files at the same commit, a few at a time.
async function readAll(paths, ref) {
  const out = {};
  const queue = paths.slice();
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      out[p] = await getFile(p, ref);
    }
  }
  await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  return out;
}

async function createPage(body) {
  const mode = body.mode === 'copy' ? 'copy' : 'simple';
  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) throw fail(400, 'Please type a page name.');

  const head = await getHeadSha();
  const manifestFile = await getFile(MANIFEST, head);
  if (!manifestFile) throw fail(500, `Couldn't find ${MANIFEST} in GitHub.`);
  const manifest = JSON.parse(manifestFile.content);

  // Build the new page.
  let built;
  if (mode === 'copy') {
    const source = manifest.pages.find((p) => p.file === body.sourceFile);
    if (!source) throw fail(400, 'Please pick the page to copy.');
    const src = await getFile(source.file, head);
    if (!src) throw fail(404, `${source.file} wasn't found in GitHub.`);
    built = copyPage(src.content, { title, slug: body.slug, description: body.description });
  } else {
    const tpl = await getFile(PAGE_TEMPLATE, head);
    if (!tpl) throw fail(500, `The page template is missing from the repo at ${PAGE_TEMPLATE}. Restore it from the admin update package.`);
    built = renderSimplePage(tpl.content, {
      title,
      slug: body.slug,
      description: body.description,
      subtitle: body.subtitle,
      heroImageSrc: body.heroImageSrc,
      heroImageAlt: body.heroImageAlt,
      bodyHtml: body.bodyHtml,
    });
  }
  const file = `${built.slug}.html`;

  // Don't overwrite anything, and don't pick an address that's already
  // forwarded somewhere else (the forwarding would hide the new page).
  if (manifest.pages.some((p) => p.file === file) || (await getFile(file, head))) {
    throw fail(409, `There's already a page at "${built.slug}". Please choose a different name or web address.`);
  }
  const vercel = await getFile('vercel.json', head);
  if (vercel) {
    try {
      const cfg = JSON.parse(vercel.content);
      if ((cfg.redirects || []).some((r) => r.source === `/${built.slug}`)) {
        throw fail(409, `The address "${built.slug}" is already used to forward visitors to another page. Please choose a different web address.`);
      }
    } catch (e) {
      if (e.expose) throw e;
    }
  }

  const files = [{ path: file, content: built.html }];

  // Admin page list: add it at the end of the regular pages.
  const pages = manifest.pages.slice();
  let at = pages.length;
  for (let i = pages.length - 1; i >= 0; i--) {
    if (!pages[i].isPost) { at = i + 1; break; }
  }
  pages.splice(at, 0, { file, title, group: 'Pages', created: true });
  files.push({ path: MANIFEST, content: JSON.stringify(Object.assign({}, manifest, { pages }), null, 2) + '\n' });

  // Sitemap.
  const sitemap = await getFile('sitemap.xml', head);
  if (sitemap && sitemap.content.includes('</urlset>') && !sitemap.content.includes(`/${built.slug}</loc>`)) {
    files.push({ path: 'sitemap.xml', content: sitemap.content.replace('</urlset>', `${renderSitemapEntry(built.slug)}</urlset>`) });
  }

  // Footer link on every page (and in both templates, so pages and posts
  // made later have it too). The new page itself gets it as well.
  const footer = { added: 0, skipped: [] };
  if (body.addToFooter) {
    const withLink = addFooterLink(built.html, file, title);
    if (withLink) files[0].content = withLink;
    const others = manifest.pages.map((p) => p.file).concat([PAGE_TEMPLATE, POST_TEMPLATE]);
    const read = await readAll(others, head);
    others.forEach((p) => {
      const f = read[p];
      const updated = f && addFooterLink(f.content, file, title);
      if (updated) {
        files.push({ path: p, content: updated });
        footer.added++;
      } else {
        footer.skipped.push(p);
      }
    });
  }

  await commitFiles(files, `Add page: ${title}`, head);
  return { file, slug: built.slug, title, url: `${SITE_URL}/${built.slug}`, footer };
}

// Removes a page made with "+ New Page": the file, its admin list entry,
// its sitemap entry and its footer links, as one commit.
async function deletePage(file) {
  const head = await getHeadSha();
  const manifestFile = await getFile(MANIFEST, head);
  const manifest = JSON.parse(manifestFile.content);
  const entry = manifest.pages.find((p) => p.file === file);
  if (!entry) throw fail(404, 'That page isn’t in the list.');
  if (!entry.created) throw fail(400, 'Only pages made with “+ New Page” can be deleted here. Ask the person who set up the website to remove other pages.');
  const slug = file.replace(/\.html$/, '');
  const files = [{ path: file, content: null }];
  const pages = manifest.pages.filter((p) => p.file !== file);
  files.push({ path: MANIFEST, content: JSON.stringify(Object.assign({}, manifest, { pages }), null, 2) + '\n' });
  const sitemap = await getFile('sitemap.xml', head);
  if (sitemap) {
    const re = new RegExp(`[ \\t]*<url>\\s*<loc>[^<]*/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>[\\s\\S]*?</url>\\n?`);
    const updated = sitemap.content.replace(re, '');
    if (updated !== sitemap.content) files.push({ path: 'sitemap.xml', content: updated });
  }
  const others = pages.map((p) => p.file).concat([PAGE_TEMPLATE, POST_TEMPLATE]);
  const read = await readAll(others, head);
  let footerRemoved = 0;
  others.forEach((p) => {
    const f = read[p];
    const updated = f && removeFooterLink(f.content, file);
    if (updated) { files.push({ path: p, content: updated }); footerRemoved++; }
  });
  await commitFiles(files, `Delete page: ${entry.title}`, head);
  return { file, title: entry.title, footerRemoved };
}

module.exports = requireAuth(async (req, res) => {
  if (req.method === 'GET') {
    const file = req.query && req.query.file;

    let manifest;
    try {
      manifest = await getManifest();
    } catch (e) {
      res.status(502).json({ error: e.message });
      return;
    }

    if (!file) {
      res.status(200).json({ pages: manifest.pages });
      return;
    }

    const match = manifest.pages.find((p) => p.file === file);
    if (!match) {
      res.status(404).json({ error: 'That file is not in the editable pages list.' });
      return;
    }

    try {
      const result = await getFile(file);
      if (!result) {
        res.status(404).json({ error: 'File not found in the repository.' });
        return;
      }
      res.status(200).json({ file, title: match.title, content: result.content, sha: result.sha });
    } catch (e) {
      res.status(502).json({ error: `Could not reach GitHub: ${e.message}` });
    }
    return;
  }

  if (req.method === 'PUT') {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch {
        body = {};
      }
    }
    const { file, content } = body || {};

    let manifest;
    try {
      manifest = await getManifest();
    } catch (e) {
      res.status(502).json({ error: e.message });
      return;
    }

    const match = manifest.pages.find((p) => p.file === file);
    if (!match) {
      res.status(404).json({ error: 'That file is not in the editable pages list.' });
      return;
    }
    if (typeof content !== 'string' || content.trim().length < 20) {
      res.status(400).json({ error: 'That content looks empty or too short to publish.' });
      return;
    }
    if (!/^\s*<!DOCTYPE html>/i.test(content)) {
      res.status(400).json({ error: 'Content must be a full HTML page starting with <!DOCTYPE html>.' });
      return;
    }

    try {
      const existing = await getFile(file);
      const result = await putFile(file, content, `Update ${file} via admin`, existing ? existing.sha : undefined);
      res.status(200).json({ ok: true, commit: result && result.commit && result.commit.sha });
    } catch (e) {
      res.status(502).json({ error: `Could not save to GitHub: ${e.message}` });
    }
    return;
  }

  if (req.method === 'DELETE') {
    // Only admins, and only pages that were made with "+ New Page".
    if (!req.user || req.user.role !== 'admin') {
      res.status(403).json({ error: 'Only admins can delete pages.' });
      return;
    }
    try {
      const result = await deletePage(req.query && req.query.file);
      res.status(200).json(Object.assign({ ok: true }, result));
    } catch (e) {
      res.status(e.expose ? e.status || 400 : 502).json({ error: e.message });
    }
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch {
        body = {};
      }
    }
    try {
      const result = await createPage(body || {});
      res.status(200).json(Object.assign({ ok: true }, result));
    } catch (e) {
      res.status(e.expose ? e.status || 400 : 502).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
